// SPDX-License-Identifier: AGPL-3.0-only
// The scripts an add runs on the computer, against real git: a bare origin, a
// clone of it with commits the remote does not have, and the seed archive the
// host would pack. Run here rather than answered by a stub, because every
// shape that broke it is git's own refusal: a branch the remote has never
// seen, the remote's own default branch two commits behind, a computer with no
// git identity of its own, and a patch git will not apply.
//
// Every script here runs with no identity and no git config at all, which is
// what a computer the person joined has.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SeedChoice, SeedPlan } from "@wsp/protocol";
import { cloneScript, MEMORY_KEPT_MARK, patchCleanupScript, patchScript, seedRestScript } from "../src/project-landing.js";
import { projectSource } from "../src/project-sources.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (at: string, ...args: string[]): string => execFileSync("git", ["-C", at, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

/** The environment a script gets on the computer holding the project: no git identity anywhere, no config of the
 * person's and none of the machine's. A box has exactly this, which is why `git am` there asked for a committer
 * and got none.
 *
 * `user.useConfigOnly` is what makes it that computer on any other: git guesses an identity from the account and
 * the hostname where it can, which on a Mac it can and on a box it could not, so a test that only emptied HOME
 * would pass here and fail there. Every identity now has to be given, which is what the patch step gives. */
function noIdentity(root: string): Record<string, string> {
  const home = join(root, "empty-home");
  mkdirSync(home, { recursive: true });
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.useConfigOnly",
    GIT_CONFIG_VALUE_0: "true",
  };
}

/** One script on that computer, as the landing runs it: its exit code and what it said, never the shell's throw,
 * since a step that failed is a row the add answers for rather than an exception here. */
