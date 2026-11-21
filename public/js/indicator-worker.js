// =============================================================================
// indicator-worker.js  -  SANDBOX that runs YOUR custom indicator code.
// -----------------------------------------------------------------------------
// Why a Web Worker?
//   * It runs on a separate thread: an infinite loop in your code can't freeze
//     the page - the main page simply kills the worker after a timeout.
//   * It has no access to the page (no DOM, no cookies, no localStorage).
//   * The server sends this file with its own Content-Security-Policy:
//     "connect-src 'none'" -> custom code cannot fetch()/WebSocket anywhere,
//     so it can't leak data even if you paste code from a stranger.
//
// Protocol:  page --> { id, code, bars, params }   worker --> { id, ok, plots | error }
// =============================================================================
import { ta } from './indicators.js';

// Belt-and-braces: remove network/import APIs from the worker's global scope.
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel']) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch { /* ignore */ }
}

const MAX_PLOTS = 8;
const compiled = new Map(); // code string -> compiled function (compile once)

/** Turn whatever the user returned into [{ name, values, color, style }]. */
function normalize(result, length) {
  let plots;
  if (Array.isArray(result) && (result.length === 0 || typeof result[0] === 'number' || result[0] === null)) {
    plots = [{ name: 'Custom', values: result }]; //    plain array of numbers
  } else if (Array.isArray(result)) {
    plots = result; //                                   array of plot objects
  } else if (result && Array.isArray(result.values)) {
    plots = [result]; //                                 single plot object
  } else {
    throw new Error('Return an array of numbers, or [{ name, values, color }].');
  }
  return plots.slice(0, MAX_PLOTS).map((p, i) => {
    if (!Array.isArray(p.values)) throw new Error(`Plot ${i + 1} has no "values" array.`);
    if (p.values.length !== length) throw new Error(`Plot "${p.name ?? i + 1}" has ${p.values.length} values but there are ${length} bars.`);
    return {
      name: String(p.name ?? `Plot ${i + 1}`).slice(0, 40),
      values: p.values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
      // only accept simple #rrggbb colours (no CSS tricks)
      color: /^#[0-9a-fA-F]{6}$/.test(p.color ?? '') ? p.color : null,
      style: p.style === 'histogram' ? 'histogram' : 'line',
    };
  });
}

self.onmessage = (event) => {
  const { id, code, bars, params } = event.data ?? {};
  try {
    if (typeof code !== 'string' || code.length > 20000) throw new Error('Code missing or longer than 20,000 characters.');
    let fn = compiled.get(code);
    if (!fn) {
      // "use strict" + function scope: your code sees only bars, params and ta.
      fn = new Function('bars', 'params', 'ta', `"use strict";\n${code}`);
      compiled.set(code, fn);
    }
    // Give the code a frozen copy so it can't mess with shared objects.
    const safeBars = Object.freeze(bars.map((b) => Object.freeze({ ...b })));
    const plots = normalize(fn(safeBars, Object.freeze({ ...params }), ta), bars.length);
    self.postMessage({ id, ok: true, plots });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err).slice(0, 500) });
  }
};
