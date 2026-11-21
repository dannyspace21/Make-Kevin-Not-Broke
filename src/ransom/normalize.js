// =============================================================================
// ransom/normalize.js  -  turn messy company names into comparable keys.
// -----------------------------------------------------------------------------
// Leak sites write "ACME Corp.", SEC writes "ACME CORPORATION", HIBP writes
// "Acme". To compare them we lower-case, remove punctuation and remove legal
// suffixes like "inc", "corp", "llc", "holdings".
// =============================================================================

const SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'ltd', 'limited',
  'plc', 'lp', 'llp', 'sa', 'ag', 'nv', 'se', 'group', 'holdings', 'holding', 'the',
  'trust', 'de', 'del', 'com', 'class', 'a', 'b',
]);

/** "The ACME Holdings, Inc." -> "acme" */
export function normalizeName(name) {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é -> e
    .replace(/https?:\/\//g, ' ')
    .replace(/\.(com|net|org|io|us|co)\b/g, ' ') //    "acme.com" -> "acme"
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !SUFFIXES.has(w))
    .join(' ')
    .trim();
}

/** "https://www.Acme-Corp.com/about" -> "acmecorp" (domain root, no dashes). */
export function domainRoot(domainOrUrl) {
  if (typeof domainOrUrl !== 'string' || !domainOrUrl.trim()) return '';
  try {
    const host = new URL(domainOrUrl.includes('://') ? domainOrUrl : `https://${domainOrUrl}`).hostname;
    const parts = host.replace(/^www\./, '').split('.');
    // take the label before the TLD ("acme" from acme.co.uk is imperfect but OK)
    const root = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return root.replace(/[^a-z0-9]/g, '');
  } catch {
    return '';
  }
}

/** Compact key (no spaces) used for domain-vs-name comparison. */
export const compact = (s) => normalizeName(s).replace(/ /g, '');
