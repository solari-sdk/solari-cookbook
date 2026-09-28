// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StageStep, StageView } from "../src/init.js";
import { buildTakes, buildTimes, readBuildTimes, rebuildEstimate } from "../src/init-times.js";

const step = (stage: StageStep["stage"], ms?: number): StageStep => ({ stage, start: "", end: "", fail: "", state: "done", tail: [], ...(ms !== undefined ? { ms } : {}) });
const view = (...steps: StageStep[]): StageView => ({ steps });
const AT = new Date("2026-09-05T19:44:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the build's measured stages", () => {
  it("records every clocked stage of the build and the seal; the closing stage of each has no clock and is left out", () => {
    const prepare = view(step("creating", 61_000), step("deploying-daemon", 30_000), step("installing-tools", 1_059_000), step("ready"));
    const seal = view(step("snapshotting", 40_000), step("smoke-forking", 80_000), step("sealed"));
    expect(buildTimes([prepare, seal], AT)).toEqual({
      at: "2026-09-05T19:44:00.000Z",
      stages: { creating: 61_000, "deploying-daemon": 30_000, "installing-tools": 1_059_000, snapshotting: 40_000, "smoke-forking": 80_000 },
    });
  });

  it("a stage skipped before the closing one means the builder already held it: no measurement of a rebuild", () => {
    const prepare = view(step("creating", 5_000), step("deploying-daemon"), step("installing-tools", 1_000), step("ready"));
    expect(buildTimes([prepare, view(step("snapshotting", 1), step("sealed"))], AT)).toBeUndefined();
  });

  it("nothing clocked is nothing recorded", () => {
    expect(buildTimes([view(step("ready")), view()], AT)).toBeUndefined();
  });
});

describe("the last build read back from the import result", () => {
  it("reads the record when it is there and well formed, and nothing otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-times-"));
    dirs.push(dir);
    const path = join(dir, "golden-import.json");
    expect(readBuildTimes(path)).toBeUndefined();
    writeFileSync(path, "{ not json");
    expect(readBuildTimes(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ tools: [], agents: [] }));
    expect(readBuildTimes(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ build: { at: "2026-09-05T19:44:00.000Z", stages: {} } }));
    expect(readBuildTimes(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ build: { at: "2026-09-05T19:44:00.000Z", stages: { creating: "61000" } } }));
    expect(readBuildTimes(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ build: { at: "2026-09-05T19:44:00.000Z", stages: { creating: 61_000, "installing-tools": 1_059_000 } } }));
    expect(readBuildTimes(path)).toEqual({ at: "2026-09-05T19:44:00.000Z", stages: { creating: 61_000, "installing-tools": 1_059_000 } });
  });
});

describe("how long the build takes, in the build screen's own words", () => {
  it("names the measured length as the last build's, and the constant as a guess, so both fit after \"The build takes\"", () => {
    const at = AT.toISOString();
    expect(buildTakes(undefined)).toBe("about ten minutes, not measured on this computer yet");
    expect(buildTakes({ at, stages: { creating: 61_000, "installing-tools": 1_059_000, snapshotting: 40_000 } })).toBe("about 19 minutes, going by the last one");
    expect(buildTakes({ at, stages: { creating: 30_000 } })).toBe("under a minute, going by the last one");
    expect(buildTakes({ at, stages: { creating: 61_000 } })).toBe("about a minute, going by the last one");
    // The two frames say the same length in their own words, from one measurement.
    expect(rebuildEstimate({ at, stages: { creating: 61_000 } })).toBe("about a minute last time");
  });
});

describe("the rebuild estimate", () => {
  it("says the constant and that nothing was measured when there is no last build", () => {
    expect(rebuildEstimate(undefined)).toBe("about ten minutes, not measured on this computer yet");
  });

  it("says the last build's stages summed to the minute when there is one", () => {
    const at = AT.toISOString();
    expect(rebuildEstimate({ at, stages: { creating: 61_000, "deploying-daemon": 30_000, "installing-tools": 1_059_000, snapshotting: 40_000, "smoke-forking": 30_000 } })).toBe("about 20 minutes last time");
    expect(rebuildEstimate({ at, stages: { creating: 50_000, "installing-tools": 40_000 } })).toBe("about 2 minutes last time");
    expect(rebuildEstimate({ at, stages: { creating: 70_000 } })).toBe("about a minute last time");
    expect(rebuildEstimate({ at, stages: { creating: 20_000 } })).toBe("under a minute last time");
  });
});
