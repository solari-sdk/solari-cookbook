// SPDX-License-Identifier: AGPL-3.0-only
// The sources of a tick, in their order, and the shape the file takes.
import { CATALOG, CATALOG_AGENTS } from "@wsp/catalog";
import { Recipe } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { computeRecipe, unknownCommands } from "../src/recipe.js";
import { HEAVY_BYTES, HEAVY_USED_FLOOR, USED_FLOOR, meetsUsedFloor, readHistories } from "../src/history/index.js";
import { fakeHost } from "./fake-host.js";

const claudeLine = (sessionId: string, command: string): string =>
  JSON.stringify({ type: "assistant", sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] } });

const codexLine = (id: string, cmd: string): string =>
  [JSON.stringify({ type: "session_meta", payload: { id, cwd: "/Users/dev/proj" } }), JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }) } })].join("\n");
/** The one agent this host can open a thread on, as the wizard and the recipe verb name it. */
const CLAUDE_THREADS = { threadAgents: ["claude"] };

const laptop = () =>
  fakeHost({
    which: ["claude", "gh", "node", "git"],
    files: {
      "~/.claude/settings.json": "{}",
      "~/.claude/skills/": 2048,
      "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", "agent-browser open https://x && export API=sk-ant-x-secret-value"), claudeLine("s1", "agent-browser click a; agent-browser click b; agent-browser fill c"), claudeLine("s1", "go version")].join("\n"),
      "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", "agent-browser snapshot"),
      "/Users/dev/proj/package.json": JSON.stringify({ engines: { node: ">=22" } }),
      "/Users/dev/proj/go.mod": "module example.com/x\n",
      "/Users/dev/proj/Gemfile": 'source "https://rubygems.org"\n',
    },
  });

