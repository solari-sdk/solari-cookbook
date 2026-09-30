import type { BisectReport, BisectVerdict, TrialRecord } from '../bisect/bisect.ts';
import type { TrialResult } from '../bisect/ddmin.ts';
import { shortId } from './replay.ts';
import type { Style } from './style.ts';

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const VERDICT_TEXT: Record<Exclude<BisectVerdict, 'found'>, string> = {
  'no-candidates':
    'NO CANDIDATES: none of the differences can be varied on a sandbox (see skipped).',
  'setup-failed': 'SETUP FAILED: the good environment could not be built.',
  'reset-failed':
    'RESET FAILED: a trial could not be undone, so the search stopped rather than trust later trials.',
  'baseline-fails':
    'BASELINE FAILS: the good environment fails here on its own, so no difference can be blamed.',
  'not-reproduced':
    'NOT REPRODUCED: applying every captured difference does not fail the captured way. The cause is outside what the capsules record (OS, unset values, local files).',
};

function mark(result: TrialResult, style: Style): string {
  if (result === 'fail') return style.red('FAIL');
  if (result === 'pass') return style.green('pass');
  return style.yellow('????');
}

/**
 * Smallest trials whose every attempt failed consistently, but with a signature other than the
 * captured one. They are not counted as the bug (bisect is conservative), yet they often point at
 * the real cause with a cosmetic difference, so they are shown.
 */
export function failsDifferently(report: BisectReport, limit = 3): TrialRecord[] {
  return report.trials
    .filter((trial) => {
      const signatures = new Set(trial.attempts.map((a) => a.signature));
      return (
        trial.result === 'unresolved' &&
        trial.attempts.length > 0 &&
        trial.attempts.every((a) => a.outcome === 'fail' && !a.timedOut) &&
        signatures.size === 1
      );
    })
    .sort((a, b) => a.atoms.length - b.atoms.length)
    .slice(0, limit);
}

export function renderBisect(report: BisectReport, style: Style): string {
  const lines = [
    style.bold(`Bisect on ${report.backend}`) +
      style.dim(` (machine ${shortId(report.machineId)}, run ${report.runId})`),
  ];

  const failedStep = report.steps.find((step) => !step.ok && !step.optional);
  if (failedStep) {
    lines.push(
      `  ${style.red('✗')} ${failedStep.title} (exit ${failedStep.exitCode ?? 'timeout'})`,
    );
    if (failedStep.outputTail)
      lines.push(style.dim(failedStep.outputTail.replace(/^/gm, '      ')));
  } else if (report.steps.length > 0) {
    const setupMs = report.steps.reduce((total, step) => total + step.durationMs, 0);
    lines.push(
      style.dim(`  good environment built in ${seconds(setupMs)} (${report.steps.length} steps)`),
    );
  }

  if (report.candidates.length > 0) {
    lines.push(
      '',
      style.bold(`Candidates (${report.candidates.length})`),
      ...report.candidates.map((c) => `  ${c}`),
    );
  }
  if (report.trials.length > 0) {
    lines.push('', style.bold(`Trials (${report.trials.length})`));
    report.trials.forEach((trial, index) => {
      const applied =
        trial.atoms.length === 0 ? style.dim('(good environment)') : trial.atoms.join(' + ');
      lines.push(
        `  ${String(index + 1).padStart(2)}  ${mark(trial.result, style)}  ${applied}  ${style.dim(seconds(trial.durationMs))}`,
      );
    });
  }

  lines.push('');
  if (report.verdict === 'found') {
    lines.push(style.green(style.bold('Minimal failing difference:')));
    lines.push(...report.minimal.map((label) => `  ${style.bold(label)}`));
    lines.push(
      style.dim(
        report.minimal.length === 1
          ? 'Applying it to the good environment fails the captured way; without it, it passes.'
          : 'Together they fail the captured way; removing any one of them makes it pass.',
      ),
    );
  } else {
    lines.push(style.yellow(VERDICT_TEXT[report.verdict]));
  }

  const different = failsDifferently(report);
  if (different.length > 0) {
    lines.push(
      '',
      style.bold('Also failing, but not the captured way'),
      style.dim(
        '  (a different failure signature, e.g. another runtime formats the error differently)',
      ),
      ...different.map((trial) => `  ${trial.atoms.join(' + ')}`),
    );
  }

  if (report.skipped.length > 0) {
    lines.push('', style.bold(`Not varied (${report.skipped.length})`));
    lines.push(...report.skipped.map((s) => `  ${s.key}: ${style.dim(s.reason)}`));
  }
  if (report.notes.length > 0) {
    lines.push('', style.bold('Notes'), ...report.notes.map((note) => `  - ${note}`));
  }
  return lines.join('\n');
}
