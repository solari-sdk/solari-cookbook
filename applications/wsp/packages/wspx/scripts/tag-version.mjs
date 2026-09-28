// SPDX-License-Identifier: AGPL-3.0-only
// node scripts/tag-version.mjs v1.2.3: prints the version a release tag names,
// once main's own line carries the commit it points at and every manifest that
// carries a version agrees with it. A tag on a commit main never took, or one
// that says a number the manifests do not, fails here before anything is built.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_TAG as TAG } from "./bundles.mjs";
import { versionedManifests } from "./release.mjs";

/** Whether a ref name is a release tag, the one rule for what the workflow answers to. */
export function isReleaseTag(tag) {
  return TAG.test(tag);
}

/** The version a release tag names: v1.2.3 carries 1.2.3. */
export function versionFromTag(tag) {
  const found = TAG.exec(tag);
  if (found === null) throw new Error(`not a release tag: ${tag} (expected v1.2.3)`);
  return found[1];
}

/** Every versioned manifest whose number is not the tag's, each with the number it does carry. */
export function manifestMismatches(repo, version) {
  return versionedManifests(repo)
    .map(file => ({ file: relative(repo, file), version: JSON.parse(readFileSync(file, "utf8")).version }))
    .filter(manifest => manifest.version !== version);
}

/** The commit a tag names, or one sentence saying the tag is not here: git answers a missing ref with a block of
 * its own on stderr, and a refusal is one line. */
function commitOf(git, tag) {
  try {
    return git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]).trim();
  } catch {
    throw new Error(`no tag ${tag} in this checkout; fetch the tag before asking what it names`);
  }
}

/** The commit a release tag points at, and whether the line named by `ref` carries it. First parents only: a
 * commit inside a branch someone merged is reachable from main without main ever having taken it, so the read and
 * the sentence below agree only on the line main walked itself. */
function tagOnLine(repo, tag, ref) {
  const git = args => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = commitOf(git, tag);
  return { commit, on: git(["rev-list", "--first-parent", ref]).split("\n").includes(commit) };
}

/** The version to build, or an error naming the commit off main's line, else the tag's number and each manifest's.
 * The ancestry read comes first, so a tag on a side branch reads that sentence and not a manifest's. */
export function checkTag(repo, tag, ref = "origin/main") {
  const version = versionFromTag(tag);
  const { commit, on } = tagOnLine(repo, tag, ref);
  if (!on) throw new Error(`tag ${tag} points at ${commit}, which is not on main's own line; tag a commit main carries`);
  const wrong = manifestMismatches(repo, version);
  if (wrong.length > 0) {
    const said = wrong.map(manifest => `${manifest.file} says ${manifest.version}`).join(", ");
    throw new Error(`tag ${tag} says ${version}, ${said}: retag the commit that carries ${version}`);
  }
  return version;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(checkTag(fileURLToPath(new URL("../../..", import.meta.url)), process.argv[2] ?? ""));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
