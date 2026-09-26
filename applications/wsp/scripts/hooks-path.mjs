// SPDX-License-Identifier: AGPL-3.0-only
// The hooks git runs come from main and from nowhere else. Their versioned
// source is .githooks in the tree, and this writes main's copy of each into a
// folder under the repository's common git directory, outside every worktree,
// then points core.hooksPath at that folder in the shared config. So a
// checkout of someone else's branch runs main's hooks at a commit, and that
// branch's hook text runs once it has landed and not before. An install with
// no git around it, which is what a package installed from a registry sees,
// has nothing to wire; a repository carrying no main branch and a git that
// will not take the setting leave the hooks unwired and say so. None of the
// three is a failed install.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = ".githooks";
const FOLDER = "wsp-hooks";
/** Each hook lands under a name of its own and is renamed over the hook's, so a second install running at the same
 * moment in another worktree never leaves a half written file where git reads a hook; the pid in the name is what
 * says whether that install is still going. */
const WRITING = `.${process.pid}.writing`;
const HALF_WRITTEN = /\.(\d+)\.writing$/;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Whether this repository has that ref at all. */
function reads(ref) {
  try {
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** Whether a name is an install's half written hook and that install is still running, which is the one thing the
 * sweep leaves alone. A pid that answers nothing was an install that died and its file is swept with the rest. */
function beingWritten(name) {
  const found = HALF_WRITTEN.exec(name);
  if (found === null) return false;
  try {
    process.kill(Number(found[1]), 0);
    return true;
  } catch (e) {
    // A running process someone else owns answers EPERM; only a pid nothing answers to is gone.
    return e.code === "EPERM";
  }
}

function wire() {
  let common;
  try {
    common = git("rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  } catch {
    return "hooks: no git repository here, nothing to wire";
  }
  const ref = ["main", "origin/main"].find(reads);
  if (ref === undefined) return "hooks: no main branch here, the hooks are not wired";
  const folder = join(common, FOLDER);
  mkdirSync(folder, { recursive: true });
  const names = git("ls-tree", "--name-only", ref, `${SOURCE}/`)
    .split("\n")
    .filter(line => line !== "")
    .map(line => line.slice(SOURCE.length + 1));
  for (const name of names) {
    const writing = join(folder, `${name}${WRITING}`);
    writeFileSync(writing, git("show", `${ref}:${SOURCE}/${name}`));
    chmodSync(writing, 0o755);
    renameSync(writing, join(folder, name));
  }
  for (const gone of readdirSync(folder)) {
    if (!names.includes(gone) && !beingWritten(gone)) rmSync(join(folder, gone), { recursive: true, force: true });
  }
  try {
    git("config", "core.hooksPath", folder);
  } catch {
    return `hooks: git would not take core.hooksPath, so the hooks in ${folder} are not wired`;
  }
  return `hooks: git reads the hooks main carries, from ${folder}`;
}

console.log(wire());
