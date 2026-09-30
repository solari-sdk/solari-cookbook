import { randomUUID } from 'node:crypto';
import { type Backend, type Machine, TWIN_LABELS } from '../backend/types.ts';
import type { Capsule } from '../capsule/schema.ts';
import {
  ENV_SCRIPT,
  envScript,
  RUN_SCRIPT,
  runScript,
  SHELL_SCRIPT,
  shellScript,
} from '../shell/guest.ts';
import {
  canPin,
  computePins,
  LIST_INSTALLED_PATH,
  LIST_INSTALLED_SCRIPT,
  listInstalledArgv,
  type Pin,
  parseInstalled,
  patchedPackageNames,
  pinStep,
} from './pin.ts';
import { type PlanOptions, planReplay, type ReplayPlan, type Step } from './plan.ts';
import { REPO_DIR } from './runtimes.ts';
import { type AttemptResult, classify, describeAttempt, type Verdict } from './verdict.ts';

export interface StepResult {
  id: string;
  title: string;
  ok: boolean;
  optional: boolean;
  durationMs: number;
  exitCode: number | null;
  /** Last lines of output, kept only for failed steps. */
  outputTail: string | null;
}

export interface ReplayReport {
  verdict: Verdict;
  runId: string;
  backend: string;
  machineId: string | null;
  /** Set when the machine was left running for inspection. */
  kept: boolean;
  expected: { outcome: 'pass' | 'fail'; signature: string | null; keyLines: string[] };
  steps: StepResult[];
  attempts: AttemptResult[];
  notes: string[];
  /** Packages replay installed at the capsule's recorded versions, on top of the lockfile install. */
  pinned?: Pin[];
  /** Set by a verify run: the command was first run without the fix, on its own machine. */
  baseline?: { verdict: Verdict; machineId: string | null };
}

export type ReplayEvent =
  | { type: 'baseline-start' }
  | { type: 'machine'; id: string }
  | { type: 'step-start'; step: Step }
  | { type: 'step-end'; result: StepResult }
  | { type: 'attempt-start'; index: number; total: number }
  | { type: 'attempt-end'; index: number; attempt: AttemptResult }
  | { type: 'output'; chunk: string };

export interface ReplayOptions extends PlanOptions {
  /** Runs of the command; more than one separates reproducible failures from flaky ones. */
  attempts?: number;
  /** Leave the machine running when the failure reproduces, with a snapshot at that point. */
  keep?: boolean;
  /** Install the capsule's recorded npm package versions where the lockfile install differs (default true). */
  pin?: boolean;
  onEvent?: (event: ReplayEvent) => void;
}

const IDLE_TIMEOUT_MS = 15 * 60_000;
const FAILED_STEP_TAIL_LINES = 30;

