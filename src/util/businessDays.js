// =============================================================================
// businessDays.js  -  SEC "business day" math for the Form 8-K deadline.
// -----------------------------------------------------------------------------
// SEC rule (Form 8-K, Item 1.05): a company must file within FOUR BUSINESS DAYS
// after it determines a cybersecurity incident is "material".
// Business day = Monday-Friday that is NOT a U.S. federal holiday.
//
// IMPORTANT REAL-WORLD NOTE: the clock legally starts at the *materiality
// determination*, which outsiders never see. This app uses the first date a
// ransomware leak site publicly listed the victim as the best observable
// proxy. That is why results are "signals", not proof of a violation.
//
// All dates here are handled as plain "YYYY-MM-DD" strings in UTC so time zones
// can't shift a date by one day.
// =============================================================================

/** Date -> "YYYY-MM-DD" (UTC). */
export const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/** "YYYY-MM-DD" -> Date at 00:00 UTC. */
const parse = (s) => new Date(`${s}T00:00:00Z`);

/** The nth (1-based) given weekday (0=Sun) of a month; n=-1 means "last". */
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1));
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
  }
  const last = new Date(Date.UTC(year, month + 1, 0)); // day 0 of next month = last day
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}

/** Fixed-date holidays move to Friday/Monday when they fall on a weekend. */
function observed(date) {
  const day = date.getUTCDay();
  if (day === 6) return new Date(date.getTime() - 86400000); // Sat -> Fri
  if (day === 0) return new Date(date.getTime() + 86400000); // Sun -> Mon
  return date;
}

const holidayCache = new Map();

/** Returns a Set of "YYYY-MM-DD" U.S. federal holidays (observed) for a year. */
export function federalHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const d = (m, day) => new Date(Date.UTC(year, m, day));
  const list = [
    observed(d(0, 1)), //                 New Year's Day
    nthWeekday(year, 0, 1, 3), //         Martin Luther King Jr. Day (3rd Mon Jan)
    nthWeekday(year, 1, 1, 3), //         Washington's Birthday (3rd Mon Feb)
    nthWeekday(year, 4, 1, -1), //        Memorial Day (last Mon May)
    observed(d(5, 19)), //                Juneteenth
    observed(d(6, 4)), //                 Independence Day
    nthWeekday(year, 8, 1, 1), //         Labor Day (1st Mon Sep)
    nthWeekday(year, 9, 1, 2), //         Columbus Day (2nd Mon Oct)
    observed(d(10, 11)), //               Veterans Day
    nthWeekday(year, 10, 4, 4), //        Thanksgiving (4th Thu Nov)
    observed(d(11, 25)), //               Christmas Day
  ];
  const set = new Set(list.map(ymd));
  // New Year's Day of NEXT year can be observed on Dec 31 of this year.
  const nextNewYear = observed(d(12, 1));
  if (nextNewYear.getUTCFullYear() === year) set.add(ymd(nextNewYear));
  holidayCache.set(year, set);
  return set;
}

/** True if the "YYYY-MM-DD" date is a SEC business day. */
export function isBusinessDay(dateStr) {
  const date = parse(dateStr);
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !federalHolidays(date.getUTCFullYear()).has(dateStr);
}

/** Adds N business days to a date and returns the resulting "YYYY-MM-DD". */
export function addBusinessDays(dateStr, n) {
  let date = parse(dateStr);
  let added = 0;
  while (added < n) {
    date = new Date(date.getTime() + 86400000);
    if (isBusinessDay(ymd(date))) added += 1;
  }
  return ymd(date);
}

/**
 * Counts business days AFTER `startStr` up to and including `endStr`.
 * Example: start Mon, end Fri (same week) -> 4.
 */
export function businessDaysBetween(startStr, endStr) {
  if (endStr <= startStr) return 0;
  let count = 0;
  let date = parse(startStr);
  const end = parse(endStr);
  while (date < end) {
    date = new Date(date.getTime() + 86400000);
    if (isBusinessDay(ymd(date))) count += 1;
  }
  return count;
}
