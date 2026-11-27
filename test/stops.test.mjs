import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Timetable } from '../public/js/timetable.js';
import { StopIndex } from '../public/js/stops.js';
import { addDays, weekday } from '../public/js/util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = path.join(root, 'public/data/timetable.json');
if (!fs.existsSync(dataFile)) throw new Error('Chybí public/data/timetable.json (spusť npm run data)');
const tt = new Timetable(JSON.parse(fs.readFileSync(dataFile, 'utf8')));

// první pondělí po sestavení dat (vlaky mají kalendář jen od data sestavení)
const DAY = (() => { let d = tt.meta.built.slice(0, 10).replaceAll('-', ''); while (weekday(d) !== 0) d = addDays(d, 1); return d; })();
const idx = new StopIndex(tt);
const icons = (name) => idx.stops.filter((s) => s.name === `Ústí nad Labem, ${name}`);

test('zastávky v Ústí: počty nástupišť jako ve skutečnosti (stejně jako v appce)', () => {
  const expected = {
    'Stříbrníky': 4, 'Bělehradská': 3, 'Poliklinika': 3,
    'Ovčácká stezka': 2, 'Nové Skorotice': 2, 'V Rokli': 2, 'Karla IV.': 2, 'Sociální péče': 2, 'Mírové náměstí': 2, 'Divadlo': 2,
  };
  for (const [name, n] of Object.entries(expected)) {
    const bus = icons(name).filter((s) => s.kind !== 'rail');
    assert.equal(bus.length, n, `${name}: ${bus.length} nástupišť, čekáno ${n}`);
  }
});

test('Hlavní nádraží: autobusy (nejvýš nástupiště pro každý směr) a vlaky zvlášť, obojí s odjezdy', () => {
  const hn = icons('Hlavní nádraží');
  const rail = hn.filter((s) => s.kind === 'rail'), bus = hn.filter((s) => s.kind !== 'rail');
  assert.equal(rail.length, 1);
  // od listopadu 2026 staví linky 85, 450, 451 a 801 i ve směru do centra (sloupek u Čajkovského): 1–2 nástupiště
  assert.ok(bus.length >= 1 && bus.length <= 2, `autobusových nástupišť: ${bus.length}`);
  const now = { day: DAY, sec: 8 * 3600 };
  const trains = idx.departures(rail[0], now);
  assert.ok(trains.length > 5 && trains.every((d) => d.isTrain), `vlaků: ${trains.length}`);
  const buses = bus.map((b) => idx.departures(b, now));
  assert.ok(buses.every((l) => l.length > 0 && l.every((d) => !d.isTrain)), 'nástupiště bez odjezdů nebo s vlakem');
  assert.ok(Math.max(...buses.map((l) => l.length)) > 10, `autobusů: ${buses.map((l) => l.length)}`);
  // nástupiště nesdílejí odjezdy
  if (buses.length === 2) {
    const a = new Set(buses[0].map((d) => `${d.tid}|${d.dep}`));
    assert.ok(buses[1].every((d) => !a.has(`${d.tid}|${d.dep}`)), 'stejný odjezd na obou nástupištích');
  }
});

test('každé nástupiště má odjezdy a dvě nástupiště zastávky odjezdy nesdílí', () => {
  const now = { day: DAY, sec: 7 * 3600 };
  for (const name of ['Mírové náměstí', 'Stříbrníky', 'Ovčácká stezka', 'Sociální péče']) {
    const seen = new Set();
    for (const s of icons(name)) {
      const deps = idx.departures(s, now, 6);
      assert.ok(deps.length > 0, `${name} ${s.key}: žádné odjezdy`);
      for (const d of deps) {
        const k = `${d.tid}@${d.dep}`;
        assert.ok(!seen.has(k), `${name}: odjezd ${k} na dvou nástupištích`);
        seen.add(k);
      }
    }
  }
});

test('zastávky trasy leží na nástupišti svého směru', () => {
  const st = icons('Mírové náměstí');
  const dep = idx.departures(st[0], { day: DAY, sec: 8 * 3600 })[0];
  const t = tt.trips[dep.tid];
  const pts = idx.platformPoints(Array.from(t.stops));
  const at = pts.find((p) => p && p.id === dep.from);
  assert.ok(at && Math.abs(at.lat - st[0].lat) < 1e-9 && Math.abs(at.lng - st[0].lng) < 1e-9, 'bod trasy není na nástupišti odjezdu');
});

// celostátní jízdní řád na serveru (Praha, Plzeň…): jen když jsou stažená data (npm run data)
const dbFile = path.join(root, 'data/timetable.sqlite');
test('server: zastávky a odjezdy mimo kraj z celostátního jízdního řádu', { skip: !fs.existsSync(dbFile) }, async () => {
  const { StopService } = await import('../lib/stop-service.mjs');
  const s = await StopService.open(dbFile);
  try {
    const andel = s.inView({ south: 50.069, north: 50.073, west: 14.400, east: 14.408 });
    assert.ok(andel.length >= 2, `Anděl: ${andel.length} zastávek`);
    let deps = 0;
    for (const [key] of andel) deps += s.departures(key, { day: DAY, sec: 8 * 3600 }).deps.length;
    assert.ok(deps > 20, `Anděl: ${deps} odjezdů`);
    const one = s.departures(andel[0][0], { day: DAY, sec: 8 * 3600 }).deps[0];
    const pts = s.platformPoints(one.tid);
    assert.ok(pts && pts.some(Boolean), 'spoj bez poloh zastávek');
  } finally { s.close(); }
});
