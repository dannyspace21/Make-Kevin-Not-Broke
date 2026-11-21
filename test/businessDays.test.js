// Tests for the SEC business-day calculator (run with: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBusinessDays, businessDaysBetween, isBusinessDay, federalHolidays } from '../src/util/businessDays.js';

test('weekends are not business days', () => {
  assert.equal(isBusinessDay('2026-11-21'), false); // Saturday
  assert.equal(isBusinessDay('2026-11-22'), false); // Sunday
  assert.equal(isBusinessDay('2026-11-23'), true); //  Monday
});

test('federal holidays incl. observed dates', () => {
  const h2026 = federalHolidays(2026);
  assert.ok(h2026.has('2026-11-26')); // Thanksgiving (4th Thu Nov)
  assert.ok(h2026.has('2026-07-03')); // July 4 is a Saturday -> observed Friday
  assert.ok(h2026.has('2026-01-19')); // MLK day
  assert.ok(federalHolidays(2027).has('2027-12-24')); // Christmas Sat -> Fri
  assert.ok(federalHolidays(2027).has('2027-12-31')); // New Year 2028 is Sat -> observed Dec 31
});

test('4 business days skips weekends and Thanksgiving', () => {
  assert.equal(addBusinessDays('2026-11-16', 4), '2026-11-20'); // Mon -> Fri
  assert.equal(addBusinessDays('2026-11-20', 4), '2026-11-27'); // Fri -> next Fri (Thu 26 is Thanksgiving)
});

test('businessDaysBetween counts days after start through end', () => {
  assert.equal(businessDaysBetween('2026-11-16', '2026-11-20'), 4);
  assert.equal(businessDaysBetween('2026-11-20', '2026-11-23'), 1);
  assert.equal(businessDaysBetween('2026-11-20', '2026-11-20'), 0);
});
