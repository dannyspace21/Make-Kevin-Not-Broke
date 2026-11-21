// =============================================================================
// app.js  -  MAIN BROWSER CONTROLLER. Wires everything together.
// -----------------------------------------------------------------------------
//  state  ->  what ticker/timeframe/indicators are selected (saved in localStorage
//             so they survive reloads AND ticker changes)
//  loadBars()            -> downloads candles, then recomputes every indicator
//  recomputeIndicators() -> runs built-ins directly, custom code in the sandbox
//  connectSocket()       -> live ticks + ransomware alerts from our server
// =============================================================================
import { ChartManager } from './chart.js';
import { BUILTIN_INDICATORS, getBuiltin, defaultParams, sanitizeParams } from './indicators.js';
import { h, $, toast, openModal, closeModal, storage, api, uid } from './ui.js';
import { initRansomPanel, onRansomAlert, refreshRansom } from './ransom.js';
import { initAiPanel } from './ai.js';

// ---------------------------------------------------------------- state -----
const TIMEFRAMES = ['1Min', '5Min', '15Min', '30Min', '1Hour', '4Hour', '1Day'];
const TF_SECONDS = { '1Min': 60, '5Min': 300, '15Min': 900, '30Min': 1800, '1Hour': 3600, '4Hour': 14400, '1Day': 86400 };

const state = {
  symbol: storage.get('mknb.symbol', 'AAPL'),
  timeframe: storage.get('mknb.timeframe', '5Min'),
  bars: [],
  // Active indicators: [{ uid, kind:'builtin'|'custom', ref, params, colors, visible }]
  indicators: storage.get('mknb.indicators', null) ?? [
    { uid: uid(), kind: 'builtin', ref: 'ema', params: { length: 9 }, colors: ['#ff2a6d'], visible: true },
    { uid: uid(), kind: 'builtin', ref: 'bb', params: { length: 20, mult: 2 }, colors: ['#b967ff', '#05ffa1', '#b967ff'], visible: true },
    { uid: uid(), kind: 'builtin', ref: 'rsi', params: { length: 14 }, colors: ['#b967ff'], visible: true },
  ],
  // Saved custom indicator definitions: [{ id, name, pane, inputs:{k:v}, code }]
  customLib: storage.get('mknb.customLib', []),
  watchlist: storage.get('mknb.watchlist', ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY']),
  lastComputed: [], // computed indicator items (for legend + AI context)
  errors: {}, //       uid -> error message for indicators that failed
  status: {},
};
if (!TIMEFRAMES.includes(state.timeframe)) state.timeframe = '5Min';

const save = () => {
  storage.set('mknb.symbol', state.symbol);
  storage.set('mknb.timeframe', state.timeframe);
  storage.set('mknb.indicators', state.indicators);
  storage.set('mknb.customLib', state.customLib);
  storage.set('mknb.watchlist', state.watchlist);
};

const chart = new ChartManager($('#chart'));

// ------------------------------------------------ custom-code sandbox -------
// One Web Worker runs custom indicator code. If a script takes longer than
// 2 seconds (infinite loop?) we kill the worker and start a fresh one.
class Sandbox {
  constructor() { this.spawn(); this.seq = 0; this.queue = Promise.resolve(); }
  spawn() { this.worker = new Worker('/js/indicator-worker.js', { type: 'module' }); }
  run(code, bars, params) {
    // queue: one job at a time so replies can't get mixed up
    const job = () => new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.worker.terminate(); this.spawn();
        resolve({ ok: false, error: 'Timed out after 2s (infinite loop?)' });
      }, 2000);
      this.worker.onmessage = (e) => { if (e.data.id === id) { clearTimeout(timer); resolve(e.data); } };
      this.worker.onerror = (e) => { clearTimeout(timer); e.preventDefault(); resolve({ ok: false, error: e.message || 'Worker error' }); };
      this.worker.postMessage({ id, code, bars, params });
    });
    this.queue = this.queue.then(job, job);
    return this.queue;
  }
}
const sandbox = new Sandbox();

