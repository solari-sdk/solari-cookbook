import { sha256Hex } from '../util/hash.ts';
import type { Capsule, EnvFact, PackageManagerFact } from './schema.ts';

export type DiffCategory =
  | 'os'
  | 'runtime'
  | 'tool'
  | 'packageManager'
  | 'nodeDependency'
  | 'pythonDependency'
  | 'env'
  | 'locale'
  | 'repo';

/** One environment fact that differs between two capsules. These become bisect candidates. */
export interface Difference {
  category: DiffCategory;
  key: string;
  a: string | null;
  b: string | null;
}

type Flat = Record<string, string | null>;

function compareMaps(category: DiffCategory, a: Flat, b: Flat): Difference[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diffs: Difference[] = [];
  for (const key of keys) {
    const left = a[key] ?? null;
    const right = b[key] ?? null;
    if (left !== right) diffs.push({ category, key, a: left, b: right });
  }
  return diffs;
}

/** Human-readable form of an env fact. Values are only as specific as both sides allow. */
export function describeEnv(fact: EnvFact | undefined): string | null {
  if (!fact || fact.state === 'absent') return null;
  if (fact.state === 'empty') return '(empty)';
  if (fact.value !== undefined) return fact.value;
  if (fact.hash !== undefined) return `(hash ${fact.hash.slice(0, 8)})`;
  return '(set)';
}

/**
 * Compares two env facts at the most precise level both sides support: plain values if both have
 * them, salted hashes if both have them, otherwise only whether the variable is set.
 */
export function envDiffers(a: EnvFact | undefined, b: EnvFact | undefined): boolean {
  const stateA = a?.state ?? 'absent';
  const stateB = b?.state ?? 'absent';
  if (stateA !== stateB) return true;
  if (a?.value !== undefined && b?.value !== undefined) return a.value !== b.value;
  if (a?.hash !== undefined && b?.hash !== undefined) return a.hash !== b.hash;
  return false;
}

function diffEnv(a: Capsule['env'], b: Capsule['env']): Difference[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys
    .filter((key) => envDiffers(a[key], b[key]))
    .map((key) => ({ category: 'env', key, a: describeEnv(a[key]), b: describeEnv(b[key]) }));
}

function flattenManagers(managers: PackageManagerFact[]): Flat {
  const flat: Flat = {};
  for (const manager of managers) {
    flat[manager.name] = manager.version ?? manager.declared ?? '(unknown version)';
    flat[`${manager.name} lockfile`] = manager.lockfileSha256?.slice(0, 12) ?? null;
  }
  return flat;
}

function flattenNodeDeps(deps: Record<string, string[]> | undefined): Flat {
  return Object.fromEntries(Object.entries(deps ?? {}).map(([name, v]) => [name, v.join(', ')]));
}

function flattenRepo(repo: Capsule['repo']): Flat {
  if (!repo) return {};
  return {
    remote: repo.remote,
    commit: repo.commit,
    'working tree diff': repo.diff ? `sha256 ${sha256Hex(repo.diff).slice(0, 12)}` : null,
  };
}

/** Lists every differing fact between capsule `a` and capsule `b`, grouped by category. */
export function diffCapsules(a: Capsule, b: Capsule): Difference[] {
  const osFlat = (c: Capsule): Flat => ({
    platform: c.os.platform,
    arch: c.os.arch,
    distro: c.os.distro && `${c.os.distro} ${c.os.distroVersion ?? ''}`.trim(),
    libc: c.os.libc && `${c.os.libc} ${c.os.libcVersion ?? ''}`.trim(),
  });
  return [
    ...compareMaps('os', osFlat(a), osFlat(b)),
    ...compareMaps('runtime', a.runtimes, b.runtimes),
    ...compareMaps(
      'packageManager',
      flattenManagers(a.packageManagers),
      flattenManagers(b.packageManagers),
    ),
    ...compareMaps(
      'nodeDependency',
      flattenNodeDeps(a.resolved.node),
      flattenNodeDeps(b.resolved.node),
    ),
    ...compareMaps('pythonDependency', a.resolved.python ?? {}, b.resolved.python ?? {}),
    ...diffEnv(a.env, b.env),
    ...compareMaps('locale', { ...a.locale }, { ...b.locale }),
    ...compareMaps('repo', flattenRepo(a.repo), flattenRepo(b.repo)),
    ...compareMaps('tool', a.tools, b.tools),
  ];
}
