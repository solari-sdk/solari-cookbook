// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { claudeMemoryDir, claudeProjectKey, defaultSeedChoice, type SeedFile, type SeedPlan, seedChoiceFrom, seedCommitsLandedLine, seedingLine, seedRowWords, seedSummaryLines } from "../src/index.js";

const file = (path: string, kind: SeedFile["kind"], bytes: number, row?: { id: string; name: string }): SeedFile => ({
  path,
  dir: false,
  bytes,
  kind,
  ...(row === undefined ? {} : { row }),
  ticked: kind === "config",
});

const PLAN: SeedPlan = {
  source: "/Users/dev/spoo-landing",
  remote: "https://github.com/spoo-me/frontend.git",
  branch: "refactor/dashboard-polish",
  defaultBranch: "main",
  unpushed: { commits: 2, base: "9f1c2e4aa11b0c3d4e5f60718293a4b5c6d7e8f9" },
  uncommitted: 4,
  memory: { key: claudeProjectKey("/Users/dev/spoo-landing"), files: 5, bytes: 28_000 },
  files: [
    file(".env.local", "config", 4096, { id: "next", name: "Next" }),
    file(".claude/settings.local.json", "config", 4096, { id: "agents", name: "agents" }),
    file("node_modules", "rebuilt", 2_600_000_000, { id: "node", name: "Node" }),
    file("dev.db", "data", 900_000, { id: "databases", name: "databases" }),
    file(".git-credentials", "never", 300, { id: "logins", name: "logins" }),
    file(".next-mock", "unknown", 3_200_000_000),
  ],
  remembered: false,
};

describe("the key a project's memory sits under", () => {
  it("is the path with every other character dashed, so two paths one dash apart collide", () => {
    expect(claudeProjectKey("/Users/a/b-c")).toBe("-Users-a-b-c");
    expect(claudeProjectKey("/Users/a/b/c")).toBe(claudeProjectKey("/Users/a/b-c"));
  });

  it("names the memory folder under a state home once, for the collector, the runtime and the engine alike", () => {
    expect(claudeMemoryDir("/Users/dev/.claude", "-Users-dev-wsp")).toBe("/Users/dev/.claude/projects/-Users-dev-wsp/memory");
    expect(claudeMemoryDir("/root/.claude/", "-root-wsp")).toBe("/root/.claude/projects/-root-wsp/memory");
  });
});

describe("what a seed ticks before anybody touches the menu", () => {
  it("ticks the configuration, the memory and the commits, and nothing of any other kind", () => {
    expect(defaultSeedChoice(PLAN)).toEqual({ files: [".env.local", ".claude/settings.local.json"], memory: true, commits: true });
  });

  it("takes the ticks the plan carries, so an untick remembered for that folder holds", () => {
    // The menu a remembered choice was applied to carries their ticks, not the catalogue's: a config row they
    // unticked last time stays unticked, and a row they kept that no row names travels.
    const remembered: SeedPlan = {
      ...PLAN,
      remembered: true,
      files: PLAN.files.map(f => ({ ...f, ticked: f.path === ".next-mock" })),
    };
    expect(defaultSeedChoice(remembered)).toEqual({ files: [".next-mock"], memory: true, commits: true });
  });

  it("never ticks a login, whatever a remembered choice says about it", () => {
    const remembered: SeedPlan = { ...PLAN, remembered: true, files: PLAN.files.map(f => ({ ...f, ticked: true })) };
    expect(defaultSeedChoice(remembered).files).not.toContain(".git-credentials");
  });

  it("ticks no memory and no commits where the folder has neither", () => {
    expect(defaultSeedChoice({ ...PLAN, memory: null, unpushed: null })).toEqual({ files: [".env.local", ".claude/settings.local.json"], memory: false, commits: false });
  });
});

