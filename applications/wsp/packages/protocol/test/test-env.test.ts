// SPDX-License-Identifier: AGPL-3.0-only
// A test says the environment it means. Reading a wsp variable off the process
// that happens to be running the suite makes the result depend on the shell
// that started it: every builder on one computer with WSP_LABS or WSP_TURN
// exported saw unrelated cases fail. So a test hands the environment it means
// into the code under test, and the only wsp variables a test may read off its
// own process are the gates that decide whether the file runs at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import { ROOT, testFiles } from "./source-files.js";
import { TEST_ENV } from "../../../vitest.env.js";

/** The gates a person throws to turn a suite on, each read once to decide whether its file runs. Nothing else: a
 * variable that changes what the code under test does is handed in, never read off the process running the suite. */
const GATES: Record<string, string> = {
  WSP_LIVE: "runs the tests that create real machines",
  WSP_LIVE_LONG: "runs the live tests that take hours",
  WSP_LIVE_STATE: "the state file the live tests read their golden from",
  WSP_GOLDEN: "the golden the live tests build on instead of the state file's",
  WSP_RUNTIME_LIVE: "runs the tests that drive the workspace runtime on this computer, which take root and cgroup v2",
  WSP_RENDER: "runs the Chromium render tests",
  WSP_PACK_SMOKE: "runs the npm pack smoke",
  WSP_DESKTOP_SMOKE: "runs the packaged desktop smoke",
  WSP_DESKTOP_APP: "the packaged app the desktop smoke drives instead of the built one",
  WSP_DAEMON_BIN: "the daemon binary the daemon suite drives instead of the daemon in its own process",
  WSP_SIGNED: "says a Developer ID signed the bundles the release runner built, which the certificate itself never reaches a test to say",
};

/** Every WSP_ variable the protocol names, by the constant it is exported as, so a read written as
 * process.env[TURN_TOKEN_ENV] is caught as the read of WSP_TURN that it is. */
function namedConstants(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(protocol)) {
    if (typeof value === "string" && value.startsWith("WSP_")) out[name] = value;
  }
  return out;
}

/** Every wsp variable this file reads off process.env, whether spelled out or reached through a constant. */
function wspReads(text: string, constants: Record<string, string>): string[] {
  const found: string[] = [];
  const reads = /process\.env(?:\.([A-Za-z_]\w*)|\[\s*["']([^"']+)["']\s*\]|\[\s*([A-Za-z_]\w*)\s*\])/g;
  for (const [, dotted, quoted, through] of text.matchAll(reads)) {
    const name = dotted ?? quoted ?? (through === undefined ? undefined : constants[through]);
    if (name !== undefined && name.startsWith("WSP_")) found.push(name);
  }
  return found;
}

describe("a test reads no wsp variable off the process running it", () => {
  const constants = namedConstants();
  // This file holds the samples that show what the grep catches, so it is the one test file the grep skips.
  const read = testFiles()
    .filter(rel => !rel.endsWith("test-env.test.ts"))
    .map(rel => ({ rel, names: wspReads(readFileSync(join(ROOT, rel), "utf8"), constants) }));

  it("names the two variables that broke this, so the grep cannot go blind", () => {
    expect(constants["LABS_ENV"]).toBe("WSP_LABS");
    expect(constants["TURN_TOKEN_ENV"]).toBe("WSP_TURN");
    expect(wspReads('process.env[TURN_TOKEN_ENV]\nprocess.env.WSP_LABS\nprocess.env["WSP_TURN"]', constants)).toEqual(["WSP_TURN", "WSP_LABS", "WSP_TURN"]);
    // Naming the variable is what this catches. A spread, an alias, a destructuring or a computed key reaches the
    // same value and is not a finding here on purpose: a spread of process.env into a child's environment is
    // legitimate and already used, and the belt in vitest.env.ts is what makes those spellings read nothing.
    expect(wspReads('vi.stubEnv(LABS_ENV, "1")\nconst env = { ...process.env }\nconst { WSP_LABS: labs } = process.env', constants)).toEqual([]);
  });

  it("opens the cases beside the source as well as the ones under a test folder", () => {
    const files = testFiles();
    expect(files).toContain("apps/web/src/composer-logic.test.ts");
    expect(files.filter(f => f.startsWith("apps/web/src/")).length).toBeGreaterThan(50);
    expect(files).toContain("packages/host/test/verbs.test.ts");
    // Fixtures too, which are where a read is hardest to see.
    expect(files).toContain("apps/web/test/render-browser.ts");
    expect(files.filter(f => !/\.tsx?$/.test(f))).toEqual([]);
  });

  it("reads nothing but the gates", () => {
    const offending = read.flatMap(f => f.names.filter(n => !(n in GATES)).map(n => `${f.rel}: ${n}`));
    expect(offending).toEqual([]);
  });

  it("has no gate in the list nothing gates any more", () => {
    const everyRead = new Set(read.flatMap(f => f.names));
    expect(Object.keys(GATES).filter(n => !everyRead.has(n))).toEqual([]);
  });
});

describe("the environment every test runs under", () => {
  it("turns the release check off, so no host a test starts asks GitHub", () => {
    expect(TEST_ENV[protocol.UPDATE_CHECK_ENV]).toBe("0");
  });
});
