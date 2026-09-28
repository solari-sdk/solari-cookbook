/** Application-owned APIs. They do not extend or monkey-patch the Solari SDK. */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import observation from './observation.cjs';
import { parseCheckpoint } from './checkpoint.ts';
import { provision, terminate } from './solari.ts';
import type { Compute, Sandbox, Termination } from './types.ts';

export const selectedPaths = ['README.md', 'package.json', 'src/index.js'] as const;
export type Source = Record<(typeof selectedPaths)[number], Uint8Array>;
export const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const noAuthority = () => ({ canonicalAuthority: false as const, executionAuthority: false as const });
export function sourceFromDirectory(root: string): Source {
  const source = {} as Source;
  for (const name of selectedPaths) {
    const item = observation.reader(root, name, { files: 0, bytes: 0 });
    if (item.state !== 'OBSERVED' || typeof item.content !== 'string') throw Error('SOURCE_' + item.reason);
    source[name] = Buffer.from(item.content);
  }
  return source;
}
function validateSource(source: Source): Source {
  if (Object.keys(source).sort().join('|') !== [...selectedPaths].sort().join('|')) throw Error('SOURCE_SCOPE');
  const result = {} as Source;
  for (const name of selectedPaths) {
    const b = Buffer.from(source[name]);
    if (b.length > 65536 || !Buffer.from(b.toString('utf8')).equals(b)) throw Error('SOURCE_BYTES');
    result[name] = b;
  }
  return result;
}
function locally<T>(source: Source, operation: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'hito-continuity-'));
  try {
    mkdirSync(join(root, 'src'));
    for (const name of selectedPaths) writeFileSync(join(root, name), source[name]);
    return operation(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
export interface Handoff {
  kind: 'HITO_APPLICATION_HANDOFF_V1';
  checkpoint: any;
  checkpointId: string;
  senderId: string;
  capturedAt: string;
  termination: Termination;
  provenance: 'CONTROLLER_OBSERVED_NOT_CRYPTOGRAPHIC_ATTESTATION';
  authority: ReturnType<typeof noAuthority>;
}
export interface Branch { parentCheckpointId: string; branchId: string; handoff: Handoff }
export function validateHandoff(h: Handoff): Handoff {
  const v = copy(h);
  parseCheckpoint(JSON.stringify(v.checkpoint));
  if (v.kind !== 'HITO_APPLICATION_HANDOFF_V1' || v.checkpointId !== v.checkpoint.sha256 ||
      !v.senderId || !Number.isFinite(Date.parse(v.capturedAt)) ||
      v.termination.id !== v.senderId || v.termination.terminated !== true ||
      !['ACKNOWLEDGED_KILL_AND_GET_GONE', 'ACKNOWLEDGED_KILL_AND_STRUCTURED_404'].includes(v.termination.basis) ||
      v.provenance !== 'CONTROLLER_OBSERVED_NOT_CRYPTOGRAPHIC_ATTESTATION' ||
      JSON.stringify(v.authority) !== JSON.stringify(noAuthority())) throw Error('HANDOFF_INVALID');
  return v;
}
/** Registry is scoped to one orchestration, not a distributed authority. */
export class BranchRegistry {
  private readonly ids = new Set<string>();
  forkCheckpoint(parent: Handoff, branchId: string): Branch {
    const handoff = validateHandoff(parent);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(branchId) || this.ids.has(branchId)) throw Error('BRANCH_ID');
    this.ids.add(branchId);
    return { parentCheckpointId: handoff.checkpointId, branchId, handoff };
  }
}
export interface Receipt {
  workerId: string; branchId: string; parentCheckpointId: string;
  observedAt: string; termination: Termination; takeover: any;
  authority: ReturnType<typeof noAuthority>;
}
export type WorkerObservationHook = (worker: Sandbox, context: {
  phase: 'capture' | 'takeover'; checkpointId: string; observation: any;
}) => Promise<void>;
const guestHome = '/tmp/hito-semantic-checkpoint';
const guestRoot = guestHome + '/project';
export class ContinuitySandbox {
  private attempts = 0;
  private readonly ids = new Set<string>();
  private readonly branches = new Set<string>();
  private stopped = false;
  private readonly client: Compute;
  private readonly maxCreations: number;
  private readonly hook?: WorkerObservationHook;
  constructor(client: Compute, maxCreations: number, hook?: WorkerObservationHook) {
    if (!Number.isInteger(maxCreations) || maxCreations < 1) throw Error('INVALID_BUDGET');
    this.client = client; this.maxCreations = maxCreations; this.hook = hook;
  }
  get createAttempts() { return this.attempts; }
  private async run(sourceInput: Source, handoff?: Handoff) {
    const source = validateSource(sourceInput);
    if (this.stopped || this.attempts >= this.maxCreations) throw Error('CREATE_BUDGET_OR_UNRESOLVED_CLEANUP');
    this.attempts++; // Count dispatch, including unknown creation outcomes; no retry.
    let sandbox: Sandbox;
    try { sandbox = await this.client.create({ template: 'base', cpu: 1, memMb: 2048, timeoutMs: 60000, lifecycle: { onTimeout: 'kill' } }); }
    catch { this.stopped = true; throw Error('CREATE_OUTCOME_UNKNOWN'); }
    let value: any;
    let observedAt = '';
    let termination!: Termination;
    try {
      if (!sandbox.id || this.ids.has(sandbox.id) || sandbox.id === handoff?.senderId) throw Error('FRESH_WORKER_REQUIRED');
      this.ids.add(sandbox.id);
      await sandbox.connect();
      const command = async (cmd: string, args: string[]) => {
        const r = await sandbox.commands.run(cmd, { args, timeoutMs: 30000 });
        if (r.exitCode !== 0 || Buffer.byteLength(r.stdout) > 1048576) throw Error('GUEST_RESULT_INVALID');
        return r.stdout;
      };
      await command('sh', ['-c', provision]);
      for (const name of ['hito-observation.cjs', 'observation.cjs', 'guest.cjs'])
        await sandbox.files.write(guestHome + '/' + name, readFileSync(new URL(name, import.meta.url)));
      for (const name of selectedPaths) await sandbox.files.write(guestRoot + '/' + name, source[name]);
      if (handoff) {
        await command('mkdir', ['-p', guestRoot + '/.maat']);
        await sandbox.files.write(guestRoot + '/.maat/solari-public-checkpoint.json', JSON.stringify(handoff.checkpoint));
      }
      const raw = await command(guestHome + '/node', [guestHome + '/guest.cjs', handoff ? 'takeover' : 'capture', guestRoot]);
      value = handoff ? JSON.parse(raw) : parseCheckpoint(raw);
      const expected = locally(source, root => handoff ? observation.takeover(root, handoff.checkpoint) : observation.checkpoint(observation.observe(root)));
      if (JSON.stringify(value) !== JSON.stringify(expected)) throw Error('OBSERVATION_PARITY_FAILED');
      observedAt = new Date().toISOString();
      await this.hook?.(sandbox, { phase: handoff ? 'takeover' : 'capture', checkpointId: handoff?.checkpointId ?? value.sha256, observation: value });
    } catch (error) {
      const known = ['FRESH_WORKER_REQUIRED', 'GUEST_RESULT_INVALID', 'OBSERVATION_PARITY_FAILED'];
      throw Error(error instanceof Error && known.includes(error.message) ? error.message : 'CONTINUITY_OPERATION_FAILED');
    } finally {
      try { termination = await terminate(this.client, sandbox); }
      catch { this.stopped = true; throw Error('TERMINATION_UNCONFIRMED'); }
      finally { sandbox.close(); }
    }
    return { value, workerId: sandbox.id, observedAt, termination };
  }
  async captureHandoff(source: Source): Promise<Handoff> {
    const r = await this.run(source);
    return validateHandoff({ kind: 'HITO_APPLICATION_HANDOFF_V1', checkpoint: r.value,
      checkpointId: r.value.sha256, senderId: r.workerId, capturedAt: r.observedAt,
      termination: r.termination, provenance: 'CONTROLLER_OBSERVED_NOT_CRYPTOGRAPHIC_ATTESTATION', authority: noAuthority() });
  }
  async createContinuitySandbox(source: Source, branch: Branch): Promise<Receipt> {
    const h = validateHandoff(branch.handoff);
    if (branch.parentCheckpointId !== h.checkpointId || !/^[a-zA-Z0-9_-]{1,64}$/.test(branch.branchId) || this.branches.has(branch.branchId)) throw Error('BRANCH_PARENT_OR_ID');
    this.branches.add(branch.branchId);
    const r = await this.run(source, h);
    return { workerId: r.workerId, branchId: branch.branchId, parentCheckpointId: h.checkpointId,
      observedAt: r.observedAt, takeover: r.value, termination: r.termination, authority: noAuthority() };
  }
  resumeFromHandoff(source: Source, branch: Branch) { return this.createContinuitySandbox(source, branch); }
  /** Sequential workers preserve identity without requiring a concurrency entitlement. */
  async multiWorker(inputs: { source: Source; branch: Branch }[]): Promise<Receipt[]> {
    if (new Set(inputs.map(i => i.branch.branchId)).size !== inputs.length) throw Error('DUPLICATE_BRANCH');
    const results: Receipt[] = [];
    for (const i of inputs) results.push(await this.resumeFromHandoff(i.source, i.branch));
    return results;
  }
}
export const hitoSolari = { create: (client: Compute, maxCreations: number) => new ContinuitySandbox(client, maxCreations) };
