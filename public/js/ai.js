// =============================================================================
// ai.js  -  the MULTI-AI CO-PILOT side panel (optional - needs AI keys on server).
// -----------------------------------------------------------------------------
// Works with ANY provider configured on the server: Claude, ChatGPT, Gemini,
// Grok, Mistral, DeepSeek, a local Ollama... pick one in the drop-down, or tick
// "Ask every AI" to put the same question to all of them side by side.
//
// 1. "Ask"       - type a question; the AI sees the last 120 candles, your
//                  indicator values, and any ransomware/8-K case for the ticker.
// 2. "Simulate"  - the AI makes a PRETEND decision (BUY/SELL/SHORT/COVER/HOLD).
//                  Each AI has its OWN paper wallet, so the leaderboard shows
//                  which AI would have made Kevin the most money.
//                  NO REAL ORDERS ARE EVER PLACED.
// 3. "Auto-sim"  - optionally repeat the simulation every N minutes.
// =============================================================================
import { h, $, toast, api, storage } from './ui.js';

let app = null;
let autoTimer = null;
let providers = []; // [{ id, label, model }] from /api/status
const START_CASH = 10000;

// Paper wallets, one per AI: { [providerId]: { cash, positions: { SYM: { qty, avg } }, log: [] } }
let wallets = storage.get('mknb.wallets', {});
const saveWallets = () => storage.set('mknb.wallets', wallets);
const walletFor = (id) => (wallets[id] ??= { cash: START_CASH, positions: {}, log: [] });
const lastPrices = {}; // symbol -> last price seen, for valuing open positions

/** Data we send to the server for the AI (numbers only - no keys, no personal data). */
function context() {
  return {
    symbol: app.getSymbol(),
    timeframe: app.getTimeframe(),
    bars: app.getBars().slice(-120),
    indicators: app.getIndicatorValues(),
  };
}

/** Which provider ids to call: the selected one, or all of them. */
function targets() {
  return $('#ai-all').checked ? providers.map((p) => p.id) : [$('#ai-provider').value];
}
const labelOf = (id) => providers.find((p) => p.id === id)?.label ?? id;

export function initAiPanel(appApi, status) {
  app = appApi;
  providers = status?.providers ?? [];

  // Fill the provider drop-down
  const select = $('#ai-provider');
  select.replaceChildren(...providers.map((p) => h('option', { value: p.id }, `${p.label} · ${p.model}`)));
  const saved = storage.get('mknb.aiProvider', status?.defaultProvider);
  if (providers.some((p) => p.id === saved)) select.value = saved;
  select.addEventListener('change', () => storage.set('mknb.aiProvider', select.value));
  $('#ai-all-label').hidden = providers.length < 2; // "ask every AI" only makes sense with 2+

  $('#ai-ask-form').addEventListener('submit', async (e) => { e.preventDefault(); await ask($('#ai-question').value); });
  $('#btn-ai-sim').addEventListener('click', () => simulateAll());
  $('#ai-auto').addEventListener('change', (e) => setAuto(e.target.checked));
  $('#btn-wallet-reset').addEventListener('click', () => {
    if (!confirm('Reset ALL simulated wallets to $10,000?')) return;
    wallets = {}; saveWallets(); renderLeaderboard();
  });

  if (!providers.length) {
    $('#ai-disabled').hidden = false;
    for (const el of document.querySelectorAll('#panel-ai button, #panel-ai input, #panel-ai textarea, #panel-ai select')) {
      if (el.id !== 'btn-wallet-reset') el.disabled = true;
    }
  }
  renderLeaderboard();
}

// --------------------------------------------------------------- Ask -------
async function ask(question) {
  const out = $('#ai-answers');
  const ids = targets();
  const ctx = context();
  // One answer card per AI, filled in as each reply arrives (they run in parallel).
  out.replaceChildren(...ids.map((id) => h('div', { class: 'ai-answer loading', id: `ans-${id}` },
    h('div', { class: 'ai-who' }, labelOf(id)), h('pre', {}, '🧠 Thinking…'))));
  await Promise.all(ids.map(async (id) => {
    const card = $(`#ans-${id}`);
    try {
      const { answer, provider } = await api('/api/ai/advise', { method: 'POST', body: { ...ctx, provider: id, question } });
      card.querySelector('.ai-who').textContent = `${provider.label} · ${provider.model}`;
      card.querySelector('pre').textContent = answer; // textContent = plain text, never executed
    } catch (err) {
      card.querySelector('pre').textContent = `⚠ ${err.message}`;
    } finally {
      card.classList.remove('loading');
    }
  }));
}

