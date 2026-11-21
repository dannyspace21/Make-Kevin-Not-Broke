// =============================================================================
// alpaca/demoFeed.js  -  FAKE market data for DEMO mode (no keys needed).
// -----------------------------------------------------------------------------
// Generates believable-looking random-walk candles and live ticks with the
// exact same shape as the real Alpaca data, so the rest of the app can't tell
// the difference. Every symbol gets a stable "seed" so AAPL always looks the
// same between reloads. NOTHING here is real market data.
// =============================================================================
import { EventEmitter } from 'node:events';
import { timeframeSeconds } from '../util/validate.js';

/** Deterministic pseudo-random generator (mulberry32) from a numeric seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedOf = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
const lastPrice = new Map(); // symbol -> last generated price (so ticks continue the chart)

/** Make `limit` candles ending "now" for the given symbol/timeframe. */
export function getDemoBars(symbol, timeframe, limit = 500) {
  const step = timeframeSeconds(timeframe);
  const rand = rng(seedOf(symbol + timeframe));
  const now = Math.floor(Date.now() / 1000 / step) * step;
  let price = 20 + (Math.abs(seedOf(symbol)) % 480); // $20 - $500
  const vol = 0.002 * Math.sqrt(step / 60); //           bigger candles for bigger timeframes
  const bars = [];
  for (let i = limit - 1; i >= 0; i--) {
    const open = price;
    const drift = Math.sin((limit - i) / 40) * vol * 0.4; // gentle waves = nicer demo
    const close = Math.max(1, open * (1 + drift + (rand() - 0.5) * vol * 2));
    const high = Math.max(open, close) * (1 + rand() * vol);
    const low = Math.min(open, close) * (1 - rand() * vol);
    bars.push({ time: now - i * step, open: +open.toFixed(2), high: +high.toFixed(2), low: +low.toFixed(2), close: +close.toFixed(2), volume: Math.round(1e4 + rand() * 9e4 * (step / 60)) });
    price = close;
  }
  // Rescale so the newest close equals the symbol's "current" price - that way
  // every timeframe (and the watchlist) agrees on what the stock costs now.
  const anchor = lastPrice.get(symbol) ?? 20 + (Math.abs(seedOf(symbol)) % 480);
  const k = anchor / price;
  for (const b of bars) {
    b.open = +(b.open * k).toFixed(2); b.high = +(b.high * k).toFixed(2);
    b.low = +(b.low * k).toFixed(2); b.close = +(b.close * k).toFixed(2);
  }
  lastPrice.set(symbol, anchor);
  return bars;
}

/** Emits a fake trade every second for each watched symbol. */
export class DemoStream extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.refCount = new Map();
    this.status = 'demo';
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref(); // don't keep the process alive just for the demo
  }

  tick() {
    for (const symbol of this.refCount.keys()) {
      const p = lastPrice.get(symbol) ?? 100;
      const next = Math.max(1, p * (1 + (Math.random() - 0.5) * 0.002));
      lastPrice.set(symbol, next);
      this.emit('tick', { type: 'trade', symbol, price: +next.toFixed(2), size: Math.ceil(Math.random() * 300), time: Date.now() / 1000 });
    }
  }

  addSymbol(symbol) { this.refCount.set(symbol, (this.refCount.get(symbol) ?? 0) + 1); return true; }

  removeSymbol(symbol) {
    const n = this.refCount.get(symbol) ?? 0;
    if (n <= 1) this.refCount.delete(symbol); else this.refCount.set(symbol, n - 1);
  }
}
