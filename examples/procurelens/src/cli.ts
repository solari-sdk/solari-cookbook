import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseRows, supplierUrl, type Capture } from './model.ts';
import { execute, verify, compare, verifyComparison } from './workflow.ts';
import { processLocal } from './local.ts';
import { createSolariServices } from './solari.ts';
import { renderReport, renderComparison } from './report.ts';

async function json(path: string): Promise<unknown> {
  if ((await stat(path)).size > 2097152) throw new Error('File exceeds 2 MiB');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
async function save(data: unknown, html: string): Promise<string> {
  const directory = resolve('runs', randomUUID());
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'run.json'), JSON.stringify(data, null, 2), { flag: 'wx' });
  await writeFile(resolve(directory, 'report.html'), html, { flag: 'wx' });
  return directory;
}
async function main(): Promise<void> {
  const [command, first, second, ...extra] = process.argv.slice(2);
  if (!command || !first || extra.length || !['plan', 'simulate', 'run', 'verify', 'report', 'compare'].includes(command)) throw new Error('Usage: plan|run <internal.json> <Adafruit URL>; simulate <internal.json> <capture.json>; verify|report <run.json>; compare <before.json> <after.json>');
  if (command === 'verify' || command === 'report') {
    if (second) throw new Error('Unexpected argument');
    const value = await json(first);
    if (value && typeof value === 'object' && 'kind' in value) {
      const bundle = await verifyComparison(value);
      console.log(command === 'verify' ? `INTEGRITY_VALID ${bundle.before.mode} COMPARISON (replay, not attestation)` : await save(bundle, renderComparison(bundle.before, bundle.after, bundle.result)));
      return;
    }
    const run = await verify(value);
    console.log(command === 'verify' ? `INTEGRITY_VALID ${run.mode} ${run.status} (replay, not attestation)` : await save(run, renderReport(run)));
    return;
  }
  if (!second) throw new Error('Missing second argument');
  if (command === 'compare') {
    const before = await verify(await json(first)), after = await verify(await json(second));
    const bundle = await compare(before, after);
    console.log(await save(bundle, renderComparison(before, after, bundle.result)));
    return;
  }
  const internal = parseRows(await json(first), 'internal');
  if (command === 'plan') {
    supplierUrl(second);
    console.log(JSON.stringify({ mode: 'SOLARI', source: second, internalRows: internal.length, browserSessions: 1, sandboxSessions: 1, retries: 0, workTimeoutSeconds: 45, cleanupTimeoutSeconds: 10, scope: 'One product page; no purchase; internal price must use listed single-item basis' }, null, 2));
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const simulated = command === 'simulate';
    if (!simulated && !process.env.SOLARI_API_KEY) throw new Error('SOLARI_API_KEY is required');
    const capture = simulated ? await json(second) as Capture : undefined;
    const services = simulated ? { acquire: async () => capture!, process: processLocal } : createSolariServices(process.env.SOLARI_API_KEY!);
    const run = await execute(internal, simulated ? 'SIMULATION' : 'SOLARI', capture?.sourceUrl ?? second, services, controller.signal);
    console.log(`${run.mode} ${run.status}\n${await save(run, renderReport(run))}`);
    if (!run.result) process.exitCode = 2;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
main().catch(() => { console.error('Command failed. Check command arguments, input schema, Python availability and receipt integrity.'); process.exitCode = 2; });
