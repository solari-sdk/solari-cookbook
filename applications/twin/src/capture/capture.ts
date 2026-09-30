import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CAPSULE_VERSION, type Capsule, type ResolvedDeps } from '../capsule/schema.ts';
import type { Host } from '../host.ts';
import type { Output } from '../io.ts';
import { Redactor } from '../redact/redactor.ts';
import { RULES_VERSION } from '../redact/rules.ts';
import { failureIdentity } from '../signature/signature.ts';
import { toPosixRelative } from '../util/fs.ts';
import { collectEnv } from './facts/env.ts';
import { collectNodeDeps } from './facts/node-deps.ts';
import { collectOs } from './facts/os.ts';
import { detectPackageManagers } from './facts/package-managers.ts';
import { runProbes } from './facts/probes.ts';
import { findProjectRoot } from './facts/project-root.ts';
import { collectPythonEnv } from './facts/python-deps.ts';
import { collectRepo } from './facts/repo.ts';
import { type RunResult, runCommand } from './run-command.ts';

export interface CaptureRequest {
  argv: string[];
  cwd: string;
  includeEnv: string[];
  salt: string | null;
  generator: string;
}

export interface CaptureHooks {
  /** Receives the command's live output. */
  stdout: Output;
  stderr: Output;
  onProgress?: (message: string) => void;
  /** Overridable for tests; defaults to spawning the command on the host. */
  run?: typeof runCommand;
}

export interface CaptureResult {
  capsule: Capsule;
  run: RunResult;
}

/**
 * Records the environment first (so facts describe what the command ran against), then runs the
 * command and fingerprints its failure. Every string that may carry user data goes through one
 * Redactor so the capsule's redaction summary is complete.
 */
export async function capture(
  request: CaptureRequest,
  host: Host,
  hooks: CaptureHooks,
): Promise<CaptureResult> {
  // git reports its root with symlinks resolved (macOS /var is /private/var), so the working
  // directory must be resolved too or its path relative to the root comes out as ../../..
  const cwd = await realpath(resolve(request.cwd)).catch(() => resolve(request.cwd));
  const redactor = new Redactor({ homeDir: host.homeDir });
  hooks.onProgress?.('collecting environment');

  const repo = await collectRepo(host.exec, cwd, redactor);
  const root = repo?.root ?? (await findProjectRoot(cwd));
  const [os, probes, nodeDeps, pythonEnv] = await Promise.all([
    collectOs(host),
    runProbes(host.exec, { cwd, env: host.env }),
    collectNodeDeps(cwd, root),
    collectPythonEnv(host.exec, { cwd, root, env: host.env, platform: host.platform }),
  ]);
  const packageManagers = await detectPackageManagers({
    cwd,
    root,
    versions: { ...probes.runtimes, ...probes.tools },
  });
  const env = collectEnv(host.env, { include: request.includeEnv, salt: request.salt }, redactor);
  const resolved: ResolvedDeps = {};
  if (nodeDeps) resolved.node = nodeDeps;
  if (pythonEnv?.packages) resolved.python = pythonEnv.packages;
  // The project's own interpreter (its venv) is what runs the code, not whatever python3 is on PATH.
  if (pythonEnv?.version) probes.runtimes.python = pythonEnv.version;

  hooks.onProgress?.(`running: ${request.argv.join(' ')}`);
  const run = await (hooks.run ?? runCommand)(request.argv, {
    cwd,
    env: host.env,
    stdout: hooks.stdout,
    stderr: hooks.stderr,
    now: () => host.now().getTime(),
  });

  const failed = run.exitCode !== 0;
  const outputTail = redactor.scrub(run.outputTail);
  const capsule: Capsule = {
    twin: CAPSULE_VERSION,
    createdAt: host.now().toISOString(),
    generator: request.generator,
    command: {
      argv: request.argv.map((arg) => redactor.scrub(arg)),
      cwd: toPosixRelative(root, cwd),
      exitCode: run.exitCode,
      signal: run.signal,
      durationMs: run.durationMs,
      outcome: failed ? 'fail' : 'pass',
      failure: failed ? { ...failureIdentity(run, outputTail), outputTail } : null,
    },
    os,
    runtimes: probes.runtimes,
    tools: probes.tools,
    packageManagers,
    resolved,
    repo: repo?.fact ?? null,
    env: env.env,
    locale: host.intlDefaults(),
    redaction: {
      rulesVersion: RULES_VERSION,
      valuesIncluded: env.valuesIncluded,
      hashedValues: request.salt !== null,
      scrubbed: redactor.counts(),
    },
  };
  return { capsule, run };
}
