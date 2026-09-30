import { access, readFile } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories from `from` up to `stopAt` (both inclusive). When `stopAt` is not an ancestor of
 * `from`, the walk ends at the filesystem root.
 */
export function ancestors(from: string, stopAt?: string): string[] {
  const stop = stopAt === undefined ? parse(resolve(from)).root : resolve(stopAt);
  const dirs: string[] = [];
  let dir = resolve(from);
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (dir === stop || parent === dir) return dirs;
    dir = parent;
  }
}

/** Returns the absolute path of the nearest `name` at or above `from`, or null. */
export async function findUp(name: string, from: string, stopAt?: string): Promise<string | null> {
  for (const dir of ancestors(from, stopAt)) {
    const candidate = join(dir, name);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** `path` relative to `root`, always with forward slashes so capsules are portable. */
export function toPosixRelative(root: string, path: string): string {
  const rel = relative(root, path);
  return (rel === '' ? '.' : rel).split(sep).join('/');
}
