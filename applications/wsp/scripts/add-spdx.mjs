// SPDX-License-Identifier: AGPL-3.0-only
// Adds the SPDX header to source files. With file args it processes those;
// with none it processes every .ts/.mjs file added on this branch vs main.
// Idempotent: files that already carry a header are left alone.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const HEADER = "// SPDX-License-Identifier: AGPL-3.0-only";

function newFilesOnBranch() {
  const base = execFileSync("git", ["merge-base", "main", "HEAD"], { encoding: "utf8" }).trim();
  const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", `${base}..HEAD`], {
    encoding: "utf8",
  });
  return out.split("\n").filter(f => /\.(ts|mjs)$/.test(f));
}

// What daemon/scripts/ts-types.sh writes is the crate's output and carries no header of its own.
const GENERATED = "packages/protocol/src/generated/";
const files = (process.argv.length > 2 ? process.argv.slice(2) : newFilesOnBranch()).filter(f => !f.replace(/^\.\//, "").startsWith(GENERATED));
let added = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (text.includes(HEADER)) continue;
  const lines = text.split("\n");
  const insertAt = lines[0]?.startsWith("#!") ? 1 : 0;
  lines.splice(insertAt, 0, HEADER);
  writeFileSync(file, lines.join("\n"));
  added++;
  console.log(`spdx: ${file}`);
}
console.log(`spdx: ${added} header(s) added, ${files.length - added} already present`);
