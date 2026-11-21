// =============================================================================
// indicators.js  -  the MATH behind every technical indicator.
// -----------------------------------------------------------------------------
// Part 1: `ta` - small helper functions (moving averages, RSI, std-dev...).
//         Each takes an array of numbers and returns an array of the SAME
//         length, with `null` where there isn't enough data yet.
//         Your custom indicators get this same `ta` object to play with.
//
// Part 2: BUILTIN_INDICATORS - the catalogue shown in the "Indicators" menu.
//         Each definition says:
//           id, name, pane ('overlay' = on the price chart,
//                           'separate' = its own panel underneath)
//           params  - user-editable inputs (with defaults and limits)
//           compute(bars, params) -> [{ name, values, color, style }]
//
// This file runs in the browser, in the sandbox Web Worker, AND in Node's unit
// tests, so it must not touch the DOM.
// =============================================================================

// ----------------------------- Part 1: helpers ------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const ta = {
  /** Simple Moving Average: average of the last n values. */
  sma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isNum(v)) { sum += v; count++; }
      if (i >= n) { const old = values[i - n]; if (isNum(old)) { sum -= old; count--; } }
      if (i >= n - 1 && count === n) out[i] = sum / n;
    }
    return out;
  },

  /** Exponential Moving Average: recent values weigh more (k = 2/(n+1)). */
  ema(values, n) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null;
    let seed = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) continue;
      if (prev === null) {
        seed.push(v); //               first value = SMA of the first n points
        if (seed.length === n) { prev = seed.reduce((a, b) => a + b, 0) / n; out[i] = prev; seed = null; }
      } else {
        prev = v * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  },

  /** Weighted Moving Average: weights n, n-1, ... 1 (newest heaviest). */
  wma(values, n) {
    const out = new Array(values.length).fill(null);
    const denom = (n * (n + 1)) / 2;
    for (let i = n - 1; i < values.length; i++) {
      let s = 0;
      let ok = true;
      for (let j = 0; j < n; j++) {
        const v = values[i - j];
        if (!isNum(v)) { ok = false; break; }
        s += v * (n - j);
      }
      if (ok) out[i] = s / denom;
    }
    return out;
  },

  /** Wilder's smoothing (used by RSI and ATR). */
  rma(values, n) {
    const out = new Array(values.length).fill(null);
    let prev = null;
    let seed = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) continue;
      if (prev === null) {
        seed.push(v);
        if (seed.length === n) { prev = seed.reduce((a, b) => a + b, 0) / n; out[i] = prev; }
      } else {
        prev = (prev * (n - 1) + v) / n;
        out[i] = prev;
      }
    }
    return out;
  },

  /** Rolling (population) standard deviation over n values. */
  stdev(values, n) {
    const mean = ta.sma(values, n);
    return values.map((_, i) => {
      if (mean[i] === null) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (values[j] - mean[i]) ** 2;
      return Math.sqrt(s / n);
    });
  },

  /** Highest value of the last n. */
  highest(values, n) {
    return values.map((_, i) => (i < n - 1 ? null : Math.max(...values.slice(i - n + 1, i + 1))));
  },

  /** Lowest value of the last n. */
  lowest(values, n) {
    return values.map((_, i) => (i < n - 1 ? null : Math.min(...values.slice(i - n + 1, i + 1))));
  },

  /** Difference vs. n bars ago. */
  change(values, n = 1) {
    return values.map((v, i) => (i < n || !isNum(v) || !isNum(values[i - n]) ? null : v - values[i - n]));
  },

  /** Relative Strength Index (0-100). */
  rsi(values, n = 14) {
    const ch = ta.change(values, 1);
    const up = ta.rma(ch.map((c) => (c === null ? null : Math.max(c, 0))), n);
    const down = ta.rma(ch.map((c) => (c === null ? null : Math.max(-c, 0))), n);
    return values.map((_, i) => {
      if (up[i] === null || down[i] === null) return null;
      if (down[i] === 0) return 100;
      return 100 - 100 / (1 + up[i] / down[i]);
    });
  },

  /** True Range per bar (needs full bars). */
  trueRange(bars) {
    return bars.map((b, i) => {
      if (i === 0) return b.high - b.low;
      const pc = bars[i - 1].close;
      return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    });
  },

  /** Element-wise a - b (null-safe). */
  sub(a, b) { return a.map((v, i) => (isNum(v) && isNum(b[i]) ? v - b[i] : null)); },
};

