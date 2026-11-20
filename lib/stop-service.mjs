// Zastávky a odjezdy z CELOSTÁTNÍHO jízdního řádu (na serveru), pro mapu mimo Ústecký kraj (Praha, Plzeň…).
//
// Prohlížeč má jízdní řád jen kraje (a vlaky celé sítě), takže jinde by viděl jen vlakové zastávky. Server drží
// celostátní databázi (timetable.sqlite, stejná jako v appce) a počítá nad ní nástupiště stejným kódem jako prohlížeč
// a appka (public/js/stops.js): zastávky ve výřezu mapy a odjezdy z vybrané zastávky.
import path from 'node:path';
import fs from 'node:fs';
import { StopIndex, STOP_DEPARTURE_HOURS } from '../public/js/stops.js';
import { prettyName } from '../public/js/util.js';

const toInts = (blob) => {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const out = new Int32Array(b.length >> 2);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt32(i * 4, true);
  return out;
};

const weekdayOf = (ymd) => (new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay() + 6) % 7;
const addDays = (ymd, n) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};

export class StopService {
  /** @param {string} file cesta k timetable.sqlite */
  static async open(file) {
    const { DatabaseSync } = await import('node:sqlite');
    if (!fs.existsSync(file)) throw new Error(`chybí ${file}`);
    const t0 = Date.now();
    const s = new StopService();
    s.db = new DatabaseSync(file, { readOnly: true });
    s._load();
    console.log(`[stops] ${s.index.stops.length} zastávek / nástupišť z ${s.tripCount} spojů za ${Date.now() - t0} ms`);
    return s;
  }

  _load() {
    const db = this.db;
    // zastávky (index = id) a spoje se sledem zastávek (časy se čtou až pro odjezdy)
    const maxStop = db.prepare('SELECT max(id) m FROM stop').get().m || 0;
    const stops = new Array(maxStop + 1).fill(null);
    for (const r of db.prepare('SELECT id, name, lat, lon FROM stop').iterate()) {
      const lat = r.lat || 0, lng = r.lon || 0;
      stops[r.id] = { id: r.id, name: r.name, lat, lng, hasCoords: lat !== 0 || lng !== 0 };
    }
    const maxTrip = db.prepare('SELECT max(id) m FROM trip').get().m || 0;
    const trips = new Array(maxTrip + 1).fill(null);
    // linky, dopravci a cíle se opakují u tisíců spojů: jeden řetězec místo kopie z každého řádku
    const pool = new Map();
    const intern = (x) => { if (x == null) return ''; let v = pool.get(x); if (v === undefined) { pool.set(x, x); v = x; } return v; };
    for (const r of db.prepare("SELECT id, line, agency, head, svc, gid LIKE 'czptt:%' tr FROM trip").iterate()) {
      trips[r.id] = { id: r.id, line: intern(r.line), agency: intern(r.agency), head: intern(r.head), svc: r.svc, isTrain: !!r.tr, stops: null, dep: null };
    }
    // sledy zastávek všech spojů v jednom poli (spoj = pohled do něj): bez statisíců malých bufferů
    const total = (db.prepare('SELECT sum(length(stops)) n FROM trip_times').get().n || 0) >> 2;
    const all = new Int32Array(total);
    let n = 0, off = 0;
    for (const r of db.prepare('SELECT trip, stops FROM trip_times').iterate()) {
      const t = trips[r.trip];
      if (!t) continue;
      const b = r.stops, len = b.length >> 2;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (let i = 0; i < len; i++) all[off + i] = dv.getInt32(i * 4, true);
      t.stops = all.subarray(off, off + len);
      off += len;
      n++;
    }
    for (let i = 0; i < trips.length; i++) if (trips[i] && !trips[i].stops) trips[i] = null;
    this.tripCount = n;
    this.tt = { stops, trips };
    this.index = new StopIndex(this.tt);

    // zastávka → spoje, které z ní odjíždějí (CSR: začátky + id spojů)
    const count = new Int32Array(maxStop + 2);
    for (const t of trips) if (t) for (let i = 0; i < t.stops.length - 1; i++) count[t.stops[i] + 1]++;
    for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
    const data = new Int32Array(count[count.length - 1]);
    const fill = count.slice();
    for (const t of trips) if (t) for (let i = 0; i < t.stops.length - 1; i++) data[fill[t.stops[i]]++] = t.id;
    this.tripsAt = { start: count, data };

    this.svcs = db.prepare('SELECT id, dow, d0, d1 FROM svc').all();
    this.svcDates = new Map();
    for (const r of db.prepare('SELECT svc, d, type FROM svc_date').iterate()) {
      let l = this.svcDates.get(r.d); if (!l) this.svcDates.set(r.d, (l = [])); l.push([r.svc, r.type]);
    }
    this._active = new Map();
    this.qTimes = db.prepare('SELECT dep FROM trip_times WHERE trip = ?');
  }

