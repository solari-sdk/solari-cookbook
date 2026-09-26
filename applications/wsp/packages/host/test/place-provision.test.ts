// SPDX-License-Identifier: AGPL-3.0-only
// The recipe beside this host's state file, planned for a computer somebody
// owns: the same rows a copy of the image is planned from, come to the steps
// that run on the computer itself.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "@wsp/collect";
import { TOOL_PREFIX, catalogEntry } from "@wsp/catalog";
import { MCP_ID_PREFIX, TOOLS_PATH, probePath, type Recipe } from "@wsp/protocol";
import { AGENT_NODE_STEP, closeAgentFiles, oncePathsOf, pathLine, provisionFiles, provisionMcp, type ProvisionPlan } from "@wsp/engine";
import { nodeHost } from "@wsp/collect";
import { boxGuest, cleanGuests } from "../../engine/test/box-guest.js";
import { parseEnvFile, serverEnvFileFor } from "../src/env-keys.js";
import { serversActs } from "../src/servers-acts.js";
import { placeProvisioner } from "../src/place-provision.js";
import { smallRecipePath } from "../src/recipe-file.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";

/** The recipe this computer holds: the fixture's, with Codex ticked and one row the catalog has none for. */
const SMALL: Recipe = {
  ...RECIPE,
  rows: RECIPE.rows.map(r => (r.id === "codex" ? { ...r, on: true } : r)),
  custom: [{ kind: "custom", id: "wsp-map", name: "wsp-map", install: ["npm install -g wsp-map@1.0.0"], check: "wsp-map --version", manager: "npm", why: "added by the agent" }],
};

