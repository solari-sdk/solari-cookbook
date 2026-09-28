// SPDX-License-Identifier: AGPL-3.0-only
// node scripts/release-notes.mjs v1.2.3 [--signed]: the notes for that tag's
// draft release, from the commits since the tag before it plus the README's
// lines on opening a downloaded bundle. Prints markdown; writes nothing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The version order lives with the app that also reads it; this job runs before any install, so the file is
// imported where it sits rather than through the package it belongs to.
import { compareVersions } from "../../protocol/src/semver.mjs";
import { bundleNames } from "./bundles.mjs";
import { isReleaseTag, versionFromTag } from "./tag-version.mjs";

// The README owns this text so the page a stranger reads and the notes they get
// with the download cannot drift apart; the markers are how it is lifted out.
const BUNDLES = /<!-- bundles:start -->\n([\s\S]*?)<!-- bundles:end -->/;
// A release that renames things says what moved once, in the README, where a stranger reading the page and a person
// reading the notes get the same words. The block is deleted at the release after the one that wrote it.
const RENAMES = /<!-- renames:start -->\n([\s\S]*?)<!-- renames:end -->/;
const UNSIGNED = /<!-- unsigned:start -->\n([\s\S]*?)<!-- unsigned:end -->\n?/;
const RENUMBER = /^chore: v\d/;
// The name on npm has one home, the manifest of the package that is published under it.
const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name;

/** The release tag below this one, which is where the change list starts. */
export function previousTag(tags, tag) {
  const version = versionFromTag(tag);
  const below = tags
    .map(t => t.trim())
    .filter(t => isReleaseTag(t))
    .map(t => versionFromTag(t))
    .filter(v => compareVersions(v, version) < 0)
    .sort(compareVersions);
  const last = below.at(-1);
  return last === undefined ? undefined : `v${last}`;
}

/** The commit subjects worth reading, once each. The renumbering commit is the release itself. */
export function changeLines(subjects) {
  const kept = [];
  for (const subject of subjects) {
    const line = subject.trim();
    if (line.length === 0 || RENUMBER.test(line) || kept.includes(line)) continue;
    kept.push(line);
  }
  return kept;
}

/** The README's lines on opening a downloaded bundle, so the notes say what the page says. The paragraph on unsigned
 * bundles, marked on its own inside them, is left out once an identity signs the bundles; the README keeps it until
 * the person deletes it. */
export function bundleNote(readme, signed) {
  const found = BUNDLES.exec(readme);
  if (found === null) throw new Error("README.md has no bundles:start and bundles:end markers to read the download lines from");
  return found[1]
    .replace(UNSIGNED, (_, paragraph) => (signed ? "" : paragraph))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The README's block on what this release renamed, or nothing when it has none: the notes are built from commit
 * subjects, and a table of renames does not fit one. */
export function renameNote(readme) {
  const found = RENAMES.exec(readme);
  return found === null ? undefined : found[1].trim();
}

/** The command line: the tag, and --signed when an identity signs the bundles the notes describe. */
export function cliArgs(argv) {
  return { tag: argv.find(arg => arg !== "--signed") ?? "", signed: argv.includes("--signed") };
}

/**
 * @param {{ version: string, previous?: string, changes: string[], bundles: string, renames?: string }} notes
 */
export function releaseNotes({ version, previous, changes, bundles, renames }) {
  const names = bundleNames(version);
  return [
    previous === undefined ? "## What changed" : `## What changed since ${previous}`,
    "",
    ...(renames === undefined ? [] : [renames, ""]),
    ...(changes.length > 0 ? changes.map(line => `- ${line}`) : ["- The first release."]),
    "",
    "## Downloads",
    "",
    `- \`${names.mac}\`: macOS on Apple silicon and on Intel, one disk image for both.`,
    `- \`${names.appImage}\`: Linux on x64.`,
    `- The command line: \`npm i -g ${PACKAGE}@${version}\`.`,
    "",
    bundles,
    "",
  ].join("\n");
}

function notesFor(repo, tag, signed) {
  const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const previous = previousTag(git(["tag", "--list", "v*"]).split("\n"), tag);
  const subjects = previous === undefined ? [] : git(["log", "--no-merges", "--pretty=format:%s", `${previous}..${tag}`]).split("\n");
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  const renames = renameNote(readme);
  return releaseNotes({
    version: versionFromTag(tag),
    previous,
    changes: changeLines(subjects),
    bundles: bundleNote(readme, signed),
    ...(renames === undefined ? {} : { renames }),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { tag, signed } = cliArgs(process.argv.slice(2));
    process.stdout.write(notesFor(fileURLToPath(new URL("../../..", import.meta.url)), tag, signed));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
