import { createHash } from 'node:crypto';

export type Lane = 'baseline' | 'candidate';
export type Verdict = 'verified' | 'not_reproduced' | 'still_failing' | 'inconclusive';
export type Command = { argv: string[] };
export type Source = { kind: 'fixture'; baseline: Record<string, string>; candidate: Record<string, string> }
  | { kind: 'git'; url: string; baseline: string; candidate: string };
export type Manifest = {
  version: 1; name: string; source: Source; setup: Command[];
  probe: Command & { files: Record<string, string>; expectedFailure: { exitCode: number; contains: string }; expectedSuccess: { contains: string } };
  limits: { sessionSeconds: number; commandSeconds: number };
};
export type CommandOutput = { exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; durationMs: number };
export type GuestResult = {
  protocol: 1; revision: string | null; probeSha256: string | null; runtime: { python: string; platform: string };
  setup: CommandOutput[]; probe: CommandOutput | null; error: string | null;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}
function text(value: unknown, label: string, max = 8192, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) throw new Error(`${label} must be ${empty ? '' : 'nonempty '}text up to ${max} characters without NUL`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}
function files(value: unknown, label: string): Record<string, string> {
  const obj = object(value, label);
  if (Object.keys(obj).length > 32) throw new Error(`${label}: maximum 32 files`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [path, content] of Object.entries(obj)) {
    if (path.length > 200 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path) || path.split('/').some(p => !p || p === '..' || p === '.' || p === '.git' || p === '__proto__')) throw new Error(`${label}: unsafe relative file path`);
    result[path] = text(content, `${label} content`, 65536, true);
  }
  return result;
}
function command(value: unknown, label: string): Command {
  const obj = object(value, label);
  keys(obj, ['argv'], label);
  if (!Array.isArray(obj.argv) || obj.argv.length < 1 || obj.argv.length > 64) throw new Error(`${label}.argv needs 1–64 arguments`);
  return { argv: obj.argv.map((v, i) => text(v, `${label}.argv[${i}]`, 8192, i !== 0)) };
}

export function parseManifest(value: unknown): Manifest {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 262144) throw new Error('Manifest exceeds 256 KiB');
  const obj = object(value, 'manifest');
  keys(obj, ['version', 'name', 'source', 'setup', 'probe', 'limits'], 'manifest');
  if (obj.version !== 1) throw new Error('manifest.version must be 1');
  const name = text(obj.name, 'name', 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/.test(name)) throw new Error('name must use letters, numbers, spaces, periods, underscores or hyphens');
  const rawSource = object(obj.source, 'source');
  let source: Source;
  if (rawSource.kind === 'fixture') {
    keys(rawSource, ['kind', 'baseline', 'candidate'], 'source');
    source = { kind: 'fixture', baseline: files(rawSource.baseline, 'baseline'), candidate: files(rawSource.candidate, 'candidate') };
  } else if (rawSource.kind === 'git') {
    keys(rawSource, ['kind', 'url', 'baseline', 'candidate'], 'source');
    const url = text(rawSource.url, 'source.url', 200);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(url)) throw new Error('source.url must be a public HTTPS GitHub owner/repository URL without credentials, query or fragments');
    const baseline = text(rawSource.baseline, 'baseline revision', 40);
    const candidate = text(rawSource.candidate, 'candidate revision', 40);
    if (![baseline, candidate].every(v => /^[a-f0-9]{40}$/.test(v)) || baseline === candidate) throw new Error('Use two distinct full lowercase 40-hex commit hashes');
    source = { kind: 'git', url, baseline, candidate };
  } else throw new Error('source.kind must be fixture or git');
  if (!Array.isArray(obj.setup) || obj.setup.length > 5) throw new Error('setup must contain at most five commands');
  const setup = obj.setup.map((c, i) => command(c, `setup[${i}]`));
  const rawProbe = object(obj.probe, 'probe');
  keys(rawProbe, ['argv', 'files', 'expectedFailure', 'expectedSuccess'], 'probe');
  const failure = object(rawProbe.expectedFailure, 'expectedFailure');
  const success = object(rawProbe.expectedSuccess, 'expectedSuccess');
  keys(failure, ['exitCode', 'contains'], 'expectedFailure'); keys(success, ['contains'], 'expectedSuccess');
  const failText = text(failure.contains, 'failure witness', 256);
  const successText = text(success.contains, 'success witness', 256);
  if (failText.includes(successText) || successText.includes(failText)) throw new Error('Failure and success witnesses must not contain each other');
  const limits = object(obj.limits, 'limits');
  keys(limits, ['sessionSeconds', 'commandSeconds'], 'limits');
  const sessionSeconds = integer(limits.sessionSeconds, 'sessionSeconds', 10, 300);
  const commandSeconds = integer(limits.commandSeconds, 'commandSeconds', 1, 120);
  if (commandSeconds >= sessionSeconds) throw new Error('commandSeconds must be less than sessionSeconds');
  return {
    version: 1, name, source, setup,
    probe: { ...command({ argv: rawProbe.argv }, 'probe'), files: files(rawProbe.files, 'probe.files'), expectedFailure: { exitCode: integer(failure.exitCode, 'expectedFailure.exitCode', 1, 125), contains: failText }, expectedSuccess: { contains: successText } },
    limits: { sessionSeconds, commandSeconds },
  };
}

