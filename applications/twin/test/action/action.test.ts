import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/fakes.ts';

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '../../scripts/action/run.sh');
const ATTACHMENT = 'https://github.com/user-attachments/files/123/twin-capsule.json';

/** A gh stand-in that answers from files and logs every call. */
const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >>"$FAKE/log"
case "$1 $2" in
  "pr view") cat "$FAKE/issues" ;;
  "issue view") cat "$FAKE/issue-$(basename "$3")" 2>/dev/null ;;
  "api repos/"*) cat "$FAKE/comments" ;;
esac
exit 0
`;

/** A twin stand-in that writes the comment for the verdict in $FAKE/verdict. */
const FAKE_TWIN = `#!/usr/bin/env bash
echo "twin $*" >>"$FAKE/log"
while [ $# -gt 0 ]; do [ "$1" = --comment ] && file=$2; shift; done
verdict=$(cat "$FAKE/verdict")
[ "$verdict" = crash ] && exit 3
printf '<!-- twin-verify verdict=%s -->\\n### twin\\n' "$verdict" >"$file"
[ "$verdict" = fixed ]
`;

describe('GitHub Action script', () => {
  const tempDir = useTempDirs();

  async function action(options: {
    verdict?: string;
    issues?: Record<string, string>;
    comments?: string;
    env?: Record<string, string>;
  }) {
    const dir = await tempDir();
    const files: Record<string, string> = {
      gh: FAKE_GH,
      twin: FAKE_TWIN,
      verdict: options.verdict ?? 'fixed',
      issues: Object.keys(options.issues ?? {})
        .map((n) => `https://github.com/o/r/issues/${n}\n`)
        .join(''),
      comments: options.comments ?? '',
      log: '',
      output: '',
      summary: '',
    };
    for (const [n, body] of Object.entries(options.issues ?? {})) files[`issue-${n}`] = body;
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    await chmod(join(dir, 'gh'), 0o755);
    await chmod(join(dir, 'twin'), 0o755);
    const env = {
      PATH: `${dir}:${process.env.PATH}`,
      FAKE: dir,
      TWIN_BIN: join(dir, 'twin'),
      GITHUB_OUTPUT: join(dir, 'output'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      RUNNER_TEMP: dir,
      REPO: 'o/r',
      PR: '7',
      HEAD_SHA: '0123456789abcdef',
      HEAD_REPO: 'https://github.com/agent/r.git',
      SOLARI_API_KEY: 'slr_test',
      ...options.env,
    };
    let code = 0;
    let stdout = '';
    try {
      ({ stdout } = await run('bash', [SCRIPT], { env }));
    } catch (error) {
      code = (error as { code: number }).code;
      stdout = (error as { stdout: string }).stdout;
    }
    const read = (name: string) => readFile(join(dir, name), 'utf8');
    return { code, stdout, log: await read('log'), output: await read('output'), read };
  }

  it('finds the capsule on a closed issue, verifies the head commit and comments', async () => {
    const result = await action({
      issues: { '5': 'no capsule here', '6': `Repro attached: [twin-capsule.json](${ATTACHMENT})` },
    });
    expect(result.code).toBe(0);
    expect(result.log).toContain(
      `twin verify ${ATTACHMENT} --ref 0123456789abcdef --repo https://github.com/agent/r.git --attempts 3 --comment`,
    );
    expect(result.log).toContain('gh api -X POST repos/o/r/issues/7/comments -F body=@');
    expect(result.output).toBe('verdict=fixed\n');
    expect(await result.read('summary')).toContain('### twin');
  });

  it('updates its earlier comment and fails the check when not fixed', async () => {
    const result = await action({
      verdict: 'still-failing',
      comments: '41\n42\n',
      env: { CAPSULE: 'bug.json', ATTEMPTS: '1' },
    });
    expect(result.code).toBe(1);
    expect(result.log).not.toContain('gh pr view');
    expect(result.log).toContain('twin verify bug.json');
    expect(result.log).toContain('gh api -X PATCH repos/o/r/issues/comments/42');
    expect(result.output).toBe('verdict=still-failing\n');
    expect(result.stdout).toContain("::error::twin: still-failing in the reporter's environment.");
  });

  it('skips pull requests without a capsule and can leave comments off', async () => {
    const skipped = await action({ issues: { '5': 'see https://example.com/log.json' } });
    expect(skipped.code).toBe(0);
    expect(skipped.output).toBe('verdict=skipped\n');
    expect(skipped.log).not.toContain('twin verify');

    const fork = await action({ env: { CAPSULE: 'bug.json', SOLARI_API_KEY: '' } });
    expect(fork.code).toBe(0);
    expect(fork.output).toBe('verdict=skipped\n');
    expect(fork.stdout).toContain('secrets are not passed to pull requests from forks');

    const quiet = await action({ env: { CAPSULE: 'bug.json', COMMENT: 'false' } });
    expect(quiet.code).toBe(0);
    expect(quiet.log).not.toContain('gh api');
  });

  it('fails when twin stops without a verdict or when not run on a pull request', async () => {
    const crashed = await action({ verdict: 'crash', env: { CAPSULE: 'bug.json' } });
    expect(crashed.code).toBe(1);
    expect(crashed.stdout).toContain('stopped before reaching a verdict (exit 3)');
    const push = await action({ env: { PR: '' } });
    expect(push.code).toBe(1);
    expect(push.stdout).toContain('run it on pull_request events');
  });
});