describe("the recipe this host holds, planned for a computer you own", () => {
  let dir: string;
  let home: string;
  let statePath: string;

  const planner = () =>
    placeProvisioner({
      statePath,
      home,
      platform: "linux",
      collect: async (): Promise<Manifest> => FIXTURE,
      brew: async () => new Map(),
    });

  const planned = async (): Promise<ProvisionPlan> => {
    const answer = await planner().plan({ home });
    if ("noRecipe" in answer) throw new Error(`no recipe: ${answer.noRecipe}`);
    return answer;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-place-provision-"));
    home = join(dir, "home");
    statePath = join(dir, "state.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test\n");
    writeFileSync(join(home, ".zshrc"), "export PS1='$ '\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (recipe: Recipe): void => writeFileSync(smallRecipePath(statePath), `${JSON.stringify(recipe, null, 2)}\n`);

  it("sets the plan's PATH to the probe list of the computer it is for, so no step resolves a command through a directory the workspaces there write", async () => {
    write(SMALL);
    const plan = await planner().plan({ home: "/root" });
    if ("noRecipe" in plan) throw new Error(`no recipe: ${plan.noRecipe}`);
    expect(plan.path).toBe(probePath("/root"));
    const exported = plan.steps.flatMap(s => s.cmd.split("\n").filter(l => l.startsWith("export PATH=")));
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.filter(l => l.includes("/root/.local/bin"))).toEqual([]);
  });

  it("installs under a folder of wsp's own on that computer, told to every manager on every script the job sends", async () => {
    write(SMALL);
    const plan = await planner().plan({ home: "/root" });
    if ("noRecipe" in plan) throw new Error(`no recipe: ${plan.noRecipe}`);
    expect(plan.prefix).toBe(TOOL_PREFIX);
    // Every line that puts the job's own list on a script carries the managers' knobs with it, so a row installs
    // where the daemon's fixed PATH looks and no manager writes under the home the workspaces there share.
    const exported = plan.steps.flatMap(s => s.cmd.split("\n").filter(l => l.startsWith("export PATH=") && l.includes(probePath("/root"))));
    expect(exported.length).toBeGreaterThan(0);
    for (const line of exported) expect(line).toBe(pathLine(probePath("/root"), TOOL_PREFIX));
    expect(exported[0]).toContain(`CARGO_HOME=${TOOL_PREFIX}/cargo`);
  });

  it("says where a recipe would be written when this computer holds none, and reads nothing else", async () => {
    const answer = await placeProvisioner({ statePath, home, platform: "linux", collect: async () => { throw new Error("this computer was read for a recipe that is not there"); }, brew: async () => new Map() }).plan({ home });
    expect(answer).toEqual({ noRecipe: smallRecipePath(statePath) });
  });

  it("plans the node step, each ticked agent by its own road after it, and the tools by theirs", async () => {
    write(SMALL);
    const plan = await planned();
    expect(plan.recipeAt).toBe(SMALL.at);
    const ids = plan.steps.map(t => t.id);
    expect(ids[0]).toBe(AGENT_NODE_STEP);
    expect(ids).toContain("agents/claude");
    const codex = plan.steps.find(t => t.id === "agents/codex")!;
    expect(codex.manager).toBe("npm");
    expect(codex.after).toBe(AGENT_NODE_STEP);
    // The version the catalog pins, since a computer somebody owns keeps no sealed version and so no pins.
    const road = catalogEntry("codex")!.installRoad;
    expect(codex.asks).toBe(road.road === "npm" ? road.version : undefined);
    expect(codex.asks).toBe("0.153.0");
    // A row this computer has as a Homebrew formula takes the Homebrew road on that computer too, as it does on
    // the image: the formula's own step, after the Homebrew the plan bootstraps for it.
    const gh = plan.steps.find(t => t.id === "tools/brew/gh")!;
    expect(gh.manager).toBe("brew");
    expect(ids).toContain("tools/homebrew");
    expect(ids.indexOf("tools/homebrew")).toBeLessThan(ids.indexOf("tools/brew/gh"));
  });

  it("puts no sign-in on that computer: those are the vault's and the per-box login's", async () => {
    write(SMALL);
    const plan = await planned();
    expect(plan.steps.some(t => t.id.startsWith("logins/"))).toBe(false);
    expect([...plan.steps, ...plan.skipped].some(t => t.id.startsWith("logins/"))).toBe(false);
  });

  it("puts the rows the catalog has none for last, each after the manager its own line calls", async () => {
    write(SMALL);
    const plan = await planned();
    const own = plan.steps.at(-1)!;
    expect(own.id).toBe("tools/custom/wsp-map");
    expect(own.check).toBe("wsp-map --version");
    // The manager the row names is brought onto that computer before the row runs.
    expect(own.after).toBeDefined();
    expect(plan.steps.some(t => t.id === own.after)).toBe(true);
  });

  it("carries the agents' own files and nothing else of this computer's: no dotfile, no shell rc, no identity", async () => {
    write(SMALL);
    const plan = await planned();
    expect(plan.files?.lands.map(l => [l.id, l.dest])).toEqual([
      // Claude Code's state home reads as the folder wsp gives it on the guest; Codex keeps its own name.
      ["agents/claude", ".claude-cfg"],
      ["agents/codex", ".codex"],
    ]);
    expect(plan.files?.lands.every(l => l.label !== "")).toBe(true);
    const dests = plan.files?.lands.map(l => l.dest) ?? [];
    for (const kept of [".gitconfig", ".zshrc", ".ssh/config", ".config/starship.toml", ".config/mise/config.toml"]) expect(dests).not.toContain(kept);
  });

  it("carries the MCP servers the recipe names, for the agents whose configs travel with them", async () => {
    write(SMALL);
    writeFileSync(join(home, ".claude.json"), '{ "mcpServers": { "github": { "command": "npx" } } }\n');
    const withServer = {
      ...FIXTURE,
      entries: [...FIXTURE.entries, { rung: "agents" as const, id: `${MCP_ID_PREFIX}claude/github`, label: "github", group: "Claude Code MCP servers", paths: ["~/.claude.json"], bytes: 300, default: "bring" as const }],
    };
    const plan = await placeProvisioner({ statePath, home, platform: "linux", collect: async () => withServer, brew: async () => new Map() }).plan({ home });
    if ("noRecipe" in plan) throw new Error("no recipe");
    expect(plan.mcp?.agents.map(a => [a.id, a.scopes.flatMap(sc => sc.keep)])).toEqual([["claude", ["github"]]]);
    // The config the server is defined in travels with the agent's own row, which is what the edit there reads.
    expect(plan.files?.lands.map(l => l.dest)).toContain(".claude-cfg/.claude.json");
  });

  it("puts a server added here with a header on that computer by name: no file there holds the value, and the vault does", async () => {
    write(SMALL);
    await serversActs({ here: () => ({ ...nodeHost(), home }) }).add({ kind: "here" }, { agent: "claude", name: "linear", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_api_TESTONLY" } });
    // This computer's own file holds the value as it was typed.
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toContain("lin_api_TESTONLY");
    const withServer = {
      ...FIXTURE,
      entries: [...FIXTURE.entries, { rung: "agents" as const, id: `${MCP_ID_PREFIX}claude/linear`, label: "linear", group: "Claude Code MCP servers", paths: ["~/.claude.json"], bytes: 300, default: "bring" as const }],
    };
    const g = boxGuest(["npx"]);
    try {
      const plan = await placeProvisioner({ statePath, home, platform: "linux", collect: async () => withServer, brew: async () => new Map() }).plan({ home: g.root });
      if ("noRecipe" in plan || plan.files === undefined || plan.mcp === undefined) throw new Error("no files or servers planned");
      const landed = await provisionFiles(g.machine, { home: g.root, lands: plan.files.lands, pack: plan.files.pack });
      const rows = await provisionMcp(g.machine, plan.mcp, { home: g.root, landed: landed.owned, tools: [], stage: () => {}, path: TOOLS_PATH });
      expect(rows.find(r => r.id === `${MCP_ID_PREFIX}claude/linear`)?.outcome).toBe("installed");
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
      const files = walk(g.root);
      expect(files.some(f => f.endsWith(".claude.json"))).toBe(true);
      for (const f of files) expect(readFileSync(f, "utf8"), f).not.toContain("lin_api_TESTONLY");
      await closeAgentFiles(g.machine, g.root, oncePathsOf(plan.files.lands));
      for (const f of walk(g.root)) expect(readFileSync(f, "utf8"), f).not.toContain("lin_api_TESTONLY");
      expect(readFileSync(join(g.root, ".claude-cfg", ".claude.json"), "utf8")).toContain('"Authorization": "Bearer ${WSP_MCP_LINEAR_AUTHORIZATION}"');
      expect(parseEnvFile(serverEnvFileFor(statePath))).toEqual({ WSP_MCP_LINEAR_AUTHORIZATION: "lin_api_TESTONLY" });
    } finally {
      cleanGuests([g]);
    }
  });

  it("plans nothing at all for a row of this computer that has no Linux road, and sets nothing aside for it", async () => {
    // The recipe locks such a row off before a plan sees it, so it is neither a step nor a row of the job: the
    // rows the plan does set aside are the ones it could not walk, which the engine's own tests read.
    write({ ...SMALL, rows: [...SMALL.rows, { id: "rectangle", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } }] });
    const plan = await planned();
    expect(plan.steps.some(t => t.id === "tools/brew/rectangle")).toBe(false);
    expect(plan.skipped).toEqual([]);
  });
});
