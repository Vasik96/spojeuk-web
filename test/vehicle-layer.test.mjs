import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
const { STYLES, lateMinutes, vehicleMode, vehicleStyle, baseStyle, vehicleCategory } = await import('../public/js/vehicle-layer.js');
delete globalThis.document;

test('trolejbus používá tyrkysovou barvu a při zpoždění autobusovou červenou s tyrkysovou trasou', () => {
  const onTime = { mode: 'trolleybus', delay: 0 };
  const late = { mode: 'trolleybus', delay: 4 };

  assert.equal(vehicleStyle(onTime), 'TROLLEYBUS');
  assert.equal(STYLES[vehicleStyle(onTime)].color, '#009688');
  assert.equal(vehicleStyle(late), 'TROLLEYBUS_LATE');
  assert.deepEqual(STYLES[vehicleStyle(late)], {
    color: STYLES.BUS_LATE.color,
    route: '#00695C',
    routeDark: '#4DB6AC',
  });
  assert.equal(lateMinutes(late), 0);
});

test('trolejbusy se rozpoznávají jen podle mode z API', () => {
  assert.equal(vehicleStyle({ line: '70', source: 'dpmul', delay: 0 }), 'BUS');
  assert.equal(vehicleStyle({ line: '70', source: 'dpmul', agency: 'Dopravní podnik města Ústí nad Labem', delay: 0 }), 'BUS');
  assert.equal(vehicleMode({ mode: 'trolleybus' }), 'trolleybus');
  assert.equal(vehicleStyle({ mode: 'trolleybus', line: '70', delay: 0 }), 'TROLLEYBUS');
});

test('vánoční vůz: tmavě červený styl, ale druh dopravy a kategorie zůstávají', () => {
  const xmasTram = { mode: 'tram', delay: 0, christmas: true, line: '1' };
  assert.equal(vehicleStyle(xmasTram), 'CHRISTMAS');
  assert.equal(STYLES.CHRISTMAS.color, '#800000');
  assert.equal(baseStyle(xmasTram), 'TRAM');
  assert.equal(vehicleCategory(xmasTram), 'tram');
  assert.equal(vehicleStyle({ mode: 'tram', delay: 0, christmas: false }), 'TRAM');
});
