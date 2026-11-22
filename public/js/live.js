// Živá vozidla: stahování z API, přiřazení ke spoji z jízdního řádu, příští a konečná zastávka.
import { CONFIG } from './config.js';
import { distanceM, M_PER_DEG_LAT, M_PER_DEG_LNG, prettyName, pragueNow, addDays, dayDiff, foldText, normLine } from './util.js';

// párování vozidel bez čísla spoje (DPMÚL) podle polohy: port TripLocator.matchByPosition z Android appky
const SCORE_LIMIT = 800;
const REGION = { s: 50.40, n: 50.90, w: 13.70, e: 14.45 };   // jízdní řád webu = Ústecký kraj (BBOX + rezerva)
const MATCH_TTL_MS = 30_000;
// hledání vozu pro spoj (Mapa u výsledku hledání): port findVehicle / pickMostPlausible z appky
const IMPLAUSIBLE = 10_000;
const MAX_ROUTE_OFF_M = 150;     // trasa webu = přímky mezi zastávkami, proto víc než 50 m v appce
const MAX_APPROACH_M = 8_000;
const MAX_HEADING_DIFF = 70;

const bearing = (la1, lo1, la2, lo2) => {
  const r = Math.PI / 180, y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
  const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
};
const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const usableHeading = (h) => Number.isFinite(h) && h !== 0;

