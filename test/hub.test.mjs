import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub, httpSnapshot } from '../lib/hub.mjs';
import { sourceStatusParts } from '../public/js/live.js';

const snap = (o = {}) => ({
  time: 1, held: 0, outage: false, upstreamAgeSec: 1, pollSec: 10, source: 'DPMÚL, DÚK',
  vehicles: [{ uid: 'v451', source: 'dpmul', id: 451, line: '81', ageSec: 2, lat: 50.66, lng: 14.04 }],
  sources: [
    { id: 'dpmul', name: 'DPMÚL', priority: 0, health: 'live', vehicles: 1, failures: 0, lastError: '' },
    { id: 'duk', name: 'DÚK', priority: 1, health: 'stale', vehicles: 1, failures: 0, lastError: '' },
  ],
  ...o,
});

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

test('Hub: odpověď serveru se předá beze změny, stáří poloh roste s časem od stažení', async () => {
  let t = 1_000_000;
  const hub = new Hub({ fetchSnapshot: async () => snap(), now: () => t });
  await hub.pollOnce();
  const s0 = hub.snapshot();
  assert.equal(s0.vehicles[0].uid, 'v451');
  assert.equal(s0.vehicles[0].ageSec, 2);
  assert.equal(s0.source, 'DPMÚL, DÚK');
  assert.equal(s0.outage, false);
  t += 5000;
  const s1 = hub.snapshot();
  assert.equal(s1.vehicles[0].ageSec, 7);
  assert.equal(s1.upstreamAgeSec, 6);
  assert.equal(s1.time, t);
});

test('Hub: bez odpovědi serveru je to výpadek, po 30 s zastaralé, po 3 min se polohy zahodí', async () => {
  let t = 1_000_000;
  const hub = new Hub({ fetchSnapshot: async () => snap({ sources: [{ id: 'dpmul', name: 'DPMÚL', priority: 0, health: 'live', vehicles: 1 }] }), now: () => t });
  assert.equal(hub.snapshot().outage, true);
  assert.equal(hub.snapshot().vehicles.length, 0);
  await hub.pollOnce();
  hub.fetchSnapshot = async () => { throw new Error('ECONNREFUSED'); };
  t += 31_000; await hub.pollOnce();
  const stale = hub.snapshot();
  assert.equal(hub.failures, 1);
  assert.equal(stale.outage, true);
  assert.equal(stale.sources[0].health, 'stale');
  assert.equal(stale.vehicles[0].ageSec, 33);
  assert.equal(stale.error, 'ECONNREFUSED');
  t += 160_000;
  const gone = hub.snapshot();
  assert.equal(gone.vehicles.length, 0);
  assert.equal(gone.source, 'žádný');
});

test('httpSnapshot: chybný stav a neplatná odpověď jsou chyba', async () => {
  const bad = httpSnapshot('http://x/', { fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(bad(), /HTTP 503/);
  const nonsense = httpSnapshot('http://x', { fetchImpl: async () => ({ ok: true, json: async () => ({ nope: 1 }) }) });
  await assert.rejects(nonsense(), /vehicles/);
  let url = '';
  const ok = httpSnapshot('http://x:8787/', { fetchImpl: async (u) => { url = u; return { ok: true, json: async () => snap() }; } });
  assert.equal((await ok()).vehicles.length, 1);
  assert.equal(url, 'http://x:8787/api/vehicles');
});

test('Hub.refresh: dotaz jen když je odpověď starší než interval, jeden naráz, čeká nejvýš maxWait', async () => {
  let t = 1_000_000, calls = 0, slow = false;
  const hub = new Hub({ pollMs: 3000, now: () => t, fetchSnapshot: async () => { calls++; if (slow) await new Promise((r) => setTimeout(r, 200)); return snap(); } });
  await hub.refresh(); assert.equal(calls, 1);
  t += 1000; await hub.refresh(); assert.equal(calls, 1, 'méně než interval');
  t += 3000; slow = true;
  const t0 = Date.now(); await hub.refresh(50); assert.ok(Date.now() - t0 < 150, 'nečeká déle než maxWait');
  assert.equal(calls, 2);
  await hub.refresh(50); assert.equal(calls, 2, 'rozběhnutý dotaz se nezdvojuje');
});

test('dedupeByUid: stejný uid ze dvou zdrojů se nezdvojí (jedna značka na mapě)', async () => {
  const { dedupeByUid } = await import('../public/js/util.js');
  const a = { uid: 'v811', lat: 50.7, lng: 14.0, ageSec: 3, source: 'dpmul' };
  const b = { uid: 'v811', lat: 50.6, lng: 14.1, ageSec: 200, source: 'duk' };
  const c = { uid: 'v5', lat: 1, lng: 1, ageSec: 0 };
  const out = dedupeByUid([b, a, c], (v) => v.uid);
  assert.equal(out.length, 2);
  assert.equal(out.find((v) => v.uid === 'v811').source, 'dpmul'); // čerstvější vyhrává
});
