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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

// Start from a clean, predictable layout.
await page.addInitScript(() => {
  if (!sessionStorage.getItem('seeded')) {
    localStorage.clear();
    localStorage.setItem('mknb.symbol', JSON.stringify('NVDA'));
    localStorage.setItem('mknb.timeframe', JSON.stringify('15Min'));
    sessionStorage.setItem('seeded', '1');
  }
});

// The AI needs a real API key; for the picture we return a clearly-labelled
// sample response instead of calling a model.
await page.route('**/api/status', async (route) => {
  const res = await route.fetch();
  const json = await res.json();
  json.ai = { enabled: true, provider: 'anthropic', model: 'sample' };
  await route.fulfill({ json });
});
await page.route('**/api/ai/simulate', (route) => route.fulfill({ json: { decision: {
  action: 'HOLD', confidence: 62, position_size_pct: 0, entry: 0, stop_loss: 0, take_profit: 0,
  reasoning: '[SAMPLE RESPONSE FOR SCREENSHOT] Price is pinned to the BB basis with RSI near 50 - no edge. Waiting for a close above the upper band or for the 8-K clock on the watched ticker to resolve.',
  risks: ['Leak-site claim could become a late 8-K headline', 'Low IEX volume makes signals noisy'],
} } }));

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

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

// 5. AI co-pilot (sample response)
await page.click('.tab[data-panel="panel-ai"]');
await page.click('#btn-ai-sim');
await page.waitForTimeout(800);
await shot('ai-copilot');

// 6. Ticker switch keeps indicators
await page.click('.tab[data-panel="panel-watchdog"]');
await page.locator('.case').first().click();
await page.waitForTimeout(2000);
await shot('ticker-switch-keeps-indicators');

await browser.close();
console.log(`Screenshots written to ${OUT}/`);
