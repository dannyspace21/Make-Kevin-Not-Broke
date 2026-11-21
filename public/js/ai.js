// =============================================================================
// ai.js  -  the AI CO-PILOT side panel (optional - needs an AI key on the server).
// -----------------------------------------------------------------------------
// 1. "Ask"       - type a question; the AI sees the last 120 candles, your
//                  indicator values, and any ransomware/8-K case for the ticker.
// 2. "Simulate"  - the AI makes a PRETEND decision (BUY/SELL/SHORT/COVER/HOLD).
//                  It is recorded in a local paper wallet so you can see how the
//                  AI *would* have done. NO REAL ORDERS ARE EVER PLACED.
// 3. "Auto-sim"  - optionally repeat the simulation every N minutes.
// =============================================================================
import { h, $, toast, api, storage } from './ui.js';

let app = null;
let autoTimer = null;

// Paper wallet: { cash, positions: { SYMBOL: { qty, avg } }, log: [] }
let wallet = storage.get('mknb.wallet', null) ?? { cash: 10000, positions: {}, log: [] };
const saveWallet = () => storage.set('mknb.wallet', wallet);

/** Data we send to the server for the AI (numbers only - no keys, no personal data). */
function context() {
  return {
    symbol: app.getSymbol(),
    timeframe: app.getTimeframe(),
    bars: app.getBars().slice(-120),
    indicators: app.getIndicatorValues(),
  };
}

export function initAiPanel(appApi) {
  app = appApi;
  $('#ai-ask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await ask($('#ai-question').value);
  });
  $('#btn-ai-sim').addEventListener('click', () => simulate());
  $('#ai-auto').addEventListener('change', (e) => setAuto(e.target.checked));
  $('#btn-wallet-reset').addEventListener('click', () => {
    if (!confirm('Reset the simulated wallet to $10,000?')) return;
    wallet = { cash: 10000, positions: {}, log: [] }; saveWallet(); renderWallet();
  });
  if (!app.aiEnabled()) {
    $('#ai-disabled').hidden = false;
    for (const el of document.querySelectorAll('#panel-ai button, #panel-ai input, #panel-ai textarea')) {
      if (el.id !== 'btn-wallet-reset') el.disabled = true;
    }
  }
  renderWallet();
}

async function ask(question) {
  const out = $('#ai-answer');
  out.textContent = '🧠 Thinking…';
  out.classList.add('loading');
  try {
    const { answer } = await api('/api/ai/advise', { method: 'POST', body: { ...context(), question } });
    out.textContent = answer; // textContent = shown as plain text, never executed
  } catch (err) {
    out.textContent = `⚠ ${err.message}`;
  } finally {
    out.classList.remove('loading');
  }
}

async function simulate() {
  const card = $('#ai-decision');
  card.replaceChildren(h('p', { class: 'muted' }, '🤖 Running simulation…'));
  try {
    const ctx = context();
    const { decision: d } = await api('/api/ai/simulate', { method: 'POST', body: { ...ctx, scenario: $('#ai-scenario').value } });
    const price = ctx.bars[ctx.bars.length - 1]?.close ?? 0;
    applyToWallet(ctx.symbol, d, price);
    card.replaceChildren(
      h('div', { class: `decision decision-${d.action.toLowerCase()}` }, d.action),
      h('dl', { class: 'case-facts' },
        h('dt', {}, 'Confidence'), h('dd', {}, `${d.confidence}%`),
        h('dt', {}, 'Size'), h('dd', {}, `${d.position_size_pct}% of wallet`),
        h('dt', {}, 'Entry / Stop / Target'), h('dd', {}, `${d.entry} / ${d.stop_loss} / ${d.take_profit}`)),
      h('p', {}, d.reasoning),
      d.risks.length ? h('ul', { class: 'risks' }, ...d.risks.map((r) => h('li', {}, r))) : null,
    );
  } catch (err) {
    card.replaceChildren(h('p', { class: 'muted' }, `⚠ ${err.message}`));
  }
}

/** Execute the AI's decision against the PAPER wallet at the current price. */
function applyToWallet(symbol, d, price) {
  if (!price) return;
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
  saveWallet();
  renderWallet(symbol, price);
}

function renderWallet(symbol, price) {
  let equity = wallet.cash;
  for (const [s, p] of Object.entries(wallet.positions)) {
    const mark = s === symbol && price ? price : p.avg; // only the current ticker has a live price
    equity += p.qty * mark;
  }
  const pnl = equity - 10000;
  $('#wallet-summary').replaceChildren(
    h('span', {}, `Cash $${wallet.cash.toFixed(2)}`),
    h('span', { class: pnl >= 0 ? 'up' : 'down' }, `Equity $${equity.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})`),
  );
  $('#wallet-log').replaceChildren(...wallet.log.slice(0, 20).map((l) => h('li', {},
    h('time', {}, new Date(l.at).toLocaleTimeString()), ` ${l.symbol} ${l.action} (${l.confidence}%) - ${l.note}`)));
}

function setAuto(on) {
  clearInterval(autoTimer);
  autoTimer = null;
  if (!on) return;
  const minutes = Math.max(5, Number($('#ai-auto-minutes').value) || 15); // min 5 min = cost control
  toast(`Auto-sim every ${minutes} min (simulated trades only).`, 'info', 4000);
  simulate();
  autoTimer = setInterval(simulate, minutes * 60000);
}
