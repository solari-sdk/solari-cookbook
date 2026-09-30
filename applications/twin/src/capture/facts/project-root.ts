import { join } from 'node:path';
import { ancestors, pathExists } from '../../util/fs.ts';

const PROJECT_MARKERS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
];

/**
 * Outside a git work tree, the nearest directory with a project manifest stands in for the repo
 * root, so running from a subdirectory (src/) still finds the lockfile and node_modules.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  for (const dir of ancestors(cwd)) {
    for (const marker of PROJECT_MARKERS) {
      if (await pathExists(join(dir, marker))) return dir;
    }
  }
  return cwd;
}
