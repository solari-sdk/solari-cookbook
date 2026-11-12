import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],

    // design.md §10/§11: unit tests never touch live Solari services. The live
    // integration run is a separate, manually triggered workflow — it must not
    // be reachable from `npm test`.
    exclude: ["node_modules/**", "dist/**", "scripts/**", ".venv/**"],

    environment: "node",
    restoreMocks: true,
  },
});