  activeSvcs(ymd) {
    let set = this._active.get(ymd);
    if (set) return set;
    const wd = weekdayOf(ymd);
    set = new Set();
    for (const s of this.svcs) if (s.d0 <= ymd && ymd <= s.d1 && s.dow?.[wd] === '1') set.add(s.id);
    for (const [svc, type] of this.svcDates.get(ymd) || []) { if (type === 1) set.add(svc); else if (type === 2) set.delete(svc); }
    if (this._active.size > 8) this._active.clear();
    this._active.set(ymd, set);
    return set;
  }

  /** Zastávky ve výřezu: [klíč, lat, lng, druh] (druh 'rail' = vlaky, jinak autobus / MHD). */
  inView(b, limit = 1500) {
    return this.index.inView(b, limit).map((s) => [s.key, +s.lat.toFixed(6), +s.lng.toFixed(6), s.kind === 'rail' ? 'rail' : 'bus']);
  }

  /**
   * Odjezdy ze zastávky (klíč z [inView]) od now na hours hodin: název zastávky a seznam
   * { tid, day, dep, line, head, isTrain, agency, from }.
   * @param {{day:string, sec:number}} now
   */
  departures(key, now, hours = STOP_DEPARTURE_HOURS) {
    const stop = this.index.byKey.get(key);
    if (!stop) return null;
    const { start, data } = this.tripsAt;
    const today = this.activeSvcs(now.day), yest = this.activeSvcs(addDays(now.day, -1)), tom = this.activeSvcs(addDays(now.day, 1));
    const crossesMidnight = now.sec + hours * 3600 > 86400;
    const seen = new Set(), cand = [];
    for (const id of stop.ttStops) {
      for (let k = start[id]; k < start[id + 1]; k++) {
        const t = this.tt.trips[data[k]];
        if (!t || seen.has(t.id)) continue;
        seen.add(t.id);
        const shifts = [];
        if (today.has(t.svc)) shifts.push(0);
        if (yest.has(t.svc)) shifts.push(-86400);
        if (crossesMidnight && tom.has(t.svc)) shifts.push(86400);
        if (!shifts.length) continue;
        if (!t.dep) t.dep = toInts(this.qTimes.get(t.id).dep);   // časy jen pro spoje, které tu jedou
        for (const sh of shifts) cand.push([t, sh]);
      }
    }
    const list = this.index.departures(stop, now, hours, cand).map((d) => ({ ...d, agency: this.tt.trips[d.tid].agency }));
    return { name: stop.name, kind: stop.kind, deps: list };
  }

  /** Polohy zastávek spoje na nástupištích (pole zarovnané se zastávkami, null = bez souřadnic). */
  platformPoints(tid) {
    const t = this.tt.trips[tid];
    return t ? this.index.platformPoints(Array.from(t.stops)).map((p) => (p ? [+p.lat.toFixed(6), +p.lng.toFixed(6)] : null)) : null;
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

export { prettyName };
