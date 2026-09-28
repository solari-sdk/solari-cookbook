// SPDX-License-Identifier: AGPL-3.0-only
// node scripts/latest-flag.mjs v1.2.3 v1.2.2: prints the flags `gh release edit`
// takes for the release being published, against the tag GitHub serves as latest
// today, which is empty when it serves none. Latest is what the stable download
// names point at and what the site links, so a tag carrying a lower number or a
// prerelease part is published without moving them.
import { pathToFileURL } from "node:url";
import { compareVersions } from "../../protocol/src/semver.mjs";
import { versionFromTag } from "./tag-version.mjs";

/** The flags for a release tag against the one served as latest. Equal reads as latest, since a rerun of the
 * publish job meets its own tag and demoting the release it just published is not what a rerun means. */
export function latestFlag(tag, current) {
  const version = versionFromTag(tag);
  // The tag shape allows a hyphen only where the prerelease identifiers begin, so one there is what it is.
  if (version.includes("-")) return "--latest=false --prerelease";
  if (current.trim() === "") return "--latest";
  return compareVersions(version, versionFromTag(current.trim())) >= 0 ? "--latest" : "--latest=false";
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(latestFlag(process.argv[2] ?? "", process.argv[3] ?? ""));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
