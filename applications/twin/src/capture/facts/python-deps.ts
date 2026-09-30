import { join } from 'node:path';
import type { Exec } from '../../util/exec.ts';
import { findUp, pathExists } from '../../util/fs.ts';

const PROJECT_MARKERS = [
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'uv.lock',
  'poetry.lock',
  'Pipfile',
];

/** PEP 503 name normalization, so "Foo_Bar" and "foo-bar" compare equal. */
export function normalizeDistName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export function parsePipList(json: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: [string, string][] = [];
  for (const item of parsed as { name?: unknown; version?: unknown }[]) {
    if (typeof item?.name === 'string' && typeof item.version === 'string') {
      entries.push([normalizeDistName(item.name), item.version]);
    }
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

async function isPythonProject(cwd: string, root: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    if (await findUp(marker, cwd, root)) return true;
  }
  return false;
}

/** The interpreter the project would use: a local .venv, the active venv, then python3. */
async function pickInterpreter(
  cwd: string,
  root: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  const binary = platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python');
  const venv = await findUp('.venv', cwd, root);
  if (venv && (await pathExists(join(venv, binary)))) return join(venv, binary);
  if (env.VIRTUAL_ENV) return join(env.VIRTUAL_ENV, binary);
  return 'python3';
}

export interface PythonDepsOptions {
  cwd: string;
  root: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export interface PythonEnv {
  /** Version of the interpreter the project runs with (its venv), which can differ from python3. */
  version: string | null;
  packages: Record<string, string> | null;
}

/**
 * Describes the project's Python environment: the interpreter version and installed
 * distributions. Null when the directory is not a Python project.
 */
export async function collectPythonEnv(
  exec: Exec,
  options: PythonDepsOptions,
): Promise<PythonEnv | null> {
  const { cwd, root, env, platform } = options;
  if (!(await isPythonProject(cwd, root))) return null;
  const python = await pickInterpreter(cwd, root, env, platform);

  const probe = await exec([python, '--version'], { cwd, env, timeoutMs: 10_000 });
  const version = probe.ok
    ? (`${probe.stdout} ${probe.stderr}`.match(/\d+\.\d+\.\d+/)?.[0] ?? null)
    : null;

  const attempts = [
    [python, '-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'],
    // uv-created venvs ship without pip.
    ['uv', 'pip', 'list', '--format', 'json', '--python', python],
  ];
  for (const argv of attempts) {
    const result = await exec(argv, { cwd, env, timeoutMs: 30_000 });
    const parsed = result.ok ? parsePipList(result.stdout) : null;
    if (parsed) return { version, packages: parsed };
  }
  return { version, packages: null };
}
