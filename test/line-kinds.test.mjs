import test from 'node:test';
import assert from 'node:assert/strict';
import { lineKind, learnLineKind, resetLineKinds } from '../public/js/line-kinds.js';
import { t, LANG } from '../public/js/i18n.js';

test('druh linky ze živých dat: dopravce + linka, autobus nic nepřepíše', () => {
  resetLineKinds();
  const dpmul = 'Dopravní podnik města Ústí nad Labem a.s.';
  assert.equal(lineKind(dpmul, '72'), null);
  learnLineKind(dpmul, ' 72', 'trolleybus');
  learnLineKind(dpmul, '72', 'bus');
  assert.equal(lineKind(dpmul, '72'), 'trolleybus');
  assert.equal(lineKind('Arriva Teplice', '72'), null, 'stejné číslo u jiného dopravce');
});

test('mimo prohlížeč je jazyk čeština, množná čísla', () => {
  assert.equal(LANG, 'cs');
  assert.equal(t('n.transfers', { n: 0 }), 'přímý spoj');
  assert.equal(t('n.stops', { n: 3 }), '3 zastávky');
  assert.equal(t('n.midStops', { n: 5 }), '5 mezizastávek');
  assert.equal(t('delay', { n: 4 }), 'Zpoždění 4 min');
});
