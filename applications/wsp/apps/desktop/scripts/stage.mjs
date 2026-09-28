// SPDX-License-Identifier: AGPL-3.0-only
// Lays out build/app, the directory electron-builder packages: the bundled
// main, command and preload, the onboarding page, every shipped asset in the
// host's own packed layout (build/app/assets, one folder up from the bundles,
// where the host's asset table reads them back from for the window and for
// the wsp command alike). Nothing native rides beside the bundles: the daemon
// is a static binary among the assets.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeGlyphs } from "./glyphs.mjs";

// The table of shipped assets lives in @wsp/host's build output, and build:app
// runs on its own from `start`, so a tree that has not built it is named here
// instead of in a resolver stack trace.
const { ASSETS_DIR, ASSET_KINDS, stageAssetOrSkip, workspaceAsset } = await import("@wsp/host").catch(e => {
  if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
  throw new Error("@wsp/host is not built: run pnpm --filter @wsp/desktop build:deps first");
});

const root = fileURLToPath(new URL("..", import.meta.url));
const app = join(root, "build", "app");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!existsSync(join(app, "main", "main.mjs"))) throw new Error(`main bundle not built: ${join(app, "main", "main.mjs")} is missing`);
if (!existsSync(join(app, "main", "cli.mjs"))) throw new Error(`command bundle not built: ${join(app, "main", "cli.mjs")} is missing`);

rmSync(join(app, ASSETS_DIR), { recursive: true, force: true });
for (const kind of ASSET_KINDS) {
  const said = stageAssetOrSkip(workspaceAsset(kind), app, kind);
  if (said !== undefined) console.log(said);
}

// The onboarding page draws with the web app's own stylesheet, whose built name carries a hash, so the page is
// written with that name.
const webAssets = join(app, ASSETS_DIR, "web", "assets");
const webCss = readdirSync(webAssets).find(f => /^index-.*\.css$/.test(f));
if (webCss === undefined) throw new Error(`web stylesheet not found under ${webAssets}`);
const page = readFileSync(join(root, "src", "onboarding.html"), "utf8");
if (!page.includes("__WEB_CSS__")) throw new Error("onboarding.html has no __WEB_CSS__ to write the stylesheet into");
if (!page.includes("__AGENT_GLYPHS__")) throw new Error("onboarding.html has no __AGENT_GLYPHS__ to write the agents' glyphs into");
// The agents screen masks each agent's glyph out of its catalog mark, written beside the page.
const glyphIds = writeGlyphs(join(app, "main", "agents"));
writeFileSync(
  join(app, "main", "onboarding.html"),
  page.replace("__WEB_CSS__", `../${ASSETS_DIR}/web/assets/${webCss}`).replace("__AGENT_GLYPHS__", JSON.stringify(glyphIds)),
);

rmSync(join(app, "node_modules"), { recursive: true, force: true });

writeFileSync(
  join(app, "package.json"),
  `${JSON.stringify(
    {
      name: "wsp",
      productName: "wsp",
      version: pkg.version,
      private: true,
      type: "module",
      main: "main/main.mjs",
      license: pkg.license,
    },
    null,
    2,
  )}\n`,
);
console.log(`staged ${app}`);