/** Parse the "inputs" text of a custom indicator ("fast=9\nslow=21") into numbers. */
function parseInputs(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_]\w{0,30})\s*=\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// ------------------------------------------------ indicator engine ----------
/** Human label for an active indicator, e.g. "EMA (9)". */
function labelOf(ind) {
  if (ind.kind === 'builtin') {
    const def = getBuiltin(ind.ref);
    const args = def.params.map((p) => ind.params[p.key]).join(', ');
    return `${def.short}${args ? ` (${args})` : ''}`;
  }
  const c = state.customLib.find((x) => x.id === ind.ref);
  return c ? `⚡ ${c.name}` : '⚡ (deleted)';
}

/** Compute ONE indicator -> { uid, pane, plots, levels } or null on error. */
async function computeOne(ind, bars) {
  if (ind.kind === 'builtin') {
    const def = getBuiltin(ind.ref);
    if (!def) return null;
    const params = sanitizeParams(def, ind.params);
    const colors = def.colors.map((c, i) => ind.colors?.[i] || c);
    return { uid: ind.uid, pane: def.pane, levels: def.levels, plots: def.compute(bars, params, colors) };
  }
  const custom = state.customLib.find((x) => x.id === ind.ref);
  if (!custom) throw new Error('Custom indicator was deleted.');
  const res = await sandbox.run(custom.code, bars, { ...parseInputs(custom.inputs), ...ind.params });
  if (!res.ok) throw new Error(res.error);
  const palette = ['#00f0ff', '#ff2a6d', '#05ffa1', '#f9f871', '#b967ff', '#ffb800', '#ff6ec7', '#ffffff'];
  return { uid: ind.uid, pane: custom.pane, plots: res.plots.map((p, i) => ({ ...p, color: p.color || ind.colors?.[i] || palette[i % palette.length] })) };
}

let computing = false;
let pendingRebuild = false;

/**
 * Recompute every visible indicator.
 * rebuild=true  -> recreate chart series (list/params changed or new ticker)
 * rebuild=false -> just push new numbers (live tick)
 */
async function recomputeIndicators(rebuild = true) {
  if (computing) { pendingRebuild ||= rebuild; return; }
  computing = true;
  try {
    const bars = state.bars;
    const items = [];
    for (const ind of state.indicators) {
      if (!ind.visible || bars.length === 0) continue;
      try {
        const item = await computeOne(ind, bars);
        if (item) items.push(item);
        delete state.errors[ind.uid];
      } catch (err) {
        state.errors[ind.uid] = err.message;
      }
    }
    state.lastComputed = items;
    if (rebuild || !chart.updateIndicatorPlots(items, bars)) chart.setIndicatorPlots(items, bars);
    renderLegend();
  } finally {
    computing = false;
    if (pendingRebuild) { pendingRebuild = false; recomputeIndicators(true); }
  }
}

/** Latest value of every plot -> { "RSI 14": 55.2, ... } (used by the AI panel). */
function latestIndicatorValues() {
  const out = {};
  for (const item of state.lastComputed) {
    for (const plot of item.plots) {
      for (let i = plot.values.length - 1; i >= 0; i--) {
        if (plot.values[i] !== null) { out[plot.name] = plot.values[i]; break; }
      }
    }
  }
  return out;
}

// ------------------------------------------------ data loading --------------
let loadToken = 0; // ignore responses from an older ticker if the user typed fast

async function loadBars() {
  const token = ++loadToken;
  $('#chart-status').textContent = `Loading ${state.symbol}…`;
  try {
    const data = await api(`/api/bars?symbol=${encodeURIComponent(state.symbol)}&timeframe=${state.timeframe}`);
    if (token !== loadToken) return;
    state.bars = data.bars;
    chart.setBars(state.bars);
    $('#chart-status').textContent = data.bars.length ? '' : `No data for ${state.symbol} on ${state.timeframe}`;
    updateQuote();
    await recomputeIndicators(true); // <- the SAME indicators are re-applied to the new ticker
  } catch (err) {
    if (token !== loadToken) return;
    $('#chart-status').textContent = err.message;
    toast(err.message, 'warn');
  }
}

