import { APPLY_FIX_TITLE } from '../replay/plan.ts';
import type { ReplayReport } from '../replay/replay.ts';
import type { Verdict } from '../replay/verdict.ts';
import type { Style } from './style.ts';

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Solari sandbox ids run to ~200 characters; the header only needs to be recognizable. */
export function shortId(id: string | null): string {
  if (id === null) return '-';
  return id.length > 20 ? `${id.slice(0, 16)}…` : id;
}

const VERDICT_TEXT: Record<Verdict, string> = {
  reproduced: 'REPRODUCED: every attempt failed exactly as the capsule recorded.',
  'different-failure': 'DIFFERENT FAILURE: it fails here, but not the way the capsule recorded.',
  'not-reproduced':
    "NOT REPRODUCED: the command passes on this Linux machine. Replay installs from the repo's lockfile, so a failure that needs freshly resolved dependency versions, the OS, unset env values or local files does not show; `twin bisect` applies the capsule's recorded package versions.",
  flaky: 'FLAKY: attempts disagreed with each other.',
  inconclusive: 'INCONCLUSIVE: setup failed or an attempt timed out.',
};

/** The same outcomes read from the other side: a verify run hopes the failure is gone. */
const VERIFY_TEXT: Record<Verdict, string> = {
  reproduced: 'STILL FAILING: the fix does not change the captured failure.',
  'different-failure': 'DIFFERENT FAILURE: with the fix it still fails, but differently.',
  'not-reproduced': "FIXED: the command passes in the reporter's environment with the fix applied.",
  flaky: 'FLAKY: attempts disagreed with each other.',
  inconclusive: 'INCONCLUSIVE: setup failed (does the fix apply?) or an attempt timed out.',
};

const LOCKFILE_ERROR =
  /package-lock\.json|npm-shrinkwrap|yarn\.lock|pnpm-lock|frozen-lockfile|lockfile/i;

/** Names what went wrong, so a patch that does not apply is not mistaken for a timeout. */
function inconclusiveText(
  report: ReplayReport,
  verify: boolean,
  agent: boolean,
): string | undefined {
  const failed = report.steps.find((step) => !step.ok && !step.optional);
  if (failed) {
    if (verify && failed.title === APPLY_FIX_TITLE) {
      return "INCONCLUSIVE: the fix did not apply to the capsule's tree (git apply error above).";
    }
    const text = `INCONCLUSIVE: "${failed.title}" failed, so the command never ran (output above).`;
    // A lockfile that exists only on the reporter's machine (untracked or ignored) cannot be replayed.
    if (failed.id === 'dependencies' && LOCKFILE_ERROR.test(failed.outputTail ?? '')) {
      return `${text} The repository has no committed lockfile, and replay installs from the committed one.`;
    }
    return text;
  }
  const timedOut = report.attempts.findIndex((attempt) => attempt.timedOut);
  // Agents replay over MCP, which has no timeout option to raise.
  const hint = agent ? '' : ' (raise --timeout)';
  if (timedOut >= 0) return `INCONCLUSIVE: attempt ${timedOut + 1} timed out${hint}.`;
  if (verify && report.baseline) {
    const seen =
      report.baseline.verdict === 'not-reproduced' ? 'it passed' : 'it failed differently';
    return `INCONCLUSIVE: the failure did not reproduce without the fix (${seen}), so the fix cannot be verified. Replay installs from the lockfile; for a failure that needs freshly resolved dependency versions, use twin bisect.`;
  }
  return undefined;
}

function verdictLine(report: ReplayReport, style: Style, verify: boolean, agent: boolean): string {
  const { verdict } = report;
  const specific = verdict === 'inconclusive' ? inconclusiveText(report, verify, agent) : undefined;
  if (specific) return style.red(specific);
  if (verify) {
    const text = VERIFY_TEXT[verdict];
    if (verdict === 'not-reproduced') return style.green(text);
    return verdict === 'flaky' ? style.yellow(text) : style.red(text);
  }
  const text = VERDICT_TEXT[verdict];
  if (verdict === 'reproduced') return style.green(text);
  if (verdict === 'not-reproduced' || verdict === 'flaky') return style.yellow(text);
  return style.red(text);
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function renderReplay(
  report: ReplayReport,
  style: Style,
  options: {
    verify?: boolean;
    /** Kept-machine hints name the MCP tools instead of the CLI. */
    agent?: boolean;
  } = {},
): string {
  const lines = [
    style.bold(`${options.verify ? 'Verify' : 'Replay'} on ${report.backend}`) +
      style.dim(` (machine ${shortId(report.machineId)}, run ${report.runId})`),
  ];

  for (const step of report.steps) {
    const mark = step.ok ? style.green('✓') : step.optional ? style.yellow('!') : style.red('✗');
    const status = step.ok ? '' : ` (exit ${step.exitCode ?? 'timeout'})`;
    lines.push(`  ${mark} ${step.title}${status}  ${style.dim(seconds(step.durationMs))}`);
    if (step.outputTail) lines.push(style.dim(indent(step.outputTail, '      ')));
  }

  if (report.attempts.length > 0) {
    lines.push('', style.bold('Attempts'));
    report.attempts.forEach((attempt, index) => {
      const result =
        attempt.outcome === 'pass'
          ? style.green('PASS')
          : style.red(attempt.timedOut ? 'TIMEOUT' : `FAIL exit ${attempt.exitCode}`);
      const parts = [
        String(index + 1),
        result,
        attempt.signature,
        style.dim(seconds(attempt.durationMs)),
      ];
      lines.push(`  ${parts.filter(Boolean).join('  ')}`);
    });
    const expected =
      report.expected.outcome === 'pass' ? 'PASS' : `FAIL ${report.expected.signature}`;
    lines.push(`  ${style.dim('expected')}  ${expected}`);
    const first = report.attempts.find(
      (attempt) => attempt.signature !== report.expected.signature,
    );
    if (first?.keyLines.length) {
      lines.push(
        '',
        style.bold('Key lines here'),
        style.dim(indent(first.keyLines.join('\n'), '  ')),
      );
      if (report.expected.keyLines.length) {
        lines.push(
          style.bold('Key lines in capsule'),
          style.dim(indent(report.expected.keyLines.join('\n'), '  ')),
        );
      }
    }
  }

  lines.push('', verdictLine(report, style, options.verify === true, options.agent === true));

  if (report.kept && options.agent) {
    lines.push(
      '',
      style.bold("The machine is still running at the failure, in the reporter's environment:"),
      `  machine ${report.machineId}`,
      'Explore and try fixes with run and write_file on this machine, check the final diff with',
      'verify, then release it. It is billed while running and released after 15 minutes idle.',
    );
  } else if (report.kept) {
    const id = report.machineId?.slice(0, 12) ?? '';
    lines.push(
      '',
      style.bold("The machine is still running at the failure, in the reporter's environment:"),
      `  twin shell ${id}         open a terminal on it`,
      `  twin shell ${id} --web   get a browser terminal link to share`,
      style.dim(
        'It is billed while running and released after 15 minutes idle, or now with: twin stop',
      ),
    );
  }
  if (report.notes.length > 0) {
    lines.push('', style.bold('Notes'), ...report.notes.map((note) => `  - ${note}`));
  }
  return lines.join('\n');
}
