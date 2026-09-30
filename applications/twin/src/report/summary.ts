import { describeEnv } from '../capsule/diff.ts';
import type { Capsule } from '../capsule/schema.ts';
import { type Style, section } from './style.ts';

function entries(map: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
}

function commandSection(capsule: Capsule, style: Style): string {
  const { command } = capsule;
  const status = command.signal ?? `exit ${command.exitCode}`;
  const outcome = command.outcome === 'fail' ? style.red(`FAIL (${status})`) : style.green('PASS');
  const rows: [string, string][] = [
    ['argv', command.argv.join(' ')],
    ['cwd', command.cwd],
    ['result', `${outcome} in ${(command.durationMs / 1000).toFixed(1)}s`],
  ];
  if (command.failure) {
    rows.push(['signature', command.failure.signature]);
    const lines = command.failure.keyLines;
    lines.forEach((line, index) => {
      rows.push([index === 0 ? 'key lines' : '', style.dim(line)]);
    });
  }
  return section(style, 'Command', rows);
}

function systemSection(capsule: Capsule, style: Style): string {
  const { os, locale } = capsule;
  const rows: [string, string][] = [
    [
      'os',
      `${os.platform} ${os.arch} (${[os.distro, os.distroVersion].filter(Boolean).join(' ') || os.release})`,
    ],
  ];
  if (os.libc) rows.push(['libc', `${os.libc} ${os.libcVersion ?? ''}`.trim()]);
  rows.push(
    ['time zone', locale.timeZone ?? '(unknown)'],
    ['locale', locale.locale ?? '(unknown)'],
  );
  return section(style, 'System', rows);
}

function toolchainSection(capsule: Capsule, style: Style): string {
  const managers: [string, string][] = capsule.packageManagers.map((pm) => [
    pm.name,
    [
      pm.version ?? pm.declared ?? 'version unknown',
      pm.lockfile ? style.dim(pm.lockfile) : style.dim('no lockfile'),
    ].join('  '),
  ]);
  const deps: [string, string][] = [];
  if (capsule.resolved.node) {
    deps.push(['node packages', `${Object.keys(capsule.resolved.node).length} installed`]);
  }
  if (capsule.resolved.python) {
    deps.push(['python packages', `${Object.keys(capsule.resolved.python).length} installed`]);
  }
  return section(style, 'Toolchain', [
    ...entries(capsule.runtimes),
    ...managers,
    ...deps,
    [
      'other tools',
      entries(capsule.tools)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || '(none)',
    ],
  ]);
}

function repoSection(capsule: Capsule, style: Style): string {
  const { repo } = capsule;
  if (!repo) return section(style, 'Repository', [['git', 'not a git repository']]);
  const diffLines = repo.diff ? repo.diff.split('\n').length : 0;
  const notes = [repo.diffTruncated && 'truncated', repo.diffRedacted && 'redacted'].filter(
    Boolean,
  );
  return section(style, 'Repository', [
    ['remote', repo.remote ?? '(none)'],
    ['commit', `${repo.commit ?? '(no commits)'}${repo.branch ? ` on ${repo.branch}` : ''}`],
    [
      'diff',
      diffLines ? `${diffLines} lines${notes.length ? ` (${notes.join(', ')})` : ''}` : 'clean',
    ],
    ['untracked', repo.untracked.length ? `${repo.untracked.length} file names` : 'none'],
  ]);
}

function envSection(capsule: Capsule, style: Style): string {
  const facts = Object.entries(capsule.env);
  const withValues = facts.filter(([, fact]) => fact.value !== undefined);
  const set = facts.filter(([, fact]) => fact.state !== 'absent').length;
  const rows: [string, string][] = withValues.map(([name, fact]) => [
    name,
    describeEnv(fact) ?? '',
  ]);
  rows.push(['names only', `${set - withValues.length} other variables (values not included)`]);
  if (capsule.redaction.hashedValues)
    rows.push(['hashed', 'values of other variables as salted HMAC']);
  return section(style, 'Environment', rows);
}

function redactionSection(capsule: Capsule, style: Style): string {
  const scrubbed = entries(
    Object.fromEntries(Object.entries(capsule.redaction.scrubbed).map(([k, v]) => [k, String(v)])),
  );
  const rows: [string, string][] = scrubbed.length
    ? scrubbed.map(([rule, count]) => [rule, `${count} replaced`])
    : [['scrubbed', 'nothing matched']];
  return section(style, `Redaction (rules v${capsule.redaction.rulesVersion})`, rows);
}

/** Everything a reader (or the reporter, before sharing) needs to judge the capsule at a glance. */
export function renderSummary(capsule: Capsule, style: Style): string {
  return [
    commandSection(capsule, style),
    systemSection(capsule, style),
    toolchainSection(capsule, style),
    repoSection(capsule, style),
    envSection(capsule, style),
    redactionSection(capsule, style),
  ].join('\n\n');
}
