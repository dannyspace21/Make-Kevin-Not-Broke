// Tests for the indicator maths (shared by browser + sandbox worker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ta, BUILTIN_INDICATORS, sanitizeParams, getBuiltin } from '../public/js/indicators.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('sma / ema basics', () => {
  assert.deepEqual(ta.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = ta.ema([1, 2, 3, 4], 2); // seed = 1.5, k = 2/3
  assert.equal(e[0], null);
  close(e[1], 1.5);
  close(e[2], 3 * (2 / 3) + 1.5 / 3);
});

test('rsi is 100 for a straight up-trend and within 0..100', () => {
  const up = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(ta.rsi(up, 14).at(-1), 100);
  const noisy = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i) * 5);
  for (const v of ta.rsi(noisy, 14)) if (v !== null) assert.ok(v >= 0 && v <= 100);
});

test('every built-in returns arrays aligned with bars', () => {
  const bars = Array.from({ length: 120 }, (_, i) => ({ time: 1700000000 + i * 60, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 1000 }));
  for (const def of BUILTIN_INDICATORS) {
    const params = Object.fromEntries(def.params.map((p) => [p.key, p.default]));
    const plots = def.compute(bars, params, def.colors);
    assert.ok(plots.length > 0, def.id);
    for (const p of plots) assert.equal(p.values.length, bars.length, `${def.id}/${p.name}`);
  }
});

test('sanitizeParams clamps bad input', () => {
  const def = getBuiltin('sma');
  assert.deepEqual(sanitizeParams(def, { length: -5 }), { length: 1 });
  assert.deepEqual(sanitizeParams(def, { length: 'abc' }), { length: 20 });
  assert.deepEqual(sanitizeParams(def, { length: 99999 }), { length: 500 });
});
