// =============================================================================
// alpaca/index.js  -  picks REAL (Alpaca) or DEMO market data in one place.
// -----------------------------------------------------------------------------
// Everything else in the app imports `market` from here and never needs to
// know whether keys were configured.
// =============================================================================
import { config } from '../config.js';
import { getAlpacaBars } from './rest.js';
import { AlpacaStream } from './stream.js';
import { getDemoBars, DemoStream } from './demoFeed.js';

const useDemo = config.demoMode || !config.alpaca.configured;

// Short cache so 20 tabs loading the same chart = 1 call to Alpaca.
const cache = new Map(); // key -> { at, bars }
const CACHE_MS = 15000;

export const market = {
  mode: useDemo ? 'demo' : 'live',
  stream: useDemo ? new DemoStream() : new AlpacaStream(),

  /** Historical candles for the chart. */
  async getBars(symbol, timeframe, limit = 1000) {
    if (useDemo) return getDemoBars(symbol, timeframe, Math.min(limit, 1000));
    const key = `${symbol}|${timeframe}|${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.bars;
    const bars = await getAlpacaBars(symbol, timeframe, limit);
    cache.set(key, { at: Date.now(), bars });
    if (cache.size > 200) cache.delete(cache.keys().next().value); // keep memory bounded
    return bars;
  },
};
