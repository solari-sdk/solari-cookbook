import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ancestors, pathExists } from '../../util/fs.ts';

/** Guards against pathological trees; real projects rarely exceed a few thousand packages. */
const MAX_PACKAGES = 50_000;

interface WalkState {
  seen: Set<string>;
  versions: Map<string, Set<string>>;
}

async function readManifest(dir: string): Promise<{ name: string; version: string } | null> {
  try {
    const json = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    return typeof json.name === 'string' && typeof json.version === 'string'
      ? { name: json.name, version: json.version }
      : null;
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function visitPackage(dir: string, state: WalkState): Promise<void> {
  if (state.seen.size >= MAX_PACKAGES) return;
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return; // Dangling symlink.
  }
  // pnpm links the same package from many places; count each real directory once.
  if (state.seen.has(real)) return;
  state.seen.add(real);

  const manifest = await readManifest(real);
  if (manifest) {
    const versions = state.versions.get(manifest.name) ?? new Set<string>();
    versions.add(manifest.version);
    state.versions.set(manifest.name, versions);
  }
  await walkNodeModules(join(real, 'node_modules'), state);
}

async function walkNodeModules(dir: string, state: WalkState): Promise<void> {
  for (const entry of await listDir(dir)) {
    if (entry === '.pnpm') {
      // pnpm's virtual store: .pnpm/<name>@<version>/node_modules/<name>
      for (const store of await listDir(join(dir, entry))) {
        await walkNodeModules(join(dir, entry, store, 'node_modules'), state);
      }
    } else if (entry.startsWith('@')) {
      for (const scoped of await listDir(join(dir, entry))) {
        await visitPackage(join(dir, entry, scoped), state);
      }
    } else if (!entry.startsWith('.')) {
      await visitPackage(join(dir, entry), state);
    }
  }
}

/**
 * Collects installed package versions from every node_modules between cwd and the repo root
 * (workspaces install into both). Reads what is actually installed, not what the lockfile says,
 * because the two drift and the installed tree is what the failing command ran against.
 */
export async function collectNodeDeps(
  cwd: string,
  root: string,
): Promise<Record<string, string[]> | null> {
  const state: WalkState = { seen: new Set(), versions: new Map() };
  let found = false;
  for (const dir of ancestors(cwd, root)) {
    const nodeModules = join(dir, 'node_modules');
    if (!(await pathExists(nodeModules))) continue;
    found = true;
    await walkNodeModules(nodeModules, state);
  }
  if (!found) return null;
  return Object.fromEntries(
    [...state.versions.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
}
