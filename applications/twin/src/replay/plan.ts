import { posix } from 'node:path';
import type { Capsule } from '../capsule/schema.ts';
import { TwinError } from '../errors.ts';
import {
  CAPSULE_DIFF_PATH,
  FIX_PATCH_PATH,
  installNodeScript,
  installPythonDepsScript,
  installPythonScript,
  nodeDir,
  nodeManagerCommands,
  REPO_DIR,
  SYSTEM_PATH,
  UV_DIR,
  VENV_DIR,
  WORK_DIR,
} from './runtimes.ts';
import { execArgv, script, shellQuote } from './shell.ts';

const MINUTE = 60_000;
const MAX_LISTED_NAMES = 5;

/** Step title of the verify patch, which reports look for to explain a patch that fails. */
export const APPLY_FIX_TITLE = 'apply candidate fix';

export type Step =
  | {
      kind: 'run';
      id: string;
      title: string;
      argv: string[];
      cwd?: string;
      timeoutMs: number;
      /** A failed optional step is reported but does not stop the replay. */
      optional?: boolean;
    }
  | { kind: 'write'; id: string; title: string; path: string; content: string };

export interface ReplayPlan {
  setup: Step[];
  command: Extract<Step, { kind: 'run' }>;
  /** Environment for every step and the command. */
  env: Record<string, string>;
  /** Differences from the reporter's machine that replay cannot recreate. */
  notes: string[];
}

export interface PlanOptions {
  /** Overrides the capsule's git remote (forks, mirrors, private clones). */
  repoUrl?: string;
  /** Overrides the capsule's commit (e.g. to verify a fix branch). */
  ref?: string;
  /** Values for variables the capsule only recorded by name. */
  env?: Record<string, string>;
  commandTimeoutMs?: number;
  /** A unified diff (candidate fix) applied after the checkout and the capsule's own diff. */
  patch?: string;
}

/** Variables that describe the host rather than the program; copying them would break the guest. */
const HOST_SPECIFIC =
  /^(?:PATH|SHELL|HOME|USER|TERM|TERMINFO|TMPDIR|LD_LIBRARY_PATH|MANPATH|INFOPATH|PKG_CONFIG_PATH|.*_(?:HOME|PATH|DIR|ROOT))$/;

/** A tool step run under the env's PATH (through sh), so the twin-installed node and npm win. */
function viaPath(argv: readonly string[]): string[] {
  return script([argv.map(shellQuote).join(' ')]);
}

function repoCheckout(url: string, ref: string): Step {
  // A ref or URL starting with "-" would be read by git as an option.
  for (const [what, value] of [
    ['ref', ref],
    ['repository URL', url],
  ] as const) {
    if (value.startsWith('-')) {
      throw new TwinError(`${what} must not start with "-": ${value}`, { exitCode: 2 });
    }
  }
  return {
    kind: 'run',
    id: 'checkout',
    title: `check out ${ref.slice(0, 12)}`,
    // Fetching one commit by SHA keeps large repos fast; GitHub and GitLab allow it.
    argv: script([
      `rm -rf ${REPO_DIR}`,
      `mkdir -p ${REPO_DIR}`,
      `cd ${REPO_DIR}`,
      'git init -q',
      `git remote add origin ${shellQuote(url)}`,
      `git fetch -q --depth 1 origin ${shellQuote(ref)}`,
      'git checkout -q --detach FETCH_HEAD',
      'git log -1 --format=%H',
    ]),
    timeoutMs: 10 * MINUTE,
  };
}

