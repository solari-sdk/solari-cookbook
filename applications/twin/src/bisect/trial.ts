import type { Step } from '../replay/plan.ts';
import { CAPSULE_DIFF_PATH, nodeDir, WORK_DIR } from '../replay/runtimes.ts';
import { execArgv, script } from '../replay/shell.ts';
import type { Atom } from './atoms.ts';

const MINUTE = 60_000;
export const BAD_DIFF_PATH = `${WORK_DIR}/failing.diff`;

export interface TrialBase {
  /** Environment of the good world (from its replay plan). */
  env: Record<string, string>;
  /** The captured command, unwrapped. */
  argv: readonly string[];
  /** Where dependencies were installed in the good world. */
  dependencyDir: string;
  repoDir: string;
  /** Whether the good world applied a working-tree diff (at CAPSULE_DIFF_PATH). */
  goodDiff: boolean;
  /** The good world's dependency install, rerun to undo dependency trials. */
  reinstall: Step | null;
}

/**
 * Steps that return the machine to the good world after a trial. Deliberately not a snapshot
 * revert: measured on Solari, revert takes 14 to 22 s, consumes the snapshot, and sometimes fails
 * with "Snapshot not found" on first use. Every trial change here has an exact, cheap inverse.
 */
export interface TrialPlan {
  /** Disk changes to make before running the command. */
  steps: Step[];
  env: Record<string, string>;
  argv: string[];
  /** Run after the trial, in order, to restore the good world. Empty for env-only trials. */
  undo: Step[];
}

function swapNode(path: string, atom: Extract<Atom, { kind: 'node' }>): string {
  const target = `${nodeDir(atom.version)}/bin`;
  if (atom.goodVersion === null) return `${target}:${path}`;
  return path.replace(`${nodeDir(atom.goodVersion)}/bin`, target);
}

/**
 * Swaps the good diff for the failing one with `git apply`, which is exactly reversible (it also
 * removes files a diff created), so undoing needs no revert.
 */
function diffSteps(
  diff: Extract<Atom, { kind: 'diff' }>,
  base: TrialBase,
): { apply: Step[]; undo: Step[] } {
  const good = `git apply --whitespace=nowarn ${CAPSULE_DIFF_PATH}`;
  const bad = `git apply --whitespace=nowarn ${BAD_DIFF_PATH}`;
  const reverse = (command: string) => command.replace('git apply', 'git apply -R');
  const hasBad = diff.diff.length > 0;
  const apply: Step[] = [];
  if (hasBad) {
    apply.push({
      kind: 'write',
      id: 'trial-diff-file',
      title: 'upload failing working tree diff',
      path: BAD_DIFF_PATH,
      content: diff.diff,
    });
  }
  apply.push({
    kind: 'run',
    id: 'trial-diff',
    title: 'switch to failing working tree diff',
    argv: script([...(base.goodDiff ? [reverse(good)] : []), ...(hasBad ? [bad] : [])]),
    cwd: base.repoDir,
    timeoutMs: MINUTE,
  });
  // Idempotent, so it also repairs a trial whose apply step failed halfway.
  const undo: Step[] = [
    {
      kind: 'run',
      id: 'trial-diff-undo',
      title: 'restore good working tree',
      argv: script([
        ...(hasBad ? [`if ${reverse(bad)} --check 2>/dev/null; then ${reverse(bad)}; fi`] : []),
        ...(base.goodDiff ? [`if ! ${reverse(good)} --check 2>/dev/null; then ${good}; fi`] : []),
      ]),
      cwd: base.repoDir,
      timeoutMs: MINUTE,
    },
  ];
  return { apply, undo };
}

/**
 * Applies a subset of atoms on top of the good world. Env, time zone and runtime changes are pure
 * process settings (both node versions are pre-installed in the base snapshot), so most trials run
 * without touching disk and need no cleanup at all.
 */
export function planTrial(atoms: readonly Atom[], base: TrialBase): TrialPlan {
  const env = { ...base.env };
  const unset: string[] = [];
  const steps: Step[] = [];
  const undo: Step[] = [];

  for (const atom of atoms) {
    if (atom.kind === 'env') {
      if (atom.value === null) {
        delete env[atom.name];
        unset.push(atom.name);
      } else {
        env[atom.name] = atom.value;
      }
    } else if (atom.kind === 'node') {
      env.PATH = swapNode(env.PATH ?? '', atom);
    }
  }

  const diff = atoms.find((atom) => atom.kind === 'diff');
  if (diff) {
    const swap = diffSteps(diff, base);
    steps.push(...swap.apply);
    undo.push(...swap.undo);
  }

  const dependencies = atoms.filter((atom) => atom.kind === 'dependency');
  if (dependencies.length > 0) {
    steps.push({
      kind: 'run',
      id: 'trial-dependencies',
      title: `install ${dependencies.map((d) => d.label).join(', ')}`,
      argv: [
        'npm',
        'install',
        '--no-save',
        '--no-audit',
        '--no-fund',
        ...dependencies.map((d) => `${d.name}@${d.version}`),
      ],
      cwd: base.dependencyDir,
      timeoutMs: 10 * MINUTE,
    });
    // Reinstalling after the diff is undone restores node_modules from the good package.json and
    // lockfile (npm ci wipes node_modules; npm install prunes packages installed with --no-save).
    if (!base.reinstall) throw new Error('dependency trials need the good world install step');
    undo.push(base.reinstall);
  }

  const command = execArgv(base.argv);
  return {
    steps,
    env,
    // Replay can only add variables to the guest's session env; `env -u` removes them per command.
    argv:
      unset.length > 0 ? ['env', ...unset.flatMap((name) => ['-u', name]), ...command] : command,
    undo,
  };
}
