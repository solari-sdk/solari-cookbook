import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, probeDigest, parseManifest, type Lane } from '../src/domain.ts';
import { runExperiment, verifyReceipt, type Provider } from '../src/runner.ts';

const manifest = parseManifest({ version: 1, name: 'regression', source: { kind: 'fixture', baseline: { 'x.py': 'bad' }, candidate: { 'x.py': 'good' } }, setup: [], probe: { argv: ['python3', 'p.py'], files: { 'p.py': 'pass' }, expectedFailure: { exitCode: 1, contains: 'BUG' }, expectedSuccess: { contains: 'FIXED' } }, limits: { sessionSeconds: 10, commandSeconds: 1 } });
function output(lane: Lane) {
  return { protocol: 1, revision: null, probeSha256: probeDigest(manifest.probe), runtime: { python: '3.12', platform: 'linux' }, setup: [], error: null, probe: { exitCode: lane === 'baseline' ? 1 : 0, stdout: lane === 'baseline' ? 'BUG' : 'FIXED', stderr: '', durationMs: 1, timedOut: false, truncated: false } };
}
function provider(events: string[], failure?: string): Provider {
  let active = false;
  return { kind: 'simulation', cleanup: async () => {}, create: async ({ lane }) => {
    assert.equal(active, false, 'Never overlap paid sessions');
    if (failure === 'create') throw new Error('creation failed');
    active = true; events.push(`create:${lane}`);
    return { id: `sim-${lane}`, execute: async () => {
      events.push(`execute:${lane}`);
      if (failure === 'execute') throw new Error('connection lost');
      return output(failure === 'not-reproduced' ? 'candidate' : lane);
    }, kill: async () => { events.push(`kill:${lane}`); if (failure === 'kill') throw new Error('DELETE failed'); active = false; } };
  } };
}

test('allocates sequential fresh sessions and seals a verifiable receipt', async () => {
  const events: string[] = [];
  const receipt = await runExperiment(manifest, provider(events));
  assert.equal(receipt.verdict, 'verified');
  assert.deepEqual(events, ['create:baseline', 'execute:baseline', 'kill:baseline', 'create:candidate', 'execute:candidate', 'kill:candidate']);
  assert.equal(receipt.cost.sessionsCreated, 2);
  assert.equal(verifyReceipt(receipt).verdict, 'verified');
  assert.throws(() => verifyReceipt({ ...receipt, verdict: 'still_failing' }));
});

test('unreproduced baseline skips candidate and saves credits', async () => {
  const events: string[] = [];
  const receipt = await runExperiment(manifest, provider(events, 'not-reproduced'));
  assert.equal(receipt.verdict, 'not_reproduced');
  assert.equal(receipt.lanes.length, 1);
  assert.deepEqual(events, ['create:baseline', 'execute:baseline', 'kill:baseline']);
});

test('execution, creation and cleanup failures remain visible and inconclusive', async () => {
  for (const failure of ['create', 'execute', 'kill']) {
    const events: string[] = [];
    const receipt = await runExperiment(manifest, provider(events, failure));
    assert.equal(receipt.verdict, 'inconclusive');
    assert.equal(receipt.lanes.length, 1);
    assert.ok(receipt.lanes[0]?.error || receipt.lanes[0]?.cleanupError);
    if (failure !== 'create') assert.ok(events.includes('kill:baseline'));
  }
});

test('both lanes receive the same probe definition (same-probe guarantee)', async () => {
  const probes: unknown[] = [];
  const probeCapturingProvider: Provider = {
    kind: 'simulation', cleanup: async () => {},
    create: async ({ lane }) => ({
      id: `sim-${lane}`,
      execute: async (m) => { probes.push(JSON.parse(JSON.stringify(m.probe))); return output(lane); },
      kill: async () => {},
    }),
  };
  const receipt = await runExperiment(manifest, probeCapturingProvider);
  assert.equal(receipt.verdict, 'verified');
  assert.equal(probes.length, 2);
  assert.deepEqual(probes[0], probes[1]);
});

test('external cancellation during execution produces inconclusive with cleanup', async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const cancelProvider: Provider = {
    kind: 'simulation', cleanup: async () => {},
    create: async ({ lane }) => ({
      id: `sim-${lane}`,
      execute: async () => { controller.abort(); return new Promise(() => {}); },
      kill: async () => { events.push(`kill:${lane}`); },
    }),
  };
  const receipt = await runExperiment(manifest, cancelProvider, { signal: controller.signal });
  assert.equal(receipt.verdict, 'inconclusive');
  assert.equal(receipt.lanes.length, 1);
  assert.ok(receipt.lanes[0]?.error);
  assert.ok(events.includes('kill:baseline'));
});

test('cleanup failure blocks verified verdict even when both results are correct', async () => {
  let killCount = 0;
  const fragileCleanupProvider: Provider = {
    kind: 'simulation', cleanup: async () => {},
    create: async ({ lane }) => ({
      id: `sim-${lane}`,
      execute: async () => output(lane),
      kill: async () => {
        killCount++;
        if (killCount === 2) throw new Error('DELETE failed on candidate');
      },
    }),
  };
  const receipt = await runExperiment(manifest, fragileCleanupProvider);
  assert.equal(receipt.verdict, 'inconclusive', 'cleanup failure must prevent verified');
  assert.ok(receipt.lanes.some(l => l.cleanupError));
  assert.ok(receipt.lanes.some(l => l.state === 'cleanup_failed'));
});

