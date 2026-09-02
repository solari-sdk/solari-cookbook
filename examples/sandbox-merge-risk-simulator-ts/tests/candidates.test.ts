import { describe, it, expect } from "vitest";
import { candidateId, generateCandidates } from "../src/candidates.js";

describe("generateCandidates", () => {
  it("generates individual and pairwise candidates for three PRs", () => {
    const candidates = generateCandidates([21, 22, 23], "pairwise");
    expect(candidates.map((c) => c.id)).toEqual([
      "21",
      "22",
      "23",
      "21+22",
      "21+23",
      "22+23",
    ]);
  });

  it("sorts PRs in candidate ids", () => {
    const candidates = generateCandidates([23, 21], "pairwise");
    expect(candidates.map((c) => c.id)).toEqual(["21", "23", "21+23"]);
  });

  it("returns explicit combination in selected mode", () => {
    const candidates = generateCandidates([21, 22, 23], "selected", "23+21");
    expect(candidates.map((c) => c.id)).toEqual(["21+23"]);
  });
});

describe("candidateId", () => {
  it("joins sorted prs with plus", () => {
    expect(candidateId([23, 21])).toBe("21+23");
  });
});
