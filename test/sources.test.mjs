import test from 'node:test';
import assert from 'node:assert/strict';
import { fuse, baseVehicleId, sameVehicleId } from '../lib/fusion.mjs';
import { Hub, uidOf } from '../lib/hub.mjs';
import { inSzBox, parseDpmul, parseSz, sjtskToWgs84, parseDelayMinutes, parsePragueLocal, SzSource, DpmulSource, DukSource } from '../lib/sources.mjs';
import { sourceStatusParts } from '../public/js/live.js';

const veh = (o) => ({ source: 'duk', segment: 'city', id: 300451, lat: 50.66, lng: 14.04, line: '81', delay: 0, ageSec: 5, state: 0, train: false, cis: '', trip: '', agency: '', dest: '', low: null, ac: null, heading: null, ...o });
const inp = (id, priority, segments, vehicles, health = 'live', staleVehicleSec = 40) => ({ id, priority, segments: new Set(segments), health, staleVehicleSec, vehicles });

test('stav zdrojů zvýrazní zastaralé a vynechá zdroje bez použitelných poloh', () => {
  assert.deepEqual(sourceStatusParts([
    { name: 'DPMÚL', health: 'live', vehicles: 20 },
    { name: 'DÚK', health: 'stale', vehicles: 5 },
    { name: 'Správa železnic', health: 'down', vehicles: 0 },
  ]), [
    { name: 'DPMÚL', stale: false },
    { name: 'DÚK', stale: true },
  ]);
  assert.deepEqual(sourceStatusParts([]), [{ name: 'žádný', stale: true }]);
});

test('ID vozů: předpona 30 se ignoruje', () => {
  assert.equal(baseVehicleId(300451), 451);
  assert.equal(baseVehicleId(301212), 1212);
  assert.equal(baseVehicleId(451), 451);
  assert.ok(sameVehicleId(300451, 451));
  assert.ok(!sameVehicleId(300451, 452));
});

test('slučování: stejný vůz z DPMÚL a DÚK je jen jednou, vyhraje čerstvější, spoj se doplní', () => {
  const dpmul = inp('dpmul', 0, ['city'], [veh({ source: 'dpmul', id: 451, lat: 50.6601, ageSec: 2 })]);
  const duk = inp('duk', 1, ['city', 'regional'], [veh({ id: 300451, cis: '000081', trip: '2359', ageSec: 20, dest: 'Církvice' })]);
  const out = fuse([duk, dpmul]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'dpmul');
  assert.equal(out[0].cis, '000081', 'číslo spoje z DÚK');
  assert.equal(out[0].trip, '2359');
  assert.equal(out[0].dest, 'Církvice');
  assert.deepEqual(out[0].sources.sort(), ['dpmul', 'duk']);
  assert.deepEqual(out[0].ids, ['dpmul:451', 'duk:300451'], 'ID vozidla zdroj:id v pořadí priority');
});

test('slučování: při shodě stáří vyhrává vyšší priorita; rozdílná čísla = různé vozy', () => {
  const a = inp('dpmul', 0, ['city'], [veh({ source: 'dpmul', id: 451, ageSec: 10 })]);
  const b = inp('duk', 1, ['city'], [veh({ id: 300451, ageSec: 12 }), veh({ id: 300452, lat: 50.7 })]);
  const out = fuse([a, b]);
  assert.equal(out.length, 2);
  assert.equal(out.find((v) => baseVehicleId(v.id) === 451).source, 'dpmul');
});

test('slučování bez ID: stejná linka do 150 m je jeden vůz, jiná linka ne', () => {
  const a = inp('dpmul', 0, ['city'], [veh({ source: 'dpmul', id: 0, line: '81' })]);
  const b = inp('duk', 1, ['city'], [veh({ id: 0, line: '81', lat: 50.6605 }), veh({ id: 0, line: '82', lat: 50.6601 })]);
  assert.equal(fuse([a, b]).length, 2);
});

