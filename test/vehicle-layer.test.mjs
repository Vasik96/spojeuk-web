import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
const { STYLES, lateMinutes, vehicleStyle } = await import('../public/js/vehicle-layer.js');
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
