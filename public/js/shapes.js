// Přesné trasy spojů (GTFS shapes). Port ShapeStore/ShapeGeometry z Android appky.
// shapes.bin se stáhne líně při prvním zobrazení trasy, tvary se rozbalují až podle potřeby.
const M_LAT = 110540.0;
const M_LNG = 111320.0;
export const MAX_OFF_M = 120;

/** zlib( varint(počet) + zigzag-varint delty lat/lng v 1e-6 ° ) → [[lat, lng], …] */
export function decodeShape(raw) {
  let p = 0;
  const varint = () => {
    let r = 0, mul = 1;
    for (;;) {
      const b = raw[p++];
      r += (b & 0x7f) * mul;
      if (!(b & 0x80)) return r;
      mul *= 128;
    }
  };
  const zig = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
  const n = varint();
  const out = new Array(n);
  let la = 0, lo = 0;
  for (let i = 0; i < n; i++) { la += zig(varint()); lo += zig(varint()); out[i] = [la / 1e6, lo / 1e6]; }
  return out;
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const res = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await res.arrayBuffer());
}

export class ShapeStore {
  constructor(url) { this.url = url; this._pack = null; this._cache = new Map(); }

  async _load() {
    if (!this._pack) {
      this._pack = (async () => {
        const res = await fetch(this.url);
        if (!res.ok) throw new Error(`shapes.bin HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const dv = new DataView(buf);
        const n = dv.getUint32(0, true);
        const base = 4 + n * 4;
        const ends = new Uint32Array(n);
        for (let i = 0; i < n; i++) ends[i] = dv.getUint32(4 + i * 4, true);
        return { buf, base, ends };
      })();
      this._pack.catch(() => { this._pack = null; }); // příští pokus to zkusí znovu
    }
    return this._pack;
  }

  /** Body tvaru (číslo shp z timetable, 1…) nebo null. */
  async points(shp) {
    if (!shp) return null;
    if (this._cache.has(shp)) return this._cache.get(shp);
    try {
      const { buf, base, ends } = await this._load();
      if (shp > ends.length) return null;
      const a = shp === 1 ? 0 : ends[shp - 2];
      const pts = decodeShape(await inflate(new Uint8Array(buf, base + a, ends[shp - 1] - a)));
      const val = pts.length >= 2 ? pts : null;
      this._cache.set(shp, val);
      return val;
    } catch { return null; }
  }
}

// ───────── geometrie ─────────

export class Path {
  constructor(pts) {
    this.pts = pts;
    const lat0 = pts[0][0], lng0 = pts[0][1];
    this.lat0 = lat0; this.lng0 = lng0;
    this.cosLat = Math.cos((lat0 * Math.PI) / 180);
    this.x = pts.map((p) => (p[1] - lng0) * M_LNG * this.cosLat);
    this.y = pts.map((p) => (p[0] - lat0) * M_LAT);
    this.cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]);
  }
  get length() { return this.cum[this.cum.length - 1]; }

  /** Pro každou skupinu blízkých segmentů: [pozice na trase v m, odchylka v m]. */
  candidates(lat, lng, maxOff = MAX_OFF_M) {
    const px = (lng - this.lng0) * M_LNG * this.cosLat, py = (lat - this.lat0) * M_LAT;
    const out = [];
    let bestD = Infinity, bestS = 0, inGroup = false;
    const { x, y, cum } = this;
    for (let i = 0; i < x.length - 1; i++) {
      const dx = x[i + 1] - x[i], dy = y[i + 1] - y[i], l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - x[i]) * dx + (py - y[i]) * dy) / l2));
      const d = Math.hypot(px - (x[i] + t * dx), py - (y[i] + t * dy));
      if (d <= maxOff) {
        if (!inGroup || d < bestD) { bestD = d; bestS = cum[i] + t * (cum[i + 1] - cum[i]); }
        inGroup = true;
      } else if (inGroup) { out.push([bestS, bestD]); inGroup = false; bestD = Infinity; }
    }
    if (inGroup) out.push([bestS, bestD]);
    return out;
  }

  pointAt(s) {
    if (s <= 0) return this.pts[0];
    if (s >= this.length) return this.pts[this.pts.length - 1];
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.cum[mid] <= s) lo = mid; else hi = mid; }
    const seg = this.cum[lo + 1] - this.cum[lo];
    const t = seg === 0 ? 0 : (s - this.cum[lo]) / seg;
    const a = this.pts[lo], b = this.pts[lo + 1];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }

  slice(from, to) {
    const a = Math.max(0, Math.min(from, to)), b = Math.min(this.length, Math.max(from, to));
    const out = [this.pointAt(a)];
    for (let i = 0; i < this.pts.length; i++) if (this.cum[i] > a && this.cum[i] < b) out.push(this.pts[i]);
    out.push(this.pointAt(b));
    return out;
  }
}

/**
 * Pozice zastávek na trase (m od začátku), neklesající s nejmenším součtem odchylek
 * (zvládne tam-a-zpět po téže silnici i smyčky). Zastávka mimo trasu dostane NaN.
 */
export function locateStops(path, stops) {
  const res = new Array(stops.length).fill(NaN);
  const layers = [];
  stops.forEach((s, i) => { const c = path.candidates(s[0], s[1]); if (c.length) layers.push([i, c]); });
  if (!layers.length) return res;
  const TOL = 30, BACK = 2000;
  const cost = [], from = [];
  layers.forEach(([, cands], li) => {
    const c = new Array(cands.length), f = new Array(cands.length);
    cands.forEach((cand, ci) => {
      if (li === 0) { c[ci] = cand[1]; f[ci] = -1; return; }
      const prev = layers[li - 1][1];
      let best = Infinity, bi = 0;
      prev.forEach((pc, pi) => {
        const back = pc[0] - cand[0];
        const step = cost[li - 1][pi] + (back <= TOL ? 0 : BACK + back);
        if (step < best) { best = step; bi = pi; }
      });
      c[ci] = best + cand[1]; f[ci] = bi;
    });
    cost.push(c); from.push(f);
  });
  const last = cost[cost.length - 1];
  let ci = last.indexOf(Math.min(...last));
  for (let li = layers.length - 1; li >= 0; li--) {
    res[layers[li][0]] = layers[li][1][ci][0];
    ci = from[li][ci];
    if (ci < 0) break;
  }
  return res;
}

/** Úsek trasy mezi zastávkami [board]..[alight] (indexy do pole `stops` = [lat,lng]) nebo null. */
export function sliceBetween(pts, stops, board, alight) {
  if (!pts || pts.length < 2 || board == null || alight == null || !stops[board] || !stops[alight]) return null;
  const path = new Path(pts);
  const pos = locateStops(path, stops);
  const a = pos[board], b = pos[alight];
  if (Number.isNaN(a) || Number.isNaN(b) || b + 30 < a) return null;
  return path.slice(a, b);
}

/** Celá trasa spoje (shape) nebo null. */
export async function tripShape(store, trip) { return store.points(trip.shp); }

/**
 * Trasa jedné jízdy: zastávky `stopIds` (podposloupnost spoje) po tvaru.
 * @param {import('./timetable.js').Timetable} tt
 */
export async function legRoute(store, tt, tid, stopIds) {
  const t = tt.trips[tid];
  const pts = await store.points(t.shp);
  if (!pts) return null;
  let board = -1;
  for (let i = 0; i + stopIds.length <= t.stops.length && board < 0; i++) {
    let ok = true;
    for (let k = 0; k < stopIds.length; k++) if (t.stops[i + k] !== stopIds[k]) { ok = false; break; }
    if (ok) board = i;
  }
  if (board < 0) return null;
  const idx = [], coords = [];
  t.stops.forEach((sid, i) => { const s = tt.stops[sid]; if (s.hasCoords) { idx.push(i); coords.push([s.lat, s.lng]); } });
  return sliceBetween(pts, coords, idx.indexOf(board), idx.indexOf(board + stopIds.length - 1));
}

// ───────── záloha: trasa po silnici z OSRM (jako OsrmClient v Android appce) ─────────
// Používá se, když spoj nemá v shapes.bin tvar (např. linka 80). Vlaky se po silnici nikdy nevedou.
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
const OSRM_MIN_GAP_M = 700, OSRM_CHUNK = 80;
const osrmMem = new Map();

function gapM(a, b) {
  return Math.hypot((a[0] - b[0]) * M_LAT, (a[1] - b[1]) * M_LNG * Math.cos((a[0] * Math.PI) / 180));
}

/** Trasa po silnici přes `stops` ([[lat,lng],…]); při jakékoli chybě vrátí null (volající nechá rovné čáry). */
export async function osrmRoute(stops) {
  if (!stops || stops.length < 2) return null;
  const way = [stops[0]];
  for (let i = 1; i < stops.length - 1; i++) if (gapM(way[way.length - 1], stops[i]) >= OSRM_MIN_GAP_M) way.push(stops[i]);
  way.push(stops[stops.length - 1]);
  if (way.length < 2) return null;
  const key = 'osrm:v2:' + way.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
  if (osrmMem.has(key)) return osrmMem.get(key);
  try { const c = localStorage.getItem(key); if (c) { const r = JSON.parse(c); osrmMem.set(key, r); return r; } } catch { /* bez cache */ }
  const job = (async () => {
    try {
      const out = [];
      for (let i = 0; i < way.length - 1; i += OSRM_CHUNK) {
        const chunk = way.slice(i, Math.min(way.length, i + OSRM_CHUNK + 1));
        const coords = chunk.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';');
        const rad = chunk.map(() => '30').join(';');
        const res = await fetch(`${OSRM_URL}${coords}?overview=full&geometries=geojson&continue_straight=false&radiuses=${rad}`);
        if (!res.ok) return null;
        const g = (await res.json()).routes?.[0]?.geometry?.coordinates;
        if (!g?.length) return null;
        for (const c of g) out.push([c[1], c[0]]);
      }
      if (out.length < 2) return null;
      try { localStorage.setItem(key, JSON.stringify(out)); } catch { /* plné úložiště */ }
      return out;
    } catch { return null; }
  })();
  osrmMem.set(key, job);
  const r = await job;
  osrmMem.set(key, r);
  if (!r) osrmMem.delete(key); // příště zkusit znovu
  return r;
}