export async function fetchVehicles() {
  const res = await fetch(`${CONFIG.API_BASE}/api/vehicles`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const vehicleUid = (v) => v.uid || (v.id ? `v${v.id}` : `p${v.lat.toFixed(4)},${v.lng.toFixed(4)}`);

export function sourceStatusParts(sources = []) {
  const active = sources.filter((s) => s.vehicles > 0 && s.health !== 'down');
  return active.length
    ? active.map((s) => ({ name: s.name, stale: s.health === 'stale' }))
    : [{ name: 'žádný', stale: true }];
}

/** Vzdálenost bodu od začátku lomené čáry spoje (m) podél trasy. */
export function progressAlong(poly, lat, lng) {
  if (poly.pts.length < 2) return null;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let bestD = Infinity, bestPos = 0;
  for (let i = 0; i < poly.pts.length - 1; i++) {
    const ax = (poly.pts[i][1] - lng) * M_PER_DEG_LNG * cosLat, ay = (poly.pts[i][0] - lat) * M_PER_DEG_LAT;
    const dx = (poly.pts[i + 1][1] - lng) * M_PER_DEG_LNG * cosLat - ax, dy = (poly.pts[i + 1][0] - lat) * M_PER_DEG_LAT - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < bestD) { bestD = d; bestPos = poly.cum[i] + t * (poly.cum[i + 1] - poly.cum[i]); }
  }
  return { pos: bestPos, off: bestD };
}

export class LiveTracker {
  constructor(tt) {
    this.tt = tt;
    this.polys = new Map();
    this.byTrip = new Map(); // "cis:trip" nebo číslo vlaku → vozidlo (pro zpoždění ve výsledcích)
    this.vehicles = [];
    this.matchCache = new Map();   // uid → { at, line, tid } (párování podle polohy je dražší, drží se chvíli)
  }

  lineIndex() {
    if (!this._lineIndex) {
      this._lineIndex = new Map();
      const tt = this.tt;
      for (let tid = 1; tid < tt.trips.length; tid++) {
        const k = normLine(tt.trips[tid].line);
        (this._lineIndex.get(k) || this._lineIndex.set(k, []).get(k)).push(tid);
      }
    }
    return this._lineIndex;
  }

  /**
   * Spoj vozidla podle linky, polohy na úseku mezi zastávkami, času (po odečtení zpoždění), směru jízdy a cíle.
   * Pro zdroje bez čísla spoje (DPMÚL), jako TripLocator.matchByPosition v appce.
   */
  matchByPosition(v, now = pragueNow()) {
    const tt = this.tt;
    const ids = this.lineIndex().get(normLine(v.line));
    if (!ids) return null;
    const wanted = foldText(v.dest || '');
    const maxDist = 700;
    const k = Math.cos((v.lat * Math.PI) / 180) * M_PER_DEG_LNG;
    const px = v.lng * k, py = v.lat * M_PER_DEG_LAT;
    let best = null, bestScore = SCORE_LIMIT;
    for (let back = 0; back <= 1; back++) {
      const day = back ? addDays(now.day, -1) : now.day;
      const rel = now.sec + back * 86400 - (v.delay || 0) * 60;
      const active = tt.activeSvcs(day);
      for (const tid of ids) {
        const t = tt.trips[tid];
        if (!active.has(t.svc) || rel < t.t0 - 900 || rel > t.t1 + 900) continue;
        let score = Infinity, legHeading = NaN, prev = -1;
        for (let j = 0; j < t.stops.length; j++) {
          const b = tt.stops[t.stops[j]];
          if (!b.hasCoords) continue;
          const i = prev; prev = j;
          if (i < 0) continue;
          const a = tt.stops[t.stops[i]];
          const ax = a.lng * k, ay = a.lat * M_PER_DEG_LAT;
          const dx = b.lng * k - ax, dy = b.lat * M_PER_DEG_LAT - ay;
          const len2 = dx * dx + dy * dy;
          const f = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          const d = Math.hypot(px - ax - dx * f, py - ay - dy * f);
          if (d > maxDist) continue;
          const tm = t.dep[i] + (t.arr[j] - t.dep[i]) * f;
          const cost = d + 0.5 * Math.abs(tm - rel);
          if (cost < score) { score = cost; legHeading = bearing(a.lat, a.lng, b.lat, b.lng); }
        }
        if (score === Infinity) continue;
        if (usableHeading(v.heading) && !Number.isNaN(legHeading) && angleDiff(v.heading, legHeading) > 90) continue;
        const h = foldText(t.head);
        if (wanted && h) { if (h.includes(wanted) || wanted.includes(h)) score -= 250; else continue; }
        if (score < bestScore) { bestScore = score; best = tid; }
      }
    }
    return best;
  }

  poly(tid) {
    let p = this.polys.get(tid);
    if (!p) { p = this.tt.tripPolyline(tid); this.polys.set(tid, p); }
    return p;
  }

  /** Najde spoj vozidla v jízdním řádu (přesně podle čísla, jinak podle polohy na lince). */
  matchTrip(v, now = pragueNow()) {
    const tt = this.tt;
    if (v._tid) return { tid: v._tid, exact: !!v._exact };
    const exact = v.train ? tt.findTrainTripId(v.cis) : tt.findTripId(v.cis, v.trip);
    if (exact) return { tid: exact, exact: true };
    const near = tt.nearestOnLine(v.line, v.lat, v.lng, now);
    return near ? { tid: near, exact: false } : null;
  }

  /**
   * Spáruje vůz s jízdním řádem (jako TripEnricher v Androidu): vlak podle čísla vlaku, autobus podle čísla spoje.
   * Linka ze spoje (S1, R22, U5…) nahradí surové označení zdroje ("Os 6805"); bez shody zůstane původní.
   */
  enrich(v) {
    const tt = this.tt;
    const tid = v.train ? tt.findTrainTripId(v.cis) : v.cis && v.cis !== '000000' && v.trip ? tt.findTripId(v.cis, v.trip) : null;
    if (!tid) {
      // vlak mimo oblast jízdního řádu webu: linka aspoň z tabulky čísel vlaků
      const line = v.train && tt.trainLines?.[String(v.cis ?? '').trim().replace(/^0+/, '')];
      if (line) v.line = line;
      return v;
    }
    const line = tt.trips[tid].line;
    if (line && line.trim() && line !== '?') v.line = line.trim();
    return v;
  }

  /** Přepočítá index zpoždění pro výsledky hledání (a doplní vozům linku z jízdního řádu). */
  update(vehicles) {
    this.byTrip.clear();
    this.vehicles = vehicles;
    for (const v of vehicles) this.enrich(v);
    // spoj vozidla (_tid): přesně podle čísla spoje / vlaku, jinak (DPMÚL) podle polohy v oblasti jízdního řádu webu
    const tt = this.tt, now = pragueNow(), nowMs = Date.now();
    for (const v of vehicles) {
      v._tid = null; v._exact = false;
      const exact = v.train ? tt.findTrainTripId(v.cis) : v.cis && v.cis !== '000000' && v.trip ? tt.findTripId(v.cis, v.trip) : null;
      if (exact) { v._tid = exact; v._exact = true; continue; }
      if (v.train || v.lat < REGION.s || v.lat > REGION.n || v.lng < REGION.w || v.lng > REGION.e) continue;
      const key = [v.line, v.lat.toFixed(3), v.lng.toFixed(3), Math.round(v.delay || 0), foldText(v.dest || ''), usableHeading(v.heading) ? v.heading : null].join('|');
      const c = this.matchCache.get(v.uid);
      if (c && c.key === key && nowMs - c.at < MATCH_TTL_MS) { v._tid = c.tid; continue; }
      v._tid = this.matchByPosition(v, now);
      this.matchCache.set(v.uid, { at: nowMs, key, tid: v._tid });
    }
    if (this.matchCache.size > 3000) this.matchCache.clear();
    for (const v of vehicles) {
      if (v.train) { if (v.cis) this.byTrip.set(`train:${v.cis.replace(/^0+/, '')}`, v); }
      else if (v.cis !== '000000' && v.trip) this.byTrip.set(`${v.cis}:${v.trip}`, v);
    }
  }

  /**
   * Živé vozidlo pro spoj z výsledků hledání (tlačítko Mapa), jako findVehicle v appce:
   * 1) vozy spárované s prvním spojem cesty (přesně nebo podle polohy), z nich ten nejvěrohodnější,
   * 2) když odjezd není v minulosti a je do 30 min: nejbližší vůz stejné linky před nástupní zastávkou správným směrem.
   * @returns {{ v: object, approximate: boolean } | null}
   */
  vehicleForJourney(d, now = pragueNow()) {
    const tt = this.tt;
    const ride = d.rides?.[0];
    if (!ride) return null;
    const t = tt.trips[ride.tid];
    const depIn = ride.dep + dayDiff(now.day, d.day) * 86400 - now.sec;   // s do odjezdu z nástupní zastávky
    const live = this.vehicles.filter((v) => v.state !== 255);
    const poly = this.poly(ride.tid);
    const boardI = poly.idx.indexOf(t.stops.indexOf(ride.from));
    const boardPos = boardI >= 0 ? poly.cum[boardI] : null;
    const key = t.isTrain ? `train:${t.num}` : t.cis ? `${t.cis}:${t.num}` : null;

    // 1) vozy tohoto spoje
    const cands = live.filter((v) => v._tid === ride.tid || (key && (v.train ? `train:${String(v.cis).replace(/^0+/, '')}` : `${v.cis}:${v.trip}`) === key));
    let best = null, bestScore = Infinity;
    for (const v of cands) {
      let score = v._exact ? 0 : 500;
      score += Math.min(v.ageSec || 0, 600) / 2;
      const pr = progressAlong(poly, v.lat, v.lng);
      if (pr) {
        score += Math.min(pr.off, 2000);
        // vůz, který měl podle odjezdu (+ zpoždění) dávno odjet, ale stojí pořád před nástupní zastávkou (točna)
        const shouldHaveLeft = -depIn - Math.max(v.delay || 0, 0) * 60 > 120;
        if (boardPos != null && shouldHaveLeft && boardPos - pr.pos > 200) score += IMPLAUSIBLE;
      }
      if (score < bestScore) { bestScore = score; best = v; }
    }
    if (best && bestScore < IMPLAUSIBLE) return { v: best, approximate: false };

    // 2) odhad: jen pro odjezd v nejbližších 30 min (minulé ani vzdálené nemá smysl tipovat)
    if (depIn < 0 || depIn > 30 * 60 || boardPos == null || poly.pts.length < 2) return null;
    const wanted = foldText(t.head);
    let near = null, nearGap = Infinity;
    for (const v of live) {
      if (normLine(v.line) !== normLine(t.line)) continue;
      const pr = progressAlong(poly, v.lat, v.lng);
      if (!pr || pr.off > MAX_ROUTE_OFF_M || pr.pos > boardPos) continue;
      const vd = foldText(v.dest || '');
      if (wanted && vd && !wanted.includes(vd) && !vd.includes(wanted)) continue;
      if (v.heading) {
        const k = poly.cum.findIndex((c) => c >= pr.pos);
        const i0 = Math.max(0, (k < 0 ? poly.pts.length - 1 : k) - 1), i1 = Math.min(poly.pts.length - 1, i0 + 1);
        if (i1 > i0 && angleDiff(bearing(poly.pts[i0][0], poly.pts[i0][1], poly.pts[i1][0], poly.pts[i1][1]), v.heading) > MAX_HEADING_DIFF) continue;
      }
      const gap = boardPos - pr.pos;
      if (gap <= MAX_APPROACH_M && gap < nearGap) { nearGap = gap; near = v; }
    }
    return near ? { v: near, approximate: true } : null;
  }

  /** Živé vozidlo, které jede daný spoj (nebo undefined). */
  forTrip(tid) {
    const t = this.tt.trips[tid];
    return t.isTrain ? this.byTrip.get(`train:${t.num}`) : t.cis ? this.byTrip.get(`${t.cis}:${t.num}`) : undefined;
  }

  /**
   * Podrobnosti ze serverového dohledání (vozidla mimo oblast jízdního řádu webu, např. Praha).
   * r = { line, head, agency, isTrain, stops: [[název, lat, lng, příjezd, odjezd]], route: [[lat, lng]] | null }
   */
  detailFromRemote(v, r) {
    const stops = r.stops.map(([name, lat, lng, arr, dep], i) => ({ id: i, name: prettyName(name), lat, lng, arr, dep, has: !!(lat || lng) }));
    const pts = [], idx = [];
    stops.forEach((s, i) => { if (s.has) { pts.push([s.lat, s.lng]); idx.push(i); } });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distanceM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    const poly = { pts, idx, cum };
    const pr = progressAlong(poly, v.lat, v.lng);
    let nextIdx = null;
    if (pr && pr.off < 1500) {
      const k = cum.findIndex((c) => c >= pr.pos - 40);
      nextIdx = idx[k < 0 ? idx.length - 1 : k];
    }
    return {
      trip: { line: r.line, head: r.head, agency: r.agency, isTrain: r.isTrain, remote: true },
      tid: null, exact: false,
      terminal: stops.length ? stops[stops.length - 1].name : null,
      next: nextIdx != null ? stops[nextIdx].name : null,
      route: pts, shape: r.route && r.route.length >= 2 ? r.route : null,
      stops, nextIdx,
    };
  }

  /** Podrobnosti o vozidle: spoj, příští a konečná zastávka, zbývající zastávky. */
  detail(v) {
    const m = this.matchTrip(v);
    if (!m) return { trip: null };
    const tt = this.tt, t = tt.trips[m.tid];
    const name = (sid) => prettyName(tt.stops[sid].name);
    const poly = this.poly(m.tid);
    const pr = progressAlong(poly, v.lat, v.lng);
    let nextIdx = null;
    if (pr && pr.off < 600) {
      const k = poly.cum.findIndex((c) => c >= pr.pos - 40);
      nextIdx = poly.idx[k < 0 ? poly.idx.length - 1 : k];
    }
    return {
      trip: t, tid: m.tid, exact: m.exact,
      terminal: name(t.stops[t.stops.length - 1]),
      next: nextIdx != null ? name(t.stops[nextIdx]) : null,
      route: poly.pts,
      stops: Array.from(t.stops, (sid, i) => ({ id: sid, name: name(sid), lat: tt.stops[sid].lat, lng: tt.stops[sid].lng, arr: t.arr[i], dep: t.dep[i], has: tt.stops[sid].hasCoords })),
      nextIdx,
    };
  }
}

export { distanceM };
