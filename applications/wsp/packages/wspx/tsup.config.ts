// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "tsup";

// One self-contained bundle for npm: the workspace packages and their
// dependencies are all devDependencies here, which tsup inlines, so the
// published package declares none. ws's optional native accelerators are the
// only imports left outside, and ws is CommonJS, so the ESM output needs a
// require of its own, and the two file names CommonJS would have given an
// inlined module are declared beside it.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  target: "node22",
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      'import { dirname as __dirnameOf } from "node:path";',
      'import { fileURLToPath as __pathOf } from "node:url";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __pathOf(import.meta.url);",
      "const __dirname = __dirnameOf(__filename);",
    ].join("\n"),
  },
  clean: true,
});