/** Switch ticker: indicators are kept, only the data changes. */
function setSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) { toast('That does not look like a ticker symbol.', 'warn'); return; }
  if (s === state.symbol && state.bars.length) return;
  sendWs({ type: 'unsubscribe', symbol: state.symbol });
  state.symbol = s;
  if (!state.watchlist.includes(s)) { state.watchlist.unshift(s); state.watchlist = state.watchlist.slice(0, 12); }
  save();
  $('#ticker-input').value = s;
  renderWatchlist();
  sendWs({ type: 'subscribe', symbol: s });
  loadBars();
}

function setTimeframe(tf) {
  if (!TIMEFRAMES.includes(tf)) return;
  state.timeframe = tf;
  save();
  renderTimeframes();
  loadBars();
}

/** Header price + change since previous candle. */
function updateQuote() {
  const b = state.bars;
  const last = b[b.length - 1];
  const prev = b[b.length - 2];
  $('#quote-symbol').textContent = state.symbol;
  if (!last) { $('#quote-price').textContent = '--'; $('#quote-change').textContent = ''; return; }
  $('#quote-price').textContent = last.close.toFixed(2);
  if (prev) {
    const ch = last.close - prev.close;
    const pct = (ch / prev.close) * 100;
    const el = $('#quote-change');
    el.textContent = `${ch >= 0 ? '+' : ''}${ch.toFixed(2)} (${pct.toFixed(2)}%)`;
    el.className = ch >= 0 ? 'up' : 'down';
  }
}

// ------------------------------------------------ live websocket ------------
let ws = null;
let wsRetry = 0;

function sendWs(obj) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsRetry = 0; setPill('#pill-stream', 'STREAM ON', 'ok'); sendWs({ type: 'subscribe', symbol: state.symbol }); };
  ws.onclose = () => {
    setPill('#pill-stream', 'STREAM OFF', 'bad');
    setTimeout(connectSocket, Math.min(30000, 1000 * 2 ** wsRetry++)); // reconnect with back-off
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'tick' && msg.data.symbol === state.symbol) onTick(msg.data);
    else if (msg.type === 'ransomAlert') onRansomAlert(msg.data);
    else if (msg.type === 'ransomUpdate') refreshRansom();
    else if (msg.type === 'streamStatus') toast(`Market stream: ${msg.data}`, 'warn');
    else if (msg.type === 'error') toast(msg.data, 'warn');
  };
}

let tickTimer = null;
/** Merge a live trade/bar into the newest candle for the current timeframe. */
function onTick(t) {
  const bars = state.bars;
  if (!bars.length) return;
  const step = TF_SECONDS[state.timeframe];
  const bucket = Math.floor(t.time / step) * step;
  const last = bars[bars.length - 1];
  if (bucket < last.time) return; // older than our newest candle - ignore

  if (t.type === 'bar' && state.timeframe === '1Min') {
    // Alpaca's finished 1-minute bar is authoritative for the 1Min chart
    const bar = { time: bucket, open: t.open, high: t.high, low: t.low, close: t.close, volume: t.volume };
    if (bucket === last.time) bars[bars.length - 1] = bar; else bars.push(bar);
  } else if (t.type === 'trade') {
    if (bucket === last.time) {
      last.high = Math.max(last.high, t.price);
      last.low = Math.min(last.low, t.price);
      last.close = t.price;
      last.volume += t.size;
    } else {
      bars.push({ time: bucket, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.size });
    }
  } else {
    return;
  }
  if (bars.length > 2000) bars.splice(0, bars.length - 2000); // memory cap
  chart.updateBar(bars[bars.length - 1]);
  updateQuote();
  // Recompute indicators at most once per second (ticks can arrive very fast).
  if (!tickTimer) tickTimer = setTimeout(() => { tickTimer = null; recomputeIndicators(false); }, 1000);
}

// ------------------------------------------------ rendering: header ---------
function setPill(sel, text, kind) {
  const el = $(sel);
  el.textContent = text;
  el.className = `pill pill-${kind}`;
}

function renderTimeframes() {
  $('#timeframes').replaceChildren(...TIMEFRAMES.map((tf) => h('button', {
    class: `tf ${tf === state.timeframe ? 'active' : ''}`, onclick: () => setTimeframe(tf), title: `Timeframe ${tf}`,
  }, tf.replace('Min', 'm').replace('Hour', 'H').replace('Day', 'D'))));
}

