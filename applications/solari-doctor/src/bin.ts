#!/usr/bin/env node
/**
 * Executable wrapper.
 *
 * Kept separate from `cli.ts` so the CLI can be imported and tested without a
 * shebang or a side effect at import time. Sets `process.exitCode` rather than
 * calling `process.exit`, so buffered stdout is flushed before the process ends.
 */

import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`solari-doctor: ${String(error)}\n`);
    process.exitCode = 2;
  },
);
