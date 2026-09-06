import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyReceipt } from '../src/runner.ts';
import { generateReport } from '../src/report.ts';

const ROOT = join(import.meta.dirname!, '..');

function cli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    execFile(process.execPath, ['--experimental-strip-types', 'src/cli.ts', ...args], {
      cwd: ROOT, timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, SOLARI_API_KEY: undefined },
    }, (error, stdout, stderr) => {
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: error ? typeof error.code === 'number' ? error.code : 1 : 0 });
    });
  });
}

test('plan validates a correct manifest and prints summary', async () => {
  const { stdout, code } = await cli('plan', 'fixtures/cache-fix.json');
  assert.equal(code, 0);
  assert.ok(stdout.includes('Manifest valid'));
  assert.ok(stdout.includes('cache-invalidation'));
  assert.ok(stdout.includes('STALE_READ'));
  assert.ok(stdout.includes('CACHE_OK'));
  assert.ok(stdout.includes('SHA-256'));
});

test('plan rejects an invalid manifest', async () => {
  const { stderr, code } = await cli('plan', 'package.json');
  assert.notEqual(code, 0);
  assert.ok(stderr.includes('Error'));
});

test('simulate produces a verified receipt with fixture', async () => {
  const dir = join(ROOT, `test-output-${randomUUID()}`);
  try {
    const { stdout, code } = await cli('simulate', 'fixtures/cache-fix.json', '--output', dir);
    assert.equal(code, 0, `Expected exit 0, got ${code}. stdout: ${stdout}`);
    assert.ok(stdout.includes('VERIFIED'));
    assert.ok(stdout.includes('SIMULATION'));

    // Verify receipt exists and is valid
    const receiptJson = await readFile(join(dir, 'receipt.json'), 'utf8');
    const receipt = JSON.parse(receiptJson);
    assert.equal(receipt.verdict, 'verified');
    assert.equal(receipt.provider, 'simulation');
    assert.equal(receipt.lanes.length, 2);
    assert.equal(receipt.lanes[0].lane, 'baseline');
    assert.equal(receipt.lanes[1].lane, 'candidate');
    assert.ok(receipt.lanes.every((l: { state: string }) => l.state === 'released'));

    // Verify receipt passes integrity check
    verifyReceipt(receipt);

    // Verify report.html exists
    const report = await readFile(join(dir, 'report.html'), 'utf8');
    assert.ok(report.includes('<!DOCTYPE html>'));
    assert.ok(report.includes('VERIFIED'));
    assert.ok(report.includes('SIMULATION'));
    assert.ok(report.includes('STALE_READ'));
    assert.ok(report.includes('CACHE_OK'));
    const expectedProbeHash = '047a8a78e998c59cea744c99809bebe65c324da0e7b6cf28d31ae60d8cbae52f';
    assert.deepEqual(receipt.lanes.map((lane: { result: { probeSha256: string } }) => lane.result.probeSha256), [expectedProbeHash, expectedProbeHash]);
    assert.equal(report.split(expectedProbeHash).length - 1, 3, 'report shows expected and both observed probe hashes');

    // Verify journal exists
    const journal = await readFile(join(dir, 'journal.jsonl'), 'utf8');
    assert.ok(journal.trim().length > 0);
    const events = journal.trim().split('\n').map(l => JSON.parse(l));
    assert.ok(events.some(e => e.lane === 'baseline'));
    assert.ok(events.some(e => e.lane === 'candidate'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('simulate with unfixed candidate produces still_failing', async () => {
  const dir = join(ROOT, `test-output-${randomUUID()}`);
  try {
    const { stdout, code } = await cli('simulate', 'fixtures/cache-unfixed.json', '--output', dir);
    assert.equal(code, 1, 'still_failing should exit 1');
    assert.ok(stdout.includes('STILL_FAILING'));

    const receipt = JSON.parse(await readFile(join(dir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.verdict, 'still_failing');
    assert.equal(receipt.provider, 'simulation');
    verifyReceipt(receipt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify accepts a valid receipt and rejects a tampered one', async () => {
  const dir = join(ROOT, `test-output-${randomUUID()}`);
  try {
    await cli('simulate', 'fixtures/cache-fix.json', '--output', dir);
    const { stdout, code } = await cli('verify', join(dir, 'receipt.json'));
    assert.equal(code, 0);
    assert.ok(stdout.includes('Receipt integrity verified'));
    assert.ok(stdout.includes('VERIFIED'));

    // Tamper with receipt
    const receipt = JSON.parse(await readFile(join(dir, 'receipt.json'), 'utf8'));
    receipt.verdict = 'inconclusive';
    const tampered = join(dir, 'tampered.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tampered, JSON.stringify(receipt));
    const { stderr: tamperedErr, code: tamperedCode } = await cli('verify', tampered);
    assert.notEqual(tamperedCode, 0);
    assert.ok(tamperedErr.includes('Error'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('output directory refuses reuse when receipt already exists', async () => {
  const dir = join(ROOT, `test-output-${randomUUID()}`);
  try {
    await cli('simulate', 'fixtures/cache-fix.json', '--output', dir);
    const { stderr, code } = await cli('simulate', 'fixtures/cache-fix.json', '--output', dir);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('already exists'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('help succeeds and malformed arguments fail before work', async () => {
  assert.equal((await cli('--help')).code, 0);
  for (const args of [
    ['plan', 'fixtures/cache-fix.json', '--typo'],
    ['simulate', 'fixtures/cache-fix.json', '--output'],
    ['plan', 'fixtures/cache-fix.json', 'extra.json'],
    ['plan', 'fixtures/cache-fix.json', '--output', 'unused'],
    ['simulate', 'fixtures/cache-fix.json', '--output', '--help'],
  ]) assert.notEqual((await cli(...args)).code, 0, args.join(' '));
});

test('simulate rejects modified code and git manifests before creating output', async () => {
  const dir = join(ROOT, 'runs', `cli-reject-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const original = JSON.parse(await readFile(join(ROOT, 'fixtures/cache-fix.json'), 'utf8'));
    const variants = [
      { ...original, probe: { ...original.probe, argv: ['python3', '-c', 'print(123)'] } },
      { ...original, probe: { ...original.probe, files: { 'probe.py': 'print(123)' } } },
      { ...original, setup: [{ argv: ['python3', '-c', 'print(123)'] }] },
      { ...original, source: { ...original.source, candidate: { 'cache.py': 'print(123)' } } },
      { ...original, source: { kind: 'git', url: 'https://github.com/example/repo', baseline: 'a'.repeat(40), candidate: 'b'.repeat(40) } },
    ];
    for (const [i, value] of variants.entries()) {
      const input = join(dir, `${i}.json`);
      const output = join(dir, `output-${i}`);
      await writeFile(input, JSON.stringify(value));
      const result = await cli('simulate', input, '--output', output);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /shipped fixtures/);
      await assert.rejects(stat(output), { code: 'ENOENT' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('simulate refuses an existing empty output directory', async () => {
  const dir = join(ROOT, 'runs', `cli-existing-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const result = await cli('simulate', 'fixtures/cache-fix.json', '--output', dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already exists/);
    await assert.rejects(stat(join(dir, 'journal.jsonl')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('input byte caps reject oversized JSON before parsing', async () => {
  const dir = join(ROOT, 'runs', `cli-large-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    for (const [command, size] of [['plan', 256 * 1024], ['verify', 1024 * 1024]] as const) {
      const file = join(dir, `${command}.json`);
      await writeFile(file, ' '.repeat(size + 1));
      const result = await cli(command, file);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /exceeds/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('report escapes guest-controlled strings and prohibits scripts', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'fixtures/cache-fix.json'), 'utf8'));
  const attack = '<script>alert("receipt")</script>';
  const report = generateReport({
    schema: 1, id: attack, provider: 'simulation', manifest, manifestSha256: attack,
    startedAt: attack, endedAt: attack, verdict: 'inconclusive', sha256: attack,
    lanes: [{ lane: 'baseline', state: 'cleanup_failed', sessionId: attack,
      startedAt: '', endedAt: '', durationMs: 0, computeMs: 0, error: attack, cleanupError: attack }],
    cost: { sessionsCreated: 1, computeSeconds: 0, estimatedUsd: 0, rateUsdPerHour: 0, estimateOnly: true },
  });
  assert.ok(!report.includes(attack));
  assert.ok(report.includes('&lt;script&gt;'));
  assert.match(report, /Content-Security-Policy/);
  assert.match(report, /script-src 'none'/);
  assert.match(report, /LOCAL SIMULATION/);
});

test('canonical fixture copy runs locally and defaults evidence to a unique runs directory', async () => {
  const inputDir = join(ROOT, 'runs', `cli-copy-${randomUUID()}`);
  await mkdir(inputDir, { recursive: true });
  let output: string | undefined;
  try {
    const fixture = JSON.parse(await readFile(join(ROOT, 'fixtures/cache-fix.json'), 'utf8'));
    const input = join(inputDir, 'copy.json');
    await writeFile(input, JSON.stringify(Object.fromEntries(Object.entries(fixture).reverse())));
    const result = await cli('simulate', input);
    output = /^Output: (.+)$/m.exec(result.stdout)?.[1]?.trim();
    assert.ok(output);
    assert.equal(join(output, '..'), join(ROOT, 'runs'));
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOCAL SIMULATION/);
    assert.match(result.stdout, /without remote isolation/);
    assert.equal(verifyReceipt(JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'))).verdict, 'verified');
  } finally {
    if (output && join(output, '..') === join(ROOT, 'runs')) await rm(output, { recursive: true, force: true });
    await rm(inputDir, { recursive: true, force: true });
  }
});

test('run command requires SOLARI_API_KEY', async () => {
  const { stderr, code } = await cli('run', 'fixtures/cache-fix.json');
  assert.notEqual(code, 0);
  assert.ok(stderr.includes('SOLARI_API_KEY'));
});

test('simulation receipt is never labeled as solari evidence', async () => {
  const dir = join(ROOT, `test-output-${randomUUID()}`);
  try {
    await cli('simulate', 'fixtures/cache-fix.json', '--output', dir);
    const receipt = JSON.parse(await readFile(join(dir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.provider, 'simulation');
    assert.notEqual(receipt.provider, 'solari');
    const report = await readFile(join(dir, 'report.html'), 'utf8');
    assert.ok(report.includes('SIMULATION'));
    assert.ok(report.includes('not real Solari evidence'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