function renderWatchlist() {
  $('#watchlist').replaceChildren(...state.watchlist.map((s) => h('li', {},
    h('button', { class: `wl-item ${s === state.symbol ? 'active' : ''}`, onclick: () => setSymbol(s) }, s),
    h('button', {
      class: 'wl-x', title: `Remove ${s}`,
      onclick: () => { state.watchlist = state.watchlist.filter((x) => x !== s); save(); renderWatchlist(); },
    }, '×'))));
}

// ------------------------------------------------ rendering: legend ---------
// The overlay in the chart's top-left corner listing active indicators with
// [eye] [gear] [x] buttons, like TradingView.
function renderLegend() {
  const rows = state.indicators.map((ind) => {
    const err = state.errors[ind.uid];
    const computed = state.lastComputed.find((x) => x.uid === ind.uid);
    const lastVals = computed?.plots.map((p) => {
      const v = [...p.values].reverse().find((x) => x !== null);
      return h('span', { class: 'legend-val', style: { color: p.color } }, v === undefined ? '–' : formatNum(v));
    }) ?? [];
    return h('div', { class: `legend-row ${ind.visible ? '' : 'hidden'} ${err ? 'error' : ''}`, title: err || '' },
      h('span', { class: 'legend-name' }, labelOf(ind)),
      ...lastVals,
      err ? h('span', { class: 'legend-err' }, '⚠ error') : null,
      h('button', { class: 'icon', title: ind.visible ? 'Hide' : 'Show', onclick: () => { ind.visible = !ind.visible; save(); recomputeIndicators(true); } }, ind.visible ? '👁' : '◌'),
      h('button', { class: 'icon', title: 'Settings', onclick: () => openSettings(ind) }, '⚙'),
      h('button', { class: 'icon', title: 'Remove', onclick: () => removeIndicator(ind.uid) }, '✕'));
  });
  $('#legend').replaceChildren(...rows);
  $('#indicator-count').textContent = String(state.indicators.length);
}

const formatNum = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(3));

// ------------------------------------------------ indicator actions ---------
function addBuiltin(def) {
  state.indicators.push({ uid: uid(), kind: 'builtin', ref: def.id, params: defaultParams(def), colors: [...def.colors], visible: true });
  save();
  recomputeIndicators(true);
  toast(`${def.short} added`, 'ok', 2500);
}

function addCustom(custom) {
  state.indicators.push({ uid: uid(), kind: 'custom', ref: custom.id, params: {}, colors: [], visible: true });
  save();
  recomputeIndicators(true);
  toast(`${custom.name} added`, 'ok', 2500);
}

function removeIndicator(id) {
  state.indicators = state.indicators.filter((i) => i.uid !== id);
  delete state.errors[id];
  save();
  recomputeIndicators(true);
}

