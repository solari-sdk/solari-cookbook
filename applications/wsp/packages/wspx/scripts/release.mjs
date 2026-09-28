// SPDX-License-Identifier: AGPL-3.0-only
// pnpm release <version|patch|minor|major> [--pack-only]: one version across
// every package that carries one, one build without the desktop bundle, one
// tarball, one publish. Run from a clean checkout of main after the gate.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const VERSION_LINE = /^(\s*"version":\s*")[^"]*(")/m;

/** The version a release argument asks for: a bump of the current one, or an exact version to move to. */
export function nextVersion(current, arg) {
  const now = SEMVER.exec(current);
  if (now === null) throw new Error(`the current version is not semver: ${current}`);
  const [major, minor, patch] = [Number(now[1]), Number(now[2]), Number(now[3])];
  if (arg === "major") return `${major + 1}.0.0`;
  if (arg === "minor") return `${major}.${minor + 1}.0`;
  if (arg === "patch") return `${major}.${minor}.${patch + 1}`;
  const asked = SEMVER.exec(arg);
  if (asked === null) throw new Error(`not a version or a bump: ${arg} (expected major, minor, patch, or 1.2.3)`);
  return arg;
}

/** Every package.json under packages/ and apps/ that declares a version, so one tag means one number everywhere. */
export function versionedManifests(repo) {
  return ["packages", "apps"]
    .flatMap(dir => readdirSync(join(repo, dir), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(repo, dir, e.name, "package.json")))
    .filter(file => existsSync(file) && JSON.parse(readFileSync(file, "utf8")).version !== undefined)
    .sort();
}

/** Rewrites the version in place, keeping the rest of the file's shape and its trailing newline. */
export function setVersion(file, version) {
  const text = readFileSync(file, "utf8");
  if (!VERSION_LINE.test(text)) throw new Error(`${file}: no version line to rewrite`);
  writeFileSync(file, text.replace(VERSION_LINE, `$1${version}$2`));
}

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function release(argv) {
  const pkg = fileURLToPath(new URL("..", import.meta.url));
  const repo = join(pkg, "..", "..");
  const packOnly = argv.includes("--pack-only");
  const [asked] = argv.filter(a => !a.startsWith("--"));
  if (asked === undefined) throw new Error("usage: pnpm release <version|patch|minor|major> [--pack-only]");

  const { name, version: current } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  const version = nextVersion(current, asked);
  // Nothing here commits; the renumbered files are named so a failed build or smoke leaves a trail, not a silently dirty tree.
  console.log(`version ${version}, rewritten in place and left for you to commit:`);
  for (const file of versionedManifests(repo)) {
    setVersion(file, version);
    console.log(`  ${relative(repo, file)}`);
  }

  // The desktop bundle is a release step of its own; the package does not carry it.
  run("pnpm", ["-r", "--filter", "!@wsp/desktop", "build"], repo);
  // Nothing is published that has not been installed from its own tarball and run.
  run("pnpm", ["--filter", name, "smoke"], repo);

  const out = mkdtempSync(join(tmpdir(), "wsp-release-"));
  run("npm", ["pack", "--pack-destination", out], pkg);
  const packed = readdirSync(out).find(f => f.endsWith(".tgz"));
  if (packed === undefined) throw new Error(`npm pack left no tarball in ${out}`);
  const tarball = join(out, packed);
  console.log(`packed ${tarball}`);

  if (packOnly) return tarball;
  run("npm", ["publish", tarball], pkg);
  console.log(`published ${name} ${version}`);
  return tarball;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    release(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
