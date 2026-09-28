// SPDX-License-Identifier: AGPL-3.0-only
// Prints the src/release-pins.ts entry for one repository at one release tag:
// the Linux asset the release road picks for each arch, downloaded here once
// and hashed, so the sum in the catalog is read before any machine runs the
// bytes. Names the release's own checksums file when it carries one, to read
// the two against each other.
//
//   node packages/catalog/scripts/pin-release.mjs <owner/repo> <tag> [x86_64=<asset>] [aarch64=<asset>]
//
// An arch whose pick is not the build the catalog wants names its asset.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The built package, so the pick below is the catalog's own and not a copy of it: build the catalog before running this.
import { ASSET_ARCH, ASSET_SKIPPED } from "../dist/index.js";

const [repo, tag] = process.argv.slice(2);
const named = Object.fromEntries(process.argv.slice(4).map(a => a.split("=")));
if (repo === undefined || tag === undefined) {
  console.error("usage: node pin-release.mjs <owner/repo> <tag> [x86_64=<asset>] [aarch64=<asset>]");
  process.exit(3);
}

// The pick the release road makes on the machine, off the road's own two patterns: a Linux asset for the arch,
// skipping what is never the build, first match wins.
const ARCH_PATTERNS = Object.fromEntries(Object.entries(ASSET_ARCH).map(([arch, pat]) => [arch, new RegExp(pat, "i")]));
const SKIPPED = new RegExp(ASSET_SKIPPED, "i");
const CHECKSUMS = /(checksums?|sha256sums?)/i;

const release = JSON.parse(execFileSync("gh", ["api", `repos/${repo}/releases/tags/${tag}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const urls = release.assets.map(a => a.browser_download_url);

const dir = mkdtempSync(join(tmpdir(), "wsp-pin-"));
const entries = [];
try {
  for (const [arch, pattern] of Object.entries(ARCH_PATTERNS)) {
    const url = named[arch] === undefined ? urls.find(u => /linux/i.test(u) && pattern.test(u) && !SKIPPED.test(u)) : urls.find(u => u.endsWith(`/${named[arch]}`));
    if (url === undefined) {
      console.error(`${repo} ${tag}: no Linux ${arch} asset`);
      continue;
    }
    const name = url.slice(url.lastIndexOf("/") + 1);
    const file = join(dir, name);
    execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "-o", file, url], { stdio: ["ignore", "ignore", "inherit"] });
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    entries.push(`${arch}: { name: ${JSON.stringify(name)}, sha256: ${JSON.stringify(sha256)} }`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const sums = urls.filter(u => CHECKSUMS.test(u.slice(u.lastIndexOf("/") + 1)));
console.log(`  // https://github.com/${repo}/releases/tag/${tag}${sums.length > 0 ? `, sums published at ${sums.join(" and ")}` : ""}`);
console.log(`  ${JSON.stringify(repo)}: { tag: ${JSON.stringify(tag)}, assets: { ${entries.join(", ")} } },`);
