// =============================================================================
// sources/hibp.js  -  VERIFICATION source: Have I Been Pwned breach list.
// -----------------------------------------------------------------------------
// HIBP's list of all known breaches (GET /api/v3/breaches) is free and needs no
// API key. A leak-site claim that ALSO shows up in HIBP is more trustworthy.
// Docs: https://haveibeenpwned.com/API/v3#AllBreaches
// =============================================================================
import { fetchJson } from '../../util/http.js';

/** Returns [{ name, domain, breachDate, addedDate, source }] */
export async function fetchHibpBreaches() {
  const data = await fetchJson('https://haveibeenpwned.com/api/v3/breaches', {
    headers: { 'User-Agent': 'MakeKevinNotBroke/1.0' }, //  HIBP requires a User-Agent
  });
  if (!Array.isArray(data)) return [];
  return data.map((b) => ({
    name: b.Title || b.Name || '',
    domain: b.Domain || '',
    breachDate: b.BreachDate || null,
    addedDate: b.AddedDate || null,
    source: 'Have I Been Pwned',
  }));
}
