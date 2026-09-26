// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "tsup";

// Two self-contained bundles, the window's main and the wsp command the shim
// runs: every workspace package and its deps ride inside, so the packaged app
// carries no pnpm node_modules tree (they are all devDependencies, which tsup
// bundles and electron-builder ignores). Electron itself and ws's optional
// native accelerators stay external.
export default defineConfig([
  {
    entry: { main: "src/main.ts", cli: "src/cli.ts" },
    format: ["esm"],
    outDir: "build/app/main",
    platform: "node",
    target: "node22",
    external: ["electron", "bufferutil", "utf-8-validate"],
    // The host's wsp skill rides in as text, the way its own build inlines it.
    loader: { ".md": "text" },
    outExtension: () => ({ js: ".mjs" }),
    // ws is CommonJS and requires node builtins at load; ESM output has no require of its own.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    clean: true,
  },
  {
    // Sandboxed preloads must be CommonJS.
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    outDir: "build/app/main",
    platform: "node",
    target: "node22",
    external: ["electron"],
    outExtension: () => ({ js: ".cjs" }),
  },
]);
