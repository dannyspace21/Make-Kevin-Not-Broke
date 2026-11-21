// Tests for the 8-K status logic
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCase } from '../src/ransom/evaluate.js';

const claimDate = '2026-11-16'; // Monday -> deadline Friday 2026-11-20

test('clock running in the first days', () => {
  const r = evaluateCase({ claimDate, today: '2026-11-17' });
  assert.equal(r.status, 'CLOCK_RUNNING');
  assert.equal(r.deadline, '2026-11-20');
  assert.equal(r.disclosedInTime, null);
});

test('deadline soon on business day 3-4', () => {
  assert.equal(evaluateCase({ claimDate, today: '2026-11-19' }).status, 'DEADLINE_SOON');
});

test('overdue on day 5 with no filing', () => {
  const r = evaluateCase({ claimDate, today: '2026-11-23' });
  assert.equal(r.status, 'OVERDUE');
  assert.equal(r.disclosedInTime, false);
});

test('Item 1.05 on time vs late', () => {
  const onTime = evaluateCase({ claimDate, today: '2026-11-25', filings: [{ date: '2026-11-20', kind: 'item-1.05' }] });
  assert.equal(onTime.status, 'DISCLOSED_ON_TIME');
  assert.equal(onTime.disclosedInTime, true);
  const late = evaluateCase({ claimDate, today: '2026-11-25', filings: [{ date: '2026-11-23', kind: 'item-1.05' }] });
  assert.equal(late.status, 'DISCLOSED_LATE');
  assert.equal(late.disclosedInTime, false);
});

test('8.01 filing is flagged for review, 1.05 wins over it', () => {
  assert.equal(evaluateCase({ claimDate, today: '2026-11-25', filings: [{ date: '2026-11-18', kind: 'possible' }] }).status, 'POSSIBLE_DISCLOSURE');
  assert.equal(evaluateCase({ claimDate, today: '2026-11-25', filings: [{ date: '2026-11-18', kind: 'possible' }, { date: '2026-11-19', kind: 'item-1.05' }] }).status, 'DISCLOSED_ON_TIME');
});
