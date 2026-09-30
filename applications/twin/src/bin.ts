#!/usr/bin/env node
// Checks the Node version before loading anything: on an older Node the real entry point would
// fail with a syntax error about a missing export instead of saying what is wrong.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(
    `twin needs Node 22 or newer; this is Node ${process.versions.node}. Install a newer Node, then run twin again.\n`,
  );
  process.exit(1);
}
await import('./main.ts');
