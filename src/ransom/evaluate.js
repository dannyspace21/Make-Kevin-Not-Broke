// =============================================================================
// ransom/evaluate.js  -  decides the "8-K clock" status of one case.
// -----------------------------------------------------------------------------
// Pure function (no network, no clock reads) so it is easy to unit-test.
//
// Inputs:
//   claimDate - first date a leak site listed the company ("YYYY-MM-DD")
//   today     - today's date ("YYYY-MM-DD")
//   filings   - cyber-related 8-Ks from sec.js (sorted oldest -> newest)
//
// Statuses (what the UI badge shows):
//   CLOCK_RUNNING       business day 0-2, nothing filed yet          (yellow)
//   DEADLINE_SOON       business day 3-4, nothing filed yet          (orange)
//   OVERDUE             past day 4 and NO 8-K at all                 (RED ALERT)
//   POSSIBLE_DISCLOSURE an 8-K Item 8.01/7.01 exists - read it        (purple)
//   DISCLOSED_ON_TIME   8-K Item 1.05 filed by the deadline          (green)
//   DISCLOSED_LATE      8-K Item 1.05 filed AFTER the deadline       (pink)
// =============================================================================
import { addBusinessDays, businessDaysBetween } from '../util/businessDays.js';

export const SEC_DEADLINE_BUSINESS_DAYS = 4;

export function evaluateCase({ claimDate, today, filings = [] }) {
  const deadline = addBusinessDays(claimDate, SEC_DEADLINE_BUSINESS_DAYS);
  const elapsed = businessDaysBetween(claimDate, today);
  const confirmed = filings.find((f) => f.kind === 'item-1.05') ?? null;
  const possible = filings.find((f) => f.kind === 'possible') ?? null;

  let status;
  let filing = null;
  if (confirmed) {
    filing = confirmed;
    status = confirmed.date <= deadline ? 'DISCLOSED_ON_TIME' : 'DISCLOSED_LATE';
  } else if (possible) {
    filing = possible;
    status = 'POSSIBLE_DISCLOSURE';
  } else if (today <= deadline) {
    status = elapsed >= 3 ? 'DEADLINE_SOON' : 'CLOCK_RUNNING';
  } else {
    status = 'OVERDUE';
  }

  // Did they disclose within 4 business days? true / false / null (= not yet known)
  let disclosedInTime = null;
  if (filing) disclosedInTime = filing.date <= deadline;
  else if (status === 'OVERDUE') disclosedInTime = false;

  return {
    status,
    deadline,
    businessDaysElapsed: elapsed,
    disclosedInTime,
    filing,
    // Plain-English hint for the trader (NOT financial advice)
    signal: signalFor(status),
  };
}

function signalFor(status) {
  switch (status) {
    case 'CLOCK_RUNNING': return 'Claimed on leak site, no 8-K yet. Market may not have priced it in.';
    case 'DEADLINE_SOON': return '4-business-day window closing. A filing (and price move) could land any moment.';
    case 'OVERDUE': return 'Past day 4 with no 8-K. Either not "material" yet, or a late disclosure is coming - high headline risk.';
    case 'POSSIBLE_DISCLOSURE': return 'An 8-K Item 8.01/7.01 was filed - open it and check whether it mentions the incident.';
    case 'DISCLOSED_ON_TIME': return 'Disclosed within the window. Watch the price reaction.';
    case 'DISCLOSED_LATE': return 'Disclosed AFTER the window - reputational damage likely, watch for a sharp move.';
    default: return '';
  }
}

/** Which status changes deserve an alert. */
export const ALERT_STATUSES = new Set(['DEADLINE_SOON', 'OVERDUE', 'POSSIBLE_DISCLOSURE', 'DISCLOSED_ON_TIME', 'DISCLOSED_LATE']);
