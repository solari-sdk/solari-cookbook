import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run, Reconciliation } from '../src/model.ts';
import { renderReport, renderComparison } from '../src/report.ts';

const result: Reconciliation = { version: 1, cards: [], summary: { internalRecords: 2, supplierRecords: 3, matchedPairs: 1, discrepancies: 4, ambiguousGroups: 1 }, normalized: { internal: [], supplier: [] } };
const base: Run = { schema: 1, mode: 'SIMULATION', status: 'FAILED_ACQUISITION', startedAt: '2026-09-01T09:00:00.000Z', finishedAt: '2026-09-01T09:01:00.000Z', internal: [], resources: { browser: 'not_started', sandbox: 'not_started' }, processorSha256: 'a'.repeat(64), sha256: 'b'.repeat(64) };

test('failed acquisition has no invented clean comparison summary', () => {
  const html = renderReport(base);
  assert.match(html, /SIMULATION/);
  assert.match(html, /FAILED_ACQUISITION/);
  assert.match(html, /No reconciliation result/);
  assert.doesNotMatch(html, /0 matched|0 discrepancies|All clear/);
});

test('report escapes source and evidence text and displays actual counts', () => {
  const row = { id: 'supplier:1', sku: '<script>alert(1)</script>', name: '<img src=x onerror=alert(1)>', price: null, currency: null, availability: null, stock: null, leadTimeDays: null };
  const run: Run = { ...base, status: 'REVIEW_REQUIRED', result: { ...result, cards: [{ classification: 'UNCOMPARABLE_FIELD', field: 'price', internalIds: [], supplierIds: ['supplier:1'], internalValue: null, supplierValue: null, matchMethod: 'none', confidence: 'none', reason: '<script>bad</script>' }], normalized: { internal: [], supplier: [{ ...row, normalizations: [] }] } }, acquisition: { sha256: 'c'.repeat(64), rows: [row], capture: { adapter: 'fixture-v1', sourceUrl: 'javascript:alert(1)', observedAt: base.startedAt, httpStatus: 200, complete: true, fragments: ['{}'], visible: [] } } };
  const html = renderReport(run);
  assert.match(html, /4 discrepancies/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Unknown/);
  assert.match(html, /fragment\[0\]/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
});

test('comparison labels both observations and hashes', () => {
  const after = { ...base, sha256: 'd'.repeat(64), startedAt: '2026-09-02T09:00:00.000Z' };
  const html = renderComparison(base, after, result);
  assert.match(html, /Before/); assert.match(html, /After/);
  assert.ok(html.includes(base.sha256)); assert.ok(html.includes(after.sha256));
  assert.ok(html.includes(after.startedAt));
});
