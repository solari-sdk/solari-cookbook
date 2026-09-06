import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, classify, parseGuestResult, digest, probeDigest } from '../src/domain.ts';

export const manifestInput = {
  version: 1, name: 'cache-test', source: { kind: 'fixture', baseline: { 'cache.py': 'bug' }, candidate: { 'cache.py': 'fix' } },
  setup: [], probe: { argv: ['python3', 'probe.py'], files: { 'probe.py': 'print("test")' }, expectedFailure: { exitCode: 1, contains: 'STALE_READ' }, expectedSuccess: { contains: 'CACHE_OK' } },
  limits: { sessionSeconds: 120, commandSeconds: 30 },
};

export function guest(exitCode: number, stdout: string) {
  return { protocol: 1, revision: null, probeSha256: probeDigest(manifestInput.probe), runtime: { python: '3.12.1', platform: 'linux' }, setup: [], probe: { exitCode, stdout, stderr: '', timedOut: false, truncated: false, durationMs: 1 }, error: null };
}

test('only an expected baseline failure and witnessed candidate pass verify', () => {
  const manifest = parseManifest(manifestInput);
  assert.equal(classify(manifest, parseGuestResult(guest(1, 'STALE_READ')), parseGuestResult(guest(0, 'CACHE_OK'))), 'verified');
  assert.equal(classify(manifest, parseGuestResult(guest(2, 'dependency missing')), parseGuestResult(guest(0, 'CACHE_OK'))), 'inconclusive');
  assert.equal(classify(manifest, parseGuestResult(guest(1, 'STALE_READ')), parseGuestResult(guest(0, ''))), 'inconclusive');
});

test('rejects unsafe source URLs, paths, limits and unknown fields before spending', () => {
  for (const url of ['http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://token@github.com/a/b', 'https://127.0.0.1/a/b', 'https://github.com/a/b?token=x']) {
    assert.throws(() => parseManifest({ ...manifestInput, source: { kind: 'git', url, baseline: 'a'.repeat(40), candidate: 'b'.repeat(40) } }));
  }
  for (const path of ['../secret', '/tmp/file', 'a/../../file', '.git/config', 'a//b', 'C:\\file']) {
    assert.throws(() => parseManifest({ ...manifestInput, probe: { ...manifestInput.probe, files: { [path]: 'x' } } }));
  }
  assert.throws(() => parseManifest({ ...manifestInput, typo: true }));
  assert.throws(() => parseManifest({ ...manifestInput, limits: { sessionSeconds: 301, commandSeconds: 30 } }));
  assert.throws(() => parseManifest({ ...manifestInput, limits: { sessionSeconds: 10, commandSeconds: 10 } }));
  assert.throws(() => parseManifest({ ...manifestInput, probe: { ...manifestInput.probe, expectedSuccess: { contains: 'STALE_READ success' } } }));
});

test('unknown, truncated, timed out, ambiguous and setup-failed output never verifies', () => {
  const manifest = parseManifest(manifestInput);
  const baseline = parseGuestResult(guest(1, 'STALE_READ'));
  for (const changed of [
    { ...guest(0, 'CACHE_OK'), error: 'failed setup' },
    { ...guest(0, 'CACHE_OK'), probe: { ...guest(0, 'CACHE_OK').probe, timedOut: true } },
    { ...guest(0, 'CACHE_OK'), probe: { ...guest(0, 'CACHE_OK').probe, truncated: true } },
    guest(0, 'STALE_READ CACHE_OK'),
    { ...guest(0, 'CACHE_OK'), probe: null },
  ]) assert.equal(classify(manifest, baseline, parseGuestResult(changed)), 'inconclusive');
  assert.equal(classify(manifest, parseGuestResult(guest(0, 'CACHE_OK'))), 'not_reproduced');
  assert.equal(classify(manifest, baseline, baseline), 'still_failing');
  assert.throws(() => parseGuestResult({ ...guest(0, 'CACHE_OK'), protocol: 2 }));
  assert.throws(() => parseGuestResult({ ...guest(0, 'CACHE_OK'), probe: { exitCode: 0 } }));
});

