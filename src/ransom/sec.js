// =============================================================================
// ransom/sec.js  -  the SOURCE OF TRUTH: SEC EDGAR filings.
// -----------------------------------------------------------------------------
// Two free, official SEC endpoints (no key needed, but SEC REQUIRES a
// descriptive User-Agent with contact info and max 10 requests/second):
//
//  1. https://www.sec.gov/files/company_tickers.json
//       -> every listed company: { cik_str, ticker, title }
//       We use it to answer "is this ransomware victim a U.S.-listed company,
//       and what is its ticker?"
//
//  2. https://data.sec.gov/submissions/CIK##########.json
//       -> that company's recent filings, incl. form type and 8-K item numbers.
//       Item 1.05 = "Material Cybersecurity Incidents" (the 4-business-day rule)
//       Item 8.01 / 7.01 = "Other events" / "Reg FD" - companies sometimes use
//       these for voluntary (not-yet-material) cyber disclosures, so we flag
//       them as "possible disclosure - verify".
// =============================================================================
import { config } from '../config.js';
import { fetchJson, sleep } from '../util/http.js';
import { log } from '../util/logger.js';
import { normalizeName, domainRoot, compact } from './normalize.js';

const DAY = 86400000;
let tickerIndex = null; // { byName: Map, byCompact: Map, loadedAt }
const submissionsCache = new Map(); // cik -> { at, data }
let lastSecCall = 0;

/** Polite throttle: at most ~5 SEC requests per second (limit is 10). */
async function secFetch(url) {
  const wait = lastSecCall + 200 - Date.now();
  if (wait > 0) await sleep(wait);
  lastSecCall = Date.now();
  return fetchJson(url, { headers: { 'User-Agent': config.ransom.secUserAgent, 'Accept-Encoding': 'gzip, deflate' } });
}

/** Download (once a day) and index the SEC company/ticker list. */
export async function loadTickerIndex() {
  if (tickerIndex && Date.now() - tickerIndex.loadedAt < DAY) return tickerIndex;
  const json = await secFetch('https://www.sec.gov/files/company_tickers.json');
  const byName = new Map();
  const byCompact = new Map();
  for (const row of Object.values(json)) {
    const entry = { cik: Number(row.cik_str), ticker: String(row.ticker).toUpperCase(), title: String(row.title) };
    const key = normalizeName(entry.title);
    // The first ticker listed for a company is usually its main share class.
    if (key && !byName.has(key)) byName.set(key, entry);
    const c = key.replace(/ /g, '');
    if (c.length >= 4 && !byCompact.has(c)) byCompact.set(c, entry);
  }
  tickerIndex = { byName, byCompact, loadedAt: Date.now() };
  log.info('sec', `ticker index loaded (${byName.size} companies)`);
  return tickerIndex;
}

/**
 * Try to match a leak-site victim to a listed company.
 * Returns { cik, ticker, title, matchType } or null.
 * We stay conservative to avoid false alarms: exact normalized name, or the
 * website domain equals the company's compacted name (>= 4 chars).
 */
export function matchCompany(index, victim) {
  const key = normalizeName(victim.name);
  if (key && index.byName.has(key)) return { ...index.byName.get(key), matchType: 'exact-name' };
  const cName = compact(victim.name);
  if (cName.length >= 4 && index.byCompact.has(cName)) return { ...index.byCompact.get(cName), matchType: 'compact-name' };
  const root = domainRoot(victim.domain || (victim.name.includes('.') ? victim.name : ''));
  if (root.length >= 4 && index.byCompact.has(root)) return { ...index.byCompact.get(root), matchType: 'domain' };
  return null;
}

/** Fetch a company's filing history (cached for 1 hour). */
async function getSubmissions(cik) {
  const hit = submissionsCache.get(cik);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.data;
  const padded = String(cik).padStart(10, '0');
  const data = await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`);
  submissionsCache.set(cik, { at: Date.now(), data });
  if (submissionsCache.size > 500) submissionsCache.delete(submissionsCache.keys().next().value);
  return data;
}

/**
 * Look for cyber-incident 8-K filings on/after `sinceDate` ("YYYY-MM-DD").
 * Returns {
 *   domesticFiler: boolean,  // files 10-K/10-Q (8-K rule applies) vs 20-F/40-F foreign filer
 *   filings: [{ date, form, items, kind: 'item-1.05' | 'possible', url }]
 * }
 */
export async function findCyberFilings(cik, sinceDate) {
  const sub = await getSubmissions(cik);
  const r = sub?.filings?.recent ?? {};
  const forms = r.form ?? [];
  const domesticFiler = forms.some((f) => ['10-K', '10-Q', '10-K/A', '10-Q/A'].includes(f));
  const filings = [];
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    const date = r.filingDate?.[i];
    if (!date || date < sinceDate) continue;
    if (form !== '8-K' && form !== '8-K/A') continue;
    const items = String(r.items?.[i] ?? '');
    const itemList = items.split(',').map((s) => s.trim());
    let kind = null;
    if (itemList.includes('1.05')) kind = 'item-1.05';
    else if (itemList.includes('8.01') || itemList.includes('7.01')) kind = 'possible';
    if (!kind) continue;
    const acc = String(r.accessionNumber?.[i] ?? '').replace(/-/g, '');
    const doc = r.primaryDocument?.[i] ?? '';
    filings.push({
      date, form, items, kind,
      url: acc ? `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${encodeURIComponent(doc)}` : '',
    });
  }
  filings.sort((a, b) => a.date.localeCompare(b.date));
  return { domesticFiler, filings };
}
