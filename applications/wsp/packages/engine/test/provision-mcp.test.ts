// SPDX-License-Identifier: AGPL-3.0-only
// The recipe's MCP servers on a computer somebody owns. The guest is a temp
// directory with real files in it, so what the run ends with is the file on
// disk: the file an agent keeps its servers in is merged key by key, every
// other key of its own stands, and a server the agent or the person has under
// one of the recipe's names is left with its row saying so.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_TOML, MCP_SERVERS_JSON, OPENCODE_JSON, parseJsonc } from "@wsp/catalog";
import { MCP_ID_PREFIX, TOOLS_PATH, placeProvisionPaths } from "@wsp/protocol";
import type { McpPlan } from "../src/golden-mcp.js";
import { closeAgentFiles, oncePathsOf, provisionFiles, type ProvisionLanding } from "../src/provision-files.js";
import { provisionMcp, theirServerLine } from "../src/provision-mcp.js";
import { tarOf } from "../src/vault.js";
import type { PackedFiles } from "../src/golden.js";
import { boxGuest, cleanGuests, type BoxGuest } from "./box-guest.js";

const HOME = "/Users/dev";

const guests: BoxGuest[] = [];
afterEach(() => cleanGuests(guests.splice(0)));

function box(present: string[] = ["npx"]): BoxGuest {
  const g = boxGuest(present);
  guests.push(g);
  return g;
}

/** What Claude Code writes for itself the first time it runs on that computer, with one server the person added
 * there by hand under a name the recipe also carries. */
const CLAUDE_ON_BOX = `${JSON.stringify(
  {
    numStartups: 41,
    oauthAccount: { emailAddress: "he@example.com" },
    mcpServers: { mine: { command: "/usr/local/bin/mine", args: [] } },
    projects: { "/root/work": { history: ["his own turn"] } },
  },
  null,
  2,
)}\n`;

/** This computer's own copy of each agent's file, which is what travels: the recipe's servers are taken from it. */
const CLAUDE_TRAVELLED = (gsc: string[] = ["--stdio"], far = false): string =>
  `${JSON.stringify(
    {
      numStartups: 7,
      mcpServers: {
        gsc: { command: "npx", args: ["-y", "gsc-mcp", ...gsc] },
        notes: { command: `${HOME}/Library/Notes/mcp`, args: [] },
        mine: { command: "npx", args: ["theirs-on-the-mac"] },
        ...(far ? { far: { command: "/usr/bin/far-mcp", args: [] } } : {}),
      },
    },
    null,
    2,
  )}\n`;

const CODEX_TRAVELLED = ['model = "gpt-5"', "", "[mcp_servers.context7]", 'command = "npx"', 'args = ["-y", "context7"]', "", "[mcp_servers.grafana]", 'command = "npx"', ""].join("\n");

/** OpenCode's own config as somebody keeps it on that computer: jsonc, with a comment of the person's. */
const OPENCODE_ON_BOX = '{\n  // my own servers\n  "theme": "dark",\n  "mcp": {}\n}\n';
const OPENCODE_TRAVELLED = `${JSON.stringify({ mcp: { docs: { type: "local", command: ["npx", "docs-mcp"], enabled: true } } }, null, 2)}\n`;

const opencodePlanOn = (root: string): McpPlan => ({
  agents: [{ id: "opencode", label: "OpenCode", scopes: [{ files: [join(root, ".config/opencode/opencode.json")], format: OPENCODE_JSON, keep: ["docs"], drop: [] }], aside: [] }],
  guestHome: root,
  rewrites: [[`${HOME}/`, `${root}/`]],
  binDirs: [],
  tools: [],
});

