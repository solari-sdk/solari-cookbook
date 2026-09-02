import { describe, it, expect } from "vitest";
import { parseCli } from "../src/cli.js";

describe("parseCli", () => {
  it("parses required options", () => {
    const opts = parseCli([
      "node",
      "mergelab",
      "--repo",
      "https://github.com/example/repo",
      "--prs",
      "21,22,23",
      "--config",
      "./config.json",
    ]);
    expect(opts.repo).toBe("https://github.com/example/repo");
    expect(opts.prs).toEqual([21, 22, 23]);
    expect(opts.config).toBe("./config.json");
    expect(opts.mode).toBe("pairwise");
    expect(opts.concurrency).toBe(2);
    expect(opts.output).toBeUndefined();
    expect(opts.ai).toBe(true);
    expect(opts.html).toBe(false);
  });

  it("honors --output", () => {
    const opts = parseCli([
      "node",
      "mergelab",
      "--repo",
      "https://github.com/example/repo",
      "--prs",
      "21,22",
      "--config",
      "./config.json",
      "--output",
      "./reports",
    ]);
    expect(opts.output).toBe("./reports");
  });

  it("enables html report with --html", () => {
    const opts = parseCli([
      "node",
      "mergelab",
      "--repo",
      "https://github.com/example/repo",
      "--prs",
      "21,22",
      "--config",
      "./config.json",
      "--html",
    ]);
    expect(opts.html).toBe(true);
  });

  it("rejects fewer than 2 PRs", () => {
    expect(() =>
      parseCli([
        "node",
        "mergelab",
        "--repo",
        "https://github.com/example/repo",
        "--prs",
        "21",
        "--config",
        "./config.json",
      ]),
    ).toThrow("2–3");
  });

  it("rejects duplicate PRs", () => {
    expect(() =>
      parseCli([
        "node",
        "mergelab",
        "--repo",
        "https://github.com/example/repo",
        "--prs",
        "21,21",
        "--config",
        "./config.json",
      ]),
    ).toThrow("unique");
  });

  it("honors --no-ai", () => {
    const opts = parseCli([
      "node",
      "mergelab",
      "--repo",
      "https://github.com/example/repo",
      "--prs",
      "21,22",
      "--config",
      "./config.json",
      "--no-ai",
    ]);
    expect(opts.ai).toBe(false);
  });
});
