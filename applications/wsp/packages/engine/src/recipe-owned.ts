// SPDX-License-Identifier: AGPL-3.0-only
// What a golden's recipe writes into the guest home, and what an upgrade does with it. The seal hashes these files
// on the builder and the version records them; a fork moving onto a newer image hashes its own copies and this
// comparison says which of them travel. One read of the recipe's file list, one rule for the comparison.
import { GUEST_HOME } from "@wsp/catalog";
import { shellQuote, type RecipeDigest, type RecipeOwnedFile } from "@wsp/protocol";
import { INLINE_EXEC_MS, execFits } from "./exec-detached.js";
import type { Machine } from "./machine.js";

/** The paths the recipe writes into the guest home and the ones it marks volatile: a tool rewrites those as it runs,
 * or the machine renders them, so their bytes never stand for a person's edit. */
export interface WrittenPaths {
  /** Home-relative, each once. */
  paths: string[];
  /** Those of them the recipe marks volatile, as roots: a file under one is volatile too. */
  volatile: string[];
}

/** The recipe's own list of written paths. Nothing else derives it; a row that names a directory travels as a
 * directory, so the read below expands it into the files under it. */
export function recipeWrittenPaths(recipe: RecipeDigest): WrittenPaths {
  const paths = [...new Set(recipe.files.map(f => f.dest))].sort();
  return { paths, volatile: paths.filter(p => recipe.files.some(f => f.dest === p && f.volatile === true)) };
}

/** The one command that hashes the files: every regular file at or under the paths, from the home they are relative
 * to. A path no longer there is silently nothing, so a recipe row a fork deleted reads as absent; a home the read
 * cannot reach fails, since an empty answer would read as a fork that changed every one of them. */
export function ownedFilesScript(home: string, paths: readonly string[]): string {
  return `cd ${shellQuote(home)} || exit 1\nfind ${paths.map(shellQuote).join(" ")} -type f -print0 2>/dev/null | xargs -0 -r sha256sum --`;
}

/** sha256sum's lines as the manifest holds them. A name it had to escape (a newline or a backslash in the path) is
 * left out: it carries a leading backslash and no recipe path has one. */
export function parseOwnedFiles(stdout: string): RecipeOwnedFile[] {
  return stdout
    .split("\n")
    .map(line => /^([0-9a-f]{64}) {2}(.+)$/.exec(line))
    .flatMap(m => (m === null ? [] : [{ path: m[2]!, sha256: m[1]! }]))
    .sort(byPath);
}

const byPath = (a: RecipeOwnedFile, b: RecipeOwnedFile): number => (a.path < b.path ? -1 : 1);

/** Every file at or under the paths on the machine, with its hash: the seal reads the recipe's paths on the builder,
 * the upgrade reads the version's paths on the fork. */
export async function readOwnedFiles(machine: Machine, paths: readonly string[], home: string = GUEST_HOME): Promise<RecipeOwnedFile[]> {
  // A version's own manifest is a thousand files on a real image (the recipe's config rows name whole directories),
  // whose paths pass the exec body cap in one command and would be refused whole, so the read goes a page at a time
  // under the same rule every other road that builds a command out of a list reads.
  const pages: string[][] = [[]];
  for (const path of paths) {
    const last = pages.at(-1)!;
    if (last.length > 0 && !execFits(ownedFilesScript(home, [...last, path]))) pages.push([path]);
    else last.push(path);
  }
  const found: RecipeOwnedFile[] = [];
  for (const page of pages) {
    if (page.length === 0) continue;
    const read = await machine.exec(ownedFilesScript(home, page), { timeoutMs: INLINE_EXEC_MS });
    if (read.exitCode !== 0) throw new Error(`reading the recipe's files on ${machine.id} failed (exit ${read.exitCode}): ${read.stderr.slice(-200)}`);
    found.push(...parseOwnedFiles(read.stdout));
  }
  return found.sort(byPath);
}

/** Whether a path is one of the roots or sits under one. */
const at = (path: string, roots: readonly string[]): boolean => roots.some(r => path === r || path.startsWith(`${r}/`));

/** The manifest a seal records: every file the recipe writes into home, hashed on the builder, with the ones under a
 * volatile row marked as it marked them. */
export async function recipeOwnedFiles(machine: Machine, recipe: RecipeDigest, home: string = GUEST_HOME): Promise<RecipeOwnedFile[]> {
  const written = recipeWrittenPaths(recipe);
  return (await readOwnedFiles(machine, written.paths, home)).map(f => (at(f.path, written.volatile) ? { ...f, volatile: true } : f));
}

/** What the vault leaves behind and what it carries when a fork moves onto a newer image. */
export interface UpgradePlan {
  /** Home-relative paths the archive drops, so the new image's copy of each stands. */
  drop: string[];
  /** The fork's own edits to files the image wrote, which travel; the result names these. */
  kept: string[];
  /** The image the fork stands on recorded no files of its own, so nothing is dropped and the whole home travels. */
  fallback: boolean;
}

/** The three-way comparison, on the paths alone: the files the fork's own image wrote, the files the new image
 * writes, and what the fork's home holds at each of those paths now. A path in no manifest is nobody's but the
 * fork's and never appears here. */
export function upgradePlan(from: readonly RecipeOwnedFile[] | undefined, to: readonly RecipeOwnedFile[] | undefined, fork: readonly RecipeOwnedFile[]): UpgradePlan {
  if (from === undefined) return { drop: [], kept: [], fallback: true };
  const here = new Map(fork.map(f => [f.path, f.sha256]));
  const was = new Set(from.map(f => f.path));
  const drop: string[] = [];
  const kept: string[] = [];
  for (const f of from) {
    // A volatile file's bytes move on their own, so a difference there is nobody's edit: it travels, unnamed.
    if (f.volatile === true) continue;
    // Gone from the fork is the new image's copy standing, not the fork's deletion winning: an archive carries no
    // deletion, and the directory the path sits in is held out of it so the copies beside it survive.
    const mine = here.get(f.path);
    (mine === undefined || mine === f.sha256 ? drop : kept).push(f.path);
  }
  // New in the image: the fork was forked before this path existed, so whatever it holds there is nobody's edit of
  // it, and the archive has to leave the path alone even when the fork holds nothing, or the directory it sits in
  // would land over the image's copy. A volatile row the recipe newly ticks is the one exception, since the fork's
  // own copy is state no image can stand in for; it is dropped only when the fork holds none.
  for (const f of to ?? []) if (!was.has(f.path) && !(f.volatile === true && here.has(f.path))) drop.push(f.path);
  return { drop: drop.sort(), kept: kept.sort(), fallback: false };
}