const LANDS: ProvisionLanding[] = [
  { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/.claude.json", once: true },
  { id: "agents/codex", label: "Codex", dest: ".codex/config.toml", once: true },
];

function planOn(root: string, far = false, unticked: readonly string[] = []): McpPlan {
  const asked = ["gsc", "mine", ...(far ? ["far"] : [])];
  return {
    agents: [
      {
        id: "claude",
        label: "Claude Code",
        scopes: [
          {
            files: [join(root, ".claude-cfg/.claude.json")],
            format: MCP_SERVERS_JSON,
            keep: asked.filter(name => !unticked.includes(name)),
            drop: [{ name: "notes", reason: "command is macOS-only, will not run" }, ...unticked.map(name => ({ name, reason: "unticked" }))],
          },
        ],
        aside: [],
      },
      { id: "codex", label: "Codex", scopes: [{ files: [join(root, ".codex/config.toml")], format: CODEX_TOML, keep: ["context7"], drop: [{ name: "grafana", reason: "unticked" }] }], aside: [] },
    ],
    guestHome: root,
    rewrites: [[`${HOME}/`, `${root}/`]],
    binDirs: [`${HOME}/.local/bin/`],
    tools: [],
  };
}

const packed = (tar: Buffer): PackedFiles => ({ tar, bytes: tar.length, unpacked: tar.length, skipped: [], cut: [], silenced: [], macPaths: [] });

const tarOfConfigs = (claude: string, codex: string): Buffer =>
  tarOf([
    { path: ".claude-cfg/.claude.json", mode: 0o600, content: claude },
    { path: ".codex/config.toml", mode: 0o600, content: codex },
  ]);

/** One run of the job's files and servers rounds on that computer, in the order the job runs them, with the close
 * that folds what it wrote into the list beside the job. */
async function run(g: BoxGuest, o: { claude?: string; codex?: string; far?: boolean; untick?: readonly string[] } = {}): Promise<{ files: [string, string][]; servers: [string, string, string | undefined][]; closing: string }> {
  const said: string[] = [];
  const landed = await provisionFiles(g.machine, { home: g.root, lands: LANDS, pack: async () => packed(tarOfConfigs(o.claude ?? CLAUDE_TRAVELLED(["--stdio"], o.far === true), o.codex ?? CODEX_TRAVELLED)) });
  const servers = await provisionMcp(g.machine, planOn(g.root, o.far === true, o.untick ?? []), {
    home: g.root,
    landed: landed.owned,
    tools: [],
    path: TOOLS_PATH,
    stage: (_which, detail) => {
      if (detail !== undefined) said.push(detail);
    },
  });
  await closeAgentFiles(g.machine, g.root, oncePathsOf(LANDS));
  return {
    files: landed.rows.map(r => [r.id, r.outcome]),
    servers: servers.map(r => [r.id, r.outcome, r.note]),
    closing: said.at(-1) ?? "",
  };
}

const list = (root: string): string[] => readFileSync(placeProvisionPaths(root).landed, "utf8").split("\n").filter(l => l !== "");
const claudeOf = (root: string): { numStartups: number; oauthAccount: unknown; projects: Record<string, unknown>; mcpServers: Record<string, { command: string; args: string[] }> } =>
  JSON.parse(readFileSync(join(root, ".claude-cfg/.claude.json"), "utf8")) as never;

describe("the recipe's servers on a computer somebody owns", { timeout: 60_000 }, () => {
  it("merges them into the file its agent keeps, reads them present on the next run, and writes its own copy again only where this computer's changed", async () => {
    const g = box();
    const { root } = g;
    mkdirSync(join(root, ".claude-cfg"), { recursive: true });
    writeFileSync(join(root, ".claude-cfg/.claude.json"), CLAUDE_ON_BOX);

    // The first run: Claude Code has already run on that computer, so its file stands and its servers are merged
    // into it; Codex has not, so its file lands whole and the servers that came in it arrived with this run.
    const first = await run(g);
    expect(first.files).toEqual([
      ["files/.claude-cfg/.claude.json", "present"],
      ["files/.codex/config.toml", "installed"],
    ]);
    expect(first.servers).toEqual([
      // Both run through npx, which brings the package down at the agent's first use of the server.
      [`${MCP_ID_PREFIX}claude/gsc`, "installed", "npx fetches the package on first use"],
      [`${MCP_ID_PREFIX}claude/notes`, "skipped", "command is macOS-only, will not run"],
      [`${MCP_ID_PREFIX}claude/mine`, "skipped", theirServerLine("Claude Code", "mine", join(root, ".claude-cfg/.claude.json"))],
      [`${MCP_ID_PREFIX}codex/context7`, "installed", "npx fetches the package on first use"],
      [`${MCP_ID_PREFIX}codex/grafana`, "skipped", "unticked"],
    ]);
    // A file that arrived whole is wsp's own hand for that run, so the server the person unticked comes out of it
    // again rather than standing there because nobody owns it.
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).not.toContain("grafana");
    // Every key the agent wrote for itself stands, and the server the person put there is the one they wrote.
    const after = claudeOf(root);
    expect(after.numStartups).toBe(41);
    expect(after.oauthAccount).toEqual({ emailAddress: "he@example.com" });
    expect(after.projects).toEqual({ "/root/work": { history: ["his own turn"] } });
    expect(after.mcpServers["mine"]).toEqual({ command: "/usr/local/bin/mine", args: [] });
    expect(after.mcpServers["gsc"]).toEqual({ command: "npx", args: ["-y", "gsc-mcp", "--stdio"] });
    // The list holds one line per key wsp wrote and not one line for either file: what wsp owns in a file its
    // agent keeps is the keys, never the bytes.
    expect(list(root)).toHaveLength(2);
    expect(list(root).map(l => l.split("\t")[0]).sort()).toEqual([`${MCP_ID_PREFIX}claude/gsc`, `${MCP_ID_PREFIX}codex/context7`]);

    // Both agents write their own files again, as they do at every launch and at the first turn in a folder.
    const rewritten = claudeOf(root);
    writeFileSync(join(root, ".claude-cfg/.claude.json"), `${JSON.stringify({ ...rewritten, numStartups: 42, projects: { ...rewritten.projects, "/root/again": { history: [] } } }, null, 2)}\n`);
    writeFileSync(join(root, ".codex/config.toml"), `${readFileSync(join(root, ".codex/config.toml"), "utf8")}\n[projects."/root/repo"]\ntrust_level = "trusted"\n`);
    const listed = list(root).sort();

    const second = await run(g);
    expect(second.files).toEqual([
      ["files/.claude-cfg/.claude.json", "present"],
      ["files/.codex/config.toml", "present"],
    ]);
    expect(second.servers.map(r => [r[0], r[1]])).toEqual([
      [`${MCP_ID_PREFIX}claude/gsc`, "present"],
      [`${MCP_ID_PREFIX}claude/notes`, "skipped"],
      [`${MCP_ID_PREFIX}claude/mine`, "skipped"],
      [`${MCP_ID_PREFIX}codex/context7`, "present"],
      [`${MCP_ID_PREFIX}codex/grafana`, "skipped"],
    ]);
    expect(list(root).sort()).toEqual(listed);
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toContain('[projects."/root/repo"]');
    // The words the round closes with say what its rows say: nothing on this run was installed.
    expect(second.closing).toContain("gsc, context7 already there");
    expect(second.closing).not.toContain("installed");
    expect(second.closing).not.toContain("fetched");

    // This computer's copy of one server changed: that key is wsp's own by the list, so it is written again.
    const third = await run(g, { claude: CLAUDE_TRAVELLED(["--stdio", "--verbose"]) });
    expect(third.servers.map(r => [r[0], r[1]])).toEqual([
      [`${MCP_ID_PREFIX}claude/gsc`, "installed"],
      [`${MCP_ID_PREFIX}claude/notes`, "skipped"],
      [`${MCP_ID_PREFIX}claude/mine`, "skipped"],
      [`${MCP_ID_PREFIX}codex/context7`, "present"],
      [`${MCP_ID_PREFIX}codex/grafana`, "skipped"],
    ]);
    const held = claudeOf(root);
    expect(held.mcpServers["gsc"]!.args).toEqual(["-y", "gsc-mcp", "--stdio", "--verbose"]);
    expect(held.numStartups).toBe(42);
    expect(held.projects["/root/again"]).toEqual({ history: [] });
    expect(held.mcpServers["mine"]).toEqual({ command: "/usr/local/bin/mine", args: [] });
    // And on a run where one server did arrive, the closing words name that one and say the other is already there.
    expect(third.closing).toContain("context7 already there");
    expect(third.closing).toContain("gsc: package fetched on first use by npx");
    expect(third.closing).not.toContain("context7 installed");
    const gsc = list(root).find(l => l.startsWith(`${MCP_ID_PREFIX}claude/gsc\t`))!;
    expect(gsc).not.toBe(listed.find(l => l.startsWith(`${MCP_ID_PREFIX}claude/gsc\t`)));
    expect(list(root)).toHaveLength(2);
  });

  it("leaves a server the agent itself rewrote since, names whose it is, and skips one whose command that computer does not have", async () => {
    const g = box();
    const { root } = g;
    mkdirSync(join(root, ".claude-cfg"), { recursive: true });
    writeFileSync(join(root, ".claude-cfg/.claude.json"), CLAUDE_ON_BOX);
    const first = await run(g, { far: true });
    expect(first.servers.find(r => r[0] === `${MCP_ID_PREFIX}claude/far`)).toEqual([`${MCP_ID_PREFIX}claude/far`, "skipped", "command not on the machine"]);
    expect(claudeOf(root).mcpServers["far"]).toBeUndefined();

    // The agent adds a field of its own to the entry wsp wrote: the entry is no longer the one the list holds, so
    // it is the agent's from here on and the next run leaves it exactly as it is.
    const held = claudeOf(root);
    held.mcpServers["gsc"] = { ...held.mcpServers["gsc"]!, args: ["-y", "gsc-mcp", "--stdio", "--codex-added-this"] };
    const theirs = `${JSON.stringify(held, null, 2)}\n`;
    writeFileSync(join(root, ".claude-cfg/.claude.json"), theirs);
    const again = await run(g, { claude: CLAUDE_TRAVELLED(["--stdio", "--verbose"]) });
    expect(again.servers.find(r => r[0] === `${MCP_ID_PREFIX}claude/gsc`)).toEqual([
      `${MCP_ID_PREFIX}claude/gsc`,
      "skipped",
      theirServerLine("Claude Code", "gsc", join(root, ".claude-cfg/.claude.json")),
    ]);
    expect(readFileSync(join(root, ".claude-cfg/.claude.json"), "utf8")).toBe(theirs);
  });

  it("writes down the keys it no longer owns, so the list stops naming a server that was unticked on this computer", async () => {
    const g = box();
    const { root } = g;
    mkdirSync(join(root, ".claude-cfg"), { recursive: true });
    writeFileSync(join(root, ".claude-cfg/.claude.json"), CLAUDE_ON_BOX);
    await run(g);
    expect(list(root).map(l => l.split("\t")[0]).sort()).toEqual([`${MCP_ID_PREFIX}claude/gsc`, `${MCP_ID_PREFIX}codex/context7`]);

    // The person unticks that server on this computer: the merge takes wsp's own entry back out of the file its
    // agent keeps, and the list stops saying wsp owns the name.
    const second = await run(g, { untick: ["gsc"] });
    expect(second.servers.find(r => r[0] === `${MCP_ID_PREFIX}claude/gsc`)![1]).toBe("skipped");
    expect(claudeOf(root).mcpServers["gsc"]).toBeUndefined();
    expect(list(root).map(l => l.split("\t")[0])).toEqual([`${MCP_ID_PREFIX}codex/context7`]);
    // What the round wrote down for a name it no longer owns is itself out of the list: it is read once, by the
    // close, and what stands afterwards is what wsp owns.
    expect(readFileSync(placeProvisionPaths(root).landed, "utf8")).not.toContain("\t-\t-");
    // Every key the agent wrote for itself and the server the person put there are where they were.
    expect(claudeOf(root).numStartups).toBe(41);
    expect(claudeOf(root).mcpServers["mine"]).toEqual({ command: "/usr/local/bin/mine", args: [] });
  });

  it("merges into a jsonc config in place, so the person's comments stand and no row says anything of them", async () => {
    const g = box();
    const { root } = g;
    const config = join(root, ".config/opencode/opencode.json");
    mkdirSync(join(root, ".config/opencode"), { recursive: true });
    writeFileSync(config, OPENCODE_ON_BOX);
    const lands: ProvisionLanding[] = [{ id: "agents/opencode", label: "OpenCode", dest: ".config/opencode/opencode.json", once: true }];
    const landed = await provisionFiles(g.machine, { home: root, lands, pack: async () => packed(tarOf([{ path: ".config/opencode/opencode.json", mode: 0o600, content: OPENCODE_TRAVELLED }])) });
    const rows = await provisionMcp(g.machine, opencodePlanOn(root), { home: root, landed: landed.owned, tools: [], path: TOOLS_PATH, stage: () => {} });
    expect(rows.map(r => [r.id, r.outcome, r.note])).toEqual([[`${MCP_ID_PREFIX}opencode/docs`, "installed", "npx fetches the package on first use"]]);
    const held = readFileSync(config, "utf8");
    expect(parseJsonc(held)).toEqual({ theme: "dark", mcp: { docs: { type: "local", command: ["npx", "docs-mcp"], enabled: true } } });
    expect(held).toContain("  // my own servers\n");
  });

  it("leaves a config that is on no computer to the merge itself, which skips its servers rather than writing a file nobody has", async () => {
    const { root, machine } = box();
    const rows = await provisionMcp(machine, planOn(root), { home: root, landed: new Map(), tools: [], stage: () => {}, path: TOOLS_PATH });
    expect(rows.every(r => r.outcome === "skipped")).toBe(true);
    expect(rows[0]!.note).toContain("Claude Code's config is not on the machine");
  });
});
