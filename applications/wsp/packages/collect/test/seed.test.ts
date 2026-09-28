// SPDX-License-Identifier: AGPL-3.0-only
import { claudeProjectKey } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { seedMenu } from "../src/seed.js";
import { fakeHost, type FakeLaptop } from "./fake-host.js";

const FOLDER = "/Users/dev/spoo-landing";
const KEY = claudeProjectKey(FOLDER);
const CLAUDE = "/Users/dev/.claude";

/** What git prints for a folder ignoring a local env file, the agent's folder, two package trees, a docs folder,
 * two build products and the Finder's own metadata: the listing read off spoo-landing on 2026-09-17. */
const LISTING = [".env.local", ".claude/", "node_modules/", ".next-mock/", "docs/", "tsconfig.tsbuildinfo", "next-env.d.ts", ".DS_Store", "components/.DS_Store"].join("\0");
const INSIDE_CLAUDE = [".claude/settings.local.json", ".claude/sessions/last.json"].join("\0");

const DU = [
  ["4", `${FOLDER}/.env.local`],
  ["44", `${FOLDER}/.claude`],
  ["2600000", `${FOLDER}/node_modules`],
  ["3200000", `${FOLDER}/.next-mock`],
  ["18000", `${FOLDER}/docs`],
  ["120", `${FOLDER}/tsconfig.tsbuildinfo`],
  ["4", `${FOLDER}/next-env.d.ts`],
  ["4", `${FOLDER}/.DS_Store`],
  ["4", `${FOLDER}/components/.DS_Store`],
  ["4", `${FOLDER}/.claude/settings.local.json`],
]
  .map(([kb, path]) => `${kb}\t${path}`)
  .join("\n");

const git = (...args: string[]): string => ["git", "-C", FOLDER, ...args].join(" ");

function laptop(over: Record<string, string> = {}, files: FakeLaptop["files"] = {}): FakeLaptop {
  return {
    files,
    exec: {
      [git("ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory")]: LISTING,
      [git("ls-files", "-z", "-o", "-i", "--exclude-standard", "--", ".claude")]: INSIDE_CLAUDE,
      [`du -sk ${DU.split("\n").map(line => line.split("\t")[1]).join(" ")}`]: DU,
      [git("remote", "get-url", "origin")]: "https://github.com/spoo-me/frontend.git",
      [git("rev-parse", "--abbrev-ref", "HEAD")]: "refactor/dashboard-polish",
      [git("symbolic-ref", "refs/remotes/origin/HEAD")]: "refs/remotes/origin/main",
      [git("merge-base", "HEAD", "origin/main")]: "9f1c2e4aa11b0c3d4e5f60718293a4b5c6d7e8f9",
      [git("rev-list", "--count", "9f1c2e4aa11b0c3d4e5f60718293a4b5c6d7e8f9..HEAD")]: "0",
      [git("status", "--porcelain")]: " M app/page.tsx\n M app/layout.tsx\n?? scratch.md\n?? notes/todo.md",
      ...over,
    },
  };
}

