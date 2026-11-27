import test from 'node:test';
import assert from 'node:assert/strict';
import { pragueNow } from '../public/js/util.js';

// původní implementace (Intl pro každé volání): rychlá verze s posunem zóny na hodinu musí dávat totéž
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const reference = (ms) => {
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = value;
  return { day: `${p.year}${p.month}${p.day}`, sec: +p.hour * 3600 + +p.minute * 60 + +p.second };
};

test('pragueNow: stejně jako Intl i přes přechody letního času a půlnoc', () => {
  // konec března a října 2026 (přechody), Silvestr, náhodné skoky tam a zpět (cache se musí přepočítat)
  for (const start of [Date.UTC(2026, 2, 28, 20), Date.UTC(2026, 9, 24, 20), Date.UTC(2026, 11, 31, 20)]) {
    for (let ms = start; ms < start + 12 * 3600e3; ms += 6_997) assert.deepEqual(pragueNow(ms), reference(ms), new Date(ms).toISOString());
  }
  let seed = 7;
  for (let i = 0; i < 5000; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const ms = Date.UTC(2026, 0, 1) + Math.floor((seed / 2 ** 32) * 730 * 86400e3);
    assert.deepEqual(pragueNow(ms), reference(ms), new Date(ms).toISOString());
  }
});