test('slučování vlaků podle čísla vlaku (DÚK + SŽ)', () => {
  const duk = inp('duk', 1, ['city', 'regional'], [veh({ id: 21234, train: true, segment: 'regional', cis: '1193', line: 'S1', ageSec: 25 })]);
  const sz = inp('train', 2, ['regional'], [veh({ source: 'train', id: 1193, train: true, segment: 'regional', cis: '1193', line: 'Os 1193', lat: 50.70, ageSec: 1 })]);
  const out = fuse([duk, sz]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'train', 'čerstvější poloha');
  assert.deepEqual([...out[0].ids].sort(), ['duk:21234', 'train:1193'], 'ID jako v Androidu: zdroj:id');
  assert.equal(out[0].train, true);
  const other = fuse([duk, inp('train', 2, ['regional'], [veh({ source: 'train', id: 1194, train: true, segment: 'regional', cis: '1194', lat: 50.66 })])]);
  assert.equal(other.length, 2, 'jiné číslo = jiný vlak');
});

test('duch: zastaralý vůz jen z DÚK zmizí, když DPMÚL MHD čerstvě pokrývá', () => {
  const dpmul = inp('dpmul', 0, ['city'], [veh({ source: 'dpmul', id: 500, lat: 50.6 })]);
  const duk = inp('duk', 1, ['city', 'regional'], [veh({ id: 300777, lat: 50.65, ageSec: 200 }), veh({ id: 100001, segment: 'regional', lat: 50.5, ageSec: 200 })]);
  const out = fuse([dpmul, duk]);
  assert.ok(!out.some((v) => v.id === 300777), 'MHD duch pryč');
  assert.ok(out.some((v) => v.id === 100001), 'regionální zůstal (DPMÚL ho nepokrývá)');
  assert.equal(fuse([{ ...dpmul, health: 'down', vehicles: [] }, duk]).length, 2, 'bez živého DPMÚL se nic nemaže');
});

test('uid je stejný pro DPMÚL i DÚK', () => {
  assert.equal(uidOf(veh({ id: 451 })), uidOf(veh({ id: 300451 })));
  assert.equal(uidOf(veh({ train: true, cis: '0001193', id: 21234 })), 't1193');
});

test('DPMÚL: parsování odpovědi', () => {
  const now = Date.parse('2026-11-10T21:00:00Z');
  const body = [
    { vehicleNumber: 451, lineName: '81', delay: '00:05:00', latitude: 50.66, longitude: 14.04, lastActivity: '2026-11-10T21:59:50+01:00', isWheelchairAccessible: true, isAirConditioned: false },
    { vehicleNumber: 2, lineName: '200', delay: '-00:01:30', latitude: 50.67, longitude: 14.05, gpsTimestamp: '2026-11-10T22:00:00' },
    { vehicleNumber: 3, lineName: '1', latitude: null, longitude: null },
    { vehicleNumber: 4, lineName: '2', latitude: 10, longitude: 10 },
    { vehicleNumber: 5, lineName: '3', latitude: 50.6, longitude: 14, lastActivity: '2026-11-10T21:30:00+01:00' },
  ];
  const v = parseDpmul(body, now);
  assert.deepEqual(v.map((x) => x.id), [451, 2]);
  assert.equal(v[0].delay, 5); assert.equal(v[0].low, true); assert.equal(v[0].ac, false);
  assert.equal(v[0].ageSec, 10);
  assert.equal(v[1].line, 'X'); assert.equal(v[1].delay, -1); // -1,5 min → -1 (stejné zaokrouhlení jako Math.round v Kotlinu)
  assert.equal(v[1].ageSec, 0, 'gpsTimestamp je místní čas (CET)');
  assert.equal(parseDelayMinutes(null), 0); assert.equal(parseDelayMinutes('3,4'), 3);
  assert.equal(parsePragueLocal('2026-07-01T12:00:00'), Date.parse('2026-07-01T10:00:00Z'), 'letní čas');
});

