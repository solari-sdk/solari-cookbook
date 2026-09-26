// SPDX-License-Identifier: AGPL-3.0-only
// The MCP stage against a guest that is a temp directory: the configs are read
// off it and the edited bytes land back on it; the command checks, the uv
// install and the df reading are canned, so the files it ends with are the proof.
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMcp, mcpPlanFor, mcpTally, type McpPlan, type McpResult } from "../src/golden-mcp.js";
import { CODEX_TOML, MCP_SERVERS_JSON, OPENCODE_JSON, UV_INSTALL, parseJsonc, type McpEditor, type McpFormat, type McpRemoved } from "@wsp/catalog";
import { MCP_ID_PREFIX, configHardLinkRefusal, shellQuote } from "@wsp/protocol";
import type { RecipeEntry } from "../src/golden-import.js";
import { guardedRoad, type ToolResult } from "../src/golden-tools.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { boxGuest, type BoxGuest } from "./box-guest.js";

const HOME = "/Users/dev";

const row = (id: string, over: Partial<RecipeEntry> = {}): RecipeEntry => ({ rung: "agents", id, label: id.slice(id.lastIndexOf("/") + 1), paths: [], bytes: 0, default: "bring", bring: true, ...over });

const AGENTS = {
  claude: { label: "Claude Code", format: MCP_SERVERS_JSON, files: ["/root/.claude-cfg/.claude.json"] },
  codex: { label: "Codex", format: CODEX_TOML, files: ["/root/.codex/config.toml"] },
  gemini: { label: "Gemini CLI", format: MCP_SERVERS_JSON, files: ["/root/.gemini/settings.json"] },
  opencode: { label: "OpenCode", format: OPENCODE_JSON, files: ["/root/.config/opencode/opencode.json", "/root/.config/opencode/opencode.jsonc"] },
};

