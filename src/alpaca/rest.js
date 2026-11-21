// =============================================================================
// alpaca/rest.js  -  downloads HISTORICAL candles (bars) from Alpaca.
// -----------------------------------------------------------------------------
// Docs: https://docs.alpaca.markets/reference/stockbars
// The browser never talks to Alpaca directly - it asks OUR server, and our
// server adds the secret key headers. That keeps your keys off the client.
// =============================================================================
import { config } from '../config.js';
import { fetchJson } from '../util/http.js';

// How far back to ask for data for each timeframe (calendar days). Chosen so
// that ~500-1000 candles come back even with nights/weekends removed.
const LOOKBACK_DAYS = { '1Min': 5, '5Min': 20, '15Min': 45, '30Min': 90, '1Hour': 180, '4Hour': 400, '1Day': 1825 };

/** Headers Alpaca uses for authentication. */
export const alpacaHeaders = () => ({
  'APCA-API-KEY-ID': config.alpaca.keyId,
  'APCA-API-SECRET-KEY': config.alpaca.secretKey,
});

/**
 * getBars('AAPL', '5Min', 1000) -> [{ time, open, high, low, close, volume }]
 * `time` is a UNIX timestamp in seconds (what the chart library expects).
 */
export async function getAlpacaBars(symbol, timeframe, limit = 1000) {
  const start = new Date(Date.now() - (LOOKBACK_DAYS[timeframe] ?? 5) * 86400000).toISOString();
  const params = new URLSearchParams({
    timeframe,
    start,
    limit: String(Math.min(10000, Math.max(10, limit))),
    feed: config.alpaca.feed,
    adjustment: 'split', // keep old prices comparable after stock splits
    sort: 'desc', //        newest first, so `limit` keeps the most recent candles
  });
  // encodeURIComponent: the symbol is already validated, but encode anyway.
  const url = `${config.alpaca.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?${params}`;
  const json = await fetchJson(url, { headers: alpacaHeaders() });
  const bars = Array.isArray(json.bars) ? json.bars : [];
  return bars
    .map((b) => ({
      time: Math.floor(Date.parse(b.t) / 1000),
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
    }))
    .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close))
    .reverse(); // back to oldest -> newest for the chart
}