/** "Indicators" dialog: search + click to add. No limit on how many. */
function openIndicatorPicker() {
  const list = h('div', { class: 'picker-list' });
  const search = h('input', { type: 'search', placeholder: 'Search indicators…', class: 'input', 'aria-label': 'Search indicators' });
  const render = () => {
    const q = search.value.toLowerCase();
    const builtins = BUILTIN_INDICATORS.filter((d) => d.name.toLowerCase().includes(q));
    const customs = state.customLib.filter((c) => c.name.toLowerCase().includes(q));
    list.replaceChildren(
      h('div', { class: 'picker-head' }, 'BUILT-IN'),
      ...builtins.map((d) => h('button', { class: 'picker-item', onclick: () => addBuiltin(d) },
        h('span', {}, d.name), h('span', { class: 'tag' }, d.pane === 'overlay' ? 'overlay' : 'pane'))),
      h('div', { class: 'picker-head' }, 'MY CUSTOM INDICATORS'),
      customs.length ? null : h('div', { class: 'muted' }, 'None yet - click "+ Create custom".'),
      ...customs.map((c) => h('div', { class: 'picker-row' },
        h('button', { class: 'picker-item', onclick: () => addCustom(c) }, h('span', {}, `⚡ ${c.name}`), h('span', { class: 'tag' }, c.pane)),
        h('button', { class: 'icon', title: 'Edit', onclick: () => openCustomEditor(c) }, '✎'),
        h('button', {
          class: 'icon', title: 'Delete',
          onclick: () => {
            if (!confirm(`Delete custom indicator "${c.name}"?`)) return;
            state.customLib = state.customLib.filter((x) => x.id !== c.id);
            state.indicators = state.indicators.filter((i) => i.ref !== c.id);
            save(); render(); recomputeIndicators(true);
          },
        }, '🗑'))),
    );
  };
  search.addEventListener('input', render);
  render();
  openModal('Indicators', search, list,
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-pink', onclick: () => openCustomEditor() }, '+ Create custom')));
  search.focus();
}

/** Settings dialog for one active indicator (params + colours). */
function openSettings(ind) {
  const fields = [];
  if (ind.kind === 'builtin') {
    const def = getBuiltin(ind.ref);
    for (const p of def.params) {
      fields.push(h('label', { class: 'field' }, p.label,
        h('input', { class: 'input', type: 'number', name: p.key, value: ind.params[p.key] ?? p.default, min: p.min, max: p.max, step: p.step })));
    }
    def.colors.forEach((c, i) => fields.push(h('label', { class: 'field' }, `Colour ${i + 1}`,
      h('input', { type: 'color', name: `color${i}`, value: ind.colors?.[i] || c }))));
  } else {
    const custom = state.customLib.find((x) => x.id === ind.ref);
    const inputs = { ...parseInputs(custom?.inputs), ...ind.params };
    for (const [k, v] of Object.entries(inputs)) {
      fields.push(h('label', { class: 'field' }, k, h('input', { class: 'input', type: 'number', name: k, value: v, step: 'any' })));
    }
    if (!fields.length) fields.push(h('p', { class: 'muted' }, 'This custom indicator has no inputs. Edit it from the Indicators menu.'));
  }
  const form = h('form', { class: 'settings-form', method: 'dialog' }, ...fields,
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'submit' }, 'Apply')));
  form.addEventListener('submit', () => {
    const data = new FormData(form);
    const params = {};
    const colors = [];
    for (const [k, v] of data.entries()) {
      if (k.startsWith('color')) colors[Number(k.slice(5))] = String(v);
      else params[k] = Number(v);
    }
    ind.params = ind.kind === 'builtin' ? sanitizeParams(getBuiltin(ind.ref), params) : params;
    if (colors.length) ind.colors = colors;
    save();
    recomputeIndicators(true);
  });
  openModal(`Settings - ${labelOf(ind)}`, form);
}

// ------------------------------------------------ custom indicator editor ---
const TEMPLATE = `// ==== Your custom indicator ===================================
// Available variables:
//   bars   -> array of { time, open, high, low, close, volume }
//   params -> numbers from the "Inputs" box (e.g. params.fast)
//   ta     -> helpers: ta.sma, ta.ema, ta.wma, ta.rma, ta.rsi,
//             ta.stdev, ta.highest, ta.lowest, ta.change, ta.sub
// Return EITHER an array of numbers (one per bar, null = no value)
// OR an array of plots: [{ name, values, color: '#rrggbb', style: 'line'|'histogram' }]
// Code runs in a locked sandbox: no internet, no page access, 2s limit.

const closes = bars.map(b => b.close);
const fast = ta.ema(closes, params.fast);
const slow = ta.ema(closes, params.slow);

return [
  { name: 'Fast EMA', values: fast, color: '#00f0ff' },
  { name: 'Slow EMA', values: slow, color: '#ff2a6d' },
];`;

