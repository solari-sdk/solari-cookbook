import type { Exec } from '../../util/exec.ts';

const VERSION = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/g;

export function firstVersion(output: string): string | null {
  return output.match(VERSION)?.[0] ?? null;
}

/** For banners like "gcc (Ubuntu 13.2.0-23ubuntu4) 13.2.0" where the real version comes last. */
export function lastVersionOnFirstLine(output: string): string | null {
  const firstLine = output.trim().split('\n')[0] ?? '';
  return firstLine.match(VERSION)?.at(-1) ?? null;
}

export interface VersionProbe {
  name: string;
  kind: 'runtime' | 'tool';
  /** Alternatives tried in order until one succeeds (e.g. python3, then python). */
  commands: readonly (readonly string[])[];
  parse?: (output: string) => string | null;
}

export const PROBES: readonly VersionProbe[] = [
  { name: 'node', kind: 'runtime', commands: [['node', '--version']] },
  { name: 'bun', kind: 'runtime', commands: [['bun', '--version']] },
  { name: 'deno', kind: 'runtime', commands: [['deno', '--version']] },
  {
    name: 'python',
    kind: 'runtime',
    commands: [
      ['python3', '--version'],
      ['python', '--version'],
    ],
  },
  {
    name: 'go',
    kind: 'runtime',
    commands: [['go', 'version']],
    parse: (out) => out.match(/\bgo(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null,
  },
  { name: 'rustc', kind: 'runtime', commands: [['rustc', '--version']] },
  {
    name: 'java',
    kind: 'runtime',
    commands: [['java', '-version']],
    parse: (out) => out.match(/version "([^"]+)"/)?.[1] ?? firstVersion(out),
  },
  { name: 'ruby', kind: 'runtime', commands: [['ruby', '--version']] },
  { name: 'npm', kind: 'tool', commands: [['npm', '--version']] },
  { name: 'pnpm', kind: 'tool', commands: [['pnpm', '--version']] },
  { name: 'yarn', kind: 'tool', commands: [['yarn', '--version']] },
  {
    name: 'pip',
    kind: 'tool',
    commands: [
      ['python3', '-m', 'pip', '--version'],
      ['python', '-m', 'pip', '--version'],
    ],
  },
  { name: 'uv', kind: 'tool', commands: [['uv', '--version']] },
  { name: 'poetry', kind: 'tool', commands: [['poetry', '--version']] },
  { name: 'cargo', kind: 'tool', commands: [['cargo', '--version']] },
  { name: 'git', kind: 'tool', commands: [['git', '--version']] },
  { name: 'make', kind: 'tool', commands: [['make', '--version']] },
  { name: 'gcc', kind: 'tool', commands: [['gcc', '--version']], parse: lastVersionOnFirstLine },
  { name: 'clang', kind: 'tool', commands: [['clang', '--version']] },
  { name: 'cmake', kind: 'tool', commands: [['cmake', '--version']] },
  { name: 'docker', kind: 'tool', commands: [['docker', '--version']] },
];

export interface ProbeResults {
  runtimes: Record<string, string>;
  tools: Record<string, string>;
}

const PROBE_TIMEOUT_MS = 10_000;

// Corepack shims for pnpm/yarn may otherwise prompt or download a package manager just to print
// its version. Capture must stay offline and non-interactive.
const PROBE_ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_NETWORK: '0' };

async function runProbe(
  exec: Exec,
  probe: VersionProbe,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string | null> {
  for (const argv of probe.commands) {
    const result = await exec(argv, {
      cwd: options.cwd,
      env: { ...options.env, ...PROBE_ENV },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (!result.ok) continue;
    // Some tools (java) print their version on stderr.
    const version = (probe.parse ?? firstVersion)(`${result.stdout}\n${result.stderr}`);
    if (version) return version;
  }
  return null;
}

/** Runs all probes concurrently. Missing tools are simply absent from the result. */
export async function runProbes(
  exec: Exec,
  options: { cwd: string; env: NodeJS.ProcessEnv },
  probes: readonly VersionProbe[] = PROBES,
): Promise<ProbeResults> {
  const versions = await Promise.all(probes.map((probe) => runProbe(exec, probe, options)));
  const results: ProbeResults = { runtimes: {}, tools: {} };
  probes.forEach((probe, index) => {
    const version = versions[index];
    if (version) results[probe.kind === 'runtime' ? 'runtimes' : 'tools'][probe.name] = version;
  });
  return results;
}
