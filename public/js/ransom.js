// =============================================================================
// ransom.js  -  the "8-K WATCHDOG" side panel + alert feed.
// -----------------------------------------------------------------------------
// Shows every tracked ransomware case with:
//   * a coloured status badge (OVERDUE, DEADLINE SOON, DISCLOSED LATE ...)
//   * a 4-segment "clock" bar showing business days used of the 4 allowed
//   * a clear YES / NO / PENDING for "disclosed within 4 business days?"
// Clicking a case loads that ticker on the chart (indicators stay on).
// =============================================================================
import { h, $, toast, api } from './ui.js';

let app = null;

const STATUS_LABEL = {
  CLOCK_RUNNING: 'CLOCK RUNNING',
  DEADLINE_SOON: 'DEADLINE SOON',
  OVERDUE: 'OVERDUE - NO 8-K',
  POSSIBLE_DISCLOSURE: 'POSSIBLE 8-K',
  DISCLOSED_ON_TIME: 'DISCLOSED ON TIME',
  DISCLOSED_LATE: 'DISCLOSED LATE',
};

export function initRansomPanel(appApi) {
  app = appApi;
  $('#btn-ransom-refresh').addEventListener('click', async () => {
    try { await api('/api/ransom/refresh', { method: 'POST' }); toast('Watchdog refresh started…', 'info', 2500); } catch (e) { toast(e.message, 'warn'); }
  });
  $('#ransom-filter').addEventListener('change', refreshRansom);
  refreshRansom();
}

/** Called by app.js when the server pushes a new alert. */
export function onRansomAlert(alert) {
  if (alert.kind === 'NEW_CASE') return; // shown in the list, no popup
  const kind = alert.status === 'OVERDUE' || alert.status === 'DISCLOSED_LATE' ? 'alert' : 'warn';
  toast(`🚨 ${alert.message}`, kind, 12000);
  bumpAlertBadge();
  refreshRansom();
}

function bumpAlertBadge() {
  const b = $('#alert-badge');
  b.textContent = String((Number(b.textContent) || 0) + 1);
  b.hidden = false;
}

/** "Disclosed within 4 business days?" indicator. */
function disclosureFlag(c) {
  if (c.disclosedInTime === true) return h('span', { class: 'flag flag-yes' }, '✔ DISCLOSED ≤ 4 DAYS');
  if (c.disclosedInTime === false) return h('span', { class: 'flag flag-no' }, '✖ NOT DISCLOSED IN 4 DAYS');
  return h('span', { class: 'flag flag-pending' }, '⏳ PENDING');
}

/** 4 little boxes; filled = business day used. Red when past day 4. */
function clockBar(c) {
  const used = c.businessDaysElapsed;
  // "late" = deadline passed without an 8-K, or the 8-K came after the deadline
  const late = used > 4 || c.status === 'OVERDUE' || c.disclosedInTime === false;
  const cells = [1, 2, 3, 4].map((d) => h('span', { class: `clock-cell ${used >= d ? 'used' : ''} ${late ? 'over' : ''}` }));
  return h('div', { class: 'clock', title: `${used} business day(s) since leak-site claim` }, ...cells,
    h('span', { class: 'clock-label' }, used > 4 ? `DAY ${used} (+${used - 4} LATE)` : c.status === 'OVERDUE' ? 'DEADLINE PASSED' : `DAY ${used}/4`));
}

export async function refreshRansom() {
  let data;
  try { data = await api('/api/ransom'); } catch (err) { $('#ransom-list').replaceChildren(h('p', { class: 'muted' }, err.message)); return; }

  const filter = $('#ransom-filter').value;
  const cases = data.cases.filter((c) => filter === 'all'
    || (filter === 'alerts' && ['OVERDUE', 'DEADLINE_SOON', 'DISCLOSED_LATE', 'POSSIBLE_DISCLOSURE'].includes(c.status))
    || (filter === 'open' && ['CLOCK_RUNNING', 'DEADLINE_SOON', 'OVERDUE'].includes(c.status)));

  $('#ransom-meta').replaceChildren(
    data.mode === 'demo' ? h('span', { class: 'pill pill-warn' }, 'DEMO - FICTIONAL COMPANIES') : null,
    h('span', { class: 'muted' }, data.lastRun ? ` Last scan ${new Date(data.lastRun).toLocaleString()}` : ' Waiting for first scan…'),
  );
  $('#ransom-sources').replaceChildren(...Object.entries(data.sourceStatus || {}).map(([k, v]) =>
    h('li', { class: String(v).startsWith('ok') ? 'src-ok' : String(v).startsWith('error') ? 'src-bad' : 'src-off' }, `${k}: ${v}`)));

  $('#ransom-list').replaceChildren(...(cases.length ? cases.map((c) => h('article', {
    class: `case case-${c.status.toLowerCase()}`, tabindex: 0, title: 'Click to open chart',
    onclick: () => app.setSymbol(c.ticker),
    onkeydown: (e) => { if (e.key === 'Enter') app.setSymbol(c.ticker); },
  },
  h('header', {},
    h('span', { class: 'case-ticker' }, c.ticker),
    h('span', { class: `badge badge-${c.status.toLowerCase()}` }, STATUS_LABEL[c.status] ?? c.status)),
  h('div', { class: 'case-company' }, c.company),
  clockBar(c),
  disclosureFlag(c),
  h('dl', { class: 'case-facts' },
    h('dt', {}, 'Leak claim'), h('dd', {}, `${c.claimDate} · ${c.group}`),
    h('dt', {}, '8-K deadline'), h('dd', {}, c.deadline),
    h('dt', {}, 'Filing'), h('dd', {}, c.filing ? `${c.filing.form} items ${c.filing.items} on ${c.filing.date}` : 'none found'),
    h('dt', {}, 'Verified by'), h('dd', {}, c.verifiedBy?.length ? c.verifiedBy.join(', ') : 'leak site only (unverified)'),
    h('dt', {}, 'Sources'), h('dd', {}, c.sources)),
  h('p', { class: 'case-signal' }, c.signal),
  c.filing?.url ? h('a', { href: c.filing.url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, 'Open SEC filing ↗') : null))
    : [h('p', { class: 'muted' }, 'No matching cases.')]));

  // Alerts tab
  $('#alert-list').replaceChildren(...(data.alerts.length ? data.alerts.map((a) => h('li', { class: `alert-item alert-${a.status.toLowerCase()}` },
    h('time', {}, new Date(a.at).toLocaleString()),
    h('button', { class: 'link', onclick: () => app.setSymbol(a.ticker) }, a.ticker),
    h('span', {}, ` ${a.kind.replace(/_/g, ' ')} - ${a.company}`)))
    : [h('li', { class: 'muted' }, 'No alerts yet.')]));
}
