// =============================================================================
// validate.js  -  tiny input validators shared by HTTP routes and WebSockets.
// -----------------------------------------------------------------------------
// Rule #1 of web security: never trust anything that comes from the browser.
// Every ticker / timeframe / text box goes through one of these functions
// BEFORE it touches an external API, a file, or a log line.
// =============================================================================

// US stock tickers: 1-10 chars, letters, digits, dot or dash (e.g. BRK.B, BF-B).
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** Returns a clean upper-case ticker or null if it is not a valid symbol. */
export function cleanSymbol(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

// Only the bar sizes Alpaca supports and our UI offers.
export const TIMEFRAMES = Object.freeze(['1Min', '5Min', '15Min', '30Min', '1Hour', '4Hour', '1Day']);

/** Returns the timeframe if it is on the allow-list, otherwise null. */
export function cleanTimeframe(input) {
  return TIMEFRAMES.includes(input) ? input : null;
}

/** Trims a free-text string and cuts it to `max` characters (default 4000). */
export function cleanText(input, max = 4000) {
  if (typeof input !== 'string') return '';
  // Strip ASCII control characters except newline/tab (prevents log forging).
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
}

/** Converts a timeframe string into seconds (used to bucket live trades). */
export function timeframeSeconds(tf) {
  return { '1Min': 60, '5Min': 300, '15Min': 900, '30Min': 1800, '1Hour': 3600, '4Hour': 14400, '1Day': 86400 }[tf] ?? 60;
}
