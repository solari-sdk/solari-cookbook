import type { Run, Reconciliation, Row, Card } from './model.ts';

function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function value(v: unknown): string { return v === null || v === undefined ? 'Unknown' : escape(v); }
function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>
  :root{font-family:system-ui,sans-serif;color:#18302b;background:#f3f5f1}body{max-width:1120px;margin:auto;padding:28px}header{border-bottom:3px solid #245b49;padding-bottom:20px}h1{font-size:2rem;margin:8px 0}h2{font-size:1.1rem}p{line-height:1.55}.mode{font-weight:750;letter-spacing:.12em;color:#245b49}.notice{padding:16px;background:#fff5d9;border-left:4px solid #bb841c}.summary{display:flex;gap:18px;flex-wrap:wrap;font-weight:650}.card{background:white;border:1px solid #d6dfd6;border-radius:8px;margin:18px 0;padding:20px}.classification{font-weight:750}.columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f1;padding:12px;font-size:.8rem}code,small{overflow-wrap:anywhere}small{color:#52625a}dt{font-weight:650}dd{margin:3px 0 12px;overflow-wrap:anywhere}@media(max-width:650px){body{padding:16px}.columns{grid-template-columns:1fr}h1{font-size:1.5rem}}</style></head><body>${body}</body></html>`;
}
function observation(run: Run, label: string): string {
  const capture = run.acquisition?.capture;
  return `<section><h2>${escape(label)}</h2><dl><dt>Execution mode</dt><dd>${escape(run.mode)}</dd><dt>State</dt><dd>${escape(run.status)}</dd><dt>Page scope</dt><dd>${capture ? escape(capture.sourceUrl) : 'Acquisition unavailable'}</dd><dt>Observed at</dt><dd>${escape(capture?.observedAt ?? run.startedAt)}</dd><dt>Run SHA-256</dt><dd><code>${escape(run.sha256)}</code></dd></dl></section>`;
}
function rowsEvidence(ids: string[], raw: Row[], normalized: Reconciliation['normalized']['internal'], supplier: boolean): string {
  return ids.map(id => {
    const index = raw.findIndex(row => row.id === id);
    const original = raw[index];
    const norm = normalized.find(row => row.id === id);
    return `<div><small>Row ${escape(id)}${supplier && index >= 0 ? ` · fragment[${index}]` : ''}</small><h3>${original ? escape(original.name) : 'Row unavailable'}</h3><strong>Raw record</strong><pre>${escape(JSON.stringify(original ?? null, null, 2))}</pre><strong>Normalized record</strong><pre>${escape(JSON.stringify(norm ?? null, null, 2))}</pre><p>${norm?.normalizations.length ? norm.normalizations.map(escape).join(' ') : 'No normalization changes.'}</p></div>`;
  }).join('') || '<p>No corresponding row in this scope.</p>';
}
function evidenceCard(card: Card, result: Reconciliation, left: Row[], right: Row[], comparison: boolean): string {
  return `<article class="card"><div class="classification">${escape(card.classification)}${card.field ? ` · ${escape(card.field)}` : ''}</div><p>${escape(card.reason)}</p><p>Match method: ${escape(card.matchMethod)} · Confidence: ${escape(card.confidence)}</p><div class="columns"><section><h2>${comparison ? 'Before supplier observation' : 'Internal purchasing record'}: ${value(card.internalValue)}</h2>${rowsEvidence(card.internalIds, left, result.normalized.internal, comparison)}</section><section><h2>${comparison ? 'After supplier observation' : 'Supplier observation'}: ${value(card.supplierValue)}</h2>${rowsEvidence(card.supplierIds, right, result.normalized.supplier, true)}</section></div>${card.delta ? `<p>Price change: ${escape(card.delta.absolute)} · ${card.delta.percent === null ? 'Percentage unavailable (zero baseline)' : `${escape(card.delta.percent)}%`}</p>` : ''}</article>`;
}
function results(result: Reconciliation, left: Row[], right: Row[], comparison = false): string {
  const s = result.summary;
  return `<section class="summary"><p>${s.internalRecords} ${comparison ? 'before' : 'internal'} records</p><p>${s.supplierRecords} ${comparison ? 'after' : 'supplier'} records</p><p>${s.matchedPairs} matched pairs</p><p>${s.discrepancies} discrepancies</p><p>${s.ambiguousGroups} ambiguous groups</p></section>${result.cards.map(card => evidenceCard(card, result, left, right, comparison)).join('')}`;
}
const warning = '<p class="notice">A supplier observation is not an independently verified quote or stock commitment. Unknown values remain unknown. Missing-record findings apply only to the supplied page scope, not the supplier catalog. Human review is required before purchasing.</p>';

export function renderReport(run: Run): string {
  return shell('ProcureLens evidence report', `<header><div class="mode">${escape(run.mode)}</div><h1>ProcureLens · purchasing evidence</h1><p>${escape(run.status)}</p>${run.mode === 'SIMULATION' ? '<p>Synthetic demonstration records. No live supplier acquisition.</p>' : ''}</header>${warning}${observation(run, 'Observation')}${run.result ? results(run.result, run.internal, run.acquisition?.rows ?? []) : '<section class="card"><h2>No reconciliation result</h2><p>The workflow did not produce a completed comparison. No clean purchasing conclusion is available.</p></section>'}`);
}

export function renderComparison(before: Run, after: Run, result: Reconciliation): string {
  return shell('ProcureLens observation comparison', `<header><div class="mode">${escape(before.mode)} → ${escape(after.mode)}</div><h1>Supplier observation changes</h1></header>${warning}<div class="columns">${observation(before, 'Before')}${observation(after, 'After')}</div>${results(result, before.acquisition?.rows ?? [], after.acquisition?.rows ?? [], true)}`);
}
