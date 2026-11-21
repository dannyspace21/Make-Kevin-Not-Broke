// =============================================================================
// server.js  -  MAIN ENTRY POINT. Starts the web server + WebSocket.
// -----------------------------------------------------------------------------
//   Browser  <--HTTP-->  Express (pages, /api/*)
//   Browser  <--WS---->  /ws  (live ticks + ransomware alerts)
//   Server   <--WS---->  Alpaca stream (ONE shared connection)
//
// Security layers (in the order a request hits them):
//   1. helmet            - security headers incl. a strict Content-Security-Policy
//   2. rate limiting     - stops a script from spamming the API (and your keys)
//   3. basic auth        - optional password (APP_PASSWORD) for the whole app
//   4. input validation  - every ticker/timeframe/text is checked (validate.js)
//   5. WebSocket origin  - only pages served by THIS app may open the socket
// =============================================================================
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { log } from './util/logger.js';
import { cleanSymbol, cleanTimeframe, cleanText } from './util/validate.js';
import { market } from './alpaca/index.js';
import { ransomMonitor } from './ransom/monitor.js';
import { aiStatus, advise, simulate } from './ai/copilot.js';

const here = path.dirname(fileURLToPath(import.meta.url)); // folder of this file (ESM has no __dirname)
const root = path.resolve(here, '..');
const app = express();
app.disable('x-powered-by'); // don't advertise "Express" to attackers
if (config.trustProxy) app.set('trust proxy', 1); // only when behind nginx/traefik etc.

// ---- 1. Security headers ----------------------------------------------------
// The CSP only allows scripts/styles/fonts from our own server. No CDNs, no
// inline scripts -> an injected <script> tag simply won't run.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      // + the exact hash of the tiny <style> tag Lightweight Charts injects for
      //   its TradingView attribution logo (allowing ONLY that one inline style).
      'style-src': ["'self'", "'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='"],
      'font-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"], // fetch() + same-origin WebSocket (ws:/wss: to self)
      'worker-src': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"], // can't be put in an <iframe> (click-jacking)
      'upgrade-insecure-requests': null, // allow plain http on localhost
    },
  },
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: false, // enable at your HTTPS reverse proxy instead
}));