test('DPMÚL: směr jízdy podle naučené stanice', () => {
  const st = new Map();
  parseDpmul([{ vehicleNumber: 1, lineName: '1', latitude: 50.0, longitude: 14.0, stationNumber: 9, stoppedAt: true }], Date.now(), st);
  const [v] = parseDpmul([{ vehicleNumber: 2, lineName: '1', latitude: 49.99, longitude: 14.0, stationNumber: 9, inTransitTo: true }], Date.now(), st);
  assert.ok(Math.abs(v.heading - 0) < 1 || Math.abs(v.heading - 360) < 1, `sever, je ${v.heading}`);
});

test('SŽ: převod S-JTSK → WGS84 (Praha) a parsování', () => {
  const p = sjtskToWgs84(-743000, -1043000);
  assert.ok(Math.abs(p[0] - 50.08) < 0.1 && Math.abs(p[1] - 14.42) < 0.1, `Praha, je ${p}`);
  assert.equal(sjtskToWgs84(0, 0), null);
  assert.equal(sjtskToWgs84(NaN, 1), null);
  const out = parseSz({ result: [
    { properties: { type: 'V', tt: 'Os', tn: '9780', ln: 'Louny', de: 3, d: 'ČD', id: 'x1' }, geometry: { coordinates: [-743000, -1043000] } },
    { properties: { type: 'S', tn: '1' }, geometry: { coordinates: [-743000, -1043000] } },
    { properties: { type: 'V', tn: '2' }, geometry: { coordinates: [0, 0] } },
  ] });
  assert.equal(out.length, 1);
  assert.equal(out[0].line, 'Os 9780'); assert.equal(out[0].cis, '9780'); assert.equal(out[0].train, true); assert.equal(out[0].delay, 3);
});

test('SŽ: jen Ústecký kraj a Praha (rámec z MapScreen.kt)', () => {
  const f = (e, n) => ({ properties: { type: 'V', tt: 'Os', tn: '1' }, geometry: { coordinates: [e, n] } });
  const out = parseSz({ result: [f(-743000, -1043000), f(-560000, -1000000), f(-1050000, -1150000)] });
  assert.equal(out.length, 1, 'Praha ano; východ (Ostrava) a západ (Cheb) ne');
  assert.ok(inSzBox(50.66, 14.04) && inSzBox(50.08, 14.42) && !inSzBox(49.5, 14.4) && !inSzBox(50.6, 15.2));
});

test('SŽ: odstup 10 s, jeden dotaz naráz, 403 = pauza s exponenciálním zpožděním', async () => {
  let t = 1_000_000, calls = 0, status = 200;
  const body = JSON.stringify({ result: [{ properties: { type: 'V', tt: 'Os', tn: '1' }, geometry: { coordinates: [-743000, -1043000] } }] });
  const s = new SzSource({ now: () => t, request: async () => { calls++; return { status, body }; } });
  await s.poll(); assert.equal(calls, 1); assert.equal(s.snapshot().vehicles.length, 1);
  t += 5000; await s.poll(); assert.equal(calls, 1, 'méně než 10 s');
  t += 6000; status = 403; await s.poll(); assert.equal(calls, 2);
  assert.ok(s.blockedUntil - t >= 10 * 60_000, 'pauza aspoň 10 min');
  t += 60_000; await s.poll(); assert.equal(calls, 2, 'při pauze se nevolá');
  assert.equal(s.snapshot().vehicles.length, 1, 'poslední data se drží');
  t += 130_000; assert.equal(s.snapshot().vehicles.length, 0, 'po 2 min zmizí');
  t += 10 * 60_000; status = 403; await s.poll();
  assert.ok(s.blockedUntil - t >= 20 * 60_000, 'druhá pauza 20 min');
});

