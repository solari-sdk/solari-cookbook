import { extract } from './acquisition.ts';
import { processLocal, processorHash } from './local.ts';
import { hash, object, keys, parseRows, timestamp, ServiceFailure, supplierUrl, type Row, type Run, type Services, type Reconciliation } from './model.ts';

export type Comparison = { schema: 1; kind: 'comparison'; before: Run; after: Run; result: Reconciliation };
export async function compare(before: Run, after: Run): Promise<Comparison> {
  if (!before.result || !after.result || !before.acquisition || !after.acquisition || before.mode !== after.mode || before.acquisition.capture.sourceUrl !== after.acquisition.capture.sourceUrl || before.acquisition.capture.adapter !== after.acquisition.capture.adapter || before.acquisition.capture.observedAt >= after.acquisition.capture.observedAt) throw new Error('Comparison requires successful ordered observations of the same source and mode');
  const result = await processLocal({ operation: 'compare', internal: before.acquisition.rows, supplier: after.acquisition.rows });
  return { schema: 1, kind: 'comparison', before, after, result };
}
export async function verifyComparison(value: unknown): Promise<Comparison> {
  const o = object(value); keys(o, ['schema', 'kind', 'before', 'after', 'result']);
  if (o.schema !== 1 || o.kind !== 'comparison') throw new Error('Invalid comparison');
  const expected = await compare(await verify(o.before), await verify(o.after));
  if (hash(expected) !== hash(o)) throw new Error('Invalid comparison replay');
  return expected;
}

export async function execute(internal: Row[], mode: Run['mode'], url: string, services: Services, signal = new AbortController().signal): Promise<Run> {
  internal = parseRows(internal, 'internal', true);
  if (mode === 'SOLARI') supplierUrl(url);
  const run: Run = { schema: 1, mode, status: 'FAILED_ACQUISITION', startedAt: new Date().toISOString(), finishedAt: '', internal, resources: { browser: 'not_started', sandbox: 'not_started' }, processorSha256: await processorHash(), sha256: '' };
  let stage: 'browser' | 'sandbox' = 'browser';
  try {
    signal.throwIfAborted();
    run.resources.browser = 'uncertain';
    const capture = await services.acquire(url, signal);
    run.resources.browser = 'released';
    signal.throwIfAborted();
    if (capture.sourceUrl !== url) throw new Error('Wrong source');
    run.acquisition = extract(capture, mode);
    stage = 'sandbox'; run.status = 'FAILED_PROCESSING';
    const input = { operation: 'reconcile' as const, internal, supplier: run.acquisition.rows };
    run.resources.sandbox = 'uncertain';
    const result = await services.process(input, signal);
    run.resources.sandbox = 'released';
    signal.throwIfAborted();
    const expected = await processLocal(input, signal);
    if (hash(result) !== hash(expected)) throw new Error('Processor replay mismatch');
    run.result = expected;
    run.status = expected.summary.discrepancies ? 'REVIEW_REQUIRED' : 'COMPLETE';
  } catch (error) {
    if (error instanceof ServiceFailure && error.resource === stage) run.resources[stage] = error.released ? 'released' : 'uncertain';
    run.error = signal.aborted ? 'CANCELLED' : stage === 'browser' ? 'ACQUISITION_FAILED' : 'PROCESSING_FAILED';
    run.status = Object.values(run.resources).includes('uncertain') ? 'CLEANUP_UNCERTAIN' : stage === 'browser' ? 'FAILED_ACQUISITION' : 'FAILED_PROCESSING';
  }
  run.finishedAt = new Date().toISOString();
  const { sha256: _, ...body } = run; run.sha256 = hash(body);
  return run;
}

// Integrity and deterministic replay, not provider attestation or proof of authenticity.
export async function verify(value: unknown): Promise<Run> {
  const o = object(value);
  keys(o, ['schema', 'mode', 'status', 'startedAt', 'finishedAt', 'internal', 'resources', 'processorSha256', 'sha256', ...('acquisition' in o ? ['acquisition'] : []), ...('result' in o ? ['result'] : []), ...('error' in o ? ['error'] : [])]);
  const { sha256, ...body } = o;
  if (sha256 !== hash(body) || o.schema !== 1 || !['SIMULATION', 'SOLARI'].includes(String(o.mode)) || o.processorSha256 !== await processorHash()) throw new Error('Invalid receipt integrity or version');
  if (timestamp(o.startedAt) > timestamp(o.finishedAt)) throw new Error('Invalid run times');
  const internal = parseRows(o.internal, 'internal', true);
  const resources = object(o.resources); keys(resources, ['browser', 'sandbox']);
  if (Object.values(resources).some(v => !['not_started', 'released', 'uncertain'].includes(String(v)))) throw new Error('Invalid cleanup state');
  const run = o as unknown as Run;
  if (run.acquisition) {
    const expected = extract(run.acquisition.capture, run.mode);
    if (hash(expected) !== hash(run.acquisition) || resources.browser !== 'released') throw new Error('Invalid acquisition evidence');
  }
  if (run.result) {
    if (!run.acquisition || resources.sandbox !== 'released' || run.error) throw new Error('Incomplete execution');
    const expected = await processLocal({ operation: 'reconcile', internal, supplier: run.acquisition.rows });
    if (hash(expected) !== hash(run.result) || run.status !== (expected.summary.discrepancies ? 'REVIEW_REQUIRED' : 'COMPLETE')) throw new Error('Invalid reconciliation');
  } else {
    const expected = Object.values(resources).includes('uncertain') ? 'CLEANUP_UNCERTAIN' : run.acquisition ? 'FAILED_PROCESSING' : 'FAILED_ACQUISITION';
    if (run.status !== expected || !['CANCELLED', 'ACQUISITION_FAILED', 'PROCESSING_FAILED'].includes(run.error ?? '')) throw new Error('Invalid failure receipt');
  }
  return run;
}
