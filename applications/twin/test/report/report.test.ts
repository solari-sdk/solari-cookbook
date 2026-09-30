import { describe, expect, it } from 'vitest';
import type { Difference } from '../../src/capsule/diff.ts';
import { renderDifferences } from '../../src/report/differences.ts';
import { createStyle, formatBytes, section, shouldColor } from '../../src/report/style.ts';
import { renderSummary } from '../../src/report/summary.ts';
import { makeCapsule } from '../helpers/capsule.ts';

const plain = createStyle(false);

describe('style', () => {
  it('colors only when enabled', () => {
    expect(plain.red('x')).toBe('x');
    expect(createStyle(true).red('x')).toBe('\u001b[31mx\u001b[39m');
  });

  it('respects NO_COLOR and dumb terminals', () => {
    expect(shouldColor(true, {})).toBe(true);
    expect(shouldColor(false, {})).toBe(false);
    expect(shouldColor(true, { NO_COLOR: '1' })).toBe(false);
    expect(shouldColor(true, { TERM: 'dumb' })).toBe(false);
  });

  it('aligns section rows', () => {
    expect(
      section(plain, 'T', [
        ['a', '1'],
        ['long', '2'],
      ]),
    ).toBe('T\n  a     1\n  long  2');
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('renderSummary', () => {
  it('shows the facts a reviewer needs', () => {
    const text = renderSummary(makeCapsule(), plain);
    for (const expected of [
      'argv       npm test',
      'result     FAIL (exit 1) in 1.2s',
      'signature  exit1:0123456789abcdef',
      'key lines  AssertionError: expected 1 to be 2',
      'os         linux x64 (ubuntu 24.04)',
      'libc       glibc 2.39',
      'time zone  Asia/Kolkata',
      'node           22.3.0',
      'npm            10.8.1  package-lock.json',
      'node packages  1 installed',
      'commit     abc123 on main',
      'diff       clean',
      'NODE_ENV    test',
      'names only  1 other variables (values not included)',
      'scrubbed  nothing matched',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('covers passing runs, missing repos, hashes and redaction counts', () => {
    const base = makeCapsule();
    const text = renderSummary(
      makeCapsule({
        command: { ...base.command, exitCode: 0, outcome: 'pass', failure: null },
        repo: null,
        resolved: { python: { numpy: '2.0.0' } },
        redaction: { ...base.redaction, hashedValues: true, scrubbed: { 'github-token': 2 } },
        os: { ...base.os, distro: null, distroVersion: null, libc: null, libcVersion: null },
        locale: { timeZone: null, locale: null },
        tools: {},
      }),
      plain,
    );
    expect(text).toContain('PASS in 1.2s');
    expect(text).not.toContain('signature');
    expect(text).toContain('git  not a git repository');
    expect(text).toContain('python packages  1 installed');
    expect(text).toContain('hashed');
    expect(text).toContain('github-token  2 replaced');
    expect(text).toContain('linux x64 (6.8.0)');
    expect(text).toContain('time zone  (unknown)');
    expect(text).toContain('other tools      (none)');
  });

  it('flags truncated and redacted diffs', () => {
    const base = makeCapsule();
    const repo = {
      ...(base.repo as NonNullable<typeof base.repo>),
      diff: 'a\nb',
      diffTruncated: true,
      diffRedacted: true,
      untracked: ['x'],
    };
    const text = renderSummary(makeCapsule({ repo }), plain);
    expect(text).toContain('diff       2 lines (truncated, redacted)');
    expect(text).toContain('untracked  1 file names');
  });
});

describe('renderDifferences', () => {
  it('says so when nothing differs', () => {
    expect(renderDifferences([], { a: 'a', b: 'b' }, plain)).toBe(
      'No differences in the captured environment.',
    );
  });

  it('groups by category and marks absent values', () => {
    const diffs: Difference[] = [
      { category: 'runtime', key: 'node', a: '20.17.0', b: '22.3.0' },
      { category: 'env', key: 'CI', a: null, b: 'true' },
    ];
    expect(renderDifferences(diffs, { a: 'good', b: 'bad' }, plain)).toBe(
      [
        '2 differences: - good  + bad',
        '',
        'Runtimes (1)',
        '  node  - 20.17.0  + 22.3.0',
        '',
        'Environment variables (1)',
        '  CI  - (absent)  + true',
      ].join('\n'),
    );
  });

  it('truncates long categories', () => {
    const diffs: Difference[] = Array.from({ length: 30 }, (_, i) => ({
      category: 'nodeDependency',
      key: `pkg-${i}`,
      a: '1.0.0',
      b: '2.0.0',
    }));
    const text = renderDifferences(diffs, { a: 'a', b: 'b' }, plain);
    expect(text).toContain('Node packages (30)');
    expect(text).toContain('... 5 more (use --json)');
    expect(text).not.toContain('pkg-29');
  });
});