function openCustomEditor(existing = null) {
  const name = h('input', { class: 'input', value: existing?.name ?? 'My EMA Cross', maxlength: 40, 'aria-label': 'Name' });
  const pane = h('select', { class: 'input', 'aria-label': 'Pane' },
    h('option', { value: 'overlay' }, 'Overlay (on price chart)'),
    h('option', { value: 'separate' }, 'Separate pane (below)'));
  pane.value = existing?.pane ?? 'overlay';
  const inputs = h('textarea', { class: 'input code', rows: 3, spellcheck: 'false', 'aria-label': 'Inputs' });
  inputs.value = existing?.inputs ?? 'fast=9\nslow=21';
  const code = h('textarea', { class: 'input code', rows: 16, spellcheck: 'false', 'aria-label': 'Code' });
  code.value = existing?.code ?? TEMPLATE;
  const out = h('pre', { class: 'test-output' }, 'Click "Test" to run against the current chart.');
  // Tab key inserts two spaces instead of leaving the textarea.
  code.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end');
  });

  const test = async () => {
    out.textContent = 'Running…';
    const res = await sandbox.run(code.value, state.bars, parseInputs(inputs.value));
    if (!res.ok) { out.textContent = `❌ ${res.error}`; out.className = 'test-output bad'; return false; }
    out.className = 'test-output ok';
    out.textContent = `✅ OK - ${res.plots.length} plot(s):\n${res.plots.map((p) => {
      const v = [...p.values].reverse().find((x) => x !== null);
      return `  ${p.name}: last = ${v ?? 'n/a'}`;
    }).join('\n')}`;
    return true;
  };

  const saveIt = async (andAdd) => {
    if (!(await test())) return;
    const entry = { id: existing?.id ?? uid(), name: name.value.trim().slice(0, 40) || 'Custom', pane: pane.value, inputs: inputs.value, code: code.value };
    const idx = state.customLib.findIndex((c) => c.id === entry.id);
    if (idx >= 0) state.customLib[idx] = entry; else state.customLib.push(entry);
    save();
    if (andAdd) addCustom(entry); else recomputeIndicators(true);
    closeModal();
  };

  openModal(existing ? `Edit: ${existing.name}` : 'Create custom indicator',
    h('div', { class: 'editor-grid' },
      h('label', { class: 'field' }, 'Name', name),
      h('label', { class: 'field' }, 'Where to draw', pane)),
    h('label', { class: 'field' }, 'Inputs (one per line: name=number)', inputs),
    h('label', { class: 'field' }, 'JavaScript', code),
    out,
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: test }, '▶ Test'),
      h('button', { class: 'btn', onclick: () => saveIt(false) }, 'Save'),
      existing ? null : h('button', { class: 'btn btn-pink', onclick: () => saveIt(true) }, 'Save & add to chart')));
}

// ------------------------------------------------ sidebar tabs --------------
function initTabs() {
  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === btn.dataset.panel));
    });
  }
}

// ------------------------------------------------ boot ----------------------
async function boot() {
  $('#ticker-input').value = state.symbol;
  $('#ticker-form').addEventListener('submit', (e) => { e.preventDefault(); setSymbol($('#ticker-input').value); });
  $('#btn-indicators').addEventListener('click', openIndicatorPicker);
  $('#btn-custom').addEventListener('click', () => openCustomEditor());
  $('#modal-close').addEventListener('click', closeModal);
  renderTimeframes();
  renderWatchlist();
  initTabs();

  try {
    state.status = await api('/api/status');
    setPill('#pill-mode', state.status.marketMode === 'live' ? `LIVE · ${state.status.feed.toUpperCase()}` : 'DEMO DATA', state.status.marketMode === 'live' ? 'ok' : 'warn');
    setPill('#pill-ai', state.status.ai.enabled ? `AI · ${state.status.ai.provider}` : 'AI OFF', state.status.ai.enabled ? 'ok' : 'off');
    if (state.status.marketMode === 'demo') toast('DEMO mode: prices are simulated. Add your Alpaca keys to .env for live data.', 'warn', 9000);
  } catch (err) {
    toast(err.message, 'warn');
  }

  // Give the side panels a small API to read chart state / switch tickers.
  const appApi = {
    getSymbol: () => state.symbol,
    getTimeframe: () => state.timeframe,
    getBars: () => state.bars,
    getIndicatorValues: latestIndicatorValues,
    setSymbol,
    aiEnabled: () => Boolean(state.status.ai?.enabled),
  };
  initRansomPanel(appApi);
  initAiPanel(appApi);

  connectSocket();
  await loadBars();
}

boot();
