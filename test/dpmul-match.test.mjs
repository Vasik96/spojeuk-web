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

// ───── směr jízdy a držení přiřazení ─────

/** Dvě po sobě jdoucí zastávky spoje s polohou o kus dál (zhruba 1/3 úseku) a bod před ní. */
function legCase() {
  const real = pragueNow();
  for (let tid = 1; tid < tt.trips.length; tid++) {
    const t = tt.trips[tid];
    if (t.isTrain || !/Ústí nad Labem a\.s\./.test(t.agency) || t.stops.length < 8) continue;
    if (!tt.activeSvcs(real.day).has(t.svc)) continue;
    const i = Math.floor(t.stops.length / 2);
    const a = tt.stops[t.stops[i]], b = tt.stops[t.stops[i + 1]];
    if (!a.hasCoords || !b.hasCoords) continue;
    const at = (f) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
    const sec = Math.round(t.dep[i] + (t.arr[i + 1] - t.dep[i]) * 0.5);
    return { tid, t, at, now: { day: real.day, sec } };
  }
}

test('vůz bez azimutu: směr z historie pohybu vybere spoj jedoucí tímto směrem, ne protisměrný', (tc) => {
  // dvojice spojů téže linky, které projíždějí stejný úsek (a→b) a (b→a) ve stejnou dobu
  const real = pragueNow();
  const active = tt.activeSvcs(real.day);
  let found = null;
  const byLine = new Map();
  for (let tid = 1; tid < tt.trips.length && !found; tid++) {
    const t = tt.trips[tid];
    if (t.isTrain || !active.has(t.svc)) continue;
    const list = byLine.get(t.line) || byLine.set(t.line, []).get(t.line);
    for (const o of list) {
      for (let i = 0; i < t.stops.length - 1 && !found; i++) {
        const j = o.t.stops.findIndex((s, k) => s === t.stops[i + 1] && o.t.stops[k + 1] === t.stops[i]);
        if (j < 0) continue;
        const a = tt.stops[t.stops[i]], b = tt.stops[t.stops[i + 1]];
        if (!a.hasCoords || !b.hasCoords) continue;
        const mid = (t.dep[i] + t.arr[i + 1]) / 2, midO = (o.t.dep[j] + o.t.arr[j + 1]) / 2;
        if (Math.abs(mid - midO) > 120) continue;
        found = { A: tid, B: o.tid, t, a, b, sec: Math.round((mid + midO) / 2) };
      }
      if (found) break;
    }
    list.push({ tid, t });
  }
  if (!found) return tc.skip('v dnešním JŘ není dvojice protisměrných spojů ve stejnou dobu');
  const at = (f) => ({ lat: found.a.lat + (found.b.lat - found.a.lat) * f, lng: found.a.lng + (found.b.lng - found.a.lng) * f });
  const p = at(0.5), behind = at(0.3);
  const now = { day: real.day, sec: found.sec };
  const live = new LiveTracker(tt);
  const mk = (uid, from) => ({ uid, source: 'dpmul', line: found.t.line, delay: 0, dest: '', lat: p.lat, lng: p.lng, trail: [from.lat, from.lng] });
  const forward = live.matchByPosition(mk('f', behind), now);   // přijel od a, jede k b
  const backward = live.matchByPosition(mk('r', at(0.7)), now); // přijel od b, jede k a
  assert.ok(forward != null && backward != null);
  assert.notEqual(forward, backward, 'opačný pohyb musí vybrat opačný spoj');
});

test('přiřazený spoj se drží i při dalším dotazu a matchTrip dává totéž', () => {
  const c = legCase();
  const p = c.at(0.5);
  const live = new LiveTracker(tt);
  const v = { uid: 'x3', source: 'dpmul', line: c.t.line, delay: 0, dest: '', lat: p.lat, lng: p.lng };
  const first = live.matchByPosition(v, c.now);
  assert.ok(first);
  for (let i = 0; i < 3; i++) assert.equal(live.matchByPosition({ ...v }, c.now), first);
  assert.equal(live.matchTrip({ ...v }, c.now).tid, first);
});

test('trackMotion: směr z posledního pohybu, azimut DPMÚL se ignoruje', () => {
  const live = new LiveTracker(tt);
  const mk = (lat, lng) => ({ uid: 'x4', source: 'dpmul', heading: 180, lat, lng });
  let v = mk(50.6600, 14.0400); live.trackMotion(v);
  v = mk(50.6603, 14.0400); live.trackMotion(v);
  v = mk(50.6606, 14.0400); live.trackMotion(v);
  assert.ok(Math.abs(v.moveHeading) < 1 || Math.abs(v.moveHeading - 360) < 1);
  v = mk(50.6606, 14.0405); live.trackMotion(v);
  v = mk(50.6606, 14.0410); live.trackMotion(v);
  assert.ok(Math.abs(v.moveHeading - 90) < 1);
  assert.ok(v.trail);
});
