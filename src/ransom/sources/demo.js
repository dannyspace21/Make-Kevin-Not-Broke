// =============================================================================
// sources/demo.js  -  FICTIONAL ransomware cases for DEMO mode.
// -----------------------------------------------------------------------------
// Every company and ticker below is MADE UP (all names end in "(DEMO)" and all
// tickers start with "ZZ") so screenshots never accuse a real company of being
// hacked. Dates are computed relative to "today" so every status appears.
// =============================================================================
import { ymd, addBusinessDays } from '../../util/businessDays.js';

const daysAgo = (n) => ymd(Date.now() - n * 86400000);

/** Returns [{ claim, match, filings, verifiedBy }] in the monitor's format. */
export function demoCases() {
  const c = (name, ticker, group, claimDate, filings = [], verifiedBy = []) => ({
    claim: { name, domain: '', group, discovered: claimDate, country: 'US', source: 'DEMO feed', url: '' },
    match: { cik: 0, ticker, title: name, matchType: 'demo' },
    filings,
    verifiedBy,
  });
  const d1 = daysAgo(12);
  const d2 = daysAgo(9);
  return [
    c('Nebula Dynamics Corp (DEMO)', 'ZZNB', 'lockbit-demo', daysAgo(10), [], ['Have I Been Pwned (demo)']),
    c('Quantum Hearth Foods (DEMO)', 'ZZQH', 'akira-demo', daysAgo(5)),
    c('Chrome Lotus Logistics (DEMO)', 'ZZCL', 'play-demo', daysAgo(1)),
    c('Synthwave Health Systems (DEMO)', 'ZZSH', 'blackbasta-demo', d1,
      [{ date: addBusinessDays(d1, 3), form: '8-K', items: '1.05,9.01', kind: 'item-1.05', url: '' }], ['Comparitech (demo)']),
    c('Ion Grid Utilities (DEMO)', 'ZZIG', 'medusa-demo', d2,
      [{ date: addBusinessDays(d2, 6), form: '8-K', items: '1.05', kind: 'item-1.05', url: '' }]),
    c('Neon Arc Retail (DEMO)', 'ZZNA', 'rhysida-demo', daysAgo(8),
      [{ date: daysAgo(2), form: '8-K', items: '8.01', kind: 'possible', url: '' }]),
  ];
}
