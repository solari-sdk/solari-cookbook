// SPDX-License-Identifier: AGPL-3.0-only
import { OPEN_SHIM_PATH } from "@wsp/protocol";
import { BROWSER_SHIM_PATH } from "@wsp/runtime";
import { describe, expect, it } from "vitest";

describe("wspx shim path", () => {
  it("the path wspx bakes into a fork's BROWSER is the protocol's, through the runtime's re-export", () => {
    expect(BROWSER_SHIM_PATH).toBe(OPEN_SHIM_PATH);
  });
});
