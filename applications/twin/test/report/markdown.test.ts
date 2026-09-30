import { describe, expect, it } from 'vitest';
import type { ReplayReport } from '../../src/replay/replay.ts';
import type { Verdict } from '../../src/replay/verdict.ts';
import { COMMENT_MARKER, renderVerifyMarkdown, verifyOutcome } from '../../src/report/markdown.ts';
import { makeCapsule } from '../helpers/capsule.ts';

function report(verdict: Verdict, outcomes: ('pass' | 'fail')[]): ReplayReport {
  return {
    verdict,
    runId: 'r1',
    backend: 'solari',
    machineId: 'sbx_1',
    kept: false,
    expected: { outcome: 'fail', signature: 'exit1:abc', keyLines: [] },
    steps: [
      {
        id: 'checkout',
        title: 'check out',
        ok: true,
        optional: false,
        durationMs: 1,
        exitCode: 0,
        outputTail: null,
      },
    ],
    attempts: outcomes.map((outcome) => ({
      exitCode: outcome === 'pass' ? 0 : 1,
      timedOut: false,
      durationMs: 1000,
      outcome,
      signature: outcome === 'pass' ? null : 'exit1:abc',
      keyLines: [],
    })),
    notes: [],
  };
}

describe('verify comments', () => {
  it.each([
    ['not-reproduced', 'fixed'],
    ['reproduced', 'still-failing'],
    ['different-failure', 'different-failure'],
    ['flaky', 'flaky'],
    ['inconclusive', 'inconclusive'],
  ] as const)('names %s as %s', (verdict, outcome) => {
    expect(verifyOutcome(verdict)).toBe(outcome);
  });

  it('leads with a findable marker and the verdict, and summarizes the environment', () => {
    const base = makeCapsule();
    const capsule = makeCapsule({
      command: { ...base.command, argv: ['npm', 'test', '--', 'a|b', '`x`'] },
    });
    const text = renderVerifyMarkdown(report('not-reproduced', ['pass', 'pass']), capsule, {
      source: 'https://example.com/c.json',
      ref: '0123456789abcdef',
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe(`${COMMENT_MARKER} verdict=fixed -->`);
    expect(lines[1]).toBe("### twin: ✅ FIXED in the reporter's environment");
    expect(text).toContain('| Attempts | 2/2 passed |');
    expect(text).toContain('| Checked | `0123456789ab` |');
    expect(text).toContain('| From | [capsule](https://example.com/c.json) |');
    expect(text).toContain("| Command | `` npm test -- 'a\\|b' '`x`' `` |");
    expect(text).toContain('node 22.3.0');
    expect(text).toContain('TZ Asia/Kolkata');
    expect(text).toContain('```text\nVerify on solari');
  });

  it('names local capsules and patches, and fences logs that contain backticks', () => {
    const failing = report('reproduced', ['fail']);
    failing.notes.push('output had ``` in it');
    const text = renderVerifyMarkdown(failing, makeCapsule(), { source: 'bug.json' });
    expect(text).toContain('### twin: ❌ STILL FAILING');
    expect(text).toContain('| Checked | patch |');
    expect(text).toContain('| From | `bug.json` |');
    expect(text).toContain('````text\n');
    expect(
      renderVerifyMarkdown(report('inconclusive', []), makeCapsule(), { source: 'x' }),
    ).toContain('| Attempts | none ran |');
  });
});
