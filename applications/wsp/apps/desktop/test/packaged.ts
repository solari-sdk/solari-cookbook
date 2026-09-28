// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonBinaryIn, DAEMON_TARGETS, stagedAsset, workspaceAsset } from "@wsp/host";
import { hostTarget, MAC_TARGETS } from "../scripts/targets.mjs";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

export interface PackagedTree {
  /** The platform-arch pairs the tree's app runs, in node's own words. The mac tree is universal and runs both. */
  targets: readonly string[];
  /** The tree electron-builder leaves under dist, and the paths inside it. */
  dir: string;
  executable: string;
  resources: string;
}

/** Every tree electron-builder's targets leave behind, from one place: the targets a tree runs decide which native
 * builds have to be in it, and which of them this machine can launch. */
export const PACKAGED_TREES: readonly PackagedTree[] = [
  { targets: MAC_TARGETS, dir: "mac-universal", executable: join("wsp.app", "Contents", "MacOS", "wsp"), resources: join("wsp.app", "Contents", "Resources") },
  { targets: ["linux-x64"], dir: "linux-unpacked", executable: "wsp", resources: "resources" },
];

/** The trees a build left on disk. */
export function packaged(): PackagedTree[] {
  return PACKAGED_TREES.filter(tree => existsSync(join(dist, tree.dir)));
}

/** The tree this machine runs, built or not. */
export function treeHere(): PackagedTree | undefined {
  return PACKAGED_TREES.find(tree => tree.targets.includes(hostTarget()));
}

/** The executable a build left for this machine: the tree this machine runs, or on a Mac the one-chip tree a plain
 * `electron-builder --mac --dir` writes instead, which electron-builder names mac on Intel and mac-arm64 on Apple
 * silicon. The first of them on disk, else the tree's own path. */
export function builtExecutableHere(): string | undefined {
  const tree = treeHere();
  if (tree === undefined) return undefined;
  const oneChip = process.platform === "darwin" ? [process.arch === "x64" ? "mac" : `mac-${process.arch}`] : [];
  return [tree.dir, ...oneChip].map(dir => join(dist, dir, tree.executable)).find(path => existsSync(path)) ?? executableIn(tree);
}

export function executableIn(tree: PackagedTree): string {
  return join(dist, tree.dir, tree.executable);
}

export function resourcesIn(tree: PackagedTree): string {
  return join(dist, tree.dir, tree.resources);
}

/** The triple the host's table gives a target's platform and chip, which names the daemon's folder wherever one
 * is kept. */
function tripleFor(target: string): string {
  const [platform, arch] = target.split("-");
  const row = DAEMON_TARGETS.find(t => t.platform === platform && t.arch === arch);
  if (row === undefined) throw new Error(`wsp builds no daemon for ${target}`);
  return row.triple;
}

/** Where a tree carries the daemon binary for one of the targets it runs: among the staged assets, under the
 * triple the host's table gives that platform and chip. */
export function daemonIn(tree: PackagedTree, target: string): string {
  return daemonBinaryIn(stagedAsset(join(resourcesIn(tree), "app"), "daemon"), tripleFor(target));
}

/** Where this checkout keeps a target's daemon binary, which a build stages into the bundle. Nothing in a node
 * build makes one: packages/wspx/scripts/daemon-binary.mjs places each, out of a cargo build or out of the release
 * job's artifacts, so a checkout holds only the slices somebody put there. */
export function daemonSourceFor(target: string): string {
  return daemonBinaryIn(workspaceAsset("daemon"), tripleFor(target));
}
