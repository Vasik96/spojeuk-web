// timetable.json pro prohlížeč z hotové celostátní databáze (timetable.sqlite z releasu spojeuk-data,
// stejná jako v Android appce, včetně spárovaných nádraží).
//
// Dřív se parsovaly celostátní GTFS zipy (stop_times přes 500 MB rozbalené v paměti + stovky tisíc spojů na haldě):
// na 1GB VPS sestavení padalo na nedostatek paměti. Tady se spoje čtou z SQLite po řádcích a v paměti zůstává
// jen výběr pro oblast (~14 tis. spojů), takže stačí pár desítek MB.
import { BBOX, RAIL_BBOX } from './build-timetable.mjs';

const inBox = (lat, lon, b) => lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1];
const toInts = (blob) => {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Int32Array(blob.byteLength >> 2);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt32(i * 4, true);
  return out;
};

/**
 * @param {string} dbFile cesta k timetable.sqlite
 * @returns stejný objekt jako buildTimetable (v, meta, agencies, stops, trips, svcs, svcDates, trainLines)
 */
export async function buildTimetableFromDb(dbFile, { tag = '', log = () => {} } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const maxStop = db.prepare('SELECT max(id) m FROM stop').get().m || 0;
    const slat = new Float64Array(maxStop + 1), slon = new Float64Array(maxStop + 1);
    for (const r of db.prepare('SELECT id, lat, lon FROM stop').iterate()) { slat[r.id] = r.lat || 0; slon[r.id] = r.lon || 0; }
    const has = (s) => slat[s] !== 0 || slon[s] !== 0;

    const stopCode = new Map();   // id v DB → id v JSON (od 1, v pořadí prvního použití)
    const stopOrder = [];
    const agencies = [], agencyIdx = new Map();
    const svcIdx = new Map();     // svc v DB → index v JSON
    const trips = [];
    const trainLines = {};
    let scanned = 0;

    log('Vybírám spoje oblasti z celostátního jízdního řádu…');
    const q = db.prepare(`SELECT t.id, t.line, t.agency, t.cis, t.num, t.head, t.svc, t.wheel, t.t0, t.t1, t.gid,
      tt.stops, tt.arr, tt.dep FROM trip t JOIN trip_times tt ON tt.trip = t.id ORDER BY t.id`);
    for (const r of q.iterate()) {
      scanned++;
      const gid = r.gid || '';
      const isTrain = gid.startsWith('czptt:');
      const line = r.line && r.line.trim() ? r.line : '?';
      if (isTrain && r.num) { const n = String(r.num).replace(/^0+/, ''); if (n && line !== '?' && !(n in trainLines)) trainLines[n] = line; }
      const stops = toInts(r.stops);
      if (stops.length < 2) continue;
      const box = isTrain ? RAIL_BBOX : BBOX;
      let inRegion = false;
      for (const s of stops) if (has(s) && inBox(slat[s], slon[s], box)) { inRegion = true; break; }
      if (!inRegion) continue;

      const arr = toInts(r.arr), dep = toInts(r.dep);
      const ids = [], times = [];
      let prevDep = 0, arr0 = 0;
      for (let i = 0; i < stops.length; i++) {
        const a = arr[i] >= 0 ? arr[i] : dep[i];
        const d = dep[i] >= 0 ? dep[i] : arr[i];
        let id = stopCode.get(stops[i]);
        if (!id) { stopOrder.push(stops[i]); id = stopOrder.length; stopCode.set(stops[i], id); }
        ids.push(id);
        // [odjezd0-příjezd0, příjezd1-odjezd0, odjezd1-příjezd1, …] (stejně jako build-timetable.mjs)
        if (i === 0) arr0 = a; else times.push(a - prevDep);
        times.push(d - a);
        prevDep = d;
      }
      const agency = r.agency || '';
      let ai = agencyIdx.get(agency);
      if (ai === undefined) { ai = agencies.length; agencies.push(agency); agencyIdx.set(agency, ai); }
      let si = svcIdx.get(r.svc);
      if (si === undefined) { si = svcIdx.size; svcIdx.set(r.svc, si); }
      trips.push([line, ai, r.cis || '', r.num || '', r.head || '', si, r.wheel || 0, isTrain ? 1 : 0, arr0, ids, times, r.t0, r.t1, gid]);
    }
    log(`Spojů v oblasti: ${trips.length} z ${scanned}`);

    const svcs = new Array(svcIdx.size);
    for (const r of db.prepare('SELECT id, dow, d0, d1 FROM svc').iterate()) {
      const si = svcIdx.get(r.id);
      if (si !== undefined) svcs[si] = [r.dow || '0000000', r.d0 || '0', r.d1 || '0'];
    }
    for (let i = 0; i < svcs.length; i++) svcs[i] ||= ['0000000', '0', '0']; // služba jen z výjimek
    const svcDates = {};
    for (const r of db.prepare('SELECT svc, d, type FROM svc_date').iterate()) {
      const si = svcIdx.get(r.svc);
      if (si !== undefined) (svcDates[r.d] ||= []).push([si, r.type]);
    }

    const qStop = db.prepare('SELECT name, place FROM stop WHERE id = ?');
    const stops = stopOrder.map((s) => {
      const r = qStop.get(s) || {};
      const lat = slat[s], lon = slon[s];
      // jako dřívější sestavení z GTFS: oblast = širší výřez vlaků (obsahuje i výřez autobusů)
      const inreg = has(s) && (inBox(lat, lon, BBOX) || inBox(lat, lon, RAIL_BBOX));
      return [r.name || '', r.place || r.name || '', +lat.toFixed(5), +lon.toFixed(5), inreg ? 1 : 0];
    });

    return {
      v: 1,
      meta: { tag, built: new Date().toISOString(), trips: trips.length, stops: stops.length },
      agencies, stops, trips, svcs, svcDates, trainLines,
    };
  } finally {
    db.close();
  }
}