function output(value: unknown): CommandOutput {
  const obj = object(value, 'command output');
  keys(obj, ['exitCode', 'stdout', 'stderr', 'timedOut', 'truncated', 'durationMs'], 'command output');
  if (typeof obj.timedOut !== 'boolean' || typeof obj.truncated !== 'boolean') throw new Error('Output needs explicit timeout and truncation flags');
  return { exitCode: integer(obj.exitCode, 'exitCode', -2147483648, 2147483647), stdout: text(obj.stdout, 'stdout', 8192, true), stderr: text(obj.stderr, 'stderr', 8192, true), timedOut: obj.timedOut, truncated: obj.truncated, durationMs: integer(obj.durationMs, 'durationMs', 0, 3600000) };
}
export function parseGuestResult(value: unknown): GuestResult {
  const obj = object(value, 'guest result');
  keys(obj, ['protocol', 'revision', 'probeSha256', 'runtime', 'setup', 'probe', 'error'], 'guest result');
  if (obj.protocol !== 1) throw new Error('Unsupported guest protocol');
  const runtime = object(obj.runtime, 'runtime');
  keys(runtime, ['python', 'platform'], 'runtime');
  if (!Array.isArray(obj.setup) || obj.setup.length > 5) throw new Error('Malformed setup results');
  const revision = obj.revision === null ? null : text(obj.revision, 'revision', 40);
  if (revision !== null && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Malformed revision');
  const probeSha256 = obj.probeSha256 === null ? null : text(obj.probeSha256, 'probeSha256', 64);
  if (probeSha256 !== null && !/^[a-f0-9]{64}$/.test(probeSha256)) throw new Error('Malformed probe digest');
  return { protocol: 1, revision, probeSha256, runtime: { python: text(runtime.python, 'runtime.python', 256), platform: text(runtime.platform, 'runtime.platform', 256) }, setup: obj.setup.map(output), probe: obj.probe === null ? null : output(obj.probe), error: obj.error === null ? null : text(obj.error, 'guest error', 2048) };
}

export function laneOutcome(manifest: Manifest, lane: Lane, result?: GuestResult): 'failed_as_expected' | 'passed' | 'unknown' {
  if (!result || result.error !== null || result.setup.length !== manifest.setup.length || result.setup.some(r => r.exitCode !== 0 || r.timedOut || r.truncated)) return 'unknown';
  if (manifest.source.kind === 'git' && result.revision !== manifest.source[lane]) return 'unknown';
  if (manifest.source.kind === 'fixture' && result.revision !== null) return 'unknown';
  if (result.probeSha256 !== probeDigest(manifest.probe)) return 'unknown';
  const probe = result.probe;
  if (!probe || probe.timedOut || probe.truncated) return 'unknown';
  const log = probe.stdout + '\n' + probe.stderr;
  const failure = log.includes(manifest.probe.expectedFailure.contains);
  const success = log.includes(manifest.probe.expectedSuccess.contains);
  if (failure && !success && probe.exitCode === manifest.probe.expectedFailure.exitCode) return 'failed_as_expected';
  if (success && !failure && probe.exitCode === 0) return 'passed';
  return 'unknown';
}
export function classify(manifest: Manifest, baseline?: GuestResult, candidate?: GuestResult): Verdict {
  const before = laneOutcome(manifest, 'baseline', baseline);
  if (before === 'passed') return 'not_reproduced';
  if (before !== 'failed_as_expected') return 'inconclusive';
  const after = laneOutcome(manifest, 'candidate', candidate);
  return after === 'passed' ? 'verified' : after === 'failed_as_expected' ? 'still_failing' : 'inconclusive';
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function probeDigest(probe: Manifest['probe']): string {
  return digest([probe.argv, Object.keys(probe.files).sort().map(path => [path, createHash('sha256').update(probe.files[path]!, 'utf8').digest('hex')])]);
}
export function safeText(value: string, secrets: string[] = []): string {
  let clean = value;
  for (const secret of secrets) if (secret) clean = clean.split(secret).join('[REDACTED]');
  return clean.replace(/slr_live_[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '');
}
