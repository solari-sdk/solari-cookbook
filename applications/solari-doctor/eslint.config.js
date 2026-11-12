import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Research/verification material and build output are not linted. The
    // scripts/ probes are throwaway evidence-gathering, not deliverable code.
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "scripts/**",
      "ci/**",
      ".venv/**",
      "vitest.config.ts",
      "eslint.config.js",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // design.md §4: checks return CheckResult and never print. Renderers own
      // all output. This makes that architectural rule enforceable rather than
      // aspirational — the renderer files opt back in explicitly.
      "no-console": "error",
    },
  },
  {
    // Renderers are the one layer whose job is writing to stdout/stderr.
    files: ["src/report/**/*.ts", "src/cli.ts"],
    rules: { "no-console": "off" },
  },
  {
    // design.md §4: the diagnosis layer is a pure function of CheckResult[].
    // Its purity is what makes exhaustive combination testing cheap, so it is
    // enforced here rather than left to review — an import of the SDK, node
    // builtins, or any layer that performs I/O fails the build.
    files: ["src/diagnosis/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@solarisdk/*",
                "node:*",
                "fs",
                "path",
                "**/context.js",
                "**/runner/*",
                "**/report/*",
                "**/checks/*",
              ],
              message:
                "The diagnosis layer must stay pure (design.md §4): no SDK, no I/O, " +
                "no dependency on layers that perform it. It may import ../types.js only.",
            },
          ],
        },
      ],
    },
  },
);
