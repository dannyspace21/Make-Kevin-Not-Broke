// =============================================================================
// sources/ransomwareLive.js  -  CLAIMS source #1: Ransomware.live
// -----------------------------------------------------------------------------
// Ransomware.live monitors ransomware gang leak sites and offers a free JSON
// API. We pull the most recent victims. Field names have changed between API
// versions, so we accept several spellings for each field.
// API: https://api.ransomware.live  (free tier is rate-limited - poll gently)
// =============================================================================
import { fetchJson } from '../../util/http.js';

const URL_V2 = 'https://api.ransomware.live/v2/recentvictims';

/** Returns [{ name, domain, group, discovered, country, source, url }] */
export async function fetchRansomwareLive() {
  const data = await fetchJson(URL_V2, { headers: { 'User-Agent': 'MakeKevinNotBroke/1.0' } });
  const rows = Array.isArray(data) ? data : Array.isArray(data?.victims) ? data.victims : [];
  return rows.map((r) => ({
    name: r.victim ?? r.post_title ?? r.name ?? '',
    domain: r.domain ?? r.website ?? '',
    group: r.group ?? r.group_name ?? 'unknown',
    discovered: r.discovered ?? r.published ?? r.attackdate ?? r.date ?? null,
    country: r.country ?? '',
    source: 'Ransomware.live',
    url: typeof r.permalink === 'string' ? r.permalink : '',
  })).filter((r) => r.name && r.discovered);
}
