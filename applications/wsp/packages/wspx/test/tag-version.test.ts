// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkTag, isReleaseTag, manifestMismatches, versionFromTag } from "../scripts/tag-version.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const made: string[] = [];
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repository of its own carrying those manifests on `main`. The workflow asks about `origin/main`; the ref is an
 * argument, so a case here asks about a local branch and needs no remote. */
function fakeRepo(packages: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-tag-"));
  made.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "tags@example.invalid");
  git(root, "config", "user.name", "tags");
  git(root, "config", "commit.gpgsign", "false");
  for (const dir of ["packages", "apps"]) mkdirSync(join(root, dir), { recursive: true });
  for (const [path, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    git(root, "add", "--", join(path, "package.json"));
  }
  commit(root, "the manifests");
  return root;
}

/** One commit, with no hook of the developer's own reading it. */
function commit(dir: string, message: string): string {
  git(dir, "commit", "-q", "--no-verify", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD").trim();
}

/** A commit on a branch of its own, whose file is no manifest, and the branch left where it was made. */
function onSideBranch(dir: string): string {
  git(dir, "checkout", "-q", "-b", "side");
  writeFileSync(join(dir, "packages", "note.txt"), "a line of its own\n");
  git(dir, "add", "--", join("packages", "note.txt"));
  const made = commit(dir, "a commit main never took");
  git(dir, "checkout", "-q", "main");
  return made;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the tag a release workflow answers to", () => {
  it("is v and a version, prerelease included", () => {
    expect(versionFromTag("v0.1.4")).toBe("0.1.4");
    expect(versionFromTag("v1.0.0-rc.1")).toBe("1.0.0-rc.1");
    expect(isReleaseTag("v0.1.4")).toBe(true);
  });

  it("is not a bare version, a branch or a nightly", () => {
    for (const ref of ["0.1.4", "main", "v0.1", "nightly", "release-0.1.4", ""]) {
      expect(isReleaseTag(ref)).toBe(false);
      expect(() => versionFromTag(ref)).toThrow(/not a release tag/);
    }
  });
});

describe("the check between the tag and the manifests", () => {
  it("passes when every versioned manifest carries the tag's number", () => {
    const root = fakeRepo({
      "packages/wspx": { name: "@zingzy/wsp", version: "0.1.4" },
      "apps/desktop": { name: "@wsp/desktop", version: "0.1.4", private: true },
      "apps/web": { name: "@wsp/web", private: true },
    });
    git(root, "tag", "v0.1.4");
    expect(manifestMismatches(root, "0.1.4")).toEqual([]);
    expect(checkTag(root, "v0.1.4", "main")).toBe("0.1.4");
  });

  it("fails naming the tag's number and each manifest that disagrees", () => {
    const root = fakeRepo({
      "packages/wspx": { name: "@zingzy/wsp", version: "0.1.4" },
      "apps/desktop": { name: "@wsp/desktop", version: "0.1.3", private: true },
    });
    git(root, "tag", "v0.1.4");
    expect(manifestMismatches(root, "0.1.4")).toEqual([{ file: join("apps", "desktop", "package.json"), version: "0.1.3" }]);
    expect(() => checkTag(root, "v0.1.4", "main")).toThrow(/tag v0\.1\.4 says 0\.1\.4, apps\/desktop\/package\.json says 0\.1\.3/);
  });

  it("says one sentence for a tag that is not here, not git's own block", () => {
    const root = fakeRepo({ "packages/wspx": { name: "@zingzy/wsp", version: "0.1.4" } });
    expect(() => checkTag(root, "v9.9.9", "main")).toThrow("no tag v9.9.9 in this checkout; fetch the tag before asking what it names");
    const script = join(repo, "packages", "wspx", "scripts", "tag-version.mjs");
    const ran = spawnSync("node", [script, "v99.99.99"], { encoding: "utf8" });
    expect(ran.status).toBe(1);
    expect(ran.stderr.trim()).toBe("no tag v99.99.99 in this checkout; fetch the tag before asking what it names");
  });

  it("fails on the tag before it reads a repository at all", () => {
    expect(() => checkTag(fakeRepo({}), "v0.1", "main")).toThrow(/not a release tag/);
  });
});

describe("the check that the tag stands on main's own line", () => {
  it("refuses a tag on a side branch, and takes the same tag once that work is squashed onto main", () => {
    const root = fakeRepo({ "packages/wspx": { name: "@zingzy/wsp", version: "0.1.4" } });
    const aside = onSideBranch(root);
    git(root, "tag", "v0.1.4", aside);
    expect(() => checkTag(root, "v0.1.4", "main")).toThrow(
      `tag v0.1.4 points at ${aside}, which is not on main's own line; tag a commit main carries`,
    );
    git(root, "merge", "-q", "--squash", "side");
    const landed = commit(root, "the work, squashed onto main");
    git(root, "tag", "-f", "v0.1.4", landed);
    expect(checkTag(root, "v0.1.4", "main")).toBe("0.1.4");
  });

  it("refuses the commit a true merge brought in and takes the merge commit itself, since the read is first parents", () => {
    const root = fakeRepo({ "packages/wspx": { name: "@zingzy/wsp", version: "0.1.4" } });
    const aside = onSideBranch(root);
    git(root, "merge", "-q", "--no-ff", "--no-verify", "-m", "the side brought in whole", "side");
    const merge = git(root, "rev-parse", "HEAD").trim();
    git(root, "tag", "v0.1.4", aside);
    expect(() => checkTag(root, "v0.1.4", "main")).toThrow(`points at ${aside}, which is not on main's own line`);
    git(root, "tag", "-f", "v0.1.4", merge);
    expect(checkTag(root, "v0.1.4", "main")).toBe("0.1.4");
  });

  it("says the ancestry sentence and not the manifest one when both would fire", () => {
    const root = fakeRepo({ "packages/wspx": { name: "@zingzy/wsp", version: "0.1.3" } });
    const aside = onSideBranch(root);
    git(root, "tag", "v0.1.4", aside);
    expect(() => checkTag(root, "v0.1.4", "main")).toThrow(/is not on main's own line/);
    expect(() => checkTag(root, "v0.1.4", "main")).not.toThrow(/says 0\.1\.3/);
  });
});

/** The version this checkout's own manifests carry, and whether it can be asked about its own tag: a shallow
 * checkout on a runner carries neither the tag nor origin/main, and the cases above cover the rule without them. */
const version = JSON.parse(readFileSync(join(repo, "apps", "desktop", "package.json"), "utf8")).version as string;
const here = ((): boolean => {
  try {
    for (const ref of [`refs/tags/v${version}`, "refs/remotes/origin/main"]) git(repo, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
})();

describe("this repository's own tag", () => {
  it.skipIf(!here)("passes for the tag its manifests name, on the line origin/main carries", () => {
    expect(checkTag(repo, `v${version}`)).toBe(version);
  });
});
