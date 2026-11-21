// Tests for the live-data parsers using FAKE responses (no network needed).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { findCyberFilings, loadTickerIndex, matchCompany } from '../src/ransom/sec.js';
import { getAlpacaBars } from '../src/alpaca/rest.js';
import { AlpacaStream } from '../src/alpaca/stream.js';

/** Replace global fetch with one that returns `body` as JSON. */
function fakeFetch(handler) {
  return mock.method(globalThis, 'fetch', async (url) => {
    const body = handler(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

test('SEC submissions -> cyber 8-K filings', async () => {
  const m = fakeFetch(() => ({
    filings: { recent: {
      form: ['10-Q', '8-K', '8-K', '8-K', '4'],
      filingDate: ['2026-11-01', '2026-11-18', '2026-11-10', '2026-11-19', '2026-11-19'],
      items: ['', '1.05,9.01', '1.05', '2.02', ''],
      accessionNumber: ['a', '0000000001-26-000001', 'c', 'd', 'e'],
      primaryDocument: ['', 'doc.htm', '', '', ''],
    } },
  }));
  const r = await findCyberFilings(123, '2026-11-15');
  m.mock.restore();
  assert.equal(r.domesticFiler, true);
  assert.equal(r.filings.length, 1); // 11-10 is before `since`, 2.02 isn't cyber
  assert.equal(r.filings[0].kind, 'item-1.05');
  assert.match(r.filings[0].url, /Archives\/edgar\/data\/123\/000000000126000001\/doc\.htm/);
});

test('SEC ticker index + matching', async () => {
  const m = fakeFetch(() => ({ 0: { cik_str: 1, ticker: 'GLBX', title: 'Globex Corporation' } }));
  const idx = await loadTickerIndex();
  m.mock.restore();
  assert.equal(matchCompany(idx, { name: 'GLOBEX CORP' }).ticker, 'GLBX');
});

test('Alpaca bars are converted and returned oldest-first', async () => {
  const m = fakeFetch(() => ({ bars: [
    { t: '2026-11-20T15:31:00Z', o: 2, h: 3, l: 1, c: 2.5, v: 10 },
    { t: '2026-11-20T15:30:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 5 },
  ] }));
  const bars = await getAlpacaBars('AAPL', '1Min');
  const url = String(m.mock.calls[0].arguments[0]);
  m.mock.restore();
  assert.equal(bars[0].time < bars[1].time, true);
  assert.equal(bars[1].close, 2.5);
  assert.match(url, /\/v2\/stocks\/AAPL\/bars\?timeframe=1Min/);
});

test('Alpaca stream messages become ticks', () => {
  const s = new AlpacaStream();
  const ticks = [];
  s.on('tick', (t) => ticks.push(t));
  s.handle({ T: 't', S: 'AAPL', p: 101.5, s: 20, t: '2026-11-20T15:30:01Z' });
  s.handle({ T: 'b', S: 'AAPL', o: 1, h: 2, l: 0.5, c: 1.5, v: 9, t: '2026-11-20T15:30:00Z' });
  assert.equal(ticks[0].type, 'trade');
  assert.equal(ticks[0].price, 101.5);
  assert.equal(ticks[1].type, 'bar');
  assert.equal(ticks[1].time, Date.parse('2026-11-20T15:30:00Z') / 1000);
});