// ------------------------- Part 2: built-in catalogue -----------------------
const closes = (bars) => bars.map((b) => b.close);
const P = (key, label, def, min = 1, max = 500, step = 1) => ({ key, label, default: def, min, max, step });

export const BUILTIN_INDICATORS = [
  {
    id: 'sma', name: 'SMA - Simple Moving Average', short: 'SMA', pane: 'overlay',
    params: [P('length', 'Length', 20)], colors: ['#00f0ff'],
    compute: (bars, p, c) => [{ name: `SMA ${p.length}`, values: ta.sma(closes(bars), p.length), color: c[0] }],
  },
  {
    id: 'ema', name: 'EMA - Exponential Moving Average', short: 'EMA', pane: 'overlay',
    params: [P('length', 'Length', 9)], colors: ['#ff2a6d'],
    compute: (bars, p, c) => [{ name: `EMA ${p.length}`, values: ta.ema(closes(bars), p.length), color: c[0] }],
  },
  {
    id: 'wma', name: 'WMA - Weighted Moving Average', short: 'WMA', pane: 'overlay',
    params: [P('length', 'Length', 20)], colors: ['#f9f871'],
    compute: (bars, p, c) => [{ name: `WMA ${p.length}`, values: ta.wma(closes(bars), p.length), color: c[0] }],
  },
  {
    id: 'bb', name: 'Bollinger Bands', short: 'BB', pane: 'overlay',
    params: [P('length', 'Length', 20), P('mult', 'Std-dev multiplier', 2, 0.1, 10, 0.1)],
    colors: ['#b967ff', '#05ffa1', '#b967ff'],
    compute: (bars, p, c) => {
      const mid = ta.sma(closes(bars), p.length);
      const sd = ta.stdev(closes(bars), p.length);
      return [
        { name: 'BB Upper', values: mid.map((m, i) => (m === null ? null : m + p.mult * sd[i])), color: c[0] },
        { name: 'BB Basis', values: mid, color: c[1] },
        { name: 'BB Lower', values: mid.map((m, i) => (m === null ? null : m - p.mult * sd[i])), color: c[2] },
      ];
    },
  },
  {
    id: 'vwap', name: 'VWAP - Volume Weighted Avg Price (session)', short: 'VWAP', pane: 'overlay',
    params: [], colors: ['#ffb800'],
    compute: (bars, p, c) => {
      // Resets each UTC day (close enough for U.S. sessions).
      let day = null; let pv = 0; let vol = 0;
      const values = bars.map((b) => {
        const d = Math.floor(b.time / 86400);
        if (d !== day) { day = d; pv = 0; vol = 0; }
        const typical = (b.high + b.low + b.close) / 3;
        pv += typical * b.volume; vol += b.volume;
        return vol ? pv / vol : null;
      });
      return [{ name: 'VWAP', values, color: c[0] }];
    },
  },
  {
    id: 'donchian', name: 'Donchian Channels', short: 'DC', pane: 'overlay',
    params: [P('length', 'Length', 20)], colors: ['#05ffa1', '#05ffa1'],
    compute: (bars, p, c) => [
      { name: 'DC High', values: ta.highest(bars.map((b) => b.high), p.length), color: c[0] },
      { name: 'DC Low', values: ta.lowest(bars.map((b) => b.low), p.length), color: c[1] },
    ],
  },
  {
    id: 'rsi', name: 'RSI - Relative Strength Index', short: 'RSI', pane: 'separate',
    params: [P('length', 'Length', 14)], colors: ['#b967ff'], levels: [30, 70],
    compute: (bars, p, c) => [{ name: `RSI ${p.length}`, values: ta.rsi(closes(bars), p.length), color: c[0] }],
  },
  {
    id: 'macd', name: 'MACD', short: 'MACD', pane: 'separate',
    params: [P('fast', 'Fast', 12), P('slow', 'Slow', 26), P('signal', 'Signal', 9)],
    colors: ['#00f0ff', '#ff2a6d', '#05ffa1'],
    compute: (bars, p, c) => {
      const macd = ta.sub(ta.ema(closes(bars), p.fast), ta.ema(closes(bars), p.slow));
      const signal = ta.ema(macd, p.signal);
      return [
        { name: 'MACD Hist', values: ta.sub(macd, signal), color: c[2], style: 'histogram' },
        { name: 'MACD', values: macd, color: c[0] },
        { name: 'Signal', values: signal, color: c[1] },
      ];
    },
  },
  {
    id: 'stoch', name: 'Stochastic Oscillator', short: 'Stoch', pane: 'separate',
    params: [P('k', '%K length', 14), P('smooth', '%K smoothing', 3), P('d', '%D length', 3)],
    colors: ['#00f0ff', '#ff2a6d'], levels: [20, 80],
    compute: (bars, p, c) => {
      const hh = ta.highest(bars.map((b) => b.high), p.k);
      const ll = ta.lowest(bars.map((b) => b.low), p.k);
      const raw = bars.map((b, i) => (hh[i] === null ? null : hh[i] === ll[i] ? 50 : (100 * (b.close - ll[i])) / (hh[i] - ll[i])));
      const k = ta.sma(raw, p.smooth);
      return [{ name: '%K', values: k, color: c[0] }, { name: '%D', values: ta.sma(k, p.d), color: c[1] }];
    },
  },
  {
    id: 'atr', name: 'ATR - Average True Range', short: 'ATR', pane: 'separate',
    params: [P('length', 'Length', 14)], colors: ['#ffb800'],
    compute: (bars, p, c) => [{ name: `ATR ${p.length}`, values: ta.rma(ta.trueRange(bars), p.length), color: c[0] }],
  },
  {
    id: 'obv', name: 'OBV - On Balance Volume', short: 'OBV', pane: 'separate',
    params: [], colors: ['#05ffa1'],
    compute: (bars, p, c) => {
      let acc = 0;
      const values = bars.map((b, i) => {
        if (i > 0) acc += b.close > bars[i - 1].close ? b.volume : b.close < bars[i - 1].close ? -b.volume : 0;
        return acc;
      });
      return [{ name: 'OBV', values, color: c[0] }];
    },
  },
  {
    id: 'roc', name: 'ROC - Rate of Change %', short: 'ROC', pane: 'separate',
    params: [P('length', 'Length', 12)], colors: ['#ff6ec7'], levels: [0],
    compute: (bars, p, c) => {
      const cl = closes(bars);
      return [{ name: `ROC ${p.length}`, values: cl.map((v, i) => (i < p.length ? null : (100 * (v - cl[i - p.length])) / cl[i - p.length])), color: c[0] }];
    },
  },
];

/** Look up a built-in by id. */
export const getBuiltin = (id) => BUILTIN_INDICATORS.find((d) => d.id === id);

/** Default param object, e.g. { length: 20 } */
export const defaultParams = (def) => Object.fromEntries(def.params.map((p) => [p.key, p.default]));

/** Clamp user-entered params to each definition's min/max (bad input can't break math). */
export function sanitizeParams(def, params = {}) {
  const out = {};
  for (const p of def.params) {
    const n = Number(params[p.key]);
    out[p.key] = Number.isFinite(n) ? Math.min(p.max, Math.max(p.min, n)) : p.default;
    if (p.step >= 1) out[p.key] = Math.round(out[p.key]);
  }
  return out;
}
