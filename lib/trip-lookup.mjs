// Dohledání spoje živého vozidla v CELOSTÁTNÍM jízdním řádu (na serveru).
//
// Prohlížeč má jen jízdní řád Ústeckého kraje (timetable.json, ~14 tis. spojů): celostátní (~295 tis. spojů) by se
// do něj stahoval zbytečně dlouho. Pražská a další vozidla mimo oblast by proto neměla spoj ani trasu. Server drží
// hotovou databázi z releasu spojeuk-data (timetable.sqlite, stejná jako v Android appce) a na dotaz vrátí spoj,
// zastávky a tvar trasy. Párování je port TripLocator.matchByPosition z appky (TripMatching.kt): linka, poloha na
// úseku mezi zastávkami, čas (po odečtení zpoždění), směr jízdy a cíl.
import fs from 'node:fs';
import path from 'node:path';
import { decodeShape, shapeMatchScore, routePrefix } from './shapes.mjs';

export const LOOKUP_FILES = {
  db: 'timetable.sqlite',
  bus: 'shapes.sqlite',
  train: 'train_shapes.sqlite',
  pid: 'pid_shapes.sqlite',
};

const SCORE_LIMIT = 800;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG = 111_320;
const PID_PREFIX = 'pidgtfs:';

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const normLine = (s) => { const t = String(s ?? '').trim(); return /^\d+$/.test(t) ? String(parseInt(t, 10)) : fold(t); };
const toInts = (blob) => {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const out = new Int32Array(b.length >> 2);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt32(i * 4, true);
  return out;
};
const bearing = (la1, lo1, la2, lo2) => {
  const r = Math.PI / 180, y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
  const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
};
const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** Pražský čas: den "YYYYMMDD", den v týdnu (po = 0) a sekundy od půlnoci; [daysBack] posune den zpět. */
export function pragueClock(nowMs = Date.now(), daysBack = 0) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const sec = +p.hour * 3600 + +p.minute * 60 + +p.second;
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day - daysBack));
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return { ymd, weekday: (d.getUTCDay() + 6) % 7, rel: sec + daysBack * 86400 };
}

export class TripLookup {
  /** @param {string} dir složka se soubory [LOOKUP_FILES] */
  static async open(dir) {
    const { DatabaseSync } = await import('node:sqlite');
    const file = (k) => path.join(dir, LOOKUP_FILES[k]);
    if (!fs.existsSync(file('db'))) throw new Error(`chybí ${file('db')}`);
    const t = new TripLookup();
    const t0 = Date.now();
    t.db = new DatabaseSync(file('db'), { readOnly: true });
    t._load();
    t.shapes = {};
    for (const k of ['bus', 'train', 'pid']) {
      if (!fs.existsSync(file(k))) continue;
      const db = new DatabaseSync(file(k), { readOnly: true });
      t.shapes[k] = {
        db,
        byGid: db.prepare('SELECT shape FROM trip_shape WHERE gid = ?'),
        byRoute: db.prepare('SELECT DISTINCT shape FROM trip_shape WHERE gid >= ? AND gid < ?'),
        blob: db.prepare('SELECT pts FROM shape WHERE id = ?'),
      };
    }
    console.log(`[trip-lookup] načteno ${t.count} spojů za ${Date.now() - t0} ms`);
    return t;
  }