describe("mcpPlanFor", () => {
  it("keeps the ticked servers, drops the unticked with their reason and a ticked server whose secret was not answered copy, sets aside an agent that is not ticked, and moves the home scope", () => {
    const rows = [
      row("agents/claude"),
      row(`${MCP_ID_PREFIX}claude/github`),
      row(`${MCP_ID_PREFIX}claude/notes`, { bring: false, default: "skip", reason: "command ~/Library/x is macOS-only, will not run" }),
      row(`${MCP_ID_PREFIX}claude/old`, { bring: false }),
      row(`${MCP_ID_PREFIX}claude/home/zomato`),
      row(`${MCP_ID_PREFIX}claude/gsc`, { consent: true, choice: "skip" }),
      row(`${MCP_ID_PREFIX}claude/home/drive`, { consent: true, choice: "copy" }),
      row("agents/codex", { bring: false }),
      row(`${MCP_ID_PREFIX}codex/grafana`),
      row(`${MCP_ID_PREFIX}mcp-remote`, { paths: ["~/.mcp-auth"] }),
      row("agents/gemini"),
      row("tools/go/codebase-memory-mcp", { rung: "tools" }),
      row("tools/brew/jq", { rung: "tools", bring: false, default: "skip", reason: "no Linux bottle" }),
      row("tools/brew-cask/iterm2", { rung: "tools", bring: false }),
      row("tools/hand/omp", { rung: "tools", bring: false, default: "skip", reason: "installed by hand; no Linux build known" }),
    ];
    expect(mcpPlanFor(rows, { home: HOME, agents: AGENTS })).toEqual<McpPlan>({
      agents: [
        {
          id: "claude", label: "Claude Code",
          scopes: [
            { files: AGENTS.claude.files, format: MCP_SERVERS_JSON, keep: ["github"], drop: [{ name: "notes", reason: "command ~/Library/x is macOS-only, will not run" }, { name: "old", reason: "unticked" }, { name: "gsc", reason: "credential-shaped; not copied without your answer on its row" }] },
            { files: AGENTS.claude.files, format: MCP_SERVERS_JSON, project: { from: HOME, to: "/root" }, keep: ["zomato", "drive"], drop: [] },
          ],
          aside: [],
        },
        { id: "codex", label: "Codex", scopes: [], aside: [{ id: `${MCP_ID_PREFIX}codex/grafana`, name: "grafana", reason: "Codex is not ticked, so its config did not travel" }] },
      ],
      guestHome: "/root",
      rewrites: [[`${HOME}/`, "/root/"], ["/opt/homebrew/", "/home/linuxbrew/.linuxbrew/"]],
      binDirs: [`${HOME}/.local/bin/`, "~/.local/bin/", "/opt/homebrew/bin/", "/opt/homebrew/sbin/"],
      tools: [{ id: "tools/go/codebase-memory-mcp", ticked: true }, { id: "tools/brew/jq", ticked: false, reason: "no Linux bottle" }, { id: "tools/hand/omp", ticked: false, reason: "installed by hand; no Linux build known" }],
    });
  });

  it("is nothing when the recipe has no MCP rows", () => {
    expect(mcpPlanFor([row("agents/claude")], { home: HOME, agents: AGENTS })).toBeUndefined();
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The guest above, with everything it made remembered for the cleanup. */
function guest(present: string[], canned: Record<string, ExecResult> = {}): BoxGuest {
  const g = boxGuest(present, canned);
  dirs.push(...g.dirs);
  return g;
}

const CLAUDE = {
  numStartups: 3,
  mcpServers: {
    github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_secret" } },
    gsc: { command: "uvx", args: ["mcp-search-console"], env: { GSC_CREDENTIALS_PATH: `${HOME}/.config/gsc/creds.json` } },
    notes: { command: `${HOME}/Library/Application Support/Notes/mcp`, args: [] },
    survivor: { command: "survivor-bin", args: [] },
  },
  projects: {
    [HOME]: { allowedTools: ["Bash"], mcpServers: { zomato: { type: "stdio", command: "npx", args: ["mcp-remote", "https://mcp.zomato.com/mcp"] }, whatsapp: { command: `${HOME}/.local/bin/uv`, args: ["--directory", `${HOME}/code/wa`, "run", "main.py"] } } },
  },
};

const CODEX = [
  'model = "gpt-5"',
  "",
  "[mcp_servers.grafana]",
  'command = "/opt/homebrew/bin/uvx"',
  'args = ["mcp-grafana", "--config=/Users/dev/.config/grafana.toml", "/Users/dev/tab\\there"]',
  'note = "keep \\u00e9 \\"quoted\\" and\\ttab"',
  "",
  "[mcp_servers.grafana.env]",
  'GRAFANA_SERVICE_ACCOUNT_TOKEN = "glsa_x" # keep the comment',
  "",
  "[mcp_servers.sentry]",
  'url = "https://mcp.sentry.dev/mcp"',
  'bearer_token_env_var = "SENTRY_TOKEN"',
  "",
  "[mcp_servers.keeper]",
  'command = "keeper"',
  "",
  "[[hooks.SessionStart]]",
  'matcher = "x"',
  "",
].join("\n");

const GEMINI = '{\n  // servers\n  "mcpServers": { "memory": { "command": "~/.local/bin/codebase-memory-mcp" }, "gone": { "command": "/Applications/X.app/x" } },\n  "theme": "dark"\n}\n';

function planOn(root: string, over: Partial<McpPlan> = {}): McpPlan {
  const file = (rel: string): string => join(root, rel);
  return {
    agents: [
      {
        id: "claude", label: "Claude Code",
        scopes: [
          { files: [file(".claude-cfg/.claude.json")], format: MCP_SERVERS_JSON, keep: ["github", "gsc"], drop: [{ name: "notes", reason: "command ~/Library/Application Support/Notes/mcp is macOS-only, will not run" }] },
          { files: [file(".claude-cfg/.claude.json")], format: MCP_SERVERS_JSON, project: { from: HOME, to: root }, keep: ["zomato", "whatsapp"], drop: [] },
        ],
        aside: [],
      },
      { id: "codex", label: "Codex", scopes: [{ files: [file(".codex/config.toml")], format: CODEX_TOML, keep: ["grafana"], drop: [{ name: "sentry", reason: "unticked" }] }], aside: [] },
      { id: "gemini", label: "Gemini CLI", scopes: [{ files: [file(".gemini/settings.json")], format: MCP_SERVERS_JSON, keep: ["memory"], drop: [{ name: "gone", reason: "path /Applications/X.app/x is macOS-only, will not run" }] }], aside: [] },
      { id: "opencode", label: "OpenCode", scopes: [{ files: [file(".config/opencode/opencode.json")], format: OPENCODE_JSON, keep: ["ctx"], drop: [] }], aside: [{ id: `${MCP_ID_PREFIX}opencode/late`, name: "late", reason: "OpenCode is not ticked, so its config did not travel" }] },
    ],
    guestHome: root,
    rewrites: [[`${HOME}/`, `${root}/`], ["/opt/homebrew/", "/home/linuxbrew/.linuxbrew/"]],
    binDirs: [`${HOME}/.local/bin/`, "~/.local/bin/", "/opt/homebrew/bin/", "/opt/homebrew/sbin/"],
    tools: [],
    ...over,
  };
}

function seed(root: string): void {
  mkdirSync(join(root, ".claude-cfg"), { recursive: true });
  writeFileSync(join(root, ".claude-cfg", ".claude.json"), `${JSON.stringify(CLAUDE, null, 2)}\n`);
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "config.toml"), CODEX);
  mkdirSync(join(root, ".gemini"), { recursive: true });
  writeFileSync(join(root, ".gemini", "settings.json"), GEMINI);
}

describe("applyMcp", () => {
  it("writes the kept definitions with their paths rewritten, drops the unticked, leaves a server it never heard of alone, and names each on the stage", async () => {
    const { root, cmds, runs, runOpts, landed, machine } = guest(["npx", "codebase-memory-mcp"]);
    seed(root);
    const stages: string[] = [];
    const results = await applyMcp(machine, planOn(root), (s, d) => void stages.push(`${s}:${d ?? ""}`));
    // One detached run reads every config; the edit itself is this computer's, so the machine runs no node of its own.
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain("wsp_mcp_read 0 ");
    expect(runs[1]).toContain("astral-sh/uv/releases");
    expect(runs[1]).toContain("\nsetsid bash -c '");
    expect(cmds.some(c => c.includes("node -e"))).toBe(false);
    // The read's answer is every config whole, the servers' secrets with it, so it says its output is not a log's.
    expect(runOpts[0]).toMatchObject({ unlogged: true });
    expect(runOpts[1]?.unlogged).toBeUndefined();
    // Each edited config lands beside itself under the writer's own prefix and goes over the file by the one config
    // write, so its mode and owner stand and an agent launching in that moment reads one whole copy or the other.
    const configs = [".claude-cfg/.claude.json", ".codex/config.toml", ".gemini/settings.json"].map(f => join(root, f));
    expect(landed.map(l => dirname(l))).toEqual(configs.map(c => dirname(c)));
    for (const l of landed) expect(basename(l)).toMatch(/^\.wsp-config-tmp\.[0-9a-f]{12}$/);
    const write = cmds.find(c => c.includes(`mv -f "$n" "$r"`))!;
    for (const [i, c] of configs.entries()) {
      expect(write).toContain(`f=${shellQuote(c)}\n`);
      expect(write).toContain(shellQuote(landed[i]!));
    }
    for (const c of configs) expect(readdirSync(dirname(c)).filter(n => n.startsWith(".wsp-"))).toEqual([]);
    const check = cmds.find(c => c.split("\n")[1]?.startsWith("if command -v"))!;
    expect(check).toBeDefined();
    expect(runs).not.toContain(check);

    const claude = JSON.parse(readFileSync(join(root, ".claude-cfg", ".claude.json"), "utf8"));
    expect(claude.numStartups).toBe(3);
    expect(Object.keys(claude.mcpServers)).toEqual(["github", "gsc", "survivor"]);
    expect(claude.mcpServers.github).toEqual(CLAUDE.mcpServers.github);
    expect(claude.mcpServers.gsc.env.GSC_CREDENTIALS_PATH).toBe(`${root}/.config/gsc/creds.json`);
    // Servers local to the laptop's home folder now belong to the machine's; the rest of the laptop project entry stays.
    expect(claude.projects[HOME]).toEqual({ allowedTools: ["Bash"], mcpServers: {} });
    expect(claude.projects[root].mcpServers).toEqual({
      zomato: CLAUDE.projects[HOME].mcpServers.zomato,
      whatsapp: { command: "uv", args: ["--directory", `${root}/code/wa`, "run", "main.py"] },
    });

    const codex = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(codex).toBe([
      'model = "gpt-5"',
      "",
      "[mcp_servers.grafana]",
      'command = "uvx"',
      // A rewritten string keeps its escapes; one the rewrite never touched is left byte for byte.
      `args = ["mcp-grafana", "--config=${root}/.config/grafana.toml", "${root}/tab\\there"]`,
      'note = "keep \\u00e9 \\"quoted\\" and\\ttab"',
      "",
      "[mcp_servers.grafana.env]",
      'GRAFANA_SERVICE_ACCOUNT_TOKEN = "glsa_x" # keep the comment',
      "",
      "[mcp_servers.keeper]",
      'command = "keeper"',
      "",
      "[[hooks.SessionStart]]",
      'matcher = "x"',
      "",
    ].join("\n"));

    const gemini = readFileSync(join(root, ".gemini", "settings.json"), "utf8");
    expect(parseJsonc(gemini)).toEqual({ mcpServers: { memory: { command: "codebase-memory-mcp" } }, theme: "dark" });
    expect(gemini).toContain("  // servers\n");

    // A definition whose package npx or uv pulls down when the agent first starts it is in place, not installed.
    expect(results).toEqual<McpResult[]>([
      { id: `${MCP_ID_PREFIX}claude/github`, agent: "Claude Code", name: "github", outcome: "fetched-on-first-use", note: "npx fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}claude/gsc`, agent: "Claude Code", name: "gsc", outcome: "fetched-on-first-use", note: "uv installed for it; uv fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}claude/notes`, agent: "Claude Code", name: "notes", outcome: "skipped", note: "command ~/Library/Application Support/Notes/mcp is macOS-only, will not run" },
      { id: `${MCP_ID_PREFIX}claude/home/zomato`, agent: "Claude Code", name: "zomato", outcome: "fetched-on-first-use", note: "npx fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}claude/home/whatsapp`, agent: "Claude Code", name: "whatsapp", outcome: "fetched-on-first-use", note: "uv installed for it; uv fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}codex/grafana`, agent: "Codex", name: "grafana", outcome: "fetched-on-first-use", note: "uv installed for it; uv fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}codex/sentry`, agent: "Codex", name: "sentry", outcome: "skipped", note: "unticked" },
      { id: `${MCP_ID_PREFIX}gemini/memory`, agent: "Gemini CLI", name: "memory", outcome: "installed" },
      { id: `${MCP_ID_PREFIX}gemini/gone`, agent: "Gemini CLI", name: "gone", outcome: "skipped", note: "path /Applications/X.app/x is macOS-only, will not run" },
      { id: `${MCP_ID_PREFIX}opencode/ctx`, agent: "OpenCode", name: "ctx", outcome: "skipped", note: "OpenCode's config is not on the machine" },
      { id: `${MCP_ID_PREFIX}opencode/late`, agent: "OpenCode", name: "late", outcome: "skipped", note: "OpenCode is not ticked, so its config did not travel" },
    ]);
    expect(stages).toEqual([
      "installing-mcp:Claude Code 5, Codex 2, Gemini CLI 2, OpenCode 2",
      "installing-mcp:uv for gsc, whatsapp, grafana",
      "installing-mcp:memory installed; github, zomato: package fetched on first use by npx; gsc, whatsapp, grafana: uv installed, package fetched on first use by uv; notes skipped (command ~/Library/Application Support/Notes/mcp is macOS-only, will not run); sentry skipped (unticked); gone skipped (path /Applications/X.app/x is macOS-only, will not run); ctx skipped (OpenCode's config is not on the machine); late skipped (OpenCode is not ticked, so its config did not travel); 2.9 GB free",
    ]);
    // Every command is looked for once on the machine's PATH; uv, found missing, is installed by its checksummed release.
    const checks = cmds.filter(c => c.includes("command -v '"));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatch(/command -v 'npx'.*command -v 'uvx'.*command -v 'uv'.*command -v 'codebase-memory-mcp'/s);
    expect(cmds.filter(c => c.includes("astral-sh/uv/releases"))).toHaveLength(1);
    expect(cmds.indexOf(checks[0]!)).toBeLessThan(cmds.findIndex(c => c.includes("astral-sh/uv/releases")));
    expect(cmds.some(c => c.includes("ghp_secret"))).toBe(false);
    // uv is a script road row in the catalog, so the stage walks that road and takes set -euo pipefail from it rather than writing its own.
    expect(cmds.find(c => c.includes("astral-sh/uv/releases"))).toBe(guardedRoad("script", UV_INSTALL));
  });

  it("the tally for the stage's end line counts the servers by outcome, zero counts left out, and says nothing for an empty plan", () => {
    const row = (name: string, outcome: McpResult["outcome"]): McpResult => ({ id: `${MCP_ID_PREFIX}claude/${name}`, agent: "Claude Code", name, outcome });
    expect(mcpTally([row("a", "installed"), row("b", "installed"), row("c", "skipped"), row("d", "fetched-on-first-use")])).toBe("2 installed, 1 skipped, 1 on first use");
    expect(mcpTally([row("a", "installed")])).toBe("1 installed");
    expect(mcpTally([])).toBeUndefined();
  });

  const geminiOnly = (root: string, over: Partial<McpPlan> = {}): McpPlan =>
    planOn(root, { agents: [{ id: "gemini", label: "Gemini CLI", scopes: [{ files: [join(root, ".gemini/settings.json")], format: MCP_SERVERS_JSON, keep: ["memory", "vanished"], drop: [] }], aside: [] }], ...over });
  const geminiServers = (root: string): string[] => Object.keys((parseJsonc(readFileSync(join(root, ".gemini/settings.json"), "utf8")) as { mcpServers: object }).mcpServers);

  it("a server whose command is not on the machine is taken out of the config and skipped with the reason; a kept server the config no longer holds is named", async () => {
    const { root, machine } = guest(["npx"]);
    seed(root);
    const stages: string[] = [];
    const results = await applyMcp(machine, geminiOnly(root), (s, d) => void stages.push(d ?? s));
    expect(results).toEqual<McpResult[]>([
      { id: `${MCP_ID_PREFIX}gemini/vanished`, agent: "Gemini CLI", name: "vanished", outcome: "skipped", note: "not in the config that travelled" },
      { id: `${MCP_ID_PREFIX}gemini/memory`, agent: "Gemini CLI", name: "memory", outcome: "skipped", note: "command not on the machine" },
    ]);
    expect(geminiServers(root)).toEqual(["gone"]);
    expect(stages.at(-1)).toBe("vanished skipped (not in the config that travelled); memory skipped (command not on the machine); 2.9 GB free");
  });

  it("a server whose command is on the machine is written and installed", async () => {
    const { root, machine } = guest(["codebase-memory-mcp"]);
    seed(root);
    const results = await applyMcp(machine, geminiOnly(root), () => {});
    expect(results[0]).toEqual({ id: `${MCP_ID_PREFIX}gemini/memory`, agent: "Gemini CLI", name: "memory", outcome: "installed" });
    expect(geminiServers(root)).toEqual(["memory", "gone"]);
  });

  it("a server that runs through npx is written even when npx is not on the machine yet", async () => {
    const { root, machine } = guest([]);
    seed(root);
    const plan = planOn(root, { agents: [{ id: "claude", label: "Claude Code", scopes: [{ files: [join(root, ".claude-cfg/.claude.json")], format: MCP_SERVERS_JSON, keep: ["github"], drop: [] }], aside: [] }] });
    const results = await applyMcp(machine, plan, () => {});
    expect(results).toEqual<McpResult[]>([
      { id: `${MCP_ID_PREFIX}claude/github`, agent: "Claude Code", name: "github", outcome: "fetched-on-first-use", note: "npx fetches the package on first use; npx is not on the machine; the server starts once it is installed there" },
    ]);
    expect(Object.keys(JSON.parse(readFileSync(join(root, ".claude-cfg/.claude.json"), "utf8")).mcpServers)).toContain("github");
  });

  it("the reason names the recipe's tool row that would have brought the command, and what became of it", async () => {
    const cases: { row: McpPlan["tools"][number]; result?: ToolResult; note: string }[] = [
      { row: { id: "tools/go/codebase-memory-mcp", ticked: true }, result: { id: "tools/go/codebase-memory-mcp", label: "codebase-memory-mcp", outcome: "skipped", note: "1.8 GB free, keeping 2 GB free" }, note: "command not on the machine; tools/go/codebase-memory-mcp was skipped (1.8 GB free, keeping 2 GB free)" },
      { row: { id: "tools/go/codebase-memory-mcp", ticked: true }, result: { id: "tools/go/codebase-memory-mcp", label: "codebase-memory-mcp", outcome: "failed", note: "exit 1: go: module not found" }, note: "command not on the machine; tools/go/codebase-memory-mcp failed (exit 1: go: module not found)" },
      { row: { id: "tools/brew/codebase-memory-mcp", ticked: false, reason: "no Linux bottle" }, note: "command not on the machine; tools/brew/codebase-memory-mcp was not ticked (no Linux bottle)" },
      { row: { id: "tools/cargo/codebase-memory-mcp", ticked: false }, note: "command not on the machine; tools/cargo/codebase-memory-mcp was not ticked" },
      { row: { id: "tools/npm/codebase-memory-mcp", ticked: true }, note: "command not on the machine; tools/npm/codebase-memory-mcp was ticked, but nothing by that name is on PATH" },
      { row: { id: "tools/go/other-bin", ticked: true }, result: { id: "tools/go/other-bin", label: "other-bin", outcome: "skipped", note: "1.8 GB free, keeping 2 GB free" }, note: "command not on the machine" },
    ];
    for (const c of cases) {
      const { root, machine } = guest(["npx"]);
      seed(root);
      const results = await applyMcp(machine, geminiOnly(root, { tools: [c.row] }), () => {}, c.result !== undefined ? [c.result] : []);
      expect(results.find(r => r.name === "memory")?.note).toBe(c.note);
    }
  });

  it("running twice leaves the files as they were after the first run and reports the same, the moved home servers included", async () => {
    const { root, machine } = guest(["npx", "uv", "codebase-memory-mcp"]);
    seed(root);
    const first = await applyMcp(machine, planOn(root), () => {});
    const after = [".claude-cfg/.claude.json", ".codex/config.toml", ".gemini/settings.json"].map(f => readFileSync(join(root, f), "utf8"));
    const second = await applyMcp(machine, planOn(root), () => {});
    expect([".claude-cfg/.claude.json", ".codex/config.toml", ".gemini/settings.json"].map(f => readFileSync(join(root, f), "utf8"))).toEqual(after);
    expect(second).toEqual(first);
    expect(second.filter(r => r.name === "zomato" || r.name === "whatsapp").map(r => r.outcome)).toEqual(["fetched-on-first-use", "fetched-on-first-use"]);
  });

  it("OpenCode's config: the kept local server's command and paths are rewritten under the mcp key, the dropped one comes out, the rest of the file stays", async () => {
    const { root, machine } = guest(["ctx-bin"]);
    mkdirSync(join(root, ".config", "opencode"), { recursive: true });
    const before = { $schema: "https://opencode.ai/config.json", theme: "dark", mcp: { ctx: { type: "local", command: ["/opt/homebrew/bin/ctx-bin", `${HOME}/notes`], enabled: true }, late: { type: "remote", url: "https://late.example/mcp" }, other: { type: "remote", url: "https://o.example" } } };
    writeFileSync(join(root, ".config", "opencode", "opencode.json"), `${JSON.stringify(before, null, 2)}\n`);
    const plan = planOn(root, { agents: [{ id: "opencode", label: "OpenCode", scopes: [{ files: [join(root, ".config/opencode/opencode.json")], format: OPENCODE_JSON, keep: ["ctx"], drop: [{ name: "late", reason: "unticked" }] }], aside: [] }] });
    const results = await applyMcp(machine, plan, () => {});
    expect(results).toEqual<McpResult[]>([
      { id: `${MCP_ID_PREFIX}opencode/ctx`, agent: "OpenCode", name: "ctx", outcome: "installed" },
      { id: `${MCP_ID_PREFIX}opencode/late`, agent: "OpenCode", name: "late", outcome: "skipped", note: "unticked" },
    ]);
    expect(JSON.parse(readFileSync(join(root, ".config", "opencode", "opencode.json"), "utf8"))).toEqual({
      $schema: "https://opencode.ai/config.json", theme: "dark",
      mcp: { ctx: { type: "local", command: ["ctx-bin", `${root}/notes`], enabled: true }, other: { type: "remote", url: "https://o.example" } },
    });
  });

  // A format the catalog does not have: one line per server, `name command args...`. The stage runs it with no
  // change of its own, so a fourth format is one module on the catalog entry.
  const linesEditor: McpEditor = (lib, scope, before) => {
    const kept = before.split("\n").filter(l => l !== "" && !scope.drop.includes(l.split(" ")[0]!));
    const out = kept.map(l => {
      const [name, command, ...args] = l.split(" ");
      return scope.keep.includes(name!) ? [name, lib.rewriteString(command!, true), ...args.map(a => lib.rewriteString(a, false))].join(" ") : l;
    });
    const written = scope.keep.map(name => {
      const line = out.find(l => l.startsWith(`${name} `));
      return line === undefined ? { name, outcome: "missing" as const } : { name, outcome: "written" as const, command: line.split(" ")[1]! };
    });
    return { text: `${out.join("\n")}\n`, results: [...written, ...scope.drop.map(name => ({ name, outcome: "dropped" as const }))] };
  };
  const lineOf = (text: string, name: string): string | undefined => text.split("\n").find(l => l.startsWith(`${name} `));
  /** The same format's merge, so a fourth format is still one module: each kept name's line taken from the copy
   * that travelled, the lines of the agent's own file that are not wsp's left where they are. */
  const linesMerge: McpFormat["merge"] = (lib, scope, own, travelled) => {
    const replace = new Set(scope.replace);
    let lines = (own ?? "").split("\n").filter(l => l !== "");
    const results = scope.keep.map(name => {
      const line = lineOf(travelled, name);
      if (line === undefined) return { name, outcome: "missing" as const };
      const [, command, ...args] = line.split(" ");
      const next = [name, lib.rewriteString(command!, true), ...args.map(a => lib.rewriteString(a, false))].join(" ");
      const here = lineOf(lines.join("\n"), name);
      const said = (outcome: "added" | "replaced" | "same" | "theirs") => ({ name, outcome, command: next.split(" ")[1]! });
      if (here === next) return said("same");
      if (here !== undefined && !replace.has(name)) return said("theirs");
      lines = [...lines.filter(l => l !== here), next];
      return said(here === undefined ? "added" : "replaced");
    });
    const dropped = scope.drop.map(name => {
      const here = lineOf(lines.join("\n"), name);
      if (here === undefined || !replace.has(name)) return { name, outcome: "left" as const };
      lines = lines.filter(l => l !== here);
      return { name, outcome: "dropped" as const };
    });
    return { text: `${lines.join("\n")}\n`, results: [...results, ...dropped], commentsDropped: false };
  };
  const linesRemove = (text: string, names: readonly string[]): McpRemoved => ({ text: text.split("\n").filter(l => !names.includes(l.split(" ")[0] ?? "")).join("\n") });
  const LINES: McpFormat = { read: () => [], place: () => ({ text: "" }), edit: linesEditor, entryOf: (text, name) => lineOf(text, name), merge: linesMerge, remove: linesRemove, refer: async text => ({ text, servers: [], entries: [] }) };

  it("a format the catalog gains is one module: the stage runs the module's editor over the text it read and reports through it, with no format of its own", async () => {
    const { root, cmds, machine } = guest(["alpha"]);
    mkdirSync(join(root, ".lines"));
    writeFileSync(join(root, ".lines", "servers.txt"), `alpha /opt/homebrew/bin/alpha --dir=${HOME}/x\nbeta beta-bin\nother keeper\n`);
    const plan = planOn(root, { agents: [{ id: "lines", label: "Lines", scopes: [{ files: [join(root, ".lines/servers.txt")], format: LINES, keep: ["alpha", "gone"], drop: [{ name: "beta", reason: "unticked" }] }], aside: [] }] });
    const results = await applyMcp(machine, plan, () => {});
    expect(results).toEqual<McpResult[]>([
      { id: `${MCP_ID_PREFIX}lines/alpha`, agent: "Lines", name: "alpha", outcome: "installed" },
      { id: `${MCP_ID_PREFIX}lines/gone`, agent: "Lines", name: "gone", outcome: "skipped", note: "not in the config that travelled" },
      { id: `${MCP_ID_PREFIX}lines/beta`, agent: "Lines", name: "beta", outcome: "skipped", note: "unticked" },
    ]);
    expect(readFileSync(join(root, ".lines", "servers.txt"), "utf8")).toBe(`alpha alpha --dir=${root}/x\nother keeper\n`);
    // Nothing of the format reaches the machine: it reads the file out and takes the bytes back.
    expect(cmds.some(c => c.includes("node -e"))).toBe(false);
    expect(cmds.some(c => c.includes("mcp_servers"))).toBe(false);
  });

  it("a read whose leader was killed says so by its exit code: its output is every config whole, so no reason is built from it", async () => {
    const { root, machine } = guest(["npx"]);
    seed(root);
    // What the wrapper leaves when the leader dies by a signal: the exit file holds 137, the err file is empty, and
    // the out file holds the lines printed so far, which here is a config of the person's.
    const printed = Buffer.from(JSON.stringify(CLAUDE), "utf8").toString("base64");
    const killed = { ...machine, run: async (script: string, o: { deadlineMs: number }) => (script.includes("wsp_mcp_read ") ? { exitCode: 137, stdout: `${printed}\n`, stderr: "" } : machine.run(script, o)) } as unknown as Machine;
    const stages: string[] = [];
    const results = await applyMcp(killed, planOn(root), (s, d) => void stages.push(d ?? s));
    expect(results.find(r => r.name === "github")?.note).toBe("the config edit did not run (exit 137)");
    expect(printed.length).toBeGreaterThan(160);
    for (const said of [...results.map(r => r.note ?? ""), ...stages]) {
      expect(said).not.toContain(printed);
      expect(said).not.toContain(printed.slice(0, 60));
      expect(said).not.toContain("ghp_secret");
    }
  });

  it("a machine that refuses the script, as the provider does over its body cap, skips every server with the words, touches no config, and does not throw", async () => {
    const { root, machine } = guest(["npx"]);
    seed(root);
    const before = readFileSync(join(root, ".claude-cfg", ".claude.json"), "utf8");
    const refusing = { ...machine, run: async () => { throw Object.assign(new Error("Payload Too Large"), { kind: "unknown", status: 413 }); }, putBytes: machine.putBytes } as unknown as Machine;
    const stages: string[] = [];
    const results = await applyMcp(refusing, planOn(root), (s, d) => void stages.push(d ?? s));
    expect(results.map(r => r.outcome)).toEqual(Array.from({ length: 11 }, () => "skipped"));
    expect(results.find(r => r.name === "github")).toEqual({ id: `${MCP_ID_PREFIX}claude/github`, agent: "Claude Code", name: "github", outcome: "skipped", note: "the config edit did not run (Payload Too Large)" });
    expect(results.find(r => r.name === "notes")?.note).toBe("command ~/Library/Application Support/Notes/mcp is macOS-only, will not run");
    expect(stages.at(-1)).toContain("github skipped (the config edit did not run (Payload Too Large))");
    expect(readFileSync(join(root, ".claude-cfg", ".claude.json"), "utf8")).toBe(before);
  });

  it("a write the machine refuses leaves no landing beside the config: those bytes are the whole file at the upload road's own mode", async () => {
    const { root, cmds, landed, machine } = guest(["codebase-memory-mcp"]);
    seed(root);
    const refusing = { ...machine, exec: async (cmd: string) => (cmd.includes('mv -f "$n" "$r"') ? { exitCode: 1, stdout: "", stderr: "cat: write error: No space left on device" } : machine.exec(cmd)) } as unknown as Machine;
    const results = await applyMcp(refusing, geminiOnly(root), () => {});
    expect(results.find(r => r.name === "memory")?.note).toBe("the edited config did not land (cat: write error: No space left on device)");
    expect(landed).toHaveLength(1);
    expect(existsSync(landed[0]!)).toBe(false);
    expect(cmds).toContain(`rm -f ${shellQuote(landed[0]!)}`);
    // The config itself is as it was: the write never ran.
    expect(readFileSync(join(root, ".gemini", "settings.json"), "utf8")).toBe(GEMINI);
  });

  it("a config with a second hard link is left as it is with the words, and one linked inside the home is written through and stays a link", async () => {
    const { root, machine } = guest(["codebase-memory-mcp"]);
    seed(root);
    linkSync(join(root, ".gemini", "settings.json"), join(root, "twin.json"));
    const refused = await applyMcp(machine, geminiOnly(root), () => {});
    expect(refused.find(r => r.name === "memory")?.note).toBe(`the edited config did not land (${configHardLinkRefusal(join(root, ".gemini", "settings.json"))})`);
    expect(readFileSync(join(root, ".gemini", "settings.json"), "utf8")).toBe(GEMINI);
    expect(readdirSync(join(root, ".gemini")).filter(n => n.startsWith(".wsp-"))).toEqual([]);

    rmSync(join(root, "twin.json"));
    mkdirSync(join(root, "dotfiles"));
    renameSync(join(root, ".gemini", "settings.json"), join(root, "dotfiles", "settings.json"));
    symlinkSync(join(root, "dotfiles", "settings.json"), join(root, ".gemini", "settings.json"));
    await applyMcp(machine, geminiOnly(root), () => {});
    expect(lstatSync(join(root, ".gemini", "settings.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "dotfiles", "settings.json"), "utf8")).toContain('"memory": { "command": "codebase-memory-mcp" }');
  });

  it("a config that is on the machine and empty did not parse; it is not a config that is not there", async () => {
    const { root, machine } = guest(["codebase-memory-mcp"]);
    mkdirSync(join(root, ".gemini"), { recursive: true });
    writeFileSync(join(root, ".gemini", "settings.json"), "");
    const results = await applyMcp(machine, geminiOnly(root), () => {});
    expect(results.map(r => r.note)).toEqual([expect.stringContaining("did not parse"), expect.stringContaining("did not parse")]);
    expect(results.some(r => r.note?.includes("is not on the machine"))).toBe(false);
  });

  it("a PATH check the machine refuses drops no server: the definitions land and the stage still closes", async () => {
    const { root, machine, cmds } = guest(["npx"]);
    seed(root);
    const refusing = { ...machine, exec: async (cmd: string) => { if (cmd.includes("command -v")) throw new Error("Bad Gateway"); return machine.exec(cmd); } } as unknown as Machine;
    const results = await applyMcp(refusing, geminiOnly(root), () => {});
    expect(geminiServers(root)).toEqual(["memory", "gone"]);
    expect(results.find(r => r.name === "memory")).toMatchObject({ outcome: "installed" });
    expect(cmds.filter(c => c.includes("command -v"))).toHaveLength(0);
  });

  it("a failed uv install is named on every server that needed it, and the definitions still land", async () => {
    const { root, machine } = guest(["npx"], { uv: { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" } });
    seed(root);
    const results = await applyMcp(machine, planOn(root), () => {});
    expect(results.find(r => r.name === "gsc")).toEqual({ id: `${MCP_ID_PREFIX}claude/gsc`, agent: "Claude Code", name: "gsc", outcome: "fetched-on-first-use", note: "uv did not install (curl: (6) Could not resolve host); the server starts once it is installed there; uv fetches the package on first use" });
    expect(Object.keys(JSON.parse(readFileSync(join(root, ".claude-cfg", ".claude.json"), "utf8")).mcpServers)).toEqual(["github", "gsc", "survivor"]);
  });
});
