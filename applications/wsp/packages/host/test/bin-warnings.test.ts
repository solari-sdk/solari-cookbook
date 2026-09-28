// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { BIN, describeWithBin } from "./built-bin.js";

/** Runs inside the bin's process after the verb, the way the engine's lazy node:sqlite load does. */
const WARN_AT_EXIT =
  "data:text/javascript," +
  encodeURIComponent(
    `process.once("beforeExit", () => {
      process.getBuiltinModule("node:sqlite");
      process.emitWarning("an old thing", "DeprecationWarning");
      process.emitWarning("another new thing", "ExperimentalWarning");
    });`,
  );

describeWithBin("the wsp bin and node's warnings", () => {
  it("drops node:sqlite's ExperimentalWarning and prints every other warning", async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", WARN_AT_EXIT, BIN, "--version"]);
    expect(stdout).toMatch(/^wsp \d/);
    expect(stderr).not.toContain("SQLite");
    expect(stderr).toContain("DeprecationWarning: an old thing");
    expect(stderr).toContain("ExperimentalWarning: another new thing");
  });
});