test('DPMÚL: vlastní server, bez čerstvých dat se použije přímé API jen s klíčem', async () => {
  const mk = (age, list) => async (url) => ({ ok: true, status: 200, headers: new Map([['x-age-sec', String(age)]]), json: async () => (url.includes('globdata') ? [{ vehicleNumber: 9, lineName: '1', latitude: 50.6, longitude: 14.0 }] : list) });
  const now = () => Date.now();
  const bad = new DpmulSource({ serverUrl: 'http://x/dpmul/traffic', now, fetchImpl: mk(-1, []) });
  await bad.poll(); assert.equal(bad.health(), 'down');
  const direct = new DpmulSource({ serverUrl: 'http://x/dpmul/traffic', apiKey: 'k', now, fetchImpl: mk(-1, []) });
  await direct.poll(); assert.equal(direct.snapshot().vehicles.length, 1);
  const ok = new DpmulSource({ serverUrl: 'http://x/dpmul/traffic', now, fetchImpl: mk(3, [{ vehicleNumber: 9, lineName: '1', latitude: 50.6, longitude: 14.0 }]) });
  await ok.poll(); assert.equal(ok.health(), 'live');
});

test('Hub: společná odpověď, štítek zdroje a uid', async () => {
  const duk = new DukSource({ fetchRaw: async () => ({ VehicleList: [{ ID: 300451, Latitude: 50.66, Longitude: 14.04, State: 0, LineID: '81', CISLineID: 81, RouteID: '2359' }] }) });
  await duk.feed.poll();
  const dp = new DpmulSource({ serverUrl: 'x', fetchImpl: async () => ({ ok: true, headers: new Map([['x-age-sec', '1']]), json: async () => [{ vehicleNumber: 451, lineName: '81', latitude: 50.6601, longitude: 14.04, lastActivity: new Date().toISOString() }] }) });
  await dp.poll();
  const s = new Hub([dp, duk]).snapshot();
  assert.equal(s.vehicles.length, 1);
  assert.equal(s.vehicles[0].uid, 'v451');
  assert.equal(s.vehicles[0].trip, '2359');
  assert.equal(s.source, 'DPMÚL, DÚK');
  assert.equal(s.sources.length, 2);
});

test('Hub.refresh: dotaz jen na zdroje starší než interval, jeden naráz, čeká nejvýš maxWait', async () => {
  let t = 1_000_000, calls = 0, slow = false;
  const src = (id) => ({ id, pollMs: 5000, async pollOnce() { calls++; if (slow) await new Promise((r) => setTimeout(r, 200)); }, snapshot: () => ({ id, priority: 1, segments: new Set(), health: 'live', staleVehicleSec: 40, vehicles: [], held: 0, failures: 0, lastError: '', name: id }) });
  const hub = new Hub([src('a'), src('b')], { now: () => t });
  await hub.refresh(); assert.equal(calls, 2);
  t += 1000; await hub.refresh(); assert.equal(calls, 2, 'méně než interval');
  t += 5000; slow = true;
  const t0 = Date.now(); await hub.refresh(50); assert.ok(Date.now() - t0 < 150, 'nečeká déle než maxWait');
  assert.equal(calls, 4);
  await hub.refresh(50); assert.equal(calls, 4, 'rozběhnutý dotaz se nezdvojuje');
});

test('Hub: stejný uid ze dvou segmentů se nezdvojí (jedna značka na mapě)', async () => {
  const { dedupeByUid } = await import('../public/js/util.js');
  const a = { uid: 'v811', lat: 50.7, lng: 14.0, ageSec: 3, source: 'dpmul' };
  const b = { uid: 'v811', lat: 50.6, lng: 14.1, ageSec: 200, source: 'duk' };
  const c = { uid: 'v5', lat: 1, lng: 1, ageSec: 0 };
  const out = dedupeByUid([b, a, c], (v) => v.uid);
  assert.equal(out.length, 2);
  assert.equal(out.find((v) => v.uid === 'v811').source, 'dpmul'); // čerstvější vyhrává
});
