// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { TEST_ENV } from "../../vitest.env.js";

const pkg = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  // The browser cannot follow a package.json main into a dist a fresh worktree may not have.
  resolve: command === "serve" ? { alias: { "@wsp/protocol": pkg("protocol/src/index.ts"), "@wsp/catalog": pkg("catalog/src/index.ts") } } : {},
  // noVNC's H.264 decoder module uses top-level await, which vite's default
  // es2020 target rejects. build.target covers only the production bundle;
  // the dev dependency prescan has its own esbuild target and needs the same.
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  // @pierre/diffs' highlighter worker loads its wasm engine with a dynamic
  // import, which Vite 5's default iife worker format cannot bundle.
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    env: TEST_ENV,
    // A budget, not a retry: the slowest case here runs half a second idle, and a gate at load average 135
    // stretched cases of 0.05 to 0.2 s to 5 to 8 s. 20 s is 40 times the slowest idle case, 2.5 times that stretch.
    testTimeout: 20_000,
    // Test-only: terminal tests drive the real in-process daemon through the
    // reach client, source-aliased like the root workspace's node project.
    alias: {
      "@wsp/engine": pkg("engine/src/index.ts"),
      "@wsp/adapter-claude": pkg("adapter-claude/src/index.ts"),
      "@wsp/adapter-codex": pkg("adapter-codex/src/index.ts"),
      "@wsp/protocol": pkg("protocol/src/index.ts"),
      "@wsp/runtime": pkg("runtime/src/index.ts"),
      "@wsp/catalog": pkg("catalog/src/index.ts"),
    },
  },
}));
