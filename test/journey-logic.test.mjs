// Logika spojení: aktuální jízda pro mapu, ohrožený přestup, příjezd do času, vzdálenost od trasy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeLegIndex, transferStatus, arrivingBy, distanceToRouteM } from '../public/js/journey-logic.js';

const h = (hh, mm) => hh * 3600 + mm * 60;
const ride = (dep, arr) => ({ kind: 'ride', dep, arr });
const walk = (dep, arr) => ({ kind: 'walk', dep, arr });
// 10:00–10:20 jízda, 10:20–10:25 chůze, 10:30–10:50 jízda, 11:00–11:10 jízda
const legs = [ride(h(10, 0), h(10, 20)), walk(h(10, 20), h(10, 25)), ride(h(10, 30), h(10, 50)), ride(h(11, 0), h(11, 10))];

test('aktuální jízda: první do 3 min po odjezdu, zpoždění posouvá', () => {
  assert.equal(activeLegIndex(legs, h(10, 3)), 0);
  assert.equal(activeLegIndex(legs, h(10, 3) + 1), 2);
  assert.equal(activeLegIndex(legs, h(10, 7), (i) => (i === 0 ? 5 : 0)), 0);
  assert.equal(activeLegIndex(legs, h(12, 0)), 3);
});

test('přestup: bez živých dat nic, rezerva s chůzí, těsný, ohrožený', () => {
  assert.equal(transferStatus(legs, 0, {}, h(10, 0)), null);
  assert.deepEqual(transferStatus(legs, 0, { 0: 0 }, h(10, 0)), { risk: 'none', marginMin: 5, delayMin: 0 });
  assert.equal(transferStatus(legs, 0, { 0: 4 }, h(10, 0)).risk, 'tight');
  const late = transferStatus(legs, 0, { 0: 7 }, h(10, 0));
  assert.equal(late.risk, 'risk');
  assert.equal(late.marginMin, -2);
});

test('přestup: zpožděný navazující pomůže, předčasný ne, minulý se nehodnotí', () => {
  assert.equal(transferStatus(legs, 0, { 0: 7, 2: 4 }, h(10, 0)).risk, 'none');
  assert.equal(transferStatus(legs, 0, { 0: 4, 2: -3 }, h(10, 0)).marginMin, 1);
  assert.equal(transferStatus(legs, 0, { 0: 10 }, h(10, 45)), null);
  assert.equal(transferStatus(legs, 0, new Map([[0, 7]]), h(10, 0)).risk, 'risk');
});

test('příjezd do času: jen ta, co stihnou, podle odjezdu', () => {
  const same = () => 0;
  const js = [{ day: 'd', dep: h(9, 0), arr: h(9, 40) }, { day: 'd', dep: h(8, 0), arr: h(8, 30) }, { day: 'd', dep: h(9, 30), arr: h(10, 5) }];
  assert.deepEqual(arrivingBy(js, 'd', h(10, 0), same).map((j) => j.dep), [h(8, 0), h(9, 0)]);
});

test('vzdálenost od trasy počítá úsečky, ne jen vrcholy', () => {
  const route = [[50.66, 14.0], [50.66, 14.05]];
  const d = distanceToRouteM(50.66 + 100 / 110540, 14.025, route);
  assert.ok(d > 95 && d < 105, `d=${d}`);
});
