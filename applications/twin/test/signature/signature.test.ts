import { describe, expect, it } from 'vitest';
import { normalizeLine, normalizeOutput } from '../../src/signature/normalize.ts';
import { failureIdentity, selectKeyLines } from '../../src/signature/signature.ts';

describe('normalizeLine', () => {
  it.each([
    ['\u001b[31mFAIL\u001b[39m a.test.ts', 'FAIL a.test.ts'],
    ['started 2026-09-28T10:00:00.123Z', 'started <time>'],
    ['at 12:34:56', 'at <time>'],
    ['Tests took 1.52s (setup 300ms)', 'Tests took <duration> (setup <duration>)'],
    ['FAIL test/a.test.ts (8.1 s)', 'FAIL test/a.test.ts'],
    ['✕ adds (3 ms)', '✕ adds'],
    ['id 123e4567-e89b-12d3-a456-426614174000', 'id <uuid>'],
    ['segfault at 0x7ffd1234', 'segfault at <hex>'],
    ['object 3f2a9c8d1e4b5a6f', 'object <hash>'],
    ['Expected: 528526800000', 'Expected: 528526800000'],
    ['at /home/alice/proj/src/a.test.ts:12:5', 'at <path>/a.test.ts:12:5'],
    ['at ~/proj/src/a.test.ts:12:5', 'at <path>/a.test.ts:12:5'],
    ['at C:\\Users\\bob\\proj\\a.js:1', 'at <path>/a.js:1'],
    ['listening on localhost:54321', 'listening on localhost:<port>'],
    ['worker pid 4242 exited', 'worker pid <n> exited'],
    ['progress 10%\rprogress 100%', 'progress 100%'],
    ['  lots   of   space  ', 'lots of space'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeLine(input)).toBe(expected);
  });

  it('leaves relative paths and line numbers intact', () => {
    expect(normalizeLine('src/utils/date.test.ts:14:7')).toBe('src/utils/date.test.ts:14:7');
  });
});

describe('normalizeOutput', () => {
  it('drops blank lines, runtime-internal locations and version trailers', () => {
    const output = [
      'node:internal/assert/utils:146',
      'Error: boom',
      '    at run (src/a.js:1:1)',
      '    at node:internal/modules/cjs/loader:1368:14',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at runScriptInThisContext (node:internal/vm:219:10)',
      'Node.js v26.7.0',
      '',
    ].join('\n');
    expect(normalizeOutput(output)).toEqual(['Error: boom', 'at run (src/a.js:1:1)']);
  });

  it('drops host configuration warnings so a failure reads the same on every machine', () => {
    const output = [
      ' WARN  Issue while reading "/home/me/.npmrc". Failed to replace env in config: $' +
        '{GITHUB_TOKEN}',
      'bash: warning: setlocale: LC_ALL: cannot change locale (en_IN.UTF-8)',
      'AssertionError: expected 1 to be 2',
    ].join('\n');
    expect(normalizeOutput(output)).toEqual(['AssertionError: expected 1 to be 2']);
  });
});

describe('selectKeyLines', () => {
  it('prefers error-looking lines in order', () => {
    const lines = ['setup', 'TypeError: x is undefined', 'teardown', 'Tests: 1 failed'];
    expect(selectKeyLines(lines)).toEqual(['TypeError: x is undefined', 'Tests: 1 failed']);
  });

  it('falls back to the last lines when nothing looks like an error', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    expect(selectKeyLines(lines)).toEqual(lines.slice(-8));
  });
});

describe('failureIdentity', () => {
  const status = { exitCode: 1, signal: null };

  it('gives the same signature for the same failure on different machines', () => {
    const mine = failureIdentity(
      status,
      'FAIL /home/alice/app/src/date.test.ts > formats (12ms)\nAssertionError: expected "10:30" to be "05:00"',
    );
    const theirs = failureIdentity(
      status,
      'FAIL /workspace/app/src/date.test.ts > formats (48ms)\nAssertionError: expected "10:30" to be "05:00"',
    );
    expect(mine.signature).toBe(theirs.signature);
    expect(mine.signature).toMatch(/^exit1:[0-9a-f]{16}$/);
  });

  it('distinguishes different failures and exit statuses', () => {
    const a = failureIdentity(status, 'Error: cannot find module "x"');
    const b = failureIdentity(status, 'Error: cannot find module "y"');
    const c = failureIdentity({ exitCode: 2, signal: null }, 'Error: cannot find module "x"');
    expect(new Set([a.signature, b.signature, c.signature]).size).toBe(3);
  });

  it('uses the signal name when the process was killed', () => {
    expect(failureIdentity({ exitCode: null, signal: 'SIGSEGV' }, '').signature).toMatch(
      /^SIGSEGV:/,
    );
  });
});
