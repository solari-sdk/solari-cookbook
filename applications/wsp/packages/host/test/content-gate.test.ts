// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { contentGateEnforced } from "./content-gate.js";

describe("where the daemon content gate is enforced", () => {
  it("enforces on this computer, where the landing gate runs and no ci variable is set", () => {
    expect(contentGateEnforced({})).toBe(true);
  });

  it("enforces in ci on main, which is the tree that lands and the one that can carry the line", () => {
    expect(contentGateEnforced({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" })).toBe(true);
  });

  it("does not enforce in ci off main, where the sha of the merged tree is not known yet", () => {
    expect(contentGateEnforced({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/ticket/x" })).toBe(false);
    // A pull request run is on the merge ref, never on a branch.
    expect(contentGateEnforced({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/pull/1/merge" })).toBe(false);
  });
});
