// SPDX-License-Identifier: AGPL-3.0-only
// What the prepare script wires: git reads the hooks main carries, out of a folder under the common git directory
// and outside every worktree, so a checkout of someone else's branch runs main's text at a commit and that
// branch's hook text runs once it has landed. Driven through real commits in throwaway repositories.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "hooks-path.mjs");
const SOURCE = join(ROOT, ".githooks");
const HOOKS = readdirSync(SOURCE).sort();
const EM_DASH = String.fromCodePoint(0x2014);
const MARKER = "marker";

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A folder of its own, removed when the case ends. */
function temporary(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  dirs.push(dir);
  return dir;
}

/** A repository whose `main` carries the four hooks this tree carries and whose `foreign` branch carries a
 * pre-commit that refuses nothing and writes a marker, which is the hook text a branch of someone else's would
 * bring. It is left with `foreign` checked out, which is what a review of that branch looks like. */
function withAForeignBranch(): string {
  const dir = temporary("wsp-hooks-path-");
  git(dir, "init", "-q", "-b", "main");
  identity(dir);
  mkdirSync(join(dir, ".githooks"));
  for (const hook of HOOKS) {
    writeFileSync(join(dir, ".githooks", hook), readFileSync(join(SOURCE, hook), "utf8"));
    chmodSync(join(dir, ".githooks", hook), 0o755);
  }
  git(dir, "add", "--", ".githooks");
  git(dir, "commit", "-q", "--no-verify", "-m", "the hooks main carries");
  git(dir, "checkout", "-q", "-b", "foreign");
  writeFileSync(join(dir, ".githooks", "pre-commit"), `#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/${MARKER}"\nexit 0\n`);
  chmodSync(join(dir, ".githooks", "pre-commit"), 0o755);
  git(dir, "add", "--", ".githooks/pre-commit");
  git(dir, "commit", "-q", "--no-verify", "-m", "a hook of this branch's own");
  return dir;
}

/** Who commits here, since a clone carries none of this and a runner has no identity of its own. */
function identity(dir: string): void {
  git(dir, "config", "user.email", "hooks@example.invalid");
  git(dir, "config", "user.name", "hooks");
  git(dir, "config", "commit.gpgsign", "false");
}

/** The script as `pnpm install` runs it, from a worktree, and the one line it says. */
function wire(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("node", [SCRIPT], { cwd: dir, encoding: "utf8", env }).trim();
}

/** The folder the hooks of a worktree's repository are read from. */
function folderOf(dir: string): string {
  return join(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(), "wsp-hooks");
}

/** What a commit of one staged file carrying an em dash did: the sentence a hook said, or nothing. */
function commitStaged(dir: string): string {
  writeFileSync(join(dir, "a.ts"), `a line with the token ${EM_DASH} the one the deploy writes\n`);
  git(dir, "add", "--", "a.ts");
  try {
    execFileSync("git", ["-C", dir, "commit", "-m", "host: the deploy writes the token"], { encoding: "utf8", stdio: "pipe" });
    return "";
  } catch (e) {
    return String((e as { stderr?: Buffer | string }).stderr ?? "").trim();
  }
}

const REFUSED = "refused: a line staged in a.ts has an em dash; write it with a comma, a colon or two sentences";

describe("what the prepare script wires", () => {
  it("points git at main's hooks from a folder outside the worktree, so a foreign branch's hook text does not run", () => {
    const dir = withAForeignBranch();
    const folder = folderOf(dir);
    expect(wire(dir)).toBe(`hooks: git reads the hooks main carries, from ${folder}`);
    expect(git(dir, "config", "--get", "core.hooksPath").trim()).toBe(folder);
    expect(folder).not.toContain(".githooks");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("foreign");
    expect(commitStaged(dir)).toBe(REFUSED);
    expect(existsSync(join(dir, MARKER))).toBe(false);
  });

  it("is one folder for every linked worktree, which share the config and the common directory", () => {
    const dir = withAForeignBranch();
    const folder = folderOf(dir);
    wire(dir);
    const linked = join(temporary("wsp-hooks-linked-"), "on-foreign");
    git(dir, "worktree", "add", "-q", "--detach", linked, "foreign");
    expect(git(linked, "config", "--get", "core.hooksPath").trim()).toBe(folder);
    expect(commitStaged(linked)).toBe(REFUSED);
    expect(existsSync(join(linked, MARKER))).toBe(false);
  });

  it("leaves the folder holding main's hook list, each executable, and no half written name", () => {
    const dir = withAForeignBranch();
    const folder = folderOf(dir);
    wire(dir);
    expect(readdirSync(folder).sort()).toEqual(HOOKS);
    for (const hook of HOOKS) expect(statSync(join(folder, hook)).mode & 0o111, hook).not.toBe(0);
    // A hook main no longer carries is not left behind for git to run.
    writeFileSync(join(folder, "pre-rebase"), "#!/bin/sh\nexit 1\n");
    wire(dir);
    expect(readdirSync(folder).sort()).toEqual(HOOKS);
  });

  it("sweeps a half written hook whose install died and leaves one whose install is still running", () => {
    const dir = withAForeignBranch();
    const folder = folderOf(dir);
    wire(dir);
    // A pid that ran and exited, which is what an install that died leaves in the name it was writing under.
    const dead = execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim();
    const gone = `pre-commit.${dead}.writing`;
    const going = `pre-commit.${process.pid}.writing`;
    for (const half of [gone, going]) writeFileSync(join(folder, half), "#!/bin/sh\nexit 1\n");
    wire(dir);
    expect(existsSync(join(folder, gone))).toBe(false);
    expect(readdirSync(folder).sort()).toEqual([...HOOKS, going].sort());
  });

  it("reads origin/main where a clone carries no main branch of its own", () => {
    const origin = withAForeignBranch();
    const clone = join(temporary("wsp-hooks-clone-"), "clone");
    execFileSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" });
    identity(clone);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("foreign");
    expect(() => git(clone, "rev-parse", "--verify", "--quiet", "refs/heads/main")).toThrow();
    expect(wire(clone)).toBe(`hooks: git reads the hooks main carries, from ${folderOf(clone)}`);
    expect(readdirSync(folderOf(clone)).sort()).toEqual(HOOKS);
    expect(commitStaged(clone)).toBe(REFUSED);
    expect(existsSync(join(clone, MARKER))).toBe(false);
  });

  it("wires nothing and says so where no main branch exists at all", () => {
    const dir = temporary("wsp-hooks-nomain-");
    git(dir, "init", "-q", "-b", "work");
    expect(wire(dir)).toBe("hooks: no main branch here, the hooks are not wired");
    expect(() => git(dir, "config", "--get", "core.hooksPath")).toThrow();
    expect(existsSync(folderOf(dir))).toBe(false);
  });

  it("is not a failed install where there is no git repository", () => {
    expect(wire(temporary("wsp-hooks-bare-"))).toBe("hooks: no git repository here, nothing to wire");
  });

  it("says the hooks are unwired when git will not take the setting, which is not the same as having no git", () => {
    const dir = withAForeignBranch();
    // A git that answers every read and refuses to write the setting, so the case holds whatever the runner's
    // privileges are.
    const bin = temporary("wsp-hooks-bin-");
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$1" in config) exit 1 ;; esac\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const said = wire(dir, { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` });
    expect(said).toBe(`hooks: git would not take core.hooksPath, so the hooks in ${folderOf(dir)} are not wired`);
    expect(() => git(dir, "config", "--get", "core.hooksPath")).toThrow();
    expect(dirname(folderOf(dir))).toBe(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
  });
});
