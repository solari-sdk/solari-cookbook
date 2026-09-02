import { describe, it, expect } from "vitest";
import { parseGitHubUrl, validatePullRequests } from "../src/github.js";
import type { PullRequestRef } from "../src/types.js";

function makePr(number: number, baseBranch: string, baseSha: string): PullRequestRef {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    baseBranch,
    baseSha,
    headSha: `head-${number}`,
    changedFiles: [`file-${number}.ts`],
  };
}

describe("parseGitHubUrl", () => {
  it("extracts owner and name", () => {
    const repo = parseGitHubUrl("https://github.com/example/repo");
    expect(repo.owner).toBe("example");
    expect(repo.name).toBe("repo");
  });

  it("strips .git suffix", () => {
    const repo = parseGitHubUrl("https://github.com/example/repo.git");
    expect(repo.name).toBe("repo");
  });

  it("rejects non-GitHub URLs", () => {
    expect(() => parseGitHubUrl("https://gitlab.com/example/repo")).toThrow();
  });
});

describe("validatePullRequests", () => {
  it("returns pinned base sha", () => {
    const prs = [makePr(1, "main", "abc"), makePr(2, "main", "abc")];
    const { baseSha } = validatePullRequests(prs);
    expect(baseSha).toBe("abc");
  });

  it("uses explicit base sha when provided", () => {
    const prs = [makePr(1, "main", "abc")];
    const { baseSha } = validatePullRequests(prs, "def");
    expect(baseSha).toBe("def");
  });

  it("rejects different base branches", () => {
    const prs = [makePr(1, "main", "abc"), makePr(2, "dev", "abc")];
    expect(() => validatePullRequests(prs)).toThrow("different base branches");
  });
});
