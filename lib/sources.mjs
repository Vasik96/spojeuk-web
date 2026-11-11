// Zdroje živých poloh. Port PortaboSource.kt (DÚK), DpmulSource.kt a SpravaZeleznicSource.kt.
//   DÚK    vlastní server (SERVER/duk/traffic), neposílá se přímo na Portabo
//   DPMÚL  vlastní server (SERVER/dpmul/traffic); přímé API jen když je nastaven DPMUL_API_KEY
//   SŽ     přímo z mapy Správy železnic (přísná pravidla, viz SzSource)
import https from 'node:https';
import { Feed, httpFetcher } from './feed.mjs';
import { baseVehicleId } from './fusion.mjs';

export const SERVER_BASE = 'http://37.46.211.70:8787';
export const SZ_URL = 'https://mapy.spravazeleznic.cz/serverside/request2.php?module=Layers%5COsVlaky&action=load';
export const DPMUL_DIRECT_URL = 'https://dpmxmobappbe.globdata.cz/api/v1/public/Common/skeleton/actual-vehicles';
const DPMUL_AGENCY = 'Dopravní podnik města Ústí nad Labem';
const DPMUL_KEYWORDS = ['dopravni podnik mesta usti', 'dpmul'];
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Společná část: čerstvost dat a "držení" poslední odpovědi při krátkém výpadku. */
class BaseSource {
  constructor({ id, name, priority, segments, maxFetchAgeS, staleVehicleSec, now = () => Date.now() }) {
    Object.assign(this, { id, name, priority, segments: new Set(segments), maxFetchAgeS, staleVehicleSec, now });
    this.list = []; this.listTs = 0; this.lastOk = 0; this.failures = 0; this.lastError = '';
  }
  health(t = this.now()) {
    if (!this.lastOk) return 'down';
    return (t - this.lastOk) / 1000 <= this.maxFetchAgeS ? 'live' : 'stale';
  }
  report(vehicles) {
    return { id: this.id, name: this.name, priority: this.priority, segments: this.segments, staleVehicleSec: this.staleVehicleSec, health: this.health(), vehicles, held: this.held?.() ?? 0, failures: this.failures, lastError: this.lastError };
  }
}

// ───────────── DÚK ─────────────

const segmentOfDuk = (v) => (v.train ? 'regional' : v.city || DPMUL_KEYWORDS.some((k) => fold(v.agency).includes(k)) ? 'city' : 'regional');

export class DukSource extends BaseSource {
  constructor({ fetchRaw, pollMs = 10_000, now, feedOpts = {} }) {
    super({ id: 'duk', name: 'DÚK', priority: 1, segments: ['city', 'regional'], maxFetchAgeS: 30, staleVehicleSec: 40, now });
    this.pollMs = pollMs;
    this.feed = new Feed({ fetchRaw, pollMs, now: this.now, ...feedOpts });
  }
  start() { this.feed.start(); }
  stop() { this.feed.stop(); }
  pollOnce() { return this.feed.poll(); }
  held() { return this._held || 0; }
  snapshot() {
    const s = this.feed.snapshot();
    this._held = s.held;
    this.lastOk = this.feed.status.lastOk; this.failures = this.feed.status.failures; this.lastError = this.feed.status.lastError;
    this.outage = s.outage;
    return this.report(s.vehicles.map((v) => ({ ...v, source: 'duk', segment: segmentOfDuk(v), heading: null })));
  }
}

// ───────────── DPMÚL ─────────────

const DELAY_RE = /^(-?)(\d{1,2}):(\d{2}):(\d{2})$/;
export function parseDelayMinutes(s) {
  s = String(s ?? '').trim();
  if (!s) return 0;
  const m = DELAY_RE.exec(s);
  if (m) { const total = +m[2] * 3600 + +m[3] * 60 + +m[4]; return Math.round((m[1] === '-' ? -total : total) / 60); }
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** "2026-11-10T22:15:03" (místní čas bez zóny) → ms. */
export function parsePragueLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offsetAt = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
  };
  let ms = asUtc - offsetAt(asUtc);
  ms = asUtc - offsetAt(ms);
  return ms;
}

