// SPDX-License-Identifier: AGPL-3.0-only
// A sha256sum for the scripts these tests run through a real shell. The one
// reading of a file's bytes both platforms answer the same way: BSD carries no
// sha256sum on every release and GNU has no shasum everywhere, and node is
// what is running the test. It answers the flags the runs under test use, as
// coreutils 9.4 answers them: `-z` ends each record with a NUL instead of a
// newline and leaves the path as it is, `--` ends the flags, a path that is
// not there is said on stderr and the rest are still read, and the exit is
// non-zero once any of them was missing.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READ = [
  'const {createHash}=require("crypto");const fs=require("fs");',
  'const hash=b=>createHash("sha256").update(b).digest("hex");',
  'let zero=false;let flags=true;const files=[];',
  'for(const a of process.argv.slice(1)){',
  'if(flags&&a==="--"){flags=false;continue}',
  'if(flags&&(a==="-z"||a==="--zero")){zero=true;continue}',
  "files.push(a)}",
  'const end=zero?"\\0":"\\n";let missing=false;',
  'if(files.length===0){process.stdout.write(hash(fs.readFileSync(0))+"  -"+end);process.exit(0)}',
  "for(const f of files){",
  'try{process.stdout.write(hash(fs.readFileSync(f))+"  "+f+end)}',
  'catch{missing=true;process.stderr.write("sha256sum: "+f+": No such file or directory\\n")}}',
  "process.exit(missing?1:0)",
].join("");

// The program is single-quoted for the shell and holds no quote of that kind; the flags come after `--` so node
// reads them as the program's arguments rather than its own.
const SHA256SUM = ["#!/bin/sh", `exec ${JSON.stringify(process.execPath)} -e '${READ}' -- "$@"`, ""].join("\n");

/** A fresh directory holding that one program, for a PATH a script under test is run with. The caller removes it. */
export function sha256sumBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "wsp-sha256sum-"));
  writeFileSync(join(bin, "sha256sum"), SHA256SUM);
  chmodSync(join(bin, "sha256sum"), 0o755);
  return bin;
}