  _load() {
    const db = this.db;
    const maxId = db.prepare('SELECT max(id) m FROM trip').get().m || 0;
    this.svc = new Int32Array(maxId + 1).fill(-1);
    this.t0 = new Int32Array(maxId + 1);
    this.t1 = new Int32Array(maxId + 1);
    this.byLine = new Map();     // normalizovaná linka → [id]
    this.byTrain = new Map();    // číslo vlaku → [id]
    this.count = 0;
    for (const r of db.prepare("SELECT id, line, svc, t0, t1, num, gid LIKE 'czptt:%' tr FROM trip").iterate()) {
      const id = r.id;
      this.svc[id] = r.svc; this.t0[id] = r.t0; this.t1[id] = r.t1;
      const k = normLine(r.line);
      let l = this.byLine.get(k); if (!l) this.byLine.set(k, (l = [])); l.push(id);
      if (r.tr && r.num) { const n = String(r.num).replace(/^0+/, ''); let x = this.byTrain.get(n); if (!x) this.byTrain.set(n, (x = [])); x.push(id); }
      this.count++;
    }
    const maxStop = db.prepare('SELECT max(id) m FROM stop').get().m || 0;
    this.slat = new Float64Array(maxStop + 1); this.slng = new Float64Array(maxStop + 1);
    for (const r of db.prepare('SELECT id, lat, lon FROM stop').iterate()) { this.slat[r.id] = r.lat || 0; this.slng[r.id] = r.lon || 0; }
    this.svcs = db.prepare('SELECT id, dow, d0, d1 FROM svc').all();
    this.svcDates = new Map();
    for (const r of db.prepare('SELECT svc, d, type FROM svc_date').iterate()) {
      let l = this.svcDates.get(r.d); if (!l) this.svcDates.set(r.d, (l = [])); l.push([r.svc, r.type]);
    }
    this._active = new Map();
    this.qTimes = db.prepare('SELECT stops, arr, dep FROM trip_times WHERE trip = ?');
    this.qTrip = db.prepare('SELECT line, agency, head, num, gid FROM trip WHERE id = ?');
    this.qStop = db.prepare('SELECT name FROM stop WHERE id = ?');
    this._timesCache = new Map();
    this._headCache = new Map();
  }

  activeSvcs(ymd, weekday) {
    let set = this._active.get(ymd);
    if (set) return set;
    set = new Set();
    for (const s of this.svcs) if (s.d0 <= ymd && ymd <= s.d1 && s.dow?.[weekday] === '1') set.add(s.id);
    for (const [svc, type] of this.svcDates.get(ymd) || []) { if (type === 1) set.add(svc); else if (type === 2) set.delete(svc); }
    if (this._active.size > 8) this._active.clear();
    this._active.set(ymd, set);
    return set;
  }

  times(tid) {
    let t = this._timesCache.get(tid);
    if (t) return t;
    const r = this.qTimes.get(tid);
    if (!r) return null;
    t = { stops: toInts(r.stops), arr: toInts(r.arr), dep: toInts(r.dep) };
    if (this._timesCache.size > 20_000) this._timesCache.clear();
    this._timesCache.set(tid, t);
    return t;
  }

  _head(tid) {
    let h = this._headCache.get(tid);
    if (h === undefined) {
      const r = this.qTrip.get(tid);
      h = r ? fold(r.head) : '';
      if (this._headCache.size > 50_000) this._headCache.clear();
      this._headCache.set(tid, h);
    }
    return h;
  }

  /**
   * Spoj vozidla: vlak podle čísla vlaku, ostatní podle linky + polohy + času + směru (TripLocator.matchByPosition).
   * @param {{line:string, lat:number, lng:number, delay?:number, heading?:number|null, dest?:string, train?:boolean, num?:string, mode?:string}} v
   * @returns {number|null} id spoje
   */
  match(v, nowMs = Date.now()) {
    if (v.train) return this._matchTrain(String(v.num ?? '').trim().replace(/^0+/, ''), nowMs);
    const ids = this.byLine.get(normLine(v.line));
    if (!ids) return null;
    const maxDist = v.mode === 'metro' ? 1500 : 700;
    const wanted = fold(v.dest);
    const k = Math.cos((v.lat * Math.PI) / 180) * M_PER_DEG_LNG;
    const px = v.lng * k, py = v.lat * M_PER_DEG_LAT;
    let best = null, bestScore = SCORE_LIMIT;
    for (let back = 0; back <= 1; back++) {
      const c = pragueClock(nowMs, back);
      const rel = c.rel - (v.delay || 0) * 60;
      const active = this.activeSvcs(c.ymd, c.weekday);
      for (const tid of ids) {
        if (!active.has(this.svc[tid]) || rel < this.t0[tid] - 900 || rel > this.t1[tid] + 900) continue;
        const tm = this.times(tid);
        if (!tm) continue;
        let score = Infinity, legHeading = NaN, prev = -1;
        for (let j = 0; j < tm.stops.length; j++) {
          const sb = tm.stops[j];
          if (!this.slat[sb] && !this.slng[sb]) continue;
          const i = prev; prev = j;
          if (i < 0) continue;
          const sa = tm.stops[i];
          const ax = this.slng[sa] * k, ay = this.slat[sa] * M_PER_DEG_LAT;
          const dx = this.slng[sb] * k - ax, dy = this.slat[sb] * M_PER_DEG_LAT - ay;
          const len2 = dx * dx + dy * dy;
          const f = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          const d = Math.hypot(px - ax - dx * f, py - ay - dy * f);
          if (d > maxDist) continue;
          const t = tm.dep[i] + (tm.arr[j] - tm.dep[i]) * f;
          const cost = d + 0.5 * Math.abs(t - rel);
          if (cost < score) { score = cost; legHeading = bearing(this.slat[sa], this.slng[sa], this.slat[sb], this.slng[sb]); }
        }
        if (score === Infinity) continue;
        if (v.heading != null && !Number.isNaN(legHeading) && angleDiff(v.heading, legHeading) > 90) continue;
        if (wanted) {
          const h = this._head(tid);
          if (h) { if (h.includes(wanted) || wanted.includes(h)) score -= 250; else continue; }
        }
        if (score < bestScore) { bestScore = score; best = tid; }
      }
    }
    return best;
  }

