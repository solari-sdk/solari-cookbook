import {
  array,
  boolean,
  DecodeError,
  type Decoder,
  integer,
  nullable,
  number,
  object,
  oneOf,
  optional,
  record,
  string,
} from './decode.ts';

/** Bumped only for breaking changes. Readers reject capsules newer than they understand. */
export const CAPSULE_VERSION = 1;

export interface Capsule {
  twin: number;
  createdAt: string;
  generator: string;
  command: CommandFact;
  os: OsFact;
  runtimes: Record<string, string>;
  tools: Record<string, string>;
  packageManagers: PackageManagerFact[];
  resolved: ResolvedDeps;
  repo: RepoFact | null;
  env: Record<string, EnvFact>;
  locale: LocaleFact;
  redaction: RedactionFact;
}

export interface CommandFact {
  argv: string[];
  /** Working directory relative to the repo root (or "." outside a repo), forward slashes. */
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outcome: 'pass' | 'fail';
  failure: FailureFact | null;
}

export interface FailureFact {
  /** Stable identity of the failure: exit status plus a fingerprint of normalized error lines. */
  signature: string;
  keyLines: string[];
  outputTail: string;
}

export interface OsFact {
  platform: string;
  arch: string;
  release: string;
  distro: string | null;
  distroVersion: string | null;
  libc: 'glibc' | 'musl' | null;
  libcVersion: string | null;
}

export type Ecosystem = 'node' | 'python' | 'rust' | 'go';

export interface PackageManagerFact {
  name: string;
  ecosystem: Ecosystem;
  version: string | null;
  /** Version pinned by package.json "packageManager", when present. */
  declared: string | null;
  /** Lockfile path relative to the repo root. */
  lockfile: string | null;
  lockfileSha256: string | null;
}

export interface ResolvedDeps {
  /** Installed package versions found in node_modules. Several entries mean duplicates. */
  node?: Record<string, string[]>;
  /** Installed distributions in the active Python environment, PEP 503 normalized names. */
  python?: Record<string, string>;
}

export interface RepoFact {
  remote: string | null;
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  /** `git diff HEAD` of tracked files, scrubbed. */
  diff: string;
  diffTruncated: boolean;
  /** True when scrubbing replaced part of the diff, so it may not apply cleanly on replay. */
  diffRedacted: boolean;
  /** Untracked file names only, never contents. */
  untracked: string[];
}

export type EnvState = 'set' | 'empty' | 'absent';

export interface EnvFact {
  state: EnvState;
  /** Present only for allowlisted or explicitly included variables. */
  value?: string;
  /** HMAC of the value under a maintainer-provided salt, for equality checks without disclosure. */
  hash?: string;
}

export interface LocaleFact {
  timeZone: string | null;
  locale: string | null;
}

export interface RedactionFact {
  rulesVersion: number;
  valuesIncluded: string[];
  hashedValues: boolean;
  /** Replacement counts per rule id across all captured text. */
  scrubbed: Record<string, number>;
}

const failureDecoder = object<FailureFact>({
  signature: string,
  keyLines: array(string),
  outputTail: string,
});

const commandDecoder = object<CommandFact>({
  argv: array(string),
  cwd: string,
  exitCode: nullable(integer),
  signal: nullable(string),
  durationMs: number,
  outcome: oneOf(['pass', 'fail']),
  failure: nullable(failureDecoder),
});

const osDecoder = object<OsFact>({
  platform: string,
  arch: string,
  release: string,
  distro: nullable(string),
  distroVersion: nullable(string),
  libc: nullable(oneOf(['glibc', 'musl'])),
  libcVersion: nullable(string),
});

const packageManagerDecoder = object<PackageManagerFact>({
  name: string,
  ecosystem: oneOf(['node', 'python', 'rust', 'go']),
  version: nullable(string),
  declared: nullable(string),
  lockfile: nullable(string),
  lockfileSha256: nullable(string),
});

const resolvedDecoder = object<ResolvedDeps>({
  node: optional(record(array(string))),
  python: optional(record(string)),
});

const repoDecoder = object<RepoFact>({
  remote: nullable(string),
  commit: nullable(string),
  branch: nullable(string),
  dirty: boolean,
  diff: string,
  diffTruncated: boolean,
  diffRedacted: boolean,
  untracked: array(string),
});

const envDecoder = object<EnvFact>({
  state: oneOf(['set', 'empty', 'absent']),
  value: optional(string),
  hash: optional(string),
});

const capsuleDecoder: Decoder<Capsule> = object<Capsule>({
  twin: integer,
  createdAt: string,
  generator: string,
  command: commandDecoder,
  os: osDecoder,
  runtimes: record(string),
  tools: record(string),
  packageManagers: array(packageManagerDecoder),
  resolved: resolvedDecoder,
  repo: nullable(repoDecoder),
  env: record(envDecoder),
  locale: object<LocaleFact>({ timeZone: nullable(string), locale: nullable(string) }),
  redaction: object<RedactionFact>({
    rulesVersion: integer,
    valuesIncluded: array(string),
    hashedValues: boolean,
    scrubbed: record(integer),
  }),
});

/** Validates parsed JSON as a capsule. Throws DecodeError with the offending path. */
export function decodeCapsule(value: unknown): Capsule {
  const version = (value as { twin?: unknown } | null)?.twin;
  if (typeof version === 'number' && version > CAPSULE_VERSION) {
    throw new DecodeError(
      'capsule.twin',
      `format v${version} is newer than this twin understands (v${CAPSULE_VERSION}); upgrade twin`,
    );
  }
  const capsule = capsuleDecoder(value, 'capsule');
  if (capsule.twin !== CAPSULE_VERSION) {
    throw new DecodeError('capsule.twin', `unsupported format v${capsule.twin}`);
  }
  return capsule;
}