function tailLines(text: string, count: number): string {
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

export async function runStep(
  machine: Machine,
  step: Step,
  env: Record<string, string>,
  emit: (e: ReplayEvent) => void,
): Promise<StepResult> {
  emit({ type: 'step-start', step });
  const base = {
    id: step.id,
    title: step.title,
    optional: step.kind === 'run' && step.optional === true,
  };
  let result: StepResult;
  if (step.kind === 'write') {
    await machine.writeFile(step.path, step.content);
    result = { ...base, ok: true, durationMs: 0, exitCode: null, outputTail: null };
  } else {
    const outcome = await machine.run({
      argv: step.argv,
      env,
      timeoutMs: step.timeoutMs,
      ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
      onOutput: (chunk) => emit({ type: 'output', chunk }),
    });
    const ok = !outcome.timedOut && outcome.exitCode === 0;
    result = {
      ...base,
      ok,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      outputTail: ok ? null : tailLines(outcome.output, FAILED_STEP_TAIL_LINES),
    };
  }
  emit({ type: 'step-end', result });
  return result;
}

/** Writes the reporter's environment and shell and command entry points into a kept machine. */
async function prepareShell(machine: Machine, plan: ReplayPlan, capsule: Capsule): Promise<void> {
  const cwd = plan.command.cwd ?? REPO_DIR;
  await machine.writeFile(ENV_SCRIPT, envScript(plan.env));
  await machine.writeFile(
    SHELL_SCRIPT,
    shellScript({ cwd, argv: capsule.command.argv, commit: capsule.repo?.commit ?? null }),
  );
  await machine.writeFile(RUN_SCRIPT, runScript({ cwd }));
  await machine.run({ argv: ['chmod', '+x', SHELL_SCRIPT, RUN_SCRIPT], timeoutMs: 30_000 });
}

/**
 * Compares the machine's installed packages with the capsule's recorded versions and installs the
 * ones that differ. Returns false only when the pin install itself failed (the report says which).
 */
async function pinDependencies(
  machine: Machine,
  capsule: Capsule,
  plan: ReplayPlan,
  options: ReplayOptions,
  report: ReplayReport,
  emit: (event: ReplayEvent) => void,
): Promise<boolean> {
  const install = plan.setup.find((step) => step.id === 'dependencies');
  const installed = report.steps.find((step) => step.id === 'dependencies');
  const recorded = capsule.resolved.node;
  // A --ref run checks out other code, so the recorded packages do not describe its tree.
  if (options.pin === false || options.ref !== undefined || !canPin(capsule) || !recorded)
    return true;
  if (install?.kind !== 'run' || !installed?.ok) return true;

  const cwd = install.cwd ?? REPO_DIR;
  await machine.writeFile(LIST_INSTALLED_PATH, LIST_INSTALLED_SCRIPT);
  const listing = await machine.run({
    argv: listInstalledArgv(cwd, REPO_DIR),
    env: plan.env,
    cwd,
    timeoutMs: 2 * 60_000,
  });
  const have = listing.exitCode === 0 ? parseInstalled(listing.output) : null;
  if (have === null) {
    report.notes.push(
      'Could not list the installed packages, so their versions were not compared with the capsule.',
    );
    return true;
  }
  const keep = options.patch === undefined ? new Set<string>() : patchedPackageNames(options.patch);
  const { pins, skipped } = computePins(recorded, have, keep);
  if (skipped.length > 0) {
    const shown = skipped.slice(0, 3).map((skip) => `${skip.name} (${skip.reason})`);
    const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : '';
    const count =
      skipped.length === 1
        ? '1 package version from the capsule was'
        : `${skipped.length} package versions from the capsule were`;
    report.notes.push(`${count} not installed: ${shown.join(', ')}${more}.`);
  }
  if (pins.length === 0) return true;

  const result = await runStep(machine, pinStep(pins, cwd), plan.env, emit);
  report.steps.push(result);
  if (!result.ok) return false;
  report.pinned = pins;
  return true;
}

/**
 * Rebuilds the capsule's environment on a fresh machine, runs the command several times and
 * classifies the outcome. The machine is always released unless the caller asked to keep a
 * reproduced failure, and even then it expires on the provider's idle timer.
 */
export async function replay(
  capsule: Capsule,
  backend: Backend,
  options: ReplayOptions = {},
): Promise<ReplayReport> {
  const plan: ReplayPlan = planReplay(capsule, options);
  const emit = options.onEvent ?? (() => {});
  const runId = randomUUID().slice(0, 8);
  const report: ReplayReport = {
    verdict: 'inconclusive',
    runId,
    backend: backend.name,
    machineId: null,
    kept: false,
    expected: {
      outcome: capsule.command.outcome,
      signature: capsule.command.failure?.signature ?? null,
      keyLines: capsule.command.failure?.keyLines ?? [],
    },
    steps: [],
    attempts: [],
    notes: [...plan.notes],
  };

  const machine = await backend.create({
    labels: { ...TWIN_LABELS, run: runId },
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  });
  report.machineId = machine.id;
  emit({ type: 'machine', id: machine.id });

  try {
    for (const step of plan.setup) {
      const result = await runStep(machine, step, plan.env, emit);
      report.steps.push(result);
      if (!result.ok && !result.optional) return report;
      if (!result.ok) report.notes.push(`Optional step failed: ${step.title}.`);
    }
    if (!(await pinDependencies(machine, capsule, plan, options, report, emit))) return report;

    const total = Math.max(1, options.attempts ?? 3);
    for (let index = 0; index < total; index++) {
      emit({ type: 'attempt-start', index, total });
      const outcome = await machine.run({
        argv: plan.command.argv,
        env: plan.env,
        timeoutMs: plan.command.timeoutMs,
        ...(plan.command.cwd === undefined ? {} : { cwd: plan.command.cwd }),
        onOutput: (chunk) => emit({ type: 'output', chunk }),
      });
      const attempt = describeAttempt(outcome);
      report.attempts.push(attempt);
      emit({ type: 'attempt-end', index, attempt });
    }
    report.verdict = classify(capsule, report.attempts);

    if (options.keep && report.verdict === 'reproduced') {
      // The machine itself is what is kept (a snapshot would cost ~30 s and ~4 GB of billed storage,
      // and revert proved unreliable). These files let `twin shell` open it in the same environment.
      await prepareShell(machine, plan, capsule);
      report.kept = true;
    }
    return report;
  } finally {
    if (report.kept) {
      await machine.detach();
    } else {
      await machine.kill().catch((error: unknown) => {
        report.notes.push(`Could not release ${machine.id} (${String(error)}); run \`twin stop\`.`);
      });
    }
  }
}

/**
 * Verifies a candidate fix. The command first runs once WITHOUT the fix on its own machine: replay
 * installs from the repo's lockfile, so a failure that came from freshly resolved dependency
 * versions does not appear, and a passing run with the fix would then prove nothing.
 */
export async function verifyFix(
  capsule: Capsule,
  backend: Backend,
  options: ReplayOptions,
): Promise<ReplayReport> {
  options.onEvent?.({ type: 'baseline-start' });
  const { patch: _patch, ref: _ref, repoUrl: _repoUrl, keep: _keep, ...plain } = options;
  const before = await replay(capsule, backend, { ...plain, attempts: 1 });
  const baseline = { verdict: before.verdict, machineId: before.machineId };
  if (before.verdict !== 'reproduced') return { ...before, verdict: 'inconclusive', baseline };

  const report = await replay(capsule, backend, options);
  report.baseline = baseline;
  return report;
}
