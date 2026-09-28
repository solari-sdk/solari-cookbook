// SPDX-License-Identifier: AGPL-3.0-only
// This computer's own folders, one level at a time, for the folder picker a
// browser tab has: the desktop shell opens the system dialog and hands the
// page a path, and no web picker can give one. Folders only, nothing here
// reads a file, and only inside the roots, which are the home folder and each
// imported project's folder. The lexical check runs before anything under a
// path is read and the realpath check refuses a symlink that leaves the roots,
// so neither a typed path nor a link inside home reaches the rest of the disk.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CACHE_DIRS, foldersOutsideLine, hiddenFolder, REPO_CAP, REPO_DEPTH, type HostFolder, type HostFolderListing, type WorkspaceView } from "@wsp/protocol";
import type { HostFolders } from "@wsp/runtime";
import { under } from "./init-import.js";
import { isRepoFolder } from "./project-bundle.js";

export interface HostFolderPaths {
  /** This computer's home folder: the first root, and where a listing starts. */
  home?: string;
  /** Each imported project's own folder, so a project the home folder does not hold is browsable too. */
  projects?: readonly string[];
  /** What this computer runs, for the one folder a Mac keeps in every home; absent reads the process's own. */
  platform?: string;
  /** This computer's own window: the whole disk is a root after the home folder. */
  wide?: boolean;
  /** The folders wsp made as workspace copies, which are repos of their own and never a project to add. */
  copies?: readonly string[];
}

/** The project folders the records name, each once: an import lands a folder on the machine at the path it has here,
 * so a record's dest names the folder on this computer as well. */
export function importedProjectFolders(workspaces: readonly WorkspaceView[]): string[] {
  return [...new Set(workspaces.map(w => w.project.path))];
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The folders every level is browsed from: the home folder, then each imported project folder that is a folder here
 * and that the home folder does not already hold. */
export function hostFolderRoots(paths: HostFolderPaths = {}): string[] {
  const home = resolve(paths.home ?? homedir());
  const projects = (paths.projects ?? []).map(p => resolve(p)).filter(p => !under(p, home) && isFolder(p));
  return paths.wide === true ? [home, "/"] : [home, ...new Set(projects)];
}

/** Whether a path is inside a root, the disk's own root included, which no path is under by a separator after it. */
const inside = (path: string, root: string): boolean => root === "/" || under(path, root);

function outside(dir: string, roots: readonly string[]): Error {
  return new Error(foldersOutsideLine(dir, roots.join(", "), "this computer"));
}

/** Which folder a listing is for: absent gives the first root, and so does one inside the roots that is gone, which
 * is what a picker opening on a folder that has since moved should show. Anything outside them is refused. */
function folderToList(dir: string | undefined, roots: readonly string[], realRoots: readonly string[]): string {
  if (dir === undefined || dir === "") return roots[0]!;
  if (!isAbsolute(dir)) throw outside(dir, roots);
  const asked = resolve(dir);
  if (!roots.some(root => inside(asked, root))) throw outside(dir, roots);
  if (!isFolder(asked)) return roots[0]!;
  const real = realOf(asked);
  if (real === null || !realRoots.some(root => inside(real, root))) throw outside(dir, roots);
  return asked;
}

/** One level: the folders directly inside `dir`, sorted by name, each marked when git tracks it, with the hidden ones
 * counted rather than listed unless `hidden`. The one rule both folder browsers read, told the home it is walking
 * and what this computer is, since the Library a Mac hides is the home's own and not every folder of that name. A
 * folder that exists and cannot be read raises, as does a path outside the roots. A symlink is a row when it points
 * at a folder the roots hold, so no row leads out of them. */
export function listHostFolders(req: { dir?: string; hidden?: boolean } = {}, paths: HostFolderPaths = {}): HostFolderListing {
  const roots = hostFolderRoots(paths);
  const realRoots = roots.map(realOf).filter((root): root is string => root !== null);
  const dir = folderToList(req.dir, roots, realRoots);
  const names = readdirSync(dir, { withFileTypes: true })
    .filter(e => {
      const path = join(dir, e.name);
      if (!isFolder(path)) return false;
      if (!e.isSymbolicLink()) return true;
      const real = realOf(path);
      return real !== null && realRoots.some(root => inside(real, root));
    })
    .map(e => e.name)
    .sort();
  const machine = { home: roots[0]!, mac: (paths.platform ?? process.platform) === "darwin" };
  const named = names.filter(name => !hiddenFolder(join(dir, name), machine));
  const shown = req.hidden === true ? names : named;
  const folders: HostFolder[] = shown.map(name => join(dir, name)).map(path => ({ path, repo: isRepoFolder(path) }));
  return { dir, roots, folders, hidden: names.length - named.length };
}

/** The branch a checkout is on, off its HEAD file, and when git last wrote there. */
function repoFacts(dir: string): { branch?: string; touchedAt: number } {
  const git = join(dir, ".git");
  const stamp = (name: string): number => {
    try {
      return statSync(join(git, name)).mtimeMs;
    } catch {
      return 0;
    }
  };
  let branch: string | undefined;
  try {
    branch = /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(git, "HEAD"), "utf8"))?.[1];
  } catch {
    branch = undefined;
  }
  return { ...(branch !== undefined ? { branch } : {}), touchedAt: Math.max(stamp("index"), stamp("HEAD"), stamp("FETCH_HEAD")) };
}

/** Every repo under the home folder and the project roots, most recently written first. Hidden folders, the Mac's
 * Library and the dependency and cache folders are not walked into, nor is a repo, whose own folders are its code. A
 * linked worktree, whose .git is a file, is left out: the repo it belongs to is listed at its own checkout. So is a
 * workspace copy wsp made, which is a repo of its own and belongs to the project it was copied from. */
export function listHostRepos(paths: HostFolderPaths = {}): HostFolderListing {
  const roots = hostFolderRoots({ ...paths, wide: false });
  const machine = { home: roots[0]!, mac: (paths.platform ?? process.platform) === "darwin" };
  const copies = new Set((paths.copies ?? []).map(p => resolve(p)));
  const found: HostFolder[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= REPO_CAP) return;
    if (isRepoFolder(dir)) {
      if (isFolder(join(dir, ".git")) && !copies.has(dir)) found.push({ path: dir, repo: true, ...repoFacts(dir) });
      return;
    }
    if (depth >= REPO_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || CACHE_DIRS.has(e.name)) continue;
      const path = join(dir, e.name);
      if (hiddenFolder(path, machine)) continue;
      walk(path, depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  found.sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0));
  return { dir: roots[0]!, roots, folders: found, hidden: 0 };
}

/** The host's side of host.folders. The records are read on every ask, so a project imported while the app is open is
 * browsable at once, and the home folder is this computer's own. */
export function hostFolders(workspaces: () => Promise<readonly WorkspaceView[]>): HostFolders {
  return {
    list: async req => {
      const all = await workspaces();
      const copies = all.flatMap(w => (w.copy === undefined ? [] : [w.copy.path]));
      const paths = { projects: importedProjectFolders(all), wide: req.wide === true, copies };
      return req.repos === true ? listHostRepos(paths) : listHostFolders(req, paths);
    },
  };
}