const bearing = (la1, lo1, la2, lo2) => {
  const f1 = (la1 * Math.PI) / 180, f2 = (la2 * Math.PI) / 180, dl = ((lo2 - lo1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};
const dist = (la1, lo1, la2, lo2) => Math.hypot((la2 - la1) * 110540, (lo2 - lo1) * 111320 * Math.cos((la1 * Math.PI) / 180));

/** Odpověď DPMÚL (pole objektů) → vozidla. `stations` = naučené polohy stanic (stationNumber → [lat, lng]). */
export function parseDpmul(body, nowMs, stations = new Map()) {
  const arr = Array.isArray(body) ? body : [];
  const out = [];
  for (const o of arr) {
    if (!o || o.latitude == null || o.longitude == null) continue;
    const lat = Number(o.latitude), lng = Number(o.longitude);
    if (!(lat >= 48 && lat <= 52 && lng >= 12 && lng <= 19)) continue;
    let observed = o.lastActivity ? Date.parse(o.lastActivity) : NaN;
    if (!Number.isFinite(observed)) observed = parsePragueLocal(o.gpsTimestamp) ?? NaN;
    const hasTs = Number.isFinite(observed);
    if (hasTs && nowMs - observed > 10 * 60_000) continue;
    const station = Number(o.stationNumber) || 0;
    const atStop = !!(o.arrivedAt || o.stoppedAt);
    let heading = null;
    if (atStop) { if (station) stations.set(station, [lat, lng]); }
    else {
      const st = stations.get(station);
      if (st && dist(lat, lng, st[0], st[1]) > 30) {
        if (o.inTransitTo || o.incomingAt) heading = bearing(lat, lng, st[0], st[1]);
        else if (o.leftAt) heading = bearing(st[0], st[1], lat, lng);
      }
    }
    let line = String(o.lineName ?? '?').trim() || '?';
    if (line === '200') line = 'X';
    const b = (k) => (o[k] == null ? null : !!o[k]);
    out.push({
      source: 'dpmul', segment: 'city', id: Number(o.vehicleNumber) || 0, lat, lng, line,
      delay: parseDelayMinutes(o.delay), ageSec: hasTs ? Math.max(0, Math.floor((nowMs - observed) / 1000)) : 0,
      state: 0, train: false, cis: '', trip: '', agency: DPMUL_AGENCY, dest: '',
      low: b('isWheelchairAccessible'), ac: b('isAirConditioned'), heading, city: true,
    });
  }
  return out;
}

export class DpmulSource extends BaseSource {
  constructor({ serverUrl, directUrl = DPMUL_DIRECT_URL, apiKey = '', pollMs = 5000, now, fetchImpl = fetch }) {
    super({ id: 'dpmul', name: 'DPMÚL', priority: 0, segments: ['city'], maxFetchAgeS: 60, staleVehicleSec: 90, now });
    Object.assign(this, { serverUrl, directUrl, apiKey, pollMs, fetchImpl });
    this.stations = new Map(); this.timer = null;
  }
  async _fromServer() {
    const res = await this.fetchImpl(this.serverUrl, { headers: { 'user-agent': 'spojeuk-web/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const age = Number(res.headers.get('x-age-sec'));
    const list = parseDpmul(body, this.now(), this.stations);
    // server po 120 s starou odpověď nevrací (posílá []), -1 = ještě žádná: tehdy nemá použitelná data
    if (!list.length && (!Number.isFinite(age) || age < 0 || age > 60)) return null;
    return list;
  }
  async _direct() {
    const res = await this.fetchImpl(this.directUrl, {
      method: 'POST', body: '', signal: AbortSignal.timeout(50_000),
      headers: { 'user-agent': 'Dart/3.12 (dart:io)', accept: 'application/json', 'content-type': 'application/json; charset=utf-8', 'x-app-env': 'prod', 'x-app-version': '2.0.14', 'dpmxbe-api-key': this.apiKey },
    });
    if (!res.ok) throw new Error(`DPMÚL HTTP ${res.status}`);
    return parseDpmul(await res.json(), this.now(), this.stations);
  }
  async poll() {
    try {
      let list = null;
      if (this.serverUrl) { try { list = await this._fromServer(); } catch (e) { this.lastError = String(e.message || e); } }
      if (!list && this.apiKey) list = await this._direct();
      if (!list) throw new Error(this.lastError || 'DPMÚL: žádná použitelná data');
      this.list = list; this.listTs = this.now(); this.lastOk = this.listTs; this.failures = 0; this.lastError = '';
    } catch (e) { this.failures++; this.lastError = String(e.message || e); }
  }
  snapshot() {
    const t = this.now();
    // při výpadku se poslední odpověď drží nejvýš 60 s (stáří poloh roste)
    const heldS = Math.floor((t - this.listTs) / 1000);
    const vehicles = this.listTs && heldS <= 60 ? this.list.map((v) => ({ ...v, ageSec: v.ageSec + heldS })) : [];
    return this.report(vehicles);
  }
  pollOnce() { return this.poll(); }
  start() { const loop = async () => { await this.poll(); this.timer = setTimeout(loop, this.pollMs); this.timer.unref?.(); }; loop(); }
  stop() { clearTimeout(this.timer); }
}

// ───────────── Správa železnic ─────────────

/** S-JTSK / Krovak East North (EPSG:5514) → [lat, lng] WGS84, nebo null. */
export function sjtskToWgs84(east, north) {
  const A = 6377397.155, F = 1 / 299.1528128, E2 = 2 * F - F * F, E = Math.sqrt(E2);
  const PHI_C = (49.5 * Math.PI) / 180, LAMBDA_0 = ((24 + 50 / 60) * Math.PI) / 180;
  const ALPHA_C = ((30 + 17 / 60 + 17.3031 / 3600) * Math.PI) / 180, PHI_P = (78.5 * Math.PI) / 180, K_P = 0.9999;
  const A_ = (A * Math.sqrt(1 - E2)) / (1 - E2 * Math.sin(PHI_C) ** 2);
  const B = Math.sqrt(1 + (E2 * Math.cos(PHI_C) ** 4) / (1 - E2));
  const GAMMA_0 = Math.asin(Math.sin(PHI_C) / B);
  const T0 = (Math.tan(Math.PI / 4 + GAMMA_0 / 2) * ((1 + E * Math.sin(PHI_C)) / (1 - E * Math.sin(PHI_C))) ** ((E * B) / 2)) / Math.tan(Math.PI / 4 + PHI_C / 2) ** B;
  const N = Math.sin(PHI_P), R0 = (K_P * A_) / Math.tan(PHI_P);
  if (Number.isNaN(east) || Number.isNaN(north) || (east === 0 && north === 0)) return null;
  const xp = -north, yp = -east, r = Math.hypot(xp, yp);
  if (r === 0) return null;
  const d = Math.atan2(yp, xp) / N;
  const s = 2 * (Math.atan((R0 / r) ** (1 / N) * Math.tan(Math.PI / 4 + PHI_P / 2)) - Math.PI / 4);
  const u = Math.asin(Math.cos(ALPHA_C) * Math.sin(s) - Math.sin(ALPHA_C) * Math.cos(s) * Math.cos(d));
  const v = Math.asin((Math.cos(s) * Math.sin(d)) / Math.cos(u));
  let phi = u;
  for (let i = 0; i < 8; i++) phi = 2 * (Math.atan(T0 ** (-1 / B) * Math.tan(u / 2 + Math.PI / 4) ** (1 / B) * ((1 + E * Math.sin(phi)) / (1 - E * Math.sin(phi))) ** (E / 2)) - Math.PI / 4);
  const lam = LAMBDA_0 - v / B;
  // Helmert (position vector), EPSG:15992 S-JTSK → WGS84
  const n = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const x = n * Math.cos(phi) * Math.cos(lam), y = n * Math.cos(phi) * Math.sin(lam), z = n * (1 - E2) * Math.sin(phi);
  const sec = Math.PI / 648000, rx = 4.998 * sec, ry = 1.587 * sec, rz = 5.261 * sec, ds = 1 + 3.56e-6;
  const x2 = 570.8 + ds * (x - rz * y + ry * z), y2 = 85.7 + ds * (rz * x + y - rx * z), z2 = 462.8 + ds * (-ry * x + rx * y + z);
  const a2 = 6378137.0, e2 = 0.00669437999014, p = Math.hypot(x2, y2);
  let la = Math.atan2(z2, p * (1 - e2));
  for (let i = 0; i < 6; i++) { const nn = a2 / Math.sqrt(1 - e2 * Math.sin(la) ** 2); la = Math.atan2(z2 + e2 * nn * Math.sin(la), p); }
  const lat = (la * 180) / Math.PI, lng = (Math.atan2(y2, x2) * 180) / Math.PI;
  return lat >= 47 && lat <= 52 && lng >= 11 && lng <= 20 ? [lat, lng] : null; // mimo ČR = chybná data
}

/** Jen Ústecký kraj, Praha a okolí: stejný rámec jako inUsteckyKraj() v MapScreen.kt (lat 49,90–51,10; lng 12,80–14,80). */
export const SZ_BOX = { latMin: 49.90, latMax: 51.10, lngMin: 12.80, lngMax: 14.80 };
export const inSzBox = (lat, lng) => lat >= SZ_BOX.latMin && lat <= SZ_BOX.latMax && lng >= SZ_BOX.lngMin && lng <= SZ_BOX.lngMax;

export function parseSz(data, i0 = 0) {
  const out = [];
  (data?.result || []).forEach((f, i) => {
    const p = f?.properties;
    if (!p || p.type !== 'V') return; // jen vlaky
    const c = f.geometry?.coordinates;
    if (!c || c.length < 2) return;
    const pos = sjtskToWgs84(Number(c[0]), Number(c[1]));
    if (!pos || !inSzBox(pos[0], pos[1])) return;
    const cat = String(p.tt ?? '').trim(), num = String(p.tn ?? '').trim();
    out.push({
      source: 'train', segment: 'regional', train: true, id: parseInt(num, 10) || i + 1 + i0,
      lat: pos[0], lng: pos[1], line: cat ? `${cat} ${num}` : num,
      delay: Math.trunc(Number(p.de) || 0), ageSec: 0, state: 0,
      cis: num, trip: String(p.id ?? ''), agency: String(p.d ?? ''), dest: String(p.ln ?? '').trim(),
      low: null, ac: null, heading: null, city: false,
    });
  });
  return out;
}

/**
 * SŽ banuje IP adresy, které na ně pouštějí služby. Proto: žádný User-Agent, min. 10 s mezi požadavky,
 * max. 1 souběžný, a 403 = dlouhá pauza s exponenciálním zpožděním (10 min → max 60 min).
 */
export class SzSource extends BaseSource {
  constructor({ url = SZ_URL, now, request = szRequest }) {
    super({ id: 'train', name: 'Správa železnic', priority: 2, segments: ['regional'], maxFetchAgeS: 40, staleVehicleSec: 40, now });
    Object.assign(this, { url, request });
    this.pollMs = 10_500;
    this.blockedUntil = 0; this.blockedCount = 0; this.lastRequest = 0; this.busy = false; this.timer = null;
  }
  async poll() {
    const t = this.now();
    if (this.busy || t < this.blockedUntil || t - this.lastRequest < 10_000) return;
    this.busy = true; this.lastRequest = t;
    try {
      const { status, body } = await this.request(this.url);
      if (status === 403) {
        const pause = Math.min(10 * 60_000 * 2 ** Math.min(this.blockedCount, 3), 60 * 60_000);
        this.blockedCount++; this.blockedUntil = t + pause;
        throw new Error(`SŽ vrátila 403, pauza ${pause / 1000} s`);
      }
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
      this.list = parseSz(JSON.parse(body)); this.listTs = t; this.lastOk = t; this.blockedCount = 0; this.failures = 0; this.lastError = '';
    } catch (e) { this.failures++; this.lastError = String(e.message || e); }
    finally { this.busy = false; }
  }
  snapshot() {
    const t = this.now(), heldS = Math.floor((t - this.listTs) / 1000);
    // při pauze/výpadku se poslední data drží jen 2 minuty
    const vehicles = this.listTs && heldS <= 120 ? this.list.map((v) => ({ ...v, ageSec: heldS })) : [];
    return this.report(vehicles);
  }
  pollOnce() { return this.poll(); }
  start() { const loop = async () => { await this.poll(); this.timer = setTimeout(loop, this.pollMs); this.timer.unref?.(); }; loop(); }
  stop() { clearTimeout(this.timer); }
}

/** HTTPS GET bez hlavičky User-Agent (node:https ji nepřidává, na rozdíl od fetch). */
function szRequest(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'application/json' }, timeout: 10_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ───────────── sestavení ze serveru ─────────────

/** Soubor nastavení z prostředí → seznam zdrojů. */
export function createSources(env, { mockFetcher } = {}) {
  const base = (env.SERVER_BASE || SERVER_BASE).replace(/\/$/, '');
  const feedOpts = { holdMhdS: Number(env.HOLD_MHD_S || 300), holdOtherS: Number(env.HOLD_OTHER_S || 180) };
  const pollMs = Number(env.POLL_S || 10) * 1000;
  if (mockFetcher) return [new DukSource({ fetchRaw: mockFetcher, pollMs, feedOpts })];
  // Portabo se přímo nevolá; DUK_URL / FEED_URL přepíšou vlastní server, PORTABO_DIRECT=1 ho přidá jako zálohu
  const urls = [env.DUK_URL || env.FEED_URL || `${base}/duk/traffic`];
  if (env.PORTABO_DIRECT === '1') urls.push('https://tabule.portabo.cz/api/v1-tabule/cis/GetTraffic/0');
  const sources = [
    new DpmulSource({ serverUrl: env.DPMUL_URL || `${base}/dpmul/traffic`, apiKey: env.DPMUL_API_KEY || '', pollMs: Number(env.DPMUL_POLL_S || 5) * 1000 }),
    new DukSource({ fetchRaw: httpFetcher(urls), pollMs, feedOpts }),
  ];
  if (env.SZ !== '0') sources.push(new SzSource({}));
  return sources;
}
export { baseVehicleId };