function run(script: string, root: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    return { exitCode: 0, stdout: execFileSync("sh", ["-c", script], { encoding: "utf8", env: noIdentity(root) }), stderr: "" };
  } catch (e) {
    const failed = e as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** A bare origin with one commit on main, and a clone of it: the shape a person's folder is in. */
function originAndClone(): { origin: string; folder: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-seed-script-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const folder = join(root, "spoo-landing");
  execFileSync("git", ["clone", "-q", origin, folder]);
  writeFileSync(join(folder, "README.md"), "one\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-qm", "first");
  git(folder, "push", "-q", "origin", "main");
  return { origin, folder, root };
}

/** The archive the host's pack would have made: the ticked file, the patch of the commits the remote does not
 * have, and the memory folder, at the paths the landing unpacks them from. */
function seedTar(root: string, o: { patch: string; memory?: string }): string {
  const stage = mkdtempSync(join(root, "stage-"));
  mkdirSync(join(stage, ".wsp-seed", "memory"), { recursive: true });
  writeFileSync(join(stage, ".env.local"), "TOKEN=abc\n");
  writeFileSync(join(stage, ".wsp-seed", "commits.patch"), o.patch);
  writeFileSync(join(stage, ".wsp-seed", "memory", "MEMORY.md"), o.memory ?? "- one thing\n");
  const tar = join(root, "seed.tgz");
  execFileSync("tar", ["-czf", tar, "-C", stage, ".env.local", ".wsp-seed"]);
  return tar;
}

function plan(o: { source: string; remote: string; branch: string; base: string; commits: number }): SeedPlan {
  return {
    source: o.source,
    remote: o.remote,
    branch: o.branch,
    defaultBranch: "main",
    unpushed: { commits: o.commits, base: o.base },
    uncommitted: 0,
    memory: { key: "-Users-dev-spoo-landing", files: 1, bytes: 20 },
    files: [{ path: ".env.local", dir: false, bytes: 12, kind: "config", row: { id: "next", name: "Next" }, ticked: true }],
    remembered: false,
  };
}

const CHOICE: SeedChoice = { files: [".env.local"], memory: true, commits: true };

/** The three steps the box road runs in order, each with its own exit code: the clone with the archive on top, the
 * patch, and the memory folder moved out with wsp's own folder removed. The patch's failure road is the landing's,
 * so it is run here only where a case asks for it. */
function landing(o: { root: string; remote: string; checkout: string; memoryDir: string; plan: SeedPlan; seedTar: string; choice?: SeedChoice }): { clone: ReturnType<typeof run>; patch: ReturnType<typeof run>; rest: () => ReturnType<typeof run>; step: { branch: string; base: string; back: string } } {
  const choice = o.choice ?? CHOICE;
  const clone = run(cloneScript({ source: projectSource("git"), remote: o.remote, checkout: o.checkout, computer: "spoo", seedTar: o.seedTar }), o.root);
  const step = { branch: o.plan.branch, base: o.plan.unpushed?.base ?? "", back: o.plan.defaultBranch ?? o.plan.branch };
  const patch = choice.commits && o.plan.unpushed !== null ? run(patchScript({ ...step, checkout: o.checkout }), o.root) : { exitCode: 0, stdout: "", stderr: "" };
  return {
    clone,
    patch,
    step,
    rest: () => run(seedRestScript({ checkout: o.checkout, memoryDir: o.memoryDir, seedTar: o.seedTar, memory: choice.memory && o.plan.memory !== null }), o.root),
  };
}

describe("the scripts that clone and seed a project on a computer with no git identity of its own", () => {
  it("lands the commits of a branch the remote has never seen as a branch of its own, on top of where they started", () => {
    const { origin, folder, root } = originAndClone();
    // The person's own branch, two commits, none of it pushed.
    git(folder, "checkout", "-qb", "refactor/dashboard-polish");
    for (const n of ["two", "three"]) {
      writeFileSync(join(folder, `${n}.md`), `${n}\n`);
      git(folder, "add", "-A");
      git(folder, "commit", "-qm", n);
    }
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const patch = git(folder, "format-patch", "--stdout", `${base}..HEAD`);
    const checkout = join(root, "checkout");
    const memoryDir = join(root, "memory");
    const ran = landing({ root, remote: origin, checkout, memoryDir, plan: plan({ source: folder, remote: origin, branch: "refactor/dashboard-polish", base, commits: 2 }), seedTar: seedTar(root, { patch }) });
    expect(ran.clone.exitCode).toBe(0);
    expect(ran.patch.exitCode, ran.patch.stderr).toBe(0);
    // The count is git's own, read off the checkout as the step's last line, which is what the record keeps.
    expect(ran.patch.stdout.trim().split("\n").at(-1)).toBe("2");
    expect(ran.rest().exitCode).toBe(0);
    // The clone came up on the remote's own default branch and is still on it.
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    // Their branch is there, with both commits on top of the commit they started from.
    expect(git(checkout, "log", "--format=%s", "refactor/dashboard-polish", "-3").trim().split("\n")).toEqual(["three", "two", "first"]);
    // The ticked file landed, the memory folder was moved out of the checkout and wsp's own folder is gone.
    expect(readFileSync(join(checkout, ".env.local"), "utf8")).toBe("TOKEN=abc\n");
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("- one thing\n");
    expect(existsSync(join(checkout, ".wsp-seed"))).toBe(false);
  });

  it("signs them as wsp and leaves the person as their author, since the computer has no identity to commit with", () => {
    const { origin, folder, root } = originAndClone();
    writeFileSync(join(folder, "two.md"), "two\n");
    git(folder, "add", "-A");
    execFileSync("git", ["-C", folder, "commit", "-qm", "two"], { env: { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com" } });
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const patch = git(folder, "format-patch", "--stdout", `${base}..HEAD`);
    const checkout = join(root, "checkout");
    const ran = landing({ root, remote: origin, checkout, memoryDir: join(root, "memory"), plan: plan({ source: folder, remote: origin, branch: "main", base, commits: 1 }), seedTar: seedTar(root, { patch }) });
    expect(ran.patch.exitCode, ran.patch.stderr).toBe(0);
    expect(ran.patch.stdout.trim().split("\n").at(-1)).toBe("1");
    // The commit is on the computer, the person's name is still on the work, and wsp is only who committed it.
    expect(git(checkout, "log", "--format=%an <%ae> committed by %cn <%ce>", "-1").trim()).toBe("Dev <dev@example.com> committed by wsp <wsp@localhost>");
    expect(git(checkout, "log", "--format=%s", "-2").trim().split("\n")).toEqual(["two", "first"]);
  });

  it("lands the commits of the remote's own default branch on top of it, where the clone already made that branch", () => {
    const { origin, folder, root } = originAndClone();
    // Two commits on main that were never pushed: the clone makes main itself, so the branch already exists.
    for (const n of ["two", "three"]) {
      writeFileSync(join(folder, `${n}.md`), `${n}\n`);
      git(folder, "add", "-A");
      git(folder, "commit", "-qm", n);
    }
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const patch = git(folder, "format-patch", "--stdout", `${base}..HEAD`);
    const checkout = join(root, "checkout");
    const memoryDir = join(root, "memory");
    const ran = landing({ root, remote: origin, checkout, memoryDir, plan: plan({ source: folder, remote: origin, branch: "main", base, commits: 2 }), seedTar: seedTar(root, { patch }) });
    expect(ran.patch.exitCode, ran.patch.stderr).toBe(0);
    expect(ran.rest().exitCode).toBe(0);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(checkout, "log", "--format=%s", "-3").trim().split("\n")).toEqual(["three", "two", "first"]);
    expect(existsSync(join(checkout, ".wsp-seed"))).toBe(false);
  });

  it("leaves the memory already standing at the agent's path alone, and says so on its own output", () => {
    const { origin, folder, root } = originAndClone();
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const checkout = join(root, "checkout");
    // The memory the agent on that computer has kept for this project, which the seed must not write over.
    const memoryDir = join(root, "state", "projects", "-srv-spoo-landing", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "- what the agent learned here\n");
    const ran = landing({
      root,
      remote: origin,
      checkout,
      memoryDir,
      plan: plan({ source: folder, remote: origin, branch: "main", base, commits: 0 }),
      seedTar: seedTar(root, { patch: "", memory: "- what the folder carried\n" }),
      choice: { files: [".env.local"], memory: true, commits: false },
    });
    expect(ran.clone.exitCode).toBe(0);
    const rest = ran.rest();
    expect(rest.exitCode, rest.stderr).toBe(0);
    // Byte for byte what the agent had, and the mark the landing reads to say the seed's memory was not landed.
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("- what the agent learned here\n");
    expect(rest.stdout).toContain(MEMORY_KEPT_MARK);
    // And the rest of the step ran as it always does: wsp's own folder gone from the checkout every copy is
    // taken of, and the ticked file still there.
    expect(readFileSync(join(checkout, ".env.local"), "utf8")).toBe("TOKEN=abc\n");
    expect(existsSync(join(checkout, ".wsp-seed"))).toBe(false);
  });

  it("takes an empty folder at the agent's path as nothing kept, so the seed's memory lands in its place", () => {
    const { origin, folder, root } = originAndClone();
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const checkout = join(root, "checkout");
    // What an older bind left on the computer as its mount point, and what the agent makes before it writes a
    // line in it: a folder with no memory in it.
    const memoryDir = join(root, "state", "projects", "-srv-spoo-landing", "memory");
    mkdirSync(memoryDir, { recursive: true });
    const ran = landing({
      root,
      remote: origin,
      checkout,
      memoryDir,
      plan: plan({ source: folder, remote: origin, branch: "main", base, commits: 0 }),
      seedTar: seedTar(root, { patch: "", memory: "- what the folder carried\n" }),
      choice: { files: [".env.local"], memory: true, commits: false },
    });
    expect(ran.clone.exitCode).toBe(0);
    const rest = ran.rest();
    expect(rest.exitCode, rest.stderr).toBe(0);
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("- what the folder carried\n");
    // Nothing was kept, so nothing is said to have been kept.
    expect(rest.stdout).not.toContain(MEMORY_KEPT_MARK);
  });

  it("is one command per line, so a step that cannot make the folder ends before the seed is swept", () => {
    const { origin, folder, root } = originAndClone();
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const checkout = join(root, "checkout");
    // A file standing where the folder above the memory has to be made: the mkdir cannot succeed.
    const parent = join(root, "state");
    writeFileSync(parent, "not a folder\n");
    const memoryDir = join(parent, "projects", "-srv-spoo-landing", "memory");
    const ran = landing({
      root,
      remote: origin,
      checkout,
      memoryDir,
      plan: plan({ source: folder, remote: origin, branch: "main", base, commits: 0 }),
      seedTar: seedTar(root, { patch: "", memory: "- what the folder carried\n" }),
      choice: { files: [".env.local"], memory: true, commits: false },
    });
    expect(ran.clone.exitCode).toBe(0);
    const rest = ran.rest();
    // The step fails and stops there: the seed's own folder is still in the checkout with the memory in it, so
    // the add says the step failed and nothing of the person's was swept away behind a mkdir nobody read.
    expect(rest.exitCode).not.toBe(0);
    expect(rest.stdout).not.toContain(MEMORY_KEPT_MARK);
    expect(existsSync(join(checkout, ".wsp-seed", "memory", "MEMORY.md"))).toBe(true);
  });

  it("lands the seed's memory where nothing stands at all, making the folder above it", () => {
    const { origin, folder, root } = originAndClone();
    const base = git(folder, "merge-base", "HEAD", "origin/main").trim();
    const checkout = join(root, "checkout");
    const memoryDir = join(root, "state", "projects", "-srv-spoo-landing", "memory");
    const ran = landing({
      root,
      remote: origin,
      checkout,
      memoryDir,
      plan: plan({ source: folder, remote: origin, branch: "main", base, commits: 0 }),
      seedTar: seedTar(root, { patch: "", memory: "- what the folder carried\n" }),
      choice: { files: [".env.local"], memory: true, commits: false },
    });
    expect(ran.clone.exitCode).toBe(0);
    const rest = ran.rest();
    expect(rest.exitCode, rest.stderr).toBe(0);
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("- what the folder carried\n");
    expect(rest.stdout).not.toContain(MEMORY_KEPT_MARK);
  });

  it("clones and seeds with no patch at all where the person kept none", () => {
    const { origin, folder, root } = originAndClone();
    const checkout = join(root, "checkout");
    const memoryDir = join(root, "memory");
    const ran = landing({
      root,
      remote: origin,
      checkout,
      memoryDir,
      plan: { ...plan({ source: folder, remote: origin, branch: "main", base: "x", commits: 0 }), unpushed: null },
      seedTar: seedTar(root, { patch: "" }),
      choice: { files: [".env.local"], memory: true, commits: false },
    });
    expect(ran.clone.exitCode).toBe(0);
    expect(ran.rest().exitCode).toBe(0);
    expect(git(checkout, "log", "--format=%s", "-1").trim()).toBe("first");
    expect(readFileSync(join(checkout, ".env.local"), "utf8")).toBe("TOKEN=abc\n");
  });
});

/** A patch of the right shape whose blobs are not in the repository: git cannot apply it and cannot fall back on
 * a three-way merge either, which is a person's commits meeting a remote that has moved. */
const UNAPPLIABLE = `From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001
From: Dev <dev@example.com>
Date: Thu, 18 Sep 2026 00:00:00 +0000
Subject: [PATCH] two

---
 README.md | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/README.md b/README.md
index 1111111aaaaaaa2222222bbbbbbb3333333ccccccc..4444444ddddddd5555555eeeeeee6666666fffffff 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-nothing like what is there
+two
--
2.39.0

`;

describe("a patch the computer's git refuses", () => {
  it("fails its own step and leaves the remote's default branch back at the remote's tip, with nothing half applied", () => {
    const { origin, folder, root } = originAndClone();
    const tip = git(folder, "rev-parse", "origin/main").trim();
    const checkout = join(root, "checkout");
    const memoryDir = join(root, "memory");
    // The person's commit is on the remote's own default branch, which is the shape where the step moves main
    // itself back to where their work started.
    const ran = landing({ root, remote: origin, checkout, memoryDir, plan: plan({ source: folder, remote: origin, branch: "main", base: tip, commits: 1 }), seedTar: seedTar(root, { patch: UNAPPLIABLE }) });
    expect(ran.clone.exitCode).toBe(0);
    expect(ran.patch.exitCode).not.toBe(0);
    // The failure road the landing runs: it says nothing and its own exit is never read.
    run(patchCleanupScript({ ...ran.step, checkout }), root);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    // Back at the remote's tip, not at the commit the step moved it to: every copy of this checkout starts where
    // the clone did.
    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(existsSync(join(checkout, ".git", "rebase-apply"))).toBe(false);
    // And the rest of the seed still lands, so the add stands with the commits left behind.
    expect(ran.rest().exitCode).toBe(0);
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("- one thing\n");
    expect(existsSync(join(checkout, ".wsp-seed"))).toBe(false);
  });

  it("drops the branch of the person's own that the step made, so the checkout carries no half branch", () => {
    const { origin, folder, root } = originAndClone();
    const tip = git(folder, "rev-parse", "origin/main").trim();
    const checkout = join(root, "checkout");
    const ran = landing({ root, remote: origin, checkout, memoryDir: join(root, "memory"), plan: plan({ source: folder, remote: origin, branch: "refactor/dashboard-polish", base: tip, commits: 1 }), seedTar: seedTar(root, { patch: UNAPPLIABLE }) });
    expect(ran.patch.exitCode).not.toBe(0);
    run(patchCleanupScript({ ...ran.step, checkout }), root);
    expect(git(checkout, "branch", "--format=%(refname:short)").trim().split("\n")).toEqual(["main"]);
    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(tip);
  });

  it("a base the remote no longer has fails the step at its first line, and the cleanup after it fails nothing", () => {
    const { origin, folder, root } = originAndClone();
    const tip = git(folder, "rev-parse", "origin/main").trim();
    const checkout = join(root, "checkout");
    const gone = "1111111111111111111111111111111111111111";
    const ran = landing({ root, remote: origin, checkout, memoryDir: join(root, "memory"), plan: plan({ source: folder, remote: origin, branch: "main", base: gone, commits: 1 }), seedTar: seedTar(root, { patch: UNAPPLIABLE }) });
    expect(ran.patch.exitCode).not.toBe(0);
    // Nothing is in progress and no branch was made, so every line of the cleanup has nothing to do: none of it
    // may be read as a failure of the add.
    run(patchCleanupScript({ ...ran.step, checkout }), root);
    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(existsSync(join(checkout, ".git", "rebase-apply"))).toBe(false);
  });
});
