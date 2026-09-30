import type { Capsule } from '../capsule/schema.ts';
import type { ReplayReport } from '../replay/replay.ts';
import { shellQuote } from '../replay/shell.ts';
import type { Verdict } from '../replay/verdict.ts';
import { renderReplay } from './replay.ts';
import { createStyle } from './style.ts';

/** Starts every verify comment, so a CI job can find and update its own comment. */
export const COMMENT_MARKER = '<!-- twin-verify';

/** A verify run's verdict, named from the fix's point of view. */
export type VerifyOutcome =
  | 'fixed'
  | 'still-failing'
  | 'different-failure'
  | 'flaky'
  | 'inconclusive';

export function verifyOutcome(verdict: Verdict): VerifyOutcome {
  if (verdict === 'not-reproduced') return 'fixed';
  if (verdict === 'reproduced') return 'still-failing';
  return verdict;
}

const HEADLINE: Record<VerifyOutcome, string> = {
  fixed: "✅ FIXED in the reporter's environment",
  'still-failing': "❌ STILL FAILING in the reporter's environment",
  'different-failure': "❌ DIFFERENT FAILURE in the reporter's environment",
  flaky: '⚠️ FLAKY: attempts disagreed',
  inconclusive: '⚠️ INCONCLUSIVE: setup failed or an attempt timed out',
};

const EXPLANATION: Record<VerifyOutcome, string> = {
  fixed:
    'The failing command passes with this change, in the environment the bug was reported from.',
  'still-failing': 'The command still fails exactly the way the reporter saw.',
  'different-failure': 'The command still fails, but not the way the reporter saw.',
  flaky: 'Some attempts passed and some failed.',
  inconclusive: 'Nothing can be concluded; the log below shows which step failed.',
};

/** A code span that survives backticks in the text. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function environment(capsule: Capsule): string {
  const runtimes = Object.entries(capsule.runtimes).map(([name, version]) => `${name} ${version}`);
  const tz = capsule.env.TZ?.value ?? capsule.locale.timeZone;
  const parts = [...runtimes, `${capsule.os.platform} ${capsule.os.arch}`];
  if (tz) parts.push(`TZ ${tz}`);
  return parts.join(', ');
}

export interface VerifyCommentOptions {
  /** Where the capsule came from (a URL is linked). */
  source: string;
  /** The checked-out ref, when verifying a pushed change. */
  ref?: string;
}

/** A pull request comment for a verify run. */
export function renderVerifyMarkdown(
  report: ReplayReport,
  capsule: Capsule,
  options: VerifyCommentOptions,
): string {
  const outcome = verifyOutcome(report.verdict);
  const noBaseline =
    outcome === 'inconclusive' &&
    report.baseline !== undefined &&
    report.attempts.length > 0 &&
    !report.attempts.some((attempt) => attempt.timedOut);
  const passed = report.attempts.filter((attempt) => attempt.outcome === 'pass').length;
  const capsuleLink = /^https:\/\//.test(options.source)
    ? `[capsule](${options.source})`
    : code(options.source);
  const rows = [
    ['Command', code(capsule.command.argv.map(shellQuote).join(' '))],
    ["Reporter's environment", environment(capsule)],
    ['Checked', options.ref ? code(options.ref.slice(0, 12)) : 'patch'],
    [
      'Attempts',
      report.attempts.length ? `${passed}/${report.attempts.length} passed` : 'none ran',
    ],
    ['From', capsuleLink],
  ];
  return [
    `${COMMENT_MARKER} verdict=${outcome} -->`,
    `### twin: ${noBaseline ? '⚠️ INCONCLUSIVE: the failure did not reproduce without the fix' : HEADLINE[outcome]}`,
    '',
    noBaseline
      ? 'The command was first run without the change and did not fail the way the reporter saw, so the change cannot be verified. Replay installs from the lockfile; a failure that needs freshly resolved dependency versions shows up in twin bisect.'
      : EXPLANATION[outcome],
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([key, value]) => `| ${key} | ${value?.replaceAll('|', '\\|')} |`),
    '',
    '<details><summary>Replay log</summary>',
    '',
    fenced(renderReplay(report, createStyle(false), { verify: true })),
    '',
    '</details>',
    '',
    "<sub>Checked by [twin](https://github.com/crypticsaiyan/twin) on a disposable Solari sandbox; the pull request's code never ran on the CI runner.</sub>",
    '',
  ].join('\n');
}
