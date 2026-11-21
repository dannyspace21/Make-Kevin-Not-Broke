// =============================================================================
// sources/genericFeed.js  -  adapter for any JSON feed you have access to.
// -----------------------------------------------------------------------------
// Ransom-DB, WatchGuard's Ransomware Tracker, Comparitech's Ransomware Attack
// Tracker and Darkweb IQ do NOT publish a free, documented public JSON API we
// can rely on (some sell API access, some are web pages only). Scraping their
// HTML would be brittle and may break their Terms of Service.
//
// So instead: if you have an API/export URL (and key) from one of them, put it
// in .env and this adapter will read it. It accepts an array, or an object
// with a `data` / `victims` / `results` / `items` array, and maps common field
// names onto our standard record shape.
// =============================================================================
import { fetchJson } from '../../util/http.js';

const pick = (obj, keys) => keys.map((k) => obj?.[k]).find((v) => v !== undefined && v !== null && v !== '');

/**
 * fetchGenericFeed({ label, url, apiKey }) -> standard records
 * The key is sent as both "Authorization: Bearer" and "X-API-Key" because
 * different vendors use different headers. Only sent to the URL YOU configure.
 */
export async function fetchGenericFeed({ label, url, apiKey }) {
  if (!url) return [];
  const headers = { 'User-Agent': 'MakeKevinNotBroke/1.0' };
  if (apiKey) { headers.Authorization = `Bearer ${apiKey}`; headers['X-API-Key'] = apiKey; }
  const data = await fetchJson(url, { headers });
  const rows = Array.isArray(data) ? data : pick(data, ['data', 'victims', 'results', 'items', 'attacks']) ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    name: String(pick(r, ['victim', 'company', 'organization', 'organisation', 'name', 'post_title', 'title']) ?? ''),
    domain: String(pick(r, ['domain', 'website', 'url']) ?? ''),
    group: String(pick(r, ['group', 'group_name', 'gang', 'ransomware', 'threat_actor']) ?? 'unknown'),
    discovered: pick(r, ['discovered', 'published', 'date', 'attack_date', 'attackdate', 'disclosed', 'breach_date', 'created_at']) ?? null,
    country: String(pick(r, ['country', 'country_code']) ?? ''),
    source: label,
    url: '',
  })).filter((r) => r.name && r.discovered);
}
