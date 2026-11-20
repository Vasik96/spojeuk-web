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

test('Hlavní nádraží: jedno autobusové nástupiště a vlaky zvlášť, obojí s odjezdy', () => {
  const hn = icons('Hlavní nádraží');
  const rail = hn.filter((s) => s.kind === 'rail'), bus = hn.filter((s) => s.kind !== 'rail');
  assert.equal(rail.length, 1);
  assert.equal(bus.length, 1);
  const now = { day: DAY, sec: 8 * 3600 };
  const trains = idx.departures(rail[0], now);
  assert.ok(trains.length > 5 && trains.every((d) => d.isTrain), `vlaků: ${trains.length}`);
  const buses = idx.departures(bus[0], now);
  assert.ok(buses.length > 10 && buses.every((d) => !d.isTrain), `autobusů: ${buses.length}`);
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
