// SPDX-License-Identifier: AGPL-3.0-only
// electron-builder calls this once per packaged tree. Electron's own signature
// does not cover the staged resources, and Gatekeeper opens a quarantined
// download of that as damaged; the daemon binaries among the assets are Mach-O
// files a deep sign of the app leaves out, so they are signed here and the app
// after them. electron-builder signs after this hook when the keychain holds an
// identity, replacing all this.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_TARGETS, daemonBinaryIn, stagedAsset } from "@wsp/host";
import { MAC_TARGETS } from "./targets.mjs";

/** The tree a universal build packs one arch into before merging: electron-builder names it
 * `${appOutDir}-${arch}-temp`, and the archs are the ones the mac bundle is merged from. */
const TEMP_TREE = new RegExp(`-(?:${MAC_TARGETS.map(target => target.split("-")[1]).join("|")})-temp$`);

export default function afterPack(context) {
  // A universal build packs each arch into its own temp tree, merges the two and calls this again on the merged
  // bundle. Only the merged one ships, and a signature on an arch tree leaves a _CodeSignature the merge refuses,
  // so the temp trees are left unsigned; electron-builder skips them for the same reason.
  if (context.electronPlatformName !== "darwin" || TEMP_TREE.test(context.appOutDir)) return;
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const entitlements = join(context.packager.projectDir, context.packager.platformSpecificBuildOptions.entitlements);
  const sign = (file, ...more) => execFileSync("codesign", ["--force", ...more, "--options", "runtime", "--entitlements", entitlements, "--sign", "-", file], { stdio: "inherit" });
  // The Mach-O daemons alone: the Linux ones beside them are what the app deploys to forks, and codesign has no
  // business with an ELF file.
  const daemons = stagedAsset(join(resources, "app"), "daemon");
  for (const target of DAEMON_TARGETS.filter(t => t.platform === "darwin")) {
    const bin = daemonBinaryIn(daemons, target.triple);
    if (existsSync(bin)) sign(bin);
  }
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  sign(app, "--deep");
  console.log(`re-signed ${app} ad hoc`);
}