// ---- 2. Rate limiting -------------------------------------------------------
app.use('/api/', rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
const aiLimiter = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many AI requests - wait a minute.' } });

// ---- 3. Optional password (HTTP Basic Auth) ---------------------------------
/** Constant-time string compare (prevents timing attacks on the password). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
/** True if the request carries the right user/password (or no password is set). */
function isAuthorized(req) {
  if (!config.appPassword) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  // Evaluate BOTH comparisons (no short-circuit) so timing doesn't reveal which one failed.
  const userOk = safeEqual(user, config.appUser);
  const passOk = safeEqual(rest.join(':'), config.appPassword);
  return userOk && passOk;
}
app.use((req, res, next) => {
  if (req.path === '/healthz' || isAuthorized(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Make Kevin Not Broke", charset="UTF-8"').status(401).send('Authentication required');
});

app.use(express.json({ limit: '200kb' })); // JSON bodies, capped in size

// ---- CSRF guard -------------------------------------------------------------
// Browsers re-send Basic Auth credentials automatically, so another website
// could try to POST to /api/ai/* (costing you AI credits). Every state-changing
// request must carry our custom header; browsers refuse to add custom headers
// cross-site without a CORS pre-flight, which this server never approves.
app.use('/api/', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('X-MKNB-Request') !== '1') return res.status(403).json({ error: 'Missing request header.' });
  next();
});

// ---- Static files -----------------------------------------------------------
// The custom-indicator sandbox worker gets its OWN, even stricter CSP:
//  - 'unsafe-eval' so it can compile YOUR indicator code with new Function()
//  - connect-src 'none' so that code can't send data anywhere (no fetch/WebSocket)
app.get('/js/indicator-worker.js', (req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'");
  next();
});
const staticOpts = { index: false, maxAge: '1h', dotfiles: 'deny' };
app.use(express.static(path.join(root, 'public'), { ...staticOpts, index: 'index.html' }));
// Third-party browser libraries served from node_modules (no CDN needed).
app.use('/vendor/lightweight-charts', express.static(path.join(root, 'node_modules/lightweight-charts/dist'), staticOpts));
app.use('/vendor/fonts/orbitron', express.static(path.join(root, 'node_modules/@fontsource/orbitron/files'), staticOpts));
app.use('/vendor/fonts/share-tech-mono', express.static(path.join(root, 'node_modules/@fontsource/share-tech-mono/files'), staticOpts));

// ---- API routes -------------------------------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

/** App status: data mode (live/demo), stream status, AI availability. */
app.get('/api/status', (req, res) => {
  res.json({
    app: 'Make Kevin Not Broke',
    marketMode: market.mode,
    feed: config.alpaca.feed,
    streamStatus: market.stream.status,
    ai: aiStatus(),
    ransomMonitor: config.ransom.enabled,
  });
});

/** Historical candles: /api/bars?symbol=AAPL&timeframe=5Min */
app.get('/api/bars', async (req, res) => {
  const symbol = cleanSymbol(req.query.symbol);
  const timeframe = cleanTimeframe(req.query.timeframe ?? '5Min');
  if (!symbol) return res.status(400).json({ error: 'Invalid ticker symbol.' });
  if (!timeframe) return res.status(400).json({ error: 'Invalid timeframe.' });
  try {
    const bars = await market.getBars(symbol, timeframe, 1000);
    res.json({ symbol, timeframe, mode: market.mode, bars });
  } catch (err) {
    log.warn('bars', `${symbol} ${timeframe}: ${err.message}`);
    const msg = err.status === 403 || err.status === 401 ? 'Alpaca rejected the API keys.'
      : err.status === 422 || err.status === 404 ? `Alpaca has no data for ${symbol}.`
        : 'Could not load bars from Alpaca.';
    res.status(502).json({ error: msg });
  }
});

/** Ransomware / 8-K watchdog snapshot. */
app.get('/api/ransom', (req, res) => res.json(ransomMonitor.snapshot()));
app.post('/api/ransom/refresh', rateLimit({ windowMs: 5 * 60000, limit: 3 }), (req, res) => {
  ransomMonitor.runCycle();
  res.json({ ok: true });
});

/**
 * Turn the browser's chart context into a small, validated object for the AI.
 * Only numbers and short strings survive; everything else is dropped.
 */
function buildAiContext(body) {
  const symbol = cleanSymbol(body?.symbol) ?? 'UNKNOWN';
  const timeframe = cleanTimeframe(body?.timeframe) ?? 'unknown';
  const bars = Array.isArray(body?.bars) ? body.bars.slice(-120) : [];
  const cleanBars = bars
    .map((b) => [b?.time, b?.open, b?.high, b?.low, b?.close, b?.volume].map(Number))
    .filter((b) => b.every(Number.isFinite))
    .map(([t, o, h, l, c, v]) => ({ t: new Date(t * 1000).toISOString(), o, h, l, c, v }));
  const indicators = {};
  if (body?.indicators && typeof body.indicators === 'object') {
    for (const [k, v] of Object.entries(body.indicators).slice(0, 50)) {
      const n = Number(v);
      if (Number.isFinite(n)) indicators[cleanText(k, 60)] = +n.toFixed(4);
    }
  }
  // Attach the watchdog's info for this ticker (if any) from OUR server data.
  const ransomCase = ransomMonitor.snapshot().cases.find((c) => c.ticker === symbol) ?? null;
  return {
    symbol, timeframe, now: new Date().toISOString(), dataMode: market.mode,
    latestIndicatorValues: indicators,
    ransomwareCase: ransomCase && {
      company: ransomCase.company, status: ransomCase.status, claimDate: ransomCase.claimDate,
      deadline: ransomCase.deadline, businessDaysElapsed: ransomCase.businessDaysElapsed,
      disclosedInTime: ransomCase.disclosedInTime, verifiedBy: ransomCase.verifiedBy, gang: ransomCase.group,
    },
    candles: cleanBars,
  };
}

app.post('/api/ai/advise', aiLimiter, async (req, res) => {
  try {
    const answer = await advise({ question: cleanText(req.body?.question, 2000), context: buildAiContext(req.body) });
    res.json({ answer });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/ai/simulate', aiLimiter, async (req, res) => {
  try {
    const decision = await simulate({ scenario: cleanText(req.body?.scenario, 2000), context: buildAiContext(req.body) });
    res.json({ decision });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Unknown API path -> JSON 404; any other unknown path -> 404 text.
app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).send('Not found'));
// Last-resort error handler: never leak stack traces to the browser.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('http', err.message);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status === 400 ? 'Bad request' : 'Server error' });
});

// ---- WebSocket: live ticks + alerts -----------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

/** Only allow the socket from our own page (blocks cross-site WebSocket hijacking). */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, tests) send no Origin
  try {
    const o = new URL(origin);
    if (o.host === req.headers.host) return true;
    return config.allowedOrigins.includes(o.origin);
  } catch {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws' || !originAllowed(req) || !isAuthorized(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/** Send JSON to one socket if it is still open. */
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

wss.on('connection', (ws) => {
  ws.symbols = new Set(); // tickers this tab watches
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  // Forward market ticks for watched symbols only.
  const onTick = (tick) => { if (ws.symbols.has(tick.symbol)) send(ws, { type: 'tick', data: tick }); };
  const onStatus = (status) => send(ws, { type: 'streamStatus', data: status });
  market.stream.on('tick', onTick);
  market.stream.on('status', onStatus);

  send(ws, { type: 'hello', data: { marketMode: market.mode, streamStatus: market.stream.status } });

  ws.on('message', (raw) => {
    if (++ws.msgCount > 600) return ws.close(1008, 'too many messages'); // crude flood guard
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === 'subscribe') {
      const symbol = cleanSymbol(msg.symbol);
      if (!symbol || ws.symbols.has(symbol)) return;
      if (ws.symbols.size >= 5) return send(ws, { type: 'error', data: 'Max 5 live symbols per tab.' });
      if (!market.stream.addSymbol(symbol)) return send(ws, { type: 'error', data: 'Server live-symbol limit reached.' });
      ws.symbols.add(symbol);
    } else if (msg?.type === 'unsubscribe') {
      const symbol = cleanSymbol(msg.symbol);
      if (symbol && ws.symbols.delete(symbol)) market.stream.removeSymbol(symbol);
    }
  });

  ws.on('close', () => {
    market.stream.off('tick', onTick);
    market.stream.off('status', onStatus);
    for (const s of ws.symbols) market.stream.removeSymbol(s);
  });
});

// Broadcast ransomware alerts/updates to every connected tab.
const broadcast = (obj) => { for (const ws of wss.clients) send(ws, obj); };
ransomMonitor.on('alert', (a) => broadcast({ type: 'ransomAlert', data: a }));
ransomMonitor.on('update', () => broadcast({ type: 'ransomUpdate' }));

// Heartbeat: drop dead connections every 30s; reset the flood counter.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.msgCount = 0;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

// ---- Start ------------------------------------------------------------------
server.listen(config.port, config.host, async () => {
  log.info('server', `Make Kevin Not Broke listening on http://${config.host}:${config.port}`);
  log.info('server', `market data: ${market.mode.toUpperCase()}${market.mode === 'demo' ? ' (add Alpaca keys to .env for live data)' : ` (feed: ${config.alpaca.feed})`}`);
  log.info('server', `AI co-pilot: ${aiStatus().enabled ? aiStatus().provider : 'disabled'}`);
  if (!config.appPassword) log.warn('server', 'APP_PASSWORD is not set - anyone who can reach this port can use the app.');
  await ransomMonitor.start();
});

// Graceful shutdown (Docker sends SIGTERM on `docker stop`).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info('server', `${sig} received, shutting down`);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
