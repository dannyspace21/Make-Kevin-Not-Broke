// Tests for input validation (security-relevant)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSymbol, cleanTimeframe, cleanText } from '../src/util/validate.js';

test('ticker validation', () => {
  assert.equal(cleanSymbol(' aapl '), 'AAPL');
  assert.equal(cleanSymbol('BRK.B'), 'BRK.B');
  assert.equal(cleanSymbol('<script>'), null);
  assert.equal(cleanSymbol('../../etc'), null);
  assert.equal(cleanSymbol('TOOLONGTICKER'), null);
  assert.equal(cleanSymbol(42), null);
});

test('timeframe allow-list', () => {
  assert.equal(cleanTimeframe('5Min'), '5Min');
  assert.equal(cleanTimeframe('2Min'), null);
});

test('cleanText strips control characters and truncates', () => {
  assert.equal(cleanText('hi\u0000\u001b[31m there', 100), 'hi[31m there');
  assert.equal(cleanText('x'.repeat(50), 10).length, 10);
});