describe("the seed menu for a folder on this computer", () => {
  it("shows every path git ignores, sized once, with the ticks the catalog's rows decide", async () => {
    const host = fakeHost(laptop());
    const plan = await seedMenu(host, FOLDER, { claudeStateHome: CLAUDE });
    expect(plan.files.map(f => [f.path, f.kind, f.bytes, f.ticked])).toEqual([
      [".claude", "unknown", 40 * 1024, false],
      [".claude/settings.local.json", "config", 4 * 1024, true],
      [".env.local", "config", 4 * 1024, true],
      [".next-mock", "unknown", 3_200_000 * 1024, false],
      ["docs", "unknown", 18_000 * 1024, false],
      ["next-env.d.ts", "rebuilt", 4 * 1024, false],
      ["node_modules", "rebuilt", 2_600_000 * 1024, false],
      ["tsconfig.tsbuildinfo", "rebuilt", 120 * 1024, false],
    ]);
    // One du for the whole menu, never one per row.
    expect(host.calls.filter(call => call.startsWith("run du "))).toHaveLength(1);
  });

  it("names the row that judged each path, so the menu says why a path is ticked", async () => {
    const plan = await seedMenu(fakeHost(laptop()), FOLDER, { claudeStateHome: CLAUDE });
    expect(plan.files.find(f => f.path === ".env.local")?.row).toEqual({ id: "next", name: "Next" });
    expect(plan.files.find(f => f.path === ".claude/settings.local.json")?.row).toEqual({ id: "agents", name: "agents" });
    expect(plan.files.find(f => f.path === "node_modules")?.row?.id).toBe("node");
    expect(plan.files.find(f => f.path === "docs")?.row).toBeUndefined();
  });

  it("hides the Finder's own metadata, wherever it sits", async () => {
    const plan = await seedMenu(fakeHost(laptop()), FOLDER, { claudeStateHome: CLAUDE });
    expect(plan.files.map(f => f.path)).not.toContain(".DS_Store");
    expect(plan.files.map(f => f.path)).not.toContain("components/.DS_Store");
  });

  it("reads the branch, the remote's default, the edits that stay here and nothing ahead of the remote", async () => {
    const plan = await seedMenu(fakeHost(laptop()), FOLDER, { claudeStateHome: CLAUDE });
    expect(plan.remote).toBe("https://github.com/spoo-me/frontend.git");
    expect(plan.branch).toBe("refactor/dashboard-polish");
    expect(plan.defaultBranch).toBe("main");
    expect(plan.unpushed).toBeNull();
    expect(plan.uncommitted).toBe(4);
    expect(plan.remembered).toBe(false);
  });

  it("counts the commits the remote does not have against the branch's own upstream", async () => {
    const plan = await seedMenu(
      fakeHost(
        laptop({
          [git("rev-parse", "--abbrev-ref", "@{upstream}")]: "origin/refactor/dashboard-polish",
          [git("merge-base", "HEAD", "origin/refactor/dashboard-polish")]: "aa11bb22cc33",
          [git("rev-list", "--count", "aa11bb22cc33..HEAD")]: "3",
        }),
      ),
      FOLDER,
      { claudeStateHome: CLAUDE },
    );
    expect(plan.unpushed).toEqual({ commits: 3, base: "aa11bb22cc33" });
  });

  it("answers no remote for a folder git has no origin for, which is what refuses the add", async () => {
    const { [git("remote", "get-url", "origin")]: _origin, ...noOrigin } = laptop().exec ?? {};
    const host = fakeHost({ exec: noOrigin });
    const plan = await seedMenu(host, FOLDER, { claudeStateHome: CLAUDE });
    expect(plan.remote).toBeNull();
  });

  it("carries the agent's memory folder for this folder, under the state home it was given", async () => {
    const files = { [`${CLAUDE}/projects/${KEY}/memory/MEMORY.md`]: 2000, [`${CLAUDE}/projects/${KEY}/memory/one.md`]: 26_000 };
    const plan = await seedMenu(fakeHost(laptop({}, files)), FOLDER, { claudeStateHome: CLAUDE });
    expect(plan.memory).toEqual({ key: KEY, files: 2, bytes: 28_000 });
  });

  it("carries no memory row where the agent kept none for this folder, or kept it under another state home", async () => {
    const files = { [`/Users/dev/.claude-other/projects/${KEY}/memory/MEMORY.md`]: 2000 };
    expect((await seedMenu(fakeHost(laptop()), FOLDER, { claudeStateHome: CLAUDE })).memory).toBeNull();
    expect((await seedMenu(fakeHost(laptop({}, files)), FOLDER, { claudeStateHome: CLAUDE })).memory).toBeNull();
    expect((await seedMenu(fakeHost(laptop({}, files)), FOLDER, { claudeStateHome: "/Users/dev/.claude-other" })).memory).toEqual({ key: KEY, files: 1, bytes: 2000 });
  });

  it("reads no file's content anywhere", async () => {
    const host = fakeHost(laptop());
    await seedMenu(host, FOLDER, { claudeStateHome: CLAUDE });
    expect(host.calls.filter(call => call.startsWith("read ") || call.startsWith("lines "))).toEqual([]);
  });
});