  _matchTrain(n, nowMs) {
    const ids = n && this.byTrain.get(n);
    if (!ids) return null;
    let best = null, bestGap = Infinity;
    for (let back = 0; back <= 1; back++) {
      const c = pragueClock(nowMs, back);
      const active = this.activeSvcs(c.ymd, c.weekday);
      for (const tid of ids) {
        if (!active.has(this.svc[tid])) continue;
        const gap = c.rel < this.t0[tid] ? this.t0[tid] - c.rel : c.rel > this.t1[tid] ? c.rel - this.t1[tid] : 0;
        if (gap < bestGap) { bestGap = gap; best = tid; }
      }
    }
    return bestGap <= 4 * 3600 ? best : null;
  }

  /** Spoj pro klienta: linka, cíl, dopravce, zastávky [název, lat, lng, příjezd, odjezd] a tvar trasy (nebo null). */
  describe(tid) {
    const r = this.qTrip.get(tid);
    const tm = this.times(tid);
    if (!r || !tm) return null;
    const stops = Array.from(tm.stops, (sid, i) => [this.qStop.get(sid)?.name ?? '', this.slat[sid], this.slng[sid], tm.arr[i], tm.dep[i]]);
    const isTrain = String(r.gid || '').startsWith('czptt:');
    return {
      tid, line: r.line, head: r.head, agency: r.agency, num: r.num, isTrain, stops,
      route: this.shape(r.gid || '', stops.filter((s) => s[1] || s[2]).map((s) => [s[1], s[2]])),
    };
  }

  /** Tvar trasy podle gid (jako RouteGeometry v appce; u zastaralých JDF id podle shody se zastávkami). */
  shape(gid, stopCoords) {
    if (!gid) return null;
    const src = gid.startsWith('czptt:') ? this.shapes.train : gid.startsWith(PID_PREFIX) ? this.shapes.pid : this.shapes.bus;
    if (!src) return null;
    const pts = (id) => { const b = src.blob.get(id)?.pts; return b ? decodeShape(Buffer.from(b)) : null; };
    const row = src.byGid.get(gid);
    if (row) return pts(row.shape);
    const prefix = src === this.shapes.bus ? routePrefix(gid) : null;
    if (!prefix || stopCoords.length < 2) return null;
    let best = null;
    for (const { shape } of src.byRoute.all(`${prefix}:`, `${prefix};`)) {
      const p = pts(shape);
      const sc = p && shapeMatchScore(p, stopCoords);
      if (sc && sc.mean <= 100 && sc.max <= 350 && (!best || sc.mean < best.sc.mean)) best = { p, sc };
    }
    return best?.p ?? null;
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
    for (const s of Object.values(this.shapes || {})) try { s.db.close(); } catch { /* ignore */ }
  }
}
