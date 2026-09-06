import { randomUUID } from 'node:crypto';
import { classify, digest, laneOutcome, parseGuestResult, parseManifest, safeText, type GuestResult, type Lane, type Manifest, type Verdict } from './domain.ts';

export type Session = {
  id: string;
  execute(manifest: Manifest, lane: Lane, signal: AbortSignal): Promise<unknown>;
  kill(signal: AbortSignal): Promise<void>;
};
export type Provider = {
  kind: 'solari' | 'simulation';
  create(context: { runId: string; lane: Lane; sessionSeconds: number }, signal: AbortSignal): Promise<Session>;
  cleanup(id: string, signal: AbortSignal): Promise<void>;
};
export type Event = { at: string; runId: string; lane: Lane; state: string; sessionId?: string; detail?: string };
export type LaneReceipt = {
  lane: Lane; state: 'released' | 'cleanup_failed' | 'creation_failed' | 'creation_uncertain';
  startedAt: string; endedAt: string; durationMs: number; computeMs: number;
  sessionId?: string; result?: GuestResult; error?: string; cleanupError?: string;
};
export type Receipt = {
  schema: 1; id: string; provider: Provider['kind']; manifest: Manifest; manifestSha256: string;
  startedAt: string; endedAt: string; verdict: Verdict; lanes: LaneReceipt[];
  cost: { sessionsCreated: number; computeSeconds: number; estimatedUsd: number; rateUsdPerHour: number; estimateOnly: true };
  sha256: string;
};
export const COMPUTE_RATE = 0.0855;
const CLEANUP_MS = 10000;
function sessionIdentity(value: unknown): value is string {
  // Provider handles are opaque (including signed, period-separated values).
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
function freeze(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child as object);
  Object.freeze(value);
}

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); throw new Error('Operation cancelled or deadline exceeded'); }
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Operation cancelled or deadline exceeded'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export async function runExperiment(input: Manifest, provider: Provider, options: { signal?: AbortSignal; onEvent?: (event: Event) => void; secrets?: string[] } = {}): Promise<Receipt> {
  const manifest = parseManifest(input);
  freeze(manifest);
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const lanes: LaneReceipt[] = [];
  const message = (error: unknown) => safeText(error instanceof Error ? error.message : String(error), options.secrets).slice(0, 2048);
  for (const lane of ['baseline', 'candidate'] as const) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), manifest.limits.sessionSeconds * 1000);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const record: LaneReceipt = { lane, state: 'creation_failed', startedAt: new Date(start).toISOString(), endedAt: '', durationMs: 0, computeMs: 0 };
    let session: Session | undefined;
    let allocationAt = 0;
    const emit = (state: string, detail?: string) => options.onEvent?.({ at: new Date().toISOString(), runId: id, lane, state, ...(session ? { sessionId: session.id } : {}), ...(detail ? { detail } : {}) });
    try {
      signal.throwIfAborted();
      emit('creating');
      const creation = provider.create({ runId: id, lane, sessionSeconds: manifest.limits.sessionSeconds }, signal);
      // A provider that completes after cancellation still owes us a release.
      void creation.then(async late => {
        if (!signal.aborted || session) return;
        try {
          options.onEvent?.({ at: new Date().toISOString(), runId: id, lane, state: 'late_creation', sessionId: late.id });
        } finally {
          try { await abortable(late.kill(AbortSignal.timeout(CLEANUP_MS)), AbortSignal.timeout(CLEANUP_MS)); }
          catch (error) { options.onEvent?.({ at: new Date().toISOString(), runId: id, lane, state: 'late_cleanup_failed', sessionId: late.id, detail: message(error) }); }
        }
      }).catch(() => {});
      try { session = await abortable(creation, signal); }
      catch (error) { record.state = 'creation_uncertain'; throw error; }
      allocationAt = Date.now();
      record.sessionId = session.id;
      if (!sessionIdentity(session.id)) throw new Error('Invalid session identity');
      if (lanes.some(previous => previous.sessionId === session!.id)) throw new Error('Provider reused a session; candidate isolation is unconfirmed');
      emit('running');
      const raw = await abortable(session.execute(manifest, lane, signal), signal);
      record.result = parseGuestResult(raw);
    } catch (error) {
      record.error = message(error);
    } finally {
      clearTimeout(timer);
      if (session) {
        try { emit('cleaning'); } catch (error) { record.error ??= message(error); }
        const cleanupSignal = AbortSignal.timeout(CLEANUP_MS);
        try {
          await abortable(session.kill(cleanupSignal), cleanupSignal);
          record.state = 'released';
        } catch (error) {
          record.state = 'cleanup_failed'; record.cleanupError = message(error);
        }
        record.computeMs = Math.max(0, Date.now() - allocationAt);
      }
      record.durationMs = Math.max(0, Date.now() - start);
      record.endedAt = new Date().toISOString();
      if (options.signal?.aborted) record.error ??= 'Experiment cancelled';
      lanes.push(record);
      try { emit(record.state, record.cleanupError ?? record.error); } catch (error) { record.error ??= message(error); }
      if (options.signal?.aborted) record.error ??= 'Experiment cancelled';
    }
    if (record.state !== 'released' || record.error || laneOutcome(manifest, lane, record.result) !== 'failed_as_expected') break;
  }
  const verdict = receiptVerdict(manifest, lanes);
  const computeSeconds = lanes.reduce((sum, lane) => sum + lane.computeMs / 1000, 0);
  const body = {
    schema: 1 as const, id, provider: provider.kind, manifest, manifestSha256: digest(manifest), startedAt, endedAt: new Date().toISOString(), verdict, lanes,
    cost: { sessionsCreated: lanes.filter(l => l.sessionId).length, computeSeconds, estimatedUsd: provider.kind === 'solari' ? computeSeconds * COMPUTE_RATE / 3600 : 0, rateUsdPerHour: COMPUTE_RATE, estimateOnly: true as const },
  };
  return { ...body, sha256: digest(body) };
}

