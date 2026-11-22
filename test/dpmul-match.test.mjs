import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Timetable } from '../public/js/timetable.js';
import { LiveTracker } from '../public/js/live.js';
import { pragueNow, addDays } from '../public/js/util.js';

const tt = new Timetable(JSON.parse(fs.readFileSync(new URL('../public/data/timetable.json', import.meta.url))));

// najde dnešní spoj DPMÚL a vrátí „now“ (pražský čas), kdy je vůz s daným zpožděním u zastávky i
function pickCase(delayMin) {
  const real = pragueNow();
  for (let tid = 1; tid < tt.trips.length; tid++) {
    const t = tt.trips[tid];
    if (t.isTrain || !/Ústí nad Labem a\.s\./.test(t.agency) || t.stops.length < 8) continue;
    if (!tt.activeSvcs(real.day).has(t.svc)) continue;
    const i = Math.floor(t.stops.length / 2), s = tt.stops[t.stops[i]];
    if (!s.hasCoords) continue;
    return { tid, t, s, now: { day: real.day, sec: t.dep[i] + delayMin * 60 } };
  }
}

test('DPMÚL vůz bez čísla spoje se zpožděním 14 min se spáruje podle polohy', () => {
  const c = pickCase(14);
  assert.ok(c, 'v JŘ je dnešní spoj DPMÚL');
  const v = { source: 'dpmul', sources: ['dpmul'], train: false, line: c.t.line, delay: 14, cis: '000000', trip: '', dest: c.t.head, heading: null, lat: c.s.lat, lng: c.s.lng };
  const live = new LiveTracker(tt);
  const m = live.matchTrip(v, c.now);
  assert.ok(m, 'spoj nalezen');
  assert.equal(tt.trips[m.tid].line, c.t.line);
  assert.equal(m.exact, false);
});

test('opačný cíl spoj nespáruje', () => {
  const c = pickCase(0);
  const v = { source: 'dpmul', train: false, line: c.t.line, delay: 0, dest: 'Neexistující konečná', lat: c.s.lat, lng: c.s.lng };
  const live = new LiveTracker(tt);
  assert.equal(live.matchByPosition(v, c.now), null);
});

test('DPMÚL azimut nula se nepovažuje za směr na sever', async () => {
  const { usableHeading } = await import('../lib/trip-lookup.mjs');
  assert.equal(usableHeading(0), false);
  assert.equal(usableHeading(null), false);
  assert.equal(usableHeading(180), true);
});
