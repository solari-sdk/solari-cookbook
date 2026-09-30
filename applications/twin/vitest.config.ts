import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The end-to-end capture tests spawn real probes (git, node, package managers); a cold CI
    // runner needs more than vitest's 5 s default.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process glue only; everything behind it is tested through injected fakes.
      exclude: ['src/bin.ts', 'src/io.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
