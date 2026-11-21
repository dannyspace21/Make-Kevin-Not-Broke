// =============================================================================
// http.js  -  safe wrapper around fetch() for calling outside APIs.
// -----------------------------------------------------------------------------
// Adds: a timeout (so a slow site can't freeze us), a response-size cap (so a
// huge/malicious response can't eat all memory), and JSON parsing.
// =============================================================================

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB is far above any feed we use

/**
 * fetchJson(url, { headers, timeoutMs }) -> parsed JSON
 * Throws an Error with the HTTP status on failure.
 */
export async function fetchJson(url, { headers = {}, timeoutMs = 20000, method = 'GET', body } = {}) {
  // Only allow http(s) URLs (blocks file:, data:, etc.).
  const u = new URL(url);
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error(`blocked protocol ${u.protocol}`);

  const res = await fetch(u, {
    method,
    headers: { Accept: 'application/json', ...headers },
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Read the body as text with a size limit.
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`response too large (${len} bytes) from ${u.host}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`response too large from ${u.host}`);

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${u.host}${u.pathname}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${u.host}${u.pathname}`);
  }
}

/** Promise-based sleep, used for polite rate limiting. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
