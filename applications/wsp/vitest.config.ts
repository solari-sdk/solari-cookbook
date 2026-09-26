import { defineConfig } from "vitest/config";

// Live tests create real machines under a two-machine cap, so files run one at
// a time. The worker pool reads this from the root config only; the same line
// on a workspace project is ignored and the files run in parallel.
export default defineConfig({
  test: { fileParallelism: process.env.WSP_LIVE !== "1" },
});
