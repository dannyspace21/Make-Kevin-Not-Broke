// =============================================================================
// scripts/screenshots.mjs  -  regenerates the README pictures.
// -----------------------------------------------------------------------------
// Usage:  1) start the app in DEMO mode   (npm start   with no Alpaca keys)
//         2) npm i -D playwright && npx playwright install chromium   (once)
//         3) npm run screenshots
// Pictures are written to docs/screenshots/. Demo mode = simulated prices and
// FICTIONAL companies, so no real company is shown as hacked.
// =============================================================================
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const OUT = 'docs/screenshots';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });

// Start from a clean, predictable layout.
await page.addInitScript(() => {
  if (!sessionStorage.getItem('seeded')) {
    localStorage.clear();
    localStorage.setItem('mknb.symbol', JSON.stringify('NVDA'));
    localStorage.setItem('mknb.timeframe', JSON.stringify('15Min'));
    localStorage.setItem('mknb.theme', JSON.stringify('dark'));
    localStorage.setItem('mknb.style', JSON.stringify('pro'));
    sessionStorage.setItem('seeded', '1');
  }
});

// The AIs need real API keys; for the pictures we pretend three are configured
// and return clearly-labelled SAMPLE responses instead of calling any model.
const SAMPLE_AIS = [
  { id: 'anthropic', label: 'Claude (Anthropic)', model: 'sample' },
  { id: 'openai', label: 'ChatGPT (OpenAI)', model: 'sample' },
  { id: 'gemini', label: 'Gemini (Google)', model: 'sample' },
];
const SAMPLE_DECISIONS = {
  anthropic: { action: 'HOLD', confidence: 62, position_size_pct: 0, reasoning: '[SAMPLE] Price pinned to the BB basis, RSI near 50 - no edge yet.' },
  openai: { action: 'BUY', confidence: 55, position_size_pct: 10, reasoning: '[SAMPLE] Higher lows on the 15m chart and MACD curling up.' },
  gemini: { action: 'SHORT', confidence: 48, position_size_pct: 5, reasoning: '[SAMPLE] Watchdog case pending - headline risk if a late 8-K lands.' },
};
await page.route('**/api/status', async (route) => {
  const res = await route.fetch();
  const json = await res.json();
  json.ai = { enabled: true, providers: SAMPLE_AIS, defaultProvider: 'anthropic' };
  await route.fulfill({ json });
});
await page.route('**/api/ai/simulate', async (route) => {
  const { provider } = route.request().postDataJSON();
  const d = SAMPLE_DECISIONS[provider];
  await route.fulfill({ json: {
    provider: { ...SAMPLE_AIS.find((p) => p.id === provider) },
    decision: { entry: 0, stop_loss: 0, take_profit: 0, risks: ['Sample response for screenshot'], ...d },
  } });
});

// Remove pop-up toasts first so they don't cover the picture.
const shot = async (name) => {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

await page.goto(BASE);
await page.waitForTimeout(3500);

// 1. Add a few more indicators so the "unlimited indicators" idea is visible.
await page.click('#btn-indicators');
for (const name of ['MACD', 'VWAP - Volume']) await page.locator('.picker-item', { hasText: name }).first().click();
await page.waitForTimeout(400);
await shot('indicator-picker');
await page.click('#modal-close');

// 2. Main dashboard with the 8-K watchdog
await page.waitForTimeout(1200);
await shot('dashboard');

// 3. Custom indicator editor with a test run
await page.click('#btn-custom');
await page.getByText('▶ Test').click();
await page.waitForTimeout(800);
await shot('custom-indicator-editor');
await page.getByText('Save & add to chart').click();
await page.waitForTimeout(1200);

// 4. Alerts tab
await page.click('.tab[data-panel="panel-alerts"]');
await page.waitForTimeout(300);
await shot('alerts');

// 5. Multi-AI co-pilot: ask every AI at once (sample responses)
await page.click('.tab[data-panel="panel-ai"]');
await page.check('#ai-all');
await page.click('#btn-ai-sim');
await page.waitForTimeout(800);
await shot('ai-copilot');

// 6. Ticker switch keeps indicators
await page.click('.tab[data-panel="panel-watchdog"]');
await page.locator('.case').first().click();
await page.waitForTimeout(2000);
await shot('ticker-switch-keeps-indicators');

// 7. Light mode (Pro theme)
await page.click('#btn-theme');
await page.waitForTimeout(800);
await shot('light-mode');
await page.click('#btn-theme'); // back to dark

// 8. Settings dialog, then switch to the Cyberpunk theme
await page.click('#btn-settings');
await page.waitForTimeout(300);
await shot('settings');
await page.locator('.choice:has(input[value="cyber"])').click();
await page.waitForTimeout(300);
await page.getByText('Done').click();
await page.waitForTimeout(1000);
await shot('cyberpunk-theme');
// leave the default theme selected for next time
await page.evaluate(() => localStorage.setItem('mknb.style', JSON.stringify('pro')));

await browser.close();
console.log(`Screenshots written to ${OUT}/`);
