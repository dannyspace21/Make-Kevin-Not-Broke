// =============================================================================
// ui.js  -  tiny helpers for building HTML safely + toasts + modals + storage.
// -----------------------------------------------------------------------------
// SECURITY: we NEVER build HTML from strings (no innerHTML with data). The h()
// helper creates elements and sets text with textContent, so a malicious
// company name like "<img onerror=...>" is displayed as plain text instead of
// being executed (prevents XSS - cross-site scripting).
// =============================================================================

/**
 * h('div', { class: 'x', onclick: fn }, 'text', childEl) -> <div class="x">text<child/></div>
 * Attributes starting with "on" become event listeners; everything else is
 * set with setAttribute. Children can be strings (safe text) or elements.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    // style objects go through the CSSOM (allowed by our strict CSP, unlike style="" strings)
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Shortcut for document.querySelector */
export const $ = (sel, root = document) => root.querySelector(sel);

/** Show a toast notification in the bottom-right corner. kind: info|warn|alert|ok */
export function toast(message, kind = 'info', ms = 6000) {
  const box = $('#toasts');
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, message);
  box.prepend(el);
  setTimeout(() => el.classList.add('fade'), ms - 400);
  setTimeout(() => el.remove(), ms);
}

/** Open a <dialog> modal and fill its body. Returns the dialog element. */
export function openModal(title, ...content) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(...content);
  if (!dlg.open) dlg.showModal();
  return dlg;
}
export const closeModal = () => $('#modal').close();

/** localStorage wrappers that never crash (private mode / blocked storage). */
export const storage = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked - ignore */ }
  },
};

/** Fetch JSON from our own API with a friendly error message. */
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    // X-MKNB-Request proves the call came from our own page (CSRF protection, see server.js)
    headers: { 'X-MKNB-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

/** Short unique id for indicators. */
export const uid = () => Math.random().toString(36).slice(2, 10);