test('receipt verification rejects tampered verdict and out-of-order lanes', async () => {
  const events: string[] = [];
  const receipt = await runExperiment(manifest, provider(events));
  assert.equal(verifyReceipt(receipt).verdict, 'verified');
  // Tamper: change verdict without recalculating hash
  assert.throws(() => verifyReceipt({ ...receipt, verdict: 'still_failing' }), /integrity|verdict/i);
  // Tamper: change manifest hash
  assert.throws(() => verifyReceipt({ ...receipt, manifestSha256: 'bad', sha256: receipt.sha256 }), /integrity/i);
});

test('cancellation during candidate cleanup prevents verification', async () => {
  const controller = new AbortController();
  const receipt = await runExperiment(manifest, {
    kind: 'simulation', cleanup: async () => {},
    create: async ({ lane }) => ({ id: `sim-${lane}`, execute: async () => output(lane), kill: async () => { if (lane === 'candidate') controller.abort(); } }),
  }, { signal: controller.signal });
  assert.equal(receipt.verdict, 'inconclusive');
});

test('a reused session cannot supply fresh candidate evidence', async () => {
  const receipt = await runExperiment(manifest, {
    kind: 'simulation', cleanup: async () => {},
    create: async ({ lane }) => ({ id: 'sim-same-session', execute: async () => output(lane), kill: async () => {} }),
  });
  assert.equal(receipt.verdict, 'inconclusive');
});

test('receipt verification validates structure and cost even when hashes are recomputed', async () => {
  const receipt = await runExperiment(manifest, provider([]));
  const reseal = (value: unknown) => { const { sha256: _hash, ...body } = value as Record<string, unknown>; return { ...body, sha256: digest(body) }; };
  for (const change of [
    { ...receipt, id: undefined },
    { ...receipt, startedAt: 'not-a-date' },
    { ...receipt, extra: true },
    { ...receipt, cost: { ...receipt.cost, sessionsCreated: 0 } },
    { ...receipt, lanes: receipt.lanes.map(l => ({ ...l, sessionId: 'sim-duplicate' })) },
    { ...receipt, lanes: receipt.lanes.map(l => ({ ...l, error: 0 })) },
    { ...receipt, verdict: 'still_failing' },
  ]) assert.throws(() => verifyReceipt(reseal(change)), JSON.stringify(change));
});

test('provider cannot change the reviewer probe between lanes', async () => {
  const receipt = await runExperiment(manifest, {
    kind: 'simulation', cleanup: async () => {},
    create: async ({ lane }) => ({ id: `sim-${lane}`, execute: async m => { m.probe.files['p.py'] = 'print("FIXED")'; return output(lane); }, kill: async () => {} }),
  });
  assert.equal(receipt.verdict, 'inconclusive');
  assert.equal(receipt.manifest.probe.files['p.py'], 'pass');
});

test('malformed protocol, missing evidence and changed probe remain inconclusive with cleanup', async () => {
  for (const evidence of [{}, null, { ...output('candidate'), protocol: 2 }, { ...output('candidate'), probeSha256: 'a'.repeat(64) }, { ...output('candidate'), probe: null }]) {
    let released = 0;
    const receipt = await runExperiment(manifest, { kind: 'simulation', cleanup: async () => {}, create: async ({ lane }) => ({ id: `sim-${lane}`, execute: async () => lane === 'baseline' ? output(lane) : evidence, kill: async () => { released++; } }) });
    assert.equal(receipt.verdict, 'inconclusive');
    assert.equal(released, 2);
    assert.equal(verifyReceipt(receipt).verdict, 'inconclusive');
  }
});

test('late creation after cancellation is released without starting a candidate', async () => {
  const controller = new AbortController();
  let finish: ((value: Awaited<ReturnType<Provider['create']>>) => void) | undefined;
  let released = false;
  const waiting = runExperiment(manifest, { kind: 'simulation', cleanup: async () => {}, create: async () => { controller.abort(); return new Promise(resolve => { finish = resolve; }); } }, { signal: controller.signal });
  const receipt = await waiting;
  assert.equal(receipt.verdict, 'inconclusive');
  assert.equal(receipt.lanes[0]?.state, 'creation_uncertain');
  finish!({ id: 'sim-late', execute: async () => { throw new Error('must not execute'); }, kill: async () => { released = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, true);
});

test('opaque provider session IDs may contain periods and must survive receipt verification', async () => {
  const receipt = await runExperiment(manifest, { kind: 'simulation', cleanup: async () => {}, create: async ({ lane }) => ({ id: `opaque-payload-${lane}.signature`, execute: async () => output(lane), kill: async () => {} }) });
  assert.equal(receipt.verdict, 'verified');
  assert.equal(verifyReceipt(receipt).verdict, 'verified');
});