test('baseline correct exit code but wrong witness text is inconclusive', () => {
  const manifest = parseManifest(manifestInput);
  assert.equal(classify(manifest, parseGuestResult(guest(1, 'WRONG_ERROR')), parseGuestResult(guest(0, 'CACHE_OK'))), 'inconclusive');
  assert.equal(classify(manifest, parseGuestResult(guest(1, 'some other failure'))), 'inconclusive');
});

test('both witnesses present in output is inconclusive (ambiguous)', () => {
  const manifest = parseManifest(manifestInput);
  const ambiguous = parseGuestResult(guest(1, 'STALE_READ and CACHE_OK'));
  assert.equal(classify(manifest, ambiguous, parseGuestResult(guest(0, 'CACHE_OK'))), 'inconclusive');
  const candidateAmbiguous = parseGuestResult(guest(0, 'CACHE_OK STALE_READ'));
  assert.equal(classify(manifest, parseGuestResult(guest(1, 'STALE_READ')), candidateAmbiguous), 'inconclusive');
});

test('git source with wrong checked-out revision is inconclusive', () => {
  const gitManifest = parseManifest({
    ...manifestInput,
    source: { kind: 'git', url: 'https://github.com/owner/repo', baseline: 'a'.repeat(40), candidate: 'b'.repeat(40) },
  });
  const wrongRev = { ...guest(1, 'STALE_READ'), revision: 'c'.repeat(40) };
  assert.equal(classify(gitManifest, parseGuestResult(wrongRev)), 'inconclusive');
});

test('manifest has a single probe definition shared by both lanes', () => {
  const manifest = parseManifest(manifestInput);
  // The manifest structure has ONE probe. There is no per-lane probe.
  // Both baseline and candidate receive the same manifest.probe object.
  assert.deepEqual(manifest.probe.argv, ['python3', 'probe.py']);
  assert.deepEqual(manifest.probe.expectedFailure, { exitCode: 1, contains: 'STALE_READ' });
  assert.deepEqual(manifest.probe.expectedSuccess, { contains: 'CACHE_OK' });
  // Mutating the probe reference would affect both lanes — the structure enforces identity.
  assert.equal(typeof manifest.probe.files, 'object');
});

test('missing candidate result after valid baseline returns inconclusive, not verified', () => {
  const manifest = parseManifest(manifestInput);
  const baseline = parseGuestResult(guest(1, 'STALE_READ'));
  assert.equal(classify(manifest, baseline, undefined), 'inconclusive');
  assert.equal(classify(manifest, baseline), 'inconclusive');
});

test('setup failure with non-zero exit in setup array prevents verification', () => {
  const manifest = parseManifest(manifestInput);
  const setupFailed = parseGuestResult({
    protocol: 1, revision: null, probeSha256: null, runtime: { python: '3.12.1', platform: 'linux' },
    setup: [{ exitCode: 1, stdout: '', stderr: 'pip failed', timedOut: false, truncated: false, durationMs: 100 }],
    probe: { exitCode: 0, stdout: 'CACHE_OK', stderr: '', timedOut: false, truncated: false, durationMs: 1 },
    error: null,
  });
  assert.equal(classify(manifest, setupFailed), 'inconclusive');
});

test('absent or different executed probe digest cannot verify', () => {
  const manifest = parseManifest(manifestInput);
  const baseline = parseGuestResult(guest(1, 'STALE_READ'));
  const candidate = parseGuestResult(guest(0, 'CACHE_OK'));
  assert.equal(classify(manifest, baseline, { ...candidate, probeSha256: digest('different probe') }), 'inconclusive');
  assert.equal(classify(manifest, { ...baseline, probeSha256: null }, candidate), 'inconclusive');
});
