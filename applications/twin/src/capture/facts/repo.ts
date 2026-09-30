import { resolve } from 'node:path';
import type { RepoFact } from '../../capsule/schema.ts';
import type { Redactor } from '../../redact/redactor.ts';
import type { Exec } from '../../util/exec.ts';

/** Keeps capsules small enough to attach to an issue. */
export const MAX_DIFF_BYTES = 200_000;
export const MAX_UNTRACKED = 200;

/** Drops credentials from https remotes (https://user:token@host/...). scp-style remotes pass through. */
export function sanitizeRemote(remote: string): string {
  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return remote;
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // Cut at a line boundary so the remaining hunks are still well-formed.
  const cut = bytes.subarray(0, maxBytes).toString('utf8');
  return { text: cut.slice(0, cut.lastIndexOf('\n') + 1), truncated: true };
}

export interface RepoInfo {
  fact: RepoFact;
  root: string;
}

/** Collects git state for the directory, or null when it is not inside a work tree. */
export async function collectRepo(
  exec: Exec,
  cwd: string,
  redactor: Redactor,
): Promise<RepoInfo | null> {
  const git = async (dir: string, ...args: string[]) => {
    const result = await exec(['git', ...args], { cwd: dir, timeoutMs: 30_000 });
    return result.ok ? result.stdout : null;
  };

  const top = await git(cwd, 'rev-parse', '--show-toplevel');
  if (top === null) return null;
  const root = resolve(top.trim());

  // Run from the root: some git commands (ls-files) scope their output to the current directory.
  const [commit, branch, remote, diff, untracked] = await Promise.all([
    git(root, 'rev-parse', '--verify', '--quiet', 'HEAD'),
    git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD'),
    git(root, 'remote', 'get-url', 'origin'),
    // --no-ext-diff/--no-textconv: the reporter's diff drivers must not change what is captured.
    git(root, 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--binary'),
    git(root, 'ls-files', '--others', '--exclude-standard', '-z'),
  ]);

  const untrackedNames = (untracked ?? '').split('\0').filter(Boolean);
  const scrubbedDiff = redactor.scrub(diff ?? '');
  const { text, truncated } = truncateUtf8(scrubbedDiff, MAX_DIFF_BYTES);

  return {
    root,
    fact: {
      remote: remote ? sanitizeRemote(remote.trim()) : null,
      commit: commit?.trim() || null,
      branch: branch?.trim() || null,
      dirty: text.length > 0 || untrackedNames.length > 0,
      diff: text,
      diffTruncated: truncated,
      diffRedacted: scrubbedDiff !== (diff ?? ''),
      untracked: untrackedNames.slice(0, MAX_UNTRACKED).map((name) => redactor.scrub(name)),
    },
  };
}
