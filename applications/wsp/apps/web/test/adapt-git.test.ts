// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { repoAbsence } from "../src/adapt/index.js";

describe("repoAbsence", () => {
  it("reads the daemon's not-a-git-repo code as a folder outside any repository", () => {
    expect(repoAbsence(Object.assign(new Error("not inside a git repository"), { code: "not-a-git-repo" }))).toBe("none");
  });

  it("reads every other failure as a read the machine refused: another code, a bare error, a non-error", () => {
    expect(repoAbsence(Object.assign(new Error("outside the browsable roots"), { code: "outside-root" }))).toBe("refused");
    expect(repoAbsence(new Error("socket closed"))).toBe("refused");
    expect(repoAbsence(null)).toBe("refused");
    expect(repoAbsence("not-a-git-repo")).toBe("refused");
  });
});
