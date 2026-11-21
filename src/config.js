// =============================================================================
// config.js  -  ONE place that reads every setting from environment variables.
// -----------------------------------------------------------------------------
// Why: secrets (API keys) must NEVER be hard-coded in source files or sent to
// the browser. We read them from the process environment (a `.env` file locally
// or `docker compose` env vars) and export a frozen (read-only) object that the
// rest of the server imports.
// =============================================================================

import 'dotenv/config'; // loads variables from a local .env file if one exists

// Small helper: read an env var as a trimmed string, or fall back to a default.
// An empty value ("KEY=" in .env) also counts as "not set".
const str = (name, fallback = '') => {
  const v = (process.env[name] ?? '').toString().trim();
  return v === '' ? fallback : v;
};

// Small helper: read an env var as an integer, clamped to a safe [min, max] range
// so a typo (e.g. POLL=0) can't hammer an external API or crash a timer.
const int = (name, fallback, min, max) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// Small helper: read "true"/"1"/"yes" as boolean true.
const bool = (name, fallback = false) => {
  const v = str(name, '').toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};

// ---- Alpaca (market data) ---------------------------------------------------
const alpacaKey = str('ALPACA_KEY_ID');
const alpacaSecret = str('ALPACA_SECRET_KEY');

// ---- AI providers ------------------------------------------------------------
// You can switch on as MANY AI providers as you like; each one with a key shows
// up in the AI panel's drop-down (and in "Ask all AIs" mode).
//   anthropic - Claude            (official Anthropic SDK)
//   openai    - ChatGPT           (OpenAI Chat Completions API)
//   gemini    - Google Gemini     (Gemini generateContent API)
//   custom1..3 - ANY "OpenAI-compatible" service: Grok (xAI), Mistral, DeepSeek,
//               Groq, OpenRouter, Perplexity, Together, or a local Ollama / LM Studio.
function buildAiProviders() {
  const list = [];
  const add = (p) => { if (p.apiKey || p.noKeyNeeded) list.push(Object.freeze(p)); };

  add({ id: 'anthropic', kind: 'anthropic', label: 'Claude (Anthropic)',
    apiKey: str('ANTHROPIC_API_KEY'), model: str('ANTHROPIC_MODEL', 'claude-opus-5-5') });

  add({ id: 'openai', kind: 'openai-compatible', label: 'ChatGPT (OpenAI)',
    apiKey: str('OPENAI_API_KEY'), model: str('OPENAI_MODEL'),
    baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1') });

  add({ id: 'gemini', kind: 'gemini', label: 'Gemini (Google)',
    apiKey: str('GEMINI_API_KEY'), model: str('GEMINI_MODEL'),
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });

  // Up to 3 extra OpenAI-compatible providers: CUSTOM_AI_1_NAME, _BASE_URL, _API_KEY, _MODEL
  for (let i = 1; i <= 3; i++) {
    const baseUrl = str(`CUSTOM_AI_${i}_BASE_URL`);
    if (!baseUrl) continue;
    add({ id: `custom${i}`, kind: 'openai-compatible', label: str(`CUSTOM_AI_${i}_NAME`, `Custom AI ${i}`).slice(0, 40),
      apiKey: str(`CUSTOM_AI_${i}_API_KEY`), model: str(`CUSTOM_AI_${i}_MODEL`), baseUrl,
      noKeyNeeded: true }); // local servers like Ollama don't need a key
  }
  return Object.freeze(list);
}
const aiProviders = buildAiProviders();

export const config = Object.freeze({
  // Web server
  port: int('PORT', 8080, 1, 65535),
  host: str('HOST', '0.0.0.0'),
  // Optional password gate (HTTP Basic Auth). Strongly recommended if you
  // expose the app beyond your own computer.
  appUser: str('APP_USER', 'kevin'),
  appPassword: str('APP_PASSWORD'),
  // Comma-separated list of extra allowed browser origins for the WebSocket
  // (the app's own origin is always allowed).
  allowedOrigins: str('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: bool('TRUST_PROXY', false),

  // Alpaca market data
  alpaca: Object.freeze({
    keyId: alpacaKey,
    secretKey: alpacaSecret,
    // "iex" is free for every Alpaca account; "sip" needs a paid data plan.
    feed: ['iex', 'sip', 'delayed_sip'].includes(str('ALPACA_FEED', 'iex')) ? str('ALPACA_FEED', 'iex') : 'iex',
    dataUrl: 'https://data.alpaca.markets',
    streamUrlBase: 'wss://stream.data.alpaca.markets/v2',
    configured: Boolean(alpacaKey && alpacaSecret),
  }),

  // DEMO mode: synthetic prices + fictional ransomware cases, so the UI can be
  // explored (and screenshotted) without any keys. Turned on automatically
  // when Alpaca keys are missing unless DEMO_MODE=false.
  demoMode: bool('DEMO_MODE', !(alpacaKey && alpacaSecret)),

  // Ransomware / SEC watchdog
  ransom: Object.freeze({
    enabled: bool('RANSOM_MONITOR_ENABLED', true),
    pollMinutes: int('RANSOM_POLL_MINUTES', 30, 5, 1440),
    // SEC asks every automated client to identify itself with a User-Agent
    // containing a contact. Set this to "YourApp you@example.com".
    secUserAgent: str('SEC_USER_AGENT', 'MakeKevinNotBroke/1.0 (set SEC_USER_AGENT in .env)'),
    // How far back (calendar days) we look for leak-site claims.
    lookbackDays: int('RANSOM_LOOKBACK_DAYS', 21, 1, 120),
    // Optional generic JSON feeds (Ransom-DB, WatchGuard, Comparitech, Darkweb IQ...)
    ransomDbUrl: str('RANSOMDB_API_URL'),
    ransomDbKey: str('RANSOMDB_API_KEY'),
    watchguardUrl: str('WATCHGUARD_FEED_URL'),
    comparitechUrl: str('COMPARITECH_FEED_URL'),
    darkwebIqUrl: str('DARKWEBIQ_FEED_URL'),
    darkwebIqKey: str('DARKWEBIQ_API_KEY'),
    hibpEnabled: bool('HIBP_ENABLED', true),
    // Optional Discord/Slack-style incoming webhook to receive alerts.
    alertWebhookUrl: str('ALERT_WEBHOOK_URL'),
  }),

  // AI co-pilot (optional)
  ai: Object.freeze({
    providers: aiProviders,
    // Which provider the drop-down selects first (falls back to the first one configured)
    defaultProvider: aiProviders.some((p) => p.id === str('AI_DEFAULT_PROVIDER'))
      ? str('AI_DEFAULT_PROVIDER') : (aiProviders[0]?.id ?? null),
    configured: aiProviders.length > 0,
  }),

  dataDir: str('DATA_DIR', './data'),
});
