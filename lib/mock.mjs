// Vývojový zdroj poloh: z jízdního řádu spočítá, kde by právě měla být vozidla, a vrátí je ve tvaru /api/vehicles.
import fs from 'node:fs';
import { Timetable } from '../public/js/timetable.js';
import { pragueNow, addDays } from '../public/js/util.js';

export function mockSnapshot(timetableFile, { limit = 450 } = {}) {
  let tt = null;
  return async () => {
    tt ||= new Timetable(JSON.parse(fs.readFileSync(timetableFile, 'utf8')));
    const now = pragueNow();
    const byUid = new Map();
    for (let back = 0; back <= 1; back++) {
      const day = addDays(now.day, -back), rel = now.sec + back * 86400;
      const active = tt.activeSvcs(day);
      for (let tid = 1; tid < tt.trips.length && byUid.size < limit; tid++) {
        const t = tt.trips[tid];
        if (!active.has(t.svc) || rel < t.t0 || rel > t.t1) continue;
        let i = 0;
        while (i + 1 < t.stops.length && t.arr[i + 1] <= rel) i++;
        const a = tt.stops[t.stops[i]], b = tt.stops[t.stops[Math.min(i + 1, t.stops.length - 1)]];
        if (!a.hasCoords || !b.hasCoords) continue;
        const span = t.arr[Math.min(i + 1, t.stops.length - 1)] - t.dep[i];
        const f = span > 0 ? Math.min(1, Math.max(0, (rel - t.dep[i]) / span)) : 0;
        const city = tid % 3 === 0 && !t.isTrain;
        const id = t.isTrain ? 20000 + (tid % 9000) : (city ? 300000 : 100000) + tid;
        const uid = t.isTrain ? `t${String(t.num).trim().replace(/^0+/, '')}` : `v${city ? tid : id}`;
        if (byUid.has(uid)) continue;
        byUid.set(uid, {
          source: 'duk', segment: t.isTrain || !city ? 'regional' : 'city', id,
          lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f,
          line: t.line, delay: tid % 7 === 0 ? 4 + (tid % 5) : tid % 4 === 0 ? 1 : 0, ageSec: 0, state: 0,
          train: !!t.isTrain, cis: t.isTrain ? String(t.num) : String(t.cis ? parseInt(t.cis, 10) : 0).padStart(6, '0'),
          trip: t.isTrain ? '' : String(t.num), agency: t.agency || '', dest: tt.stops[t.stops[t.stops.length - 1]].name,
          low: t.wheel > 0 || tid % 2 === 0, ac: tid % 3 !== 1, heading: null, city,
          sources: ['duk'], ids: [`duk:${id}`], uid,
        });
      }
    }
    const vehicles = [...byUid.values()];
    return {
      time: Date.now(), vehicles, held: 0, outage: false, upstreamAgeSec: 0, pollSec: 10, source: 'DÚK (mock)',
      sources: [{ id: 'duk', name: 'DÚK (mock)', priority: 1, health: 'live', vehicles: vehicles.length, failures: 0, lastError: '' }],
    };
  };
}