describe("computeRecipe", () => {
  it("ticks what the agents used over the floor, leaves what is installed here and never used off, and falls back to the catalog's own default", async () => {
    const recipe = await computeRecipe(laptop(), { ...CLAUDE_THREADS, now: () => new Date("2026-09-06T03:00:00Z") });
    const row = (id: string) => recipe.rows.find(r => r.id === id)!;
    expect(row("claude")).toEqual({ id: "claude", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.claude/settings.json", "~/.claude/skills"], bin: true }, size: 208 * 1024 * 1024 });
    expect(row("gh")).toEqual({ id: "gh", kind: "tool", on: false, source: { kind: "installed", paths: [], bin: true }, size: 42188962 });
    expect(row("agent-browser")).toEqual({ id: "agent-browser", kind: "tool", on: true, source: { kind: "used", sessions: 2, calls: 5 }, size: 81702912 });
    // One session's use is recorded but does not tick a row the catalog leaves off; the floor does (agent-browser above).
    expect(row("go")).toMatchObject({ on: false, source: { kind: "used", sessions: 1, calls: 1 } });
    expect(row("pnpm")).toEqual({ id: "pnpm", kind: "tool", on: true, source: { kind: "popular", sessions: 36, images: 3 }, size: 20357120 });
    expect(row("rust")).toMatchObject({ on: false, source: { kind: "popular", sessions: 4, images: 3 } });
    // An agent is never on by default: the ones not found here stay off, with the catalog's evidence as their source.
    expect(row("codex")).toEqual({ id: "codex", kind: "agent", on: false, source: { kind: "popular", sessions: 5, images: 1 }, size: 455 * 1024 * 1024 });
    expect(recipe.rows.map(r => r.id)).toEqual(CATALOG.map(e => e.id));
    expect(recipe.at).toBe("2026-09-06T03:00:00.000Z");
    expect(recipe.histories).toEqual([
      { agent: "claude", state: "read", sessions: 2, calls: 4 },
      { agent: "codex", state: "empty", sessions: 0, calls: 0 },
      { agent: "gemini", state: "no-reader", sessions: 0, calls: 0 },
      { agent: "opencode", state: "no-reader", sessions: 0, calls: 0 },
      { agent: "pi", state: "no-reader", sessions: 0, calls: 0 },
      { agent: "hermes", state: "empty", sessions: 0, calls: 0 },
      { agent: "crush", state: "no-reader", sessions: 0, calls: 0 },
      { agent: "qwen", state: "no-reader", sessions: 0, calls: 0 },
      { agent: "goose", state: "no-reader", sessions: 0, calls: 0 },
      { agent: "amp", state: "no-reader", sessions: 0, calls: 0 },
    ]);
  });

  it("ticks an agent only when it was used here and wsp can run its threads; installed or used alone is off", async () => {
    // Claude Code used here, Codex used here without an adapter, OpenCode installed and never run.
    const host = fakeHost({
      which: ["claude", "codex", "opencode"],
      files: {
        "~/.claude/settings.json": "{}",
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", "gh pr list"),
        "~/.codex/config.toml": "",
        "~/.codex/sessions/2026/06/01/rollout-2026-06-01T10-00-00-t1.jsonl": codexLine("t1", "cargo build"),
      },
    });
    const recipe = await computeRecipe(host, CLAUDE_THREADS);
    const row = (id: string) => recipe.rows.find(r => r.id === id)!;
    expect(recipe.histories.filter(h => h.sessions > 0).map(h => h.agent)).toEqual(["claude", "codex"]);
    // Every one of the three still reads as installed here: the tick and the source are separate answers.
    expect(row("claude")).toMatchObject({ on: true, source: { kind: "installed" } });
    expect(row("codex")).toMatchObject({ on: false, source: { kind: "installed" } });
    expect(row("opencode")).toMatchObject({ on: false, source: { kind: "installed" } });
    expect(recipe.rows.filter(r => r.kind === "agent" && r.on).map(r => r.id)).toEqual(["claude"]);
    // The agent wsp drives is off too when this computer never ran it.
    const quiet = await computeRecipe(fakeHost({ which: ["claude"], files: { "~/.claude/settings.json": "{}" } }), CLAUDE_THREADS);
    expect(quiet.rows.find(r => r.id === "claude")).toMatchObject({ on: false, source: { kind: "installed" } });
  });

  it("a project's own files weigh before anything this computer says, and tick the row whatever the catalog thought", async () => {
    const host = laptop();
    const scans: string[] = [];
    const recipe = await computeRecipe(host, { ...CLAUDE_THREADS, folders: ["/Users/dev/proj"], onProject: s => scans.push(...s.rows.map(n => `${n.id} ${n.why}`), ...s.candidates.map(n => `candidate ${n.id}`)) });
    const row = (id: string) => recipe.rows.find(r => r.id === id)!;
    // go was one session's use and off; the project's go.mod ticks it and says which file asked.
    expect(row("go")).toMatchObject({ on: true, source: { kind: "project", why: "go.mod needs Go" } });
    // gh is installed here and never used, so it stays off with the source this computer gave it: the project never named it.
    expect(row("gh")).toMatchObject({ on: false, source: { kind: "installed", paths: [], bin: true } });
    // node is installed here too, and the project's own file outranks that.
    expect(row("node")).toMatchObject({ on: true, source: { kind: "project", why: "engines.node >=22" } });
    expect(scans).toEqual(["node engines.node >=22", "go go.mod needs Go", "ruby Gemfile needs Ruby"]);
    expect(Recipe.parse(JSON.parse(JSON.stringify(recipe)))).toEqual(recipe);
  });

  it("a tool both installed here and used by the agents records what they ran, and the use alone decides its tick", async () => {
    const host = fakeHost({
      which: ["claude", "gh", "node", "git"],
      files: {
        "~/.claude/settings.json": "{}",
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", "gh pr list"),
      },
    });
    const recipe = await computeRecipe(host, CLAUDE_THREADS);
    // The counts are the row's source, so a screen can say "installed here, never used" and mean it; one look is under the floor.
    expect(recipe.rows.find(r => r.id === "gh")).toEqual({ id: "gh", kind: "tool", on: false, source: { kind: "used", sessions: 1, calls: 1 }, size: 42188962 });
    expect(recipe.rows.find(r => r.id === "git")).toMatchObject({ on: false, source: { kind: "installed" } });
  });

  it("installed here and never used is off whatever the size: a 3.3 GB Swift and a 4 MB Yarn both stay off while a used row is on", async () => {
    const host = fakeHost({
      which: ["swift", "yarn", "agent-browser"],
      files: {
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", "agent-browser open https://x"), claudeLine("s1", "agent-browser click a; agent-browser click b; agent-browser fill c")].join("\n"),
        "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", "agent-browser snapshot"),
      },
    });
    const recipe = await computeRecipe(host, CLAUDE_THREADS);
    const row = (id: string) => recipe.rows.find(r => r.id === id)!;
    expect(row("swift")).toMatchObject({ on: false, source: { kind: "installed", bin: true }, size: 3562135552 });
    expect(row("yarn")).toMatchObject({ on: false, source: { kind: "installed", bin: true } });
    expect(row("agent-browser")).toMatchObject({ on: true, source: { kind: "used", sessions: 2, calls: 5 } });
  });

  it("a use below the threshold is the blended rule's answer and vetoes the catalog's own default", async () => {
    // The wizard's screens start from this rule; a tool the catalog ships on that was looked at once stays off.
    const host = fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", "jq . package.json") } });
    const row = (r: Awaited<ReturnType<typeof computeRecipe>>, id: string) => r.rows.find(x => x.id === id)!;
    const blended = await computeRecipe(host, CLAUDE_THREADS);
    expect(row(blended, "jq")).toMatchObject({ on: false, source: { kind: "used", sessions: 1, calls: 1 } });
    // A tool the catalog ships on that nothing here touched still follows the catalog.
    expect(row(blended, "curl")).toMatchObject({ on: true, source: { kind: "popular" } });
    // Two sessions and five commands is the floor, and then it is on; two sessions of one command each is still a look.
    const twice = await computeRecipe(fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", "jq ."), "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", "jq .") } }), CLAUDE_THREADS);
    expect(row(twice, "jq")).toMatchObject({ on: false, source: { kind: "used", sessions: 2, calls: 2 } });
    const habit = await computeRecipe(fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", "jq . a; jq . b; jq . c; jq . d"), "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", "jq .") } }), CLAUDE_THREADS);
    expect(row(habit, "jq")).toMatchObject({ on: true, source: { kind: "used", sessions: 2, calls: 5 } });
    // An agent's own store is its use, and its use is what ticks it: one session is enough, with no floor to meet.
    expect(row(blended, "claude")).toMatchObject({ on: true, kind: "agent", source: { kind: "used", sessions: 1 } });
  });

  it("one rule decides every tick when a rule is named, and the row's source says which one it went on", async () => {
    const used = await computeRecipe(laptop(), { ...CLAUDE_THREADS, tick: "used" });
    const row = (r: Awaited<ReturnType<typeof computeRecipe>>, id: string) => r.rows.find(x => x.id === id)!;
    // Installed here counts for nothing under used: the source is read used first, so an installed row that
    // reaches the table was never run.
    expect(row(used, "gh")).toMatchObject({ on: false, source: { kind: "installed" } });
    expect(row(used, "agent-browser")).toMatchObject({ on: true, source: { kind: "used", sessions: 2, calls: 5 } });
    // One command in one session is under the floor, so used says off and the row keeps its counts.
    expect(row(used, "go")).toMatchObject({ on: false, source: { kind: "used", sessions: 1, calls: 1 } });
    expect(row(used, "pnpm")).toMatchObject({ on: false, source: { kind: "popular" } });
    expect(used.tick).toBe("used");

    const installed = await computeRecipe(laptop(), { ...CLAUDE_THREADS, tick: "installed" });
    expect(row(installed, "gh")).toMatchObject({ on: true, source: { kind: "installed" } });
    expect(row(installed, "agent-browser")).toMatchObject({ on: false, source: { kind: "used" } });
    expect(row(installed, "pnpm")).toMatchObject({ on: false });

    const byDefault = await computeRecipe(laptop(), { ...CLAUDE_THREADS, tick: "default" });
    expect(row(byDefault, "pnpm")).toMatchObject({ on: true });
    expect(row(byDefault, "go")).toMatchObject({ on: false });
    expect(row(byDefault, "claude")).toMatchObject({ on: false, kind: "agent" });
  });

  it("under used a tool is on at the floor: 2 sessions and 5 commands, 3 and 20 for a heavy row", async () => {
    // Session 0 carries what the others do not, so the counts land exactly.
    const ran = (cmd: string, sessions: number, calls: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: sessions }, (_, s) => [`~/.claude/projects/-Users-dev-proj/${cmd}-${s}.jsonl`, Array.from({ length: s === 0 ? calls - sessions + 1 : 1 }, () => claudeLine(`${cmd}-${s}`, `${cmd} run`)).join("\n")]));
    const row = async (files: Record<string, string>, id: string) => (await computeRecipe(fakeHost({ files }), { ...CLAUDE_THREADS, tick: "used" })).rows.find(r => r.id === id)!;
    expect(await row(ran("wrangler", 1, 2), "wrangler")).toMatchObject({ on: false, source: { kind: "used", sessions: 1, calls: 2 } });
    expect(await row(ran("wrangler", 2, 6), "wrangler")).toMatchObject({ on: true, source: { kind: "used", sessions: 2, calls: 6 } });
    // Java is over 300 MB, so it is weighed against the heavy floor.
    expect(await row(ran("java", 3, 5), "java")).toMatchObject({ on: false, source: { kind: "used", sessions: 3, calls: 5 } });
    expect(await row(ran("java", 4, 30), "java")).toMatchObject({ on: true, source: { kind: "used", sessions: 4, calls: 30 } });
    // Two version checks in one session are no use at all: the row falls to the catalog's own evidence.
    const checks = { "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", "vercel --version"), claudeLine("s1", "vercel -v")].join("\n") };
    expect(await row(checks, "vercel")).toMatchObject({ on: false, source: { kind: "popular" } });
    expect(USED_FLOOR).toEqual({ sessions: 2, calls: 5 });
    expect(HEAVY_USED_FLOOR).toEqual({ sessions: 3, calls: 20 });
    expect(HEAVY_BYTES).toBe(300 * 1024 * 1024);
    expect(meetsUsedFloor({ sessions: 2, calls: 5 }, HEAVY_BYTES)).toBe(true);
    expect(meetsUsedFloor({ sessions: 2, calls: 5 }, HEAVY_BYTES + 1)).toBe(false);
    expect(meetsUsedFloor({ sessions: 3, calls: 20 }, HEAVY_BYTES + 1)).toBe(true);
    expect(meetsUsedFloor({ sessions: 1, calls: 50 }, undefined)).toBe(false);
  });

  it("holds an agent no adapter can open a thread on off under every rule but installed", async () => {
    const used = await computeRecipe(laptop(), { ...CLAUDE_THREADS, tick: "used" });
    // An agent is placed by whether it is on this computer, so its row still says installed; the use ticks it.
    expect(used.rows.find(r => r.id === "claude")).toMatchObject({ on: true, source: { kind: "installed" } });
    const codexHere = () => fakeHost({ which: ["codex"], files: { "~/.codex/config.toml": "" } });
    expect((await computeRecipe(codexHere(), { ...CLAUDE_THREADS, tick: "used" })).rows.find(r => r.id === "codex")).toMatchObject({ on: false });
    expect((await computeRecipe(codexHere(), { ...CLAUDE_THREADS, tick: "installed" })).rows.find(r => r.id === "codex")).toMatchObject({ on: true });
  });

  it("weighs the histories by the folders it is given, and carries no rule when none was named", async () => {
    const one = await computeRecipe(laptop(), { ...CLAUDE_THREADS, tick: "used", folders: ["/Users/dev/nowhere"] });
    expect(one.rows.find(r => r.id === "agent-browser")).toMatchObject({ on: false, source: { kind: "popular" } });
    expect(one.histories.find(h => h.agent === "claude")).toMatchObject({ state: "empty", sessions: 0 });
    expect((await computeRecipe(laptop(), CLAUDE_THREADS)).tick).toBeUndefined();
  });

  it("lists the commands the agents ran that no catalog row carries, most-run first, catalog rows and builtins out", async () => {
    const host = fakeHost({
      files: {
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", "pulumi -q && tofu check"), claudeLine("s1", "export X=1; pulumi")].join("\n"),
        "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", "pulumi; go build"),
      },
    });
    expect(unknownCommands(await readHistories(host))).toEqual([
      { name: "pulumi", calls: 3, sessions: 2 },
      { name: "tofu", calls: 1, sessions: 1 },
    ]);
  });

  it("a project's need outside the catalog the caller narrowed to never becomes a row", async () => {
    const only = CATALOG.filter(e => e.id === "node");
    const recipe = await computeRecipe(laptop(), { ...CLAUDE_THREADS, catalog: only, folders: ["/Users/dev/proj"] });
    // go.mod asked for Go, and Go is outside the catalog this caller handed in: the rows stay the ones it named.
    expect(recipe.rows.map(r => r.id)).toEqual(["node"]);
    expect(recipe.rows[0]).toMatchObject({ on: true, source: { kind: "project", why: "engines.node >=22" } });
  });

  it("writes the protocol's shape and never a value it read", async () => {
    const recipe = await computeRecipe(laptop(), CLAUDE_THREADS);
    const text = JSON.stringify(recipe);
    expect(Recipe.parse(JSON.parse(text))).toEqual(recipe);
    expect(text).not.toContain("sk-ant-x");
    expect(text).not.toContain("https://x");
  });

  it("tells the caller what was found and read as it goes", async () => {
    const present: string[] = [];
    const read: string[] = [];
    await computeRecipe(laptop(), { ...CLAUDE_THREADS, onPresent: e => present.push(e.id), onHistory: h => read.push(`${h.agent} ${h.state}`) });
    expect(present).toEqual(["claude", "node", "git", "gh"]);
    expect(read[0]).toBe("claude read");
    expect(read).toHaveLength(CATALOG_AGENTS.length);
  });
});
