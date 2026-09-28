// SPDX-License-Identifier: AGPL-3.0-only
import { GOLDEN_SETUP, GOLDEN_SMOKE } from "@wsp/catalog";
import { describe, expect, it } from "vitest";
import { goldenBuild } from "../src/main.js";

describe("wspx golden build request", () => {
  it("is one request for every road that builds the golden, and names no size", () => {
    const request = goldenBuild({ ANTHROPIC_API_KEY: "sk-ant-x-fake" });
    // The catalog's harness line, not a copy: the one road that may run the vendor's installer is the catalog's.
    expect(request).toMatchObject({ setup: GOLDEN_SETUP, smoke: GOLDEN_SMOKE, envs: { ANTHROPIC_API_KEY: "sk-ant-x-fake" }, labels: { wsp: "1", "wsp-cli": "1" } });
    expect([request.cpu, request.memMb]).toEqual([undefined, undefined]);
  });
});