// ----------------------------------------------------------- Simulate -------
async function simulateAll() {
  const ids = targets();
  const ctx = context();
  const price = ctx.bars[ctx.bars.length - 1]?.close ?? 0;
  if (price) lastPrices[ctx.symbol] = price;
  const box = $('#ai-decision');
  box.replaceChildren(...ids.map((id) => h('div', { class: 'decision-card', id: `dec-${id}` },
    h('div', { class: 'ai-who' }, labelOf(id)), h('p', { class: 'muted' }, '🤖 Deciding…'))));

  await Promise.all(ids.map(async (id) => {
    const card = $(`#dec-${id}`);
    try {
      const { decision: d, provider } = await api('/api/ai/simulate', { method: 'POST', body: { ...ctx, provider: id, scenario: $('#ai-scenario').value } });
      applyToWallet(id, ctx.symbol, d, price);
      card.replaceChildren(
        h('div', { class: 'ai-who' }, `${provider.label} · ${provider.model}`),
        h('div', { class: `decision decision-${d.action.toLowerCase()}` }, d.action),
        h('dl', { class: 'case-facts' },
          h('dt', {}, 'Confidence'), h('dd', {}, `${d.confidence}%`),
          h('dt', {}, 'Size'), h('dd', {}, `${d.position_size_pct}% of wallet`),
          h('dt', {}, 'Entry / Stop / Target'), h('dd', {}, `${d.entry} / ${d.stop_loss} / ${d.take_profit}`)),
        h('p', {}, d.reasoning),
        d.risks.length ? h('ul', { class: 'risks' }, ...d.risks.map((r) => h('li', {}, r))) : null,
      );
    } catch (err) {
      card.replaceChildren(h('div', { class: 'ai-who' }, labelOf(id)), h('p', { class: 'muted' }, `⚠ ${err.message}`));
    }
  }));
  renderLeaderboard();
}

/** Execute one AI's decision against ITS paper wallet at the current price. */
function applyToWallet(providerId, symbol, d, price) {
  if (!price) return;
  const wallet = walletFor(providerId);
  const pos = wallet.positions[symbol] ?? { qty: 0, avg: 0 };
  let note = 'held';
  if (d.action === 'BUY' || d.action === 'COVER') {
    const budget = d.action === 'COVER' ? Math.abs(Math.min(0, pos.qty)) * price : (wallet.cash * d.position_size_pct) / 100;
    const qty = Math.floor(budget / price);
    if (qty > 0 && qty * price <= wallet.cash + 1e-9) {
      pos.avg = pos.qty >= 0 ? (pos.avg * pos.qty + qty * price) / (pos.qty + qty) : pos.avg;
      pos.qty += qty; wallet.cash -= qty * price; note = `bought ${qty} @ ${price.toFixed(2)}`;
    }
  } else if (d.action === 'SELL' && pos.qty > 0) {
    const qty = pos.qty; wallet.cash += qty * price; pos.qty = 0; note = `sold ${qty} @ ${price.toFixed(2)}`;
  } else if (d.action === 'SHORT') {
    const qty = Math.floor(((wallet.cash * d.position_size_pct) / 100) / price);
    if (qty > 0) { pos.avg = price; pos.qty -= qty; wallet.cash += qty * price; note = `shorted ${qty} @ ${price.toFixed(2)}`; }
  }
  wallet.positions[symbol] = pos;
  if (pos.qty === 0) delete wallet.positions[symbol];
  wallet.log.unshift({ at: new Date().toISOString(), symbol, action: d.action, confidence: d.confidence, note });
  wallet.log = wallet.log.slice(0, 100);
  saveWallets();
}

/** Value a wallet: cash + positions marked at the latest known price. */
function equityOf(wallet) {
  let equity = wallet.cash;
  for (const [s, p] of Object.entries(wallet.positions)) equity += p.qty * (lastPrices[s] ?? p.avg);
  return equity;
}

/** Leaderboard: which AI's paper wallet is doing best + recent trades. */
function renderLeaderboard() {
  const rows = Object.entries(wallets)
    .map(([id, w]) => ({ id, w, equity: equityOf(w) }))
    .sort((a, b) => b.equity - a.equity);
  $('#wallet-summary').replaceChildren(...(rows.length ? rows.map(({ id, w, equity }, i) => {
    const pnl = equity - START_CASH;
    return h('div', { class: 'lb-row' },
      h('span', { class: 'lb-rank' }, i === 0 ? '👑' : `#${i + 1}`),
      h('span', { class: 'lb-name' }, labelOf(id)),
      h('span', {}, `$${equity.toFixed(2)}`),
      h('span', { class: pnl >= 0 ? 'up' : 'down' }, `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`),
      h('span', { class: 'muted' }, `${w.log.length} calls`));
  }) : [h('p', { class: 'muted' }, 'No simulations yet. Each AI starts with $10,000 of pretend money.')]));

  const log = rows.flatMap(({ id, w }) => w.log.map((l) => ({ ...l, id }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);
  $('#wallet-log').replaceChildren(...log.map((l) => h('li', {},
    h('time', {}, new Date(l.at).toLocaleTimeString()), ` ${labelOf(l.id)}: ${l.symbol} ${l.action} (${l.confidence}%) - ${l.note}`)));
}

function setAuto(on) {
  clearInterval(autoTimer);
  autoTimer = null;
  if (!on) return;
  const minutes = Math.max(5, Number($('#ai-auto-minutes').value) || 15); // min 5 min = cost control
  toast(`Auto-sim every ${minutes} min (simulated trades only).`, 'info', 4000);
  simulateAll();
  autoTimer = setInterval(simulateAll, minutes * 60000);
}