function envFor(
  capsule: Capsule,
  options: PlanOptions,
  paths: string[],
): { env: Record<string, string>; unknown: string[] } {
  const env: Record<string, string> = {};
  const unknown: string[] = [];
  for (const [name, fact] of Object.entries(capsule.env)) {
    if (fact.value !== undefined) env[name] = fact.value;
    else if (fact.state === 'set' && !HOST_SPECIFIC.test(name)) unknown.push(name);
  }
  // Linux resolves the zone from TZ; the capsule records the zone the reporter's process used.
  if (env.TZ === undefined && capsule.locale.timeZone) env.TZ = capsule.locale.timeZone;
  // Capture pipes the command's output, so tools saw no terminal and printed plain text. A guest
  // command may look colour-capable, and tools like vitest then word the same failure differently.
  if (env.NO_COLOR === undefined && env.FORCE_COLOR === undefined) env.NO_COLOR = '1';
  Object.assign(env, options.env);
  env.PATH = [...paths, SYSTEM_PATH].join(':');
  return { env, unknown: unknown.filter((name) => options.env?.[name] === undefined) };
}

const NODE_COMMANDS = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'corepack']);

/**
 * Node is installed only when the project or the command needs it: a reporter's machine usually
 * has node for unrelated reasons, and installing it for a Python project wastes ~15 s per run.
 */
function usesNode(capsule: Capsule): boolean {
  const program = capsule.command.argv[0]?.split('/').at(-1) ?? '';
  return (
    NODE_COMMANDS.has(program) ||
    capsule.resolved.node !== undefined ||
    capsule.packageManagers.some((m) => m.ecosystem === 'node')
  );
}

/**
 * Turns a capsule into the exact steps that rebuild the reporter's environment on a fresh Linux
 * machine. Pure: no I/O, so every decision here is unit tested.
 */