function receiptVerdict(manifest: Manifest, lanes: LaneReceipt[]): Verdict {
  if (lanes.some(l => l.error || l.cleanupError || l.state !== 'released')) return 'inconclusive';
  return classify(manifest, lanes[0]?.result, lanes[1]?.result);
}

export function verifyReceipt(value: unknown): Receipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Receipt must be an object');
  // Hash first; all behavior-affecting fields are then checked independently.
  const raw = value as Record<string, unknown>;
  const only = (obj: object, names: string[]) => { if (Object.keys(obj).some(key => !names.includes(key))) throw new Error('Unexpected receipt field'); };
  only(raw, ['schema', 'id', 'provider', 'manifest', 'manifestSha256', 'startedAt', 'endedAt', 'verdict', 'lanes', 'cost', 'sha256']);
  const timestamp = (v: unknown): number => {
    if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('Invalid receipt timestamp');
    return Date.parse(v);
  };
  if (typeof raw.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.id)) throw new Error('Invalid receipt ID');
  const start = timestamp(raw.startedAt), end = timestamp(raw.endedAt);
  if (end < start) throw new Error('Invalid receipt chronology');
  const { sha256, ...body } = raw;
  if (typeof sha256 !== 'string' || digest(body) !== sha256) throw new Error('Receipt integrity check failed');
  if (raw.schema !== 1 || !['solari', 'simulation'].includes(String(raw.provider))) throw new Error('Unknown receipt schema or provider');
  const manifest = parseManifest(raw.manifest);
  if (raw.manifestSha256 !== digest(manifest)) throw new Error('Manifest integrity check failed');
  if (!Array.isArray(raw.lanes) || raw.lanes.length < 1 || raw.lanes.length > 2) throw new Error('Invalid receipt lanes');
  const lanes = raw.lanes.map((item: unknown, i: number): LaneReceipt => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid lane');
    const lane = item as LaneReceipt;
    only(lane, ['lane', 'state', 'startedAt', 'endedAt', 'durationMs', 'computeMs', 'sessionId', 'result', 'error', 'cleanupError']);
    if (lane.lane !== (i === 0 ? 'baseline' : 'candidate') || !['released', 'cleanup_failed', 'creation_failed', 'creation_uncertain'].includes(lane.state)) throw new Error('Invalid lane ordering or state');
    if ((lane.state === 'released' || lane.state === 'cleanup_failed') && !sessionIdentity(lane.sessionId)) throw new Error('Allocated lane needs session identity');
    if (lane.sessionId !== undefined && !sessionIdentity(lane.sessionId)) throw new Error('Invalid session identity');
    if ((lane.state === 'creation_failed' || lane.state === 'creation_uncertain') && lane.sessionId !== undefined) throw new Error('Unallocated lane has session identity');
    for (const field of ['error', 'cleanupError'] as const) if (field in lane && (typeof lane[field] !== 'string' || !lane[field]?.trim() || lane[field]!.length > 2048)) throw new Error('Invalid lane error');
    if (lane.state === 'cleanup_failed' && !lane.cleanupError) throw new Error('Missing cleanup failure evidence');
    if (lane.state === 'released' && lane.cleanupError) throw new Error('Conflicting cleanup evidence');
    if (!lane.result && !lane.error) throw new Error('Missing lane evidence or failure reason');
    for (const duration of [lane.durationMs, lane.computeMs]) if (!Number.isInteger(duration) || duration < 0) throw new Error('Invalid lane duration');
    const laneStart = timestamp(lane.startedAt), laneEnd = timestamp(lane.endedAt);
    if (laneStart < start || laneEnd > end || laneEnd < laneStart || lane.computeMs > lane.durationMs || lane.durationMs > laneEnd - laneStart) throw new Error('Invalid lane chronology');
    if (lane.result !== undefined) parseGuestResult(lane.result);
    return lane;
  });
  if (lanes.length === 2) {
    const [baseline, candidate] = lanes;
    if (baseline?.state !== 'released' || baseline.error || laneOutcome(manifest, 'baseline', baseline.result) !== 'failed_as_expected') throw new Error('Candidate ran without reproduced baseline');
    // Reused IDs may be retained in an inconclusive receipt as failure evidence.
    if (baseline.sessionId === candidate?.sessionId && !candidate?.error) throw new Error('Candidate reused baseline session');
    if (timestamp(candidate?.startedAt) < timestamp(baseline.endedAt)) throw new Error('Overlapping sessions');
  }
  if (raw.verdict !== receiptVerdict(manifest, lanes)) throw new Error('Receipt verdict disagrees with evidence');
  if (!raw.cost || typeof raw.cost !== 'object' || Array.isArray(raw.cost)) throw new Error('Missing cost evidence');
  const cost = raw.cost as Receipt['cost'];
  only(cost, ['sessionsCreated', 'computeSeconds', 'estimatedUsd', 'rateUsdPerHour', 'estimateOnly']);
  const computeSeconds = lanes.reduce((sum, lane) => sum + lane.computeMs / 1000, 0);
  if (cost.sessionsCreated !== lanes.filter(l => l.sessionId).length || cost.computeSeconds !== computeSeconds || cost.rateUsdPerHour !== COMPUTE_RATE || cost.estimateOnly !== true || cost.estimatedUsd !== (raw.provider === 'solari' ? computeSeconds * COMPUTE_RATE / 3600 : 0)) throw new Error('Cost evidence disagrees with lanes');
  return value as Receipt;
}
