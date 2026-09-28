// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/** Runs every case in a file from a folder of its own. The state a line works on is read off the folder it was
 * typed in, and this repository's own root is a checkout of wsp, so a suite left sitting in it reads every case's
 * stderr with the checkout's note on top and none of them is where a person's line is ever typed. Called first in
 * a file, so the folder is back before the case's own cleanup runs. */
export function runsFromItsOwnFolder(): void {
  let back: string;
  let here: string;
  beforeEach(() => {
    back = process.cwd();
    here = mkdtempSync(join(tmpdir(), "wsp-cwd-"));
    process.chdir(here);
  });
  afterEach(() => {
    process.chdir(back);
    rmSync(here, { recursive: true, force: true });
  });
}