export function planReplay(capsule: Capsule, options: PlanOptions = {}): ReplayPlan {
  const url = options.repoUrl ?? capsule.repo?.remote;
  const ref = options.ref ?? capsule.repo?.commit;
  if (!url)
    throw new TwinError('the capsule has no git remote; pass --repo <url>', { exitCode: 2 });
  if (!ref)
    throw new TwinError('the capsule has no commit to check out; pass --ref <sha>', {
      exitCode: 2,
    });

  const notes: string[] = [];
  const setup: Step[] = [
    {
      kind: 'run',
      id: 'workspace',
      title: 'prepare workspace',
      argv: ['mkdir', '-p', WORK_DIR],
      timeoutMs: MINUTE,
    },
  ];
  const paths: string[] = [];

  const node = usesNode(capsule) ? capsule.runtimes.node : undefined;
  if (node) {
    setup.push({
      kind: 'run',
      id: 'node',
      title: `install node ${node}`,
      argv: script(installNodeScript(node)),
      timeoutMs: 5 * MINUTE,
    });
    paths.push(`${nodeDir(node)}/bin`);
  }
  const python = capsule.runtimes.python;
  const pythonProject =
    capsule.resolved.python !== undefined ||
    capsule.packageManagers.some((m) => m.ecosystem === 'python');
  if (python && pythonProject) {
    setup.push({
      kind: 'run',
      id: 'python',
      title: `install python ${python}`,
      argv: script(installPythonScript(python)),
      timeoutMs: 10 * MINUTE,
    });
    paths.push(`${VENV_DIR}/bin`, UV_DIR);
  }

  setup.push(repoCheckout(url, ref));

  const diff = options.ref === undefined ? capsule.repo?.diff : undefined;
  if (diff) {
    const diffPath = CAPSULE_DIFF_PATH;
    setup.push(
      {
        kind: 'write',
        id: 'diff-file',
        title: 'upload working-tree diff',
        path: diffPath,
        content: diff,
      },
      {
        kind: 'run',
        id: 'diff',
        title: 'apply working-tree diff',
        argv: ['git', 'apply', '--whitespace=nowarn', diffPath],
        cwd: REPO_DIR,
        timeoutMs: MINUTE,
        optional: true,
      },
    );
    if (capsule.repo?.diffRedacted)
      notes.push('The diff was scrubbed for secrets and may not apply cleanly.');
    if (capsule.repo?.diffTruncated)
      notes.push('The diff was truncated at capture; later hunks are missing.');
  }
  if (options.patch !== undefined) {
    setup.push(
      {
        kind: 'write',
        id: 'patch-file',
        title: 'upload candidate fix',
        path: FIX_PATCH_PATH,
        content: options.patch,
      },
      {
        kind: 'run',
        id: 'patch',
        title: APPLY_FIX_TITLE,
        argv: ['git', 'apply', '--whitespace=nowarn', FIX_PATCH_PATH],
        cwd: REPO_DIR,
        timeoutMs: MINUTE,
      },
    );
  }
  if (capsule.repo?.untracked.length) {
    notes.push(
      `${capsule.repo.untracked.length} untracked files existed on the reporter's machine (names only, not recreated).`,
    );
  }

  const nodeManager = capsule.packageManagers.find((m) => m.ecosystem === 'node');
  const managerCommands = nodeManager ? nodeManagerCommands(nodeManager) : null;
  if (nodeManager && managerCommands) {
    const cwd = posix.join(REPO_DIR, posix.dirname(nodeManager.lockfile ?? 'package.json'));
    if (managerCommands.setup) {
      setup.push({
        kind: 'run',
        id: 'package-manager',
        title:
          `install ${nodeManager.name} ${nodeManager.version ?? nodeManager.declared ?? ''}`.trim(),
        // Through the env's PATH: exec alone looks the program up in the sandbox agent's PATH, so
        // `npm` would be the image's old npm and the manager would land outside the twin node.
        argv: viaPath(managerCommands.setup),
        timeoutMs: 5 * MINUTE,
      });
    }
    setup.push({
      kind: 'run',
      id: 'dependencies',
      title: `install dependencies (${managerCommands.install.join(' ')})`,
      argv: viaPath(managerCommands.install),
      cwd,
      timeoutMs: 20 * MINUTE,
    });
  } else if (nodeManager) {
    notes.push(
      `Package manager ${nodeManager.name} is not supported for replay yet; dependencies were not installed.`,
    );
  }
  if (python && pythonProject) {
    setup.push({
      kind: 'run',
      id: 'python-dependencies',
      title: 'install python dependencies',
      argv: script(installPythonDepsScript()),
      cwd: REPO_DIR,
      timeoutMs: 20 * MINUTE,
    });
  }

  if (capsule.os.platform !== 'linux') {
    notes.push(
      `Captured on ${capsule.os.platform} (${capsule.os.distro ?? capsule.os.release}); replayed on Linux with the same versions.`,
    );
  } else if (capsule.os.libc === 'musl') {
    notes.push('Captured on musl libc; the replay machine uses glibc.');
  }

  const { env, unknown } = envFor(capsule, options, paths);
  if (python && pythonProject) {
    env.VIRTUAL_ENV = VENV_DIR;
    env.UV_PROJECT_ENVIRONMENT = VENV_DIR;
  }
  const overridden = Object.keys(options.env ?? {});
  if (overridden.length > 0) {
    notes.push(
      `Overridden with --env, so this replay differs from the capsule in: ${overridden.join(', ')}.`,
    );
  }
  if (unknown.length > 0) {
    const shown = unknown.slice(0, MAX_LISTED_NAMES).join(', ');
    const more =
      unknown.length > MAX_LISTED_NAMES ? ` and ${unknown.length - MAX_LISTED_NAMES} more` : '';
    const noun = unknown.length === 1 ? 'variable was' : 'variables were';
    notes.push(
      `${unknown.length} ${noun} set on the reporter's machine but only by name, so left unset here (${shown}${more}). Usually harmless; if the command needs one, pass --env NAME=value (or have the reporter capture with --include-env NAME).`,
    );
  }

  return {
    setup,
    command: {
      kind: 'run',
      id: 'command',
      title: capsule.command.argv.join(' '),
      argv: execArgv(capsule.command.argv),
      cwd: posix.join(REPO_DIR, capsule.command.cwd),
      timeoutMs: options.commandTimeoutMs ?? 15 * MINUTE,
    },
    env,
    notes,
  };
}
