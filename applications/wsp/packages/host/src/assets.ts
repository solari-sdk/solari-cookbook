// SPDX-License-Identifier: AGPL-3.0-only
// The one table of shipped assets: the built web app the host serves, the
// wsp-daemon binaries a machine gets, and the wsp command that rides beside
// them. Each entry says what to call it, where a packed command stages it, the
// file that proves it was built and fully copied, where it comes from in a
// checkout, and how it is copied there. npm drops node_modules from a
// published tarball, so the packed road is the only one the published command
// has; adding an asset is one entry here and nothing else.
import { WEB_DIR_ENV } from "@wsp/protocol";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_BIN, daemonBinaryIn, daemonTargetHere, noDaemonBuildLine } from "./daemon-binary.js";

export const ASSET_KINDS = ["web", "daemon", "cli"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** The folder a packed command stages its assets into, one level above the bundle. */
export const ASSETS_DIR = "assets";

interface Asset {
  /** What a message about it says. */
  name: string;
  /** Its folder under ASSETS_DIR. */
  dir: string;
  /** The file inside it whose absence means it was never built, or the copy never finished. */
  proof: string;
  /** Whether a stage outside the release may go on without it: a folder no node build fills is skipped with a line
   * where it is missing, and required only where the release stages the package with it in place. */
  optional?: true;
  /** Where it comes from in a checkout. */
  workspace(): string;
  /** Copies it, the folder it was built in to the folder a packed command reads. */
  stage(from: string, to: string): void;
}

const resolveHere = (specifier: string): string => createRequire(import.meta.url).resolve(specifier);

/** The binary this computer runs, which is the one file every daemon folder must hold for the host on it to serve
 * its own workspace; a release folder holds every target's. On a platform wsp builds no daemon for the proof is a
 * file no build makes, so the stage refuses there and says why. */
const daemonProof = (): string => {
  const here = daemonTargetHere();
  return here === undefined ? DAEMON_BIN : join(here.triple, DAEMON_BIN);
};

const ASSETS: Record<AssetKind, Asset> = {
  web: {
    name: "web app",
    dir: "web",
    proof: "index.html",
    workspace: () => join(dirname(resolveHere("@wsp/web/package.json")), "dist"),
    stage: (from, to) => cpSync(from, to, { recursive: true }),
  },
  cli: {
    name: "wsp command bundle",
    dir: "cli",
    proof: "dist/bin.js",
    // The published command's own package, which carries every workspace package inside its build: not this
    // package's dist/bin.js, which leaves its imports outside and would need the whole tree beside it on a machine
    // that has none. It travels as npm lays it out, package.json beside dist, since the bin reads its version through
    // that file and announces it in every MCP handshake; dist travels whole because the build is split across chunk
    // files bin.js imports by name.
    workspace: () => join(here(), "..", "..", "wspx"),
    stage: packaged,
  },
  daemon: {
    name: "wsp-daemon binary",
    dir: "daemon",
    proof: daemonProof(),
    // One folder per target triple, each holding the binary the release built for it. In a checkout the folder is
    // filled by packages/wspx/scripts/daemon-binary.mjs out of a cargo build, since nothing in a node build makes it.
    workspace: () => join(here(), "..", "..", "wspx", "daemon"),
    stage: (from, to) => cpSync(from, to, { recursive: true }),
    optional: true,
  },
};

/** Set to 1 where the release stages the package with every daemon binary placed, so a missing one fails the build
 * there and nowhere else. */
export const REQUIRE_DAEMON_ENV = "WSP_REQUIRE_DAEMON";

/** A package as npm installs it and nothing else: its package.json and its dist, out of a folder that in a checkout
 * also holds sources, tests and a node_modules. */
function packaged(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const part of ["package.json", "dist"]) cpSync(join(from, part), join(to, part), { recursive: true });
}

/** What a message about an asset calls it, so a folder that was never built is named the same wherever it is read. */
export function assetName(kind: AssetKind): string {
  return ASSETS[kind].name;
}

/** The file inside an asset that proves it was built and fully copied. */
export function assetProof(kind: AssetKind): string {
  return ASSETS[kind].proof;
}

/** Where a packed command stages an asset under its package root; what a stage script writes and this file reads. */
export function stagedAsset(packageRoot: string, kind: AssetKind): string {
  return join(packageRoot, ASSETS_DIR, ASSETS[kind].dir);
}

/** Copies an asset out of `from` into the packed layout, refusing a source that was never built. Returns where it went. */
export function stageAsset(from: string, packageRoot: string, kind: AssetKind): string {
  const to = stagedAsset(packageRoot, kind);
  copyAsset(kind, from, to);
  return to;
}

/** Stages an asset as stageAsset does, except an optional one whose source was never filled: outside the release
 * it is skipped, and the line answered says so and names the file that would have proved it, so a checkout builds
 * the command without a daemon binary and a person reads why the command carries none. Nothing where the asset
 * was staged. */
export function stageAssetOrSkip(from: string, packageRoot: string, kind: AssetKind, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const asset = ASSETS[kind];
  const proof = join(from, asset.proof);
  if (asset.optional === true && env[REQUIRE_DAEMON_ENV] !== "1" && !existsSync(proof)) {
    return `${asset.name} not staged: ${proof} is missing, so the command carries none; packages/wspx/scripts/daemon-binary.mjs places one`;
  }
  stageAsset(from, packageRoot, kind);
  return undefined;
}

/** Copies an asset the way its own entry says, wherever it is going: the packed layout, or a bundle a machine gets.
 * Refuses a source that was never built, named in the words the table gives the asset. */
export function copyAsset(kind: AssetKind, from: string, to: string): void {
  const asset = ASSETS[kind];
  const proof = join(from, asset.proof);
  if (!existsSync(proof)) throw new Error(`${asset.name} missing: ${proof}`);
  asset.stage(from, to);
}

/** The staged asset for a bundle running out of `fromDir`, or nothing when this is not a packed command or the copy never finished. */
export function packedAsset(fromDir: string, kind: AssetKind): string | undefined {
  const dir = stagedAsset(join(fromDir, ".."), kind);
  return existsSync(join(dir, ASSETS[kind].proof)) ? dir : undefined;
}

/** Where an asset comes from in a checkout: the workspace package that builds it. Stage scripts read it from here. */
export function workspaceAsset(kind: AssetKind): string {
  return ASSETS[kind].workspace();
}

function here(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** An asset for whoever is running: staged beside a packed bundle, else built in this checkout. */
export function assetDir(kind: AssetKind, fromDir: string = here()): string {
  return packedAsset(fromDir, kind) ?? workspaceAsset(kind);
}

/** The daemon this computer runs, for its own workspace and as a place: this machine's target out of the daemon
 * asset. Refused with the platform's name where wsp builds none, and with the path where the file is not there. */
export function daemonBinaryHere(fromDir?: string): string {
  const target = daemonTargetHere();
  if (target === undefined) throw new Error(noDaemonBuildLine(process.platform, process.arch));
  const bin = daemonBinaryIn(assetDir("daemon", fromDir), target.triple);
  if (!existsSync(bin)) throw new Error(`${ASSETS.daemon.name} missing: ${bin}`);
  return bin;
}

/** The folder a host serves the app out of: the one a harness named in the environment, else the asset built or
 * staged beside this command. A harness serves a copy of the app so a build landing while a tester drives it cannot
 * change the page under them. */
export function webDirFor(env: Readonly<Record<string, string | undefined>> = process.env, fromDir?: string): string {
  const said = env[WEB_DIR_ENV];
  return said !== undefined && said !== "" ? said : assetDir("web", fromDir);
}
