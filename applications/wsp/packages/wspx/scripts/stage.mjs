// SPDX-License-Identifier: AGPL-3.0-only
// Lays out what npm publishes beside dist/bin.js: every shipped asset, copied
// the way its own entry in the host's table says, into the folder the host
// reads it back from. The root LICENSE and README are copied in because npm
// only ever publishes the ones in the package folder.
import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ASSETS_DIR, ASSET_KINDS, stageAssetOrSkip, workspaceAsset } from "@wsp/host";

/** Stages every asset into the package. The daemon binaries come from a cargo build or a release's artifacts, never
 * from this build, so a checkout without them is told so in one line and built without them; the release sets the
 * variable that makes them required. `say` is where that line goes. */
export function stageAssets(paths, env = process.env, say = console.log) {
  for (const [what, path] of [
    ["command bundle", join(paths.pkg, "dist", "bin.js")],
    ["license", join(paths.repo, "LICENSE")],
    ["readme", join(paths.repo, "README.md")],
  ]) {
    if (!existsSync(path)) throw new Error(`${what} missing: ${path}`);
  }

  const assets = join(paths.pkg, ASSETS_DIR);
  rmSync(assets, { recursive: true, force: true });
  for (const kind of ASSET_KINDS) {
    const said = stageAssetOrSkip(paths.from[kind], paths.pkg, kind, env);
    if (said !== undefined) say(said);
  }
  cpSync(join(paths.repo, "LICENSE"), join(paths.pkg, "LICENSE"));
  cpSync(join(paths.repo, "README.md"), join(paths.pkg, "README.md"));
  // npm sets the bin's mode on install; a tarball read any other way still gets an executable file.
  chmodSync(join(paths.pkg, "dist", "bin.js"), 0o755);
  return assets;
}

/** Every path the stage reads, resolved from this package: this folder, the repo, and each asset's source. */
export function stagePaths() {
  const pkg = fileURLToPath(new URL("..", import.meta.url));
  return {
    pkg,
    repo: join(pkg, "..", ".."),
    from: Object.fromEntries(ASSET_KINDS.map(kind => [kind, workspaceAsset(kind)])),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`staged ${stageAssets(stagePaths())}`);
}