describe("what a person's own words make of the menu", () => {
  it("unticks a path they cut and ticks one the catalog does not carry when they keep it", () => {
    expect(seedChoiceFrom(PLAN, [], [".env.local"]).files).toEqual([".claude/settings.local.json"]);
    expect(seedChoiceFrom(PLAN, [".next-mock"], []).files).toEqual([".env.local", ".claude/settings.local.json", ".next-mock"]);
  });

  it("drops the memory and the patch on the words that say so, and remembers only when asked", () => {
    expect(seedChoiceFrom(PLAN, [], [], { memory: false })).toMatchObject({ memory: false, commits: true });
    expect(seedChoiceFrom(PLAN, [], [], { commits: false })).toMatchObject({ memory: true, commits: false });
    expect(seedChoiceFrom(PLAN, [], [], { remember: true }).remember).toBe(true);
    expect("remember" in seedChoiceFrom(PLAN, [], [])).toBe(false);
  });

  it("refuses to carry a login by name, even when it is the path they kept", () => {
    expect(() => seedChoiceFrom(PLAN, [".git-credentials"], [])).toThrow(/never travels in a seed/);
  });

  it("refuses a path the menu never showed, and says what it holds", () => {
    expect(() => seedChoiceFrom(PLAN, ["app/page.tsx"], [])).toThrow(/is not on the seed menu/);
  });
});

describe("the words a row ends in", () => {
  it("say why each kind is ticked or not", () => {
    expect(seedRowWords(PLAN.files[0]!)).toBe("Next");
    expect(seedRowWords(PLAN.files[2]!)).toBe("rebuilt on the box");
    expect(seedRowWords(PLAN.files[3]!)).toBe("database, stop what uses it first");
    expect(seedRowWords(PLAN.files[4]!)).toBe("never travels");
    expect(seedRowWords(PLAN.files[5]!)).toBe("not in the catalogue");
  });
});

describe("what the person is told would travel", () => {
  it("is the ticked files, the memory, the patch and what stays here", () => {
    expect(seedSummaryLines(PLAN, defaultSeedChoice(PLAN))).toEqual([
      "2 files, 8 KB: .env.local, .claude/settings.local.json",
      "Claude Code memory, 5 files, 27 KB",
      "2 commits the remote does not have, as a patch from 9f1c2e4",
      "4 uncommitted changes stay on this computer",
    ]);
  });

  it("says no files travel where nothing is ticked, and nothing about a folder with no edits", () => {
    expect(seedSummaryLines({ ...PLAN, uncommitted: 0, memory: null, unpushed: null }, { files: [], memory: false, commits: false })).toEqual(["no files travel"]);
  });
});

describe("what the seeding stage says as the files go and once they have landed", () => {
  it("names the files, the memory and the commits in the menu's own counts, and where they came from", () => {
    expect(seedingLine(PLAN, defaultSeedChoice(PLAN))).toBe(
      "Seeding 2 files (8 KB), Claude Code memory (5 files, 27 KB), 2 commits the remote does not have, from /Users/dev/spoo-landing.",
    );
    // A memory folder is no file of the seed's: the menu counts it on a row of its own and so does this line,
    // so a seed of nothing but the memory reads as nought files here and as one file there.
    expect(seedingLine({ ...PLAN, unpushed: null, memory: { key: "-Users-dev-spoo-landing", files: 1, bytes: 69 } }, { files: [], memory: true, commits: false })).toBe(
      "Seeding 0 files, Claude Code memory (1 file, 69 B), from /Users/dev/spoo-landing.",
    );
    // Nothing ticked at all still says where it came from.
    expect(seedingLine({ ...PLAN, memory: null, unpushed: null }, { files: [], memory: false, commits: false })).toBe("Seeding 0 files, from /Users/dev/spoo-landing.");
  });

  it("says what the commits did, off the count the computer's own git read back", () => {
    expect(seedCommitsLandedLine(1)).toBe("1 commit landed");
    expect(seedCommitsLandedLine(2)).toBe("2 commits landed");
    expect(seedCommitsLandedLine(0)).toBe("no commits to land");
  });
});
