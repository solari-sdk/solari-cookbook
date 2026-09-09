import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execute, verify } from '../src/workflow.ts';
import { processLocal } from '../src/local.ts';
import { parseRows, ServiceFailure, hash, type Capture, type Services } from '../src/model.ts';
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
test('simulation receipt replays; changing findings even with new hash fails verification', async () => {
  const capture = await fixture('source-a') as Capture;
  const services: Services = { acquire: async () => capture, process: processLocal };
  const run = await execute(parseRows(await fixture('internal'), 'internal'), 'SIMULATION', capture.sourceUrl, services);
  assert.equal(run.status, 'REVIEW_REQUIRED');
  await verify(run);
  const tampered = structuredClone(run); tampered.result!.cards = [];
  const { sha256: _, ...body } = tampered; tampered.sha256 = hash(body);
  await assert.rejects(verify(tampered));
});
test('cleanup uncertainty and invalid processor results cannot succeed', async () => {
  const capture = await fixture('source-a') as Capture;
  const rows = parseRows(await fixture('internal'), 'internal');
  const uncertain = await execute(rows, 'SIMULATION', capture.sourceUrl, { acquire: async () => { throw new ServiceFailure('browser', false); }, process: processLocal });
  assert.equal(uncertain.status, 'CLEANUP_UNCERTAIN');
  const malformed = await execute(rows, 'SIMULATION', capture.sourceUrl, { acquire: async () => capture, process: async () => ({ cards: [], summary: { discrepancies: 0 } }) });
  assert.equal(malformed.status, 'FAILED_PROCESSING');
});
test('cancellation after acquisition cannot process or produce complete evidence', async () => {
  const capture = await fixture('source-a') as Capture;
  const controller = new AbortController(); let processed = false;
  const run = await execute(parseRows(await fixture('internal'), 'internal'), 'SIMULATION', capture.sourceUrl, {
    acquire: async () => { controller.abort(); return capture; },
    process: async () => { processed = true; return {}; },
  }, controller.signal);
  assert.equal(processed, false); assert.equal(run.status, 'FAILED_ACQUISITION');
  assert.equal(run.resources.browser, 'released'); await verify(run);
});
test('complete requires matching fields and confirmed cleanup; provenance edits fail replay', async () => {
  const capture = await fixture('source-a') as Capture;
  const internal = parseRows(capture.fragments.map(fragment => JSON.parse(fragment)), 'internal');
  const run = await execute(internal, 'SIMULATION', capture.sourceUrl, { acquire: async () => capture, process: processLocal });
  assert.equal(run.status, 'COMPLETE'); await verify(run);
  const tampered = structuredClone(run); tampered.acquisition!.rows[0]!.price = '999';
  const { sha256: _, ...body } = tampered; tampered.sha256 = hash(body);
  await assert.rejects(verify(tampered));
});
