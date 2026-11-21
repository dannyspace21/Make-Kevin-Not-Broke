// Tests for company-name normalisation and SEC matching
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, domainRoot } from '../src/ransom/normalize.js';
import { matchCompany } from '../src/ransom/sec.js';

test('normalizeName strips legal suffixes and punctuation', () => {
  assert.equal(normalizeName('The ACME Holdings, Inc.'), 'acme');
  assert.equal(normalizeName('Café Corp'), 'cafe');
  assert.equal(normalizeName('acme.com'), 'acme');
});

test('domainRoot extracts the main label', () => {
  assert.equal(domainRoot('https://www.Acme-Corp.com/about'), 'acmecorp');
  assert.equal(domainRoot('globex.net'), 'globex');
  assert.equal(domainRoot(''), '');
});

test('matchCompany is conservative', () => {
  const entry = { cik: 1, ticker: 'ACME', title: 'Acme Corp' };
  const index = { byName: new Map([['acme', entry]]), byCompact: new Map([['acme', entry]]) };
  assert.equal(matchCompany(index, { name: 'ACME Corporation' }).ticker, 'ACME');
  assert.equal(matchCompany(index, { name: 'Something Else', domain: 'acme.com' }).matchType, 'domain');
  assert.equal(matchCompany(index, { name: 'Acme Plumbing of Ohio' }), null);
});
