// =============================================================================
// alpaca/stream.js  -  LIVE prices from Alpaca's WebSocket, shared by everyone.
// -----------------------------------------------------------------------------
// Alpaca's free plan allows only ONE streaming connection per account. So the
// server opens exactly one upstream connection and "fans out" the messages to
// every open browser tab. This class keeps a reference count per symbol so we
// only subscribe to tickers someone is actually watching.
//
// Message flow:  Alpaca  --(trades/bars)-->  AlpacaStream  --(emit)-->  listeners
// Docs: https://docs.alpaca.markets/docs/real-time-stock-pricing-data
// =============================================================================
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { log } from '../util/logger.js';

const MAX_SYMBOLS = 30; // free-plan limit on simultaneously streamed symbols

export class AlpacaStream extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0); //   any number of browser tabs may listen
    this.refCount = new Map(); // symbol -> how many browser tabs watch it
    this.ws = null;
    this.authed = false;
    this.retry = 0; //            reconnect attempt counter (for back-off)
    this.status = 'idle';
  }

  /** Open the upstream connection (called lazily on first subscribe). */
  connect() {
    if (this.ws) return;
    const url = `${config.alpaca.streamUrlBase}/${config.alpaca.feed}`;
    this.status = 'connecting';
    this.ws = new WebSocket(url, { maxPayload: 4 * 1024 * 1024 });

    this.ws.on('message', (raw) => {
      let msgs;
      try { msgs = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(msgs)) return;
      for (const m of msgs) this.handle(m);
    });

    this.ws.on('close', () => {
      this.ws = null;
      this.authed = false;
      this.status = 'disconnected';
      // Reconnect with exponential back-off (1s, 2s, 4s ... max 60s) only if
      // somebody is still watching a symbol.
      if (this.refCount.size > 0) {
        const delay = Math.min(60000, 1000 * 2 ** this.retry++);
        log.warn('alpaca-stream', `closed, reconnecting in ${delay / 1000}s`);
        setTimeout(() => this.connect(), delay).unref();
      }
    });

    this.ws.on('error', (err) => log.error('alpaca-stream', err.message));
  }

  /** Handle one message object from Alpaca. */
  handle(m) {
    switch (m.T) {
      case 'success':
        if (m.msg === 'connected') {
          // Step 1: Alpaca says hello -> we send our keys.
          this.ws.send(JSON.stringify({ action: 'auth', key: config.alpaca.keyId, secret: config.alpaca.secretKey }));
        } else if (m.msg === 'authenticated') {
          // Step 2: keys accepted -> subscribe to everything being watched.
          this.authed = true;
          this.retry = 0;
          this.status = 'live';
          log.info('alpaca-stream', 'authenticated');
          this.sendSubscription('subscribe', [...this.refCount.keys()]);
        }
        break;
      case 'error':
        // 402 = bad keys, 406 = too many connections (another app uses your keys)
        this.status = `error ${m.code}: ${m.msg}`;
        log.error('alpaca-stream', `code ${m.code}: ${m.msg}`);
        this.emit('status', this.status);
        break;
      case 't': // a single trade -> price tick
        this.emit('tick', { type: 'trade', symbol: m.S, price: m.p, size: m.s, time: Date.parse(m.t) / 1000 });
        break;
      case 'b': // a finished 1-minute bar
      case 'u': // a corrected ("updated") 1-minute bar
        this.emit('tick', {
          type: 'bar', symbol: m.S, time: Math.floor(Date.parse(m.t) / 1000),
          open: m.o, high: m.h, low: m.l, close: m.c, volume: m.v,
        });
        break;
      default:
        break; // subscription confirmations etc. - nothing to do
    }
  }

  sendSubscription(action, symbols) {
    if (!this.ws || !this.authed || symbols.length === 0) return;
    this.ws.send(JSON.stringify({ action, trades: symbols, bars: symbols, updatedBars: symbols }));
  }

  /** A browser tab starts watching `symbol`. Returns false if over the limit. */
  addSymbol(symbol) {
    const n = this.refCount.get(symbol) ?? 0;
    if (n === 0 && this.refCount.size >= MAX_SYMBOLS) return false;
    this.refCount.set(symbol, n + 1);
    if (n === 0) this.sendSubscription('subscribe', [symbol]);
    this.connect();
    return true;
  }

  /** A browser tab stops watching `symbol`. */
  removeSymbol(symbol) {
    const n = this.refCount.get(symbol) ?? 0;
    if (n <= 1) {
      this.refCount.delete(symbol);
      if (n === 1) this.sendSubscription('unsubscribe', [symbol]);
    } else {
      this.refCount.set(symbol, n - 1);
    }
  }
}
