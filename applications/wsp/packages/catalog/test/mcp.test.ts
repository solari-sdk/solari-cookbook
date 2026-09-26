// SPDX-License-Identifier: AGPL-3.0-only
// Each agent's MCP config: the files it reads servers from (among the entry's
// own config paths) and its format module, which reads the servers a file
// defines, places the wsp server in a fresh file or beside what the person
// already has, once, on every run, and carries the editor the machine runs.
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS, CODEX_TOML, GEMINI_SETTINGS_JSON, MCP_AGENTS, MCP_SERVERS_JSON, OPENCODE_JSON, catalogEntry, mcpSwitch, parseJsonc, type McpEditLib, type McpFormat, type McpServer, type McpTransport } from "../src/index.js";

const HOME = "/Users/dev";
const SERVER = { kind: "stdio", command: "/usr/local/bin/node", args: ["/opt/wsp/bin.js", "mcp", "--state", "/Users/me/.wsp/state.json"], env: {} } satisfies McpTransport;
const stdio = (command: string, args: string[]): McpTransport => ({ kind: "stdio", command, args, env: {} });

describe("the catalog's MCP configs", () => {
  it("are registered from the agent entries that have one, each naming its format module and files among the entry's own config paths", () => {
    expect(MCP_AGENTS.map(a => a.id)).toEqual(["claude", "codex", "gemini", "opencode"]);
    expect(MCP_AGENTS.map(a => a.mcp.format)).toEqual([MCP_SERVERS_JSON, CODEX_TOML, GEMINI_SETTINGS_JSON, OPENCODE_JSON]);
    for (const a of MCP_AGENTS) for (const f of a.mcp.files) expect(a.configPaths, a.id).toContain(f);
    expect(CATALOG_AGENTS.filter(a => a.mcp !== undefined)).toEqual(MCP_AGENTS);
    expect(catalogEntry("pi")).toMatchObject({ kind: "agent" });
    expect((catalogEntry("pi") as { mcp?: unknown }).mcp).toBeUndefined();
  });

  it("every module carries the edit the import runs over the text it read off the machine, and the merge a computer somebody owns runs into the file its agent keeps", () => {
    for (const format of new Set<McpFormat>(MCP_AGENTS.map(a => a.mcp.format))) {
      expect(typeof format.edit).toBe("function");
      expect(typeof format.merge).toBe("function");
      expect(typeof format.entryOf).toBe("function");
    }
  });
});

describe("read", () => {
  it("mcpServers JSON: command or url entries at the root are user scope, the home folder's project entry is home scope, and entries that name neither are left out", () => {
    const text = JSON.stringify({
      mcpServers: { a: { command: "x" }, b: { url: "https://b" }, c: { type: "sse", url: "https://c" }, d: {} },
      projects: { [HOME]: { mcpServers: { z: { type: "stdio", command: "npx", args: ["mcp-remote", "https://z"] } } }, [`${HOME}/code`]: { mcpServers: { other: { command: "o" } } } },
    });
    expect(MCP_SERVERS_JSON.read(text, HOME)).toEqual<McpServer[]>([
      { name: "a", scope: "user", transport: { kind: "stdio", command: "x", args: [], env: {} }, envRefs: [] },
      { name: "b", scope: "user", transport: { kind: "http", url: "https://b", headers: {} }, envRefs: [] },
      { name: "c", scope: "user", transport: { kind: "http", url: "https://c", headers: {} }, envRefs: [] },
      { name: "z", scope: "home", transport: { kind: "stdio", command: "npx", args: ["mcp-remote", "https://z"], env: {} }, envRefs: [] },
    ]);
    const gemini = '{\n  // my servers\n  "mcpServers": { "docs": { "httpUrl": "https://docs.example/mcp", "headers": { "Authorization": "Bearer abcdef" } }, },\n}\n';
    expect(MCP_SERVERS_JSON.read(gemini, HOME)).toEqual<McpServer[]>([{ name: "docs", scope: "user", transport: { kind: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer abcdef" } }, envRefs: [] }]);
    expect(MCP_SERVERS_JSON.read("nope", HOME)).toEqual([]);
    expect(MCP_SERVERS_JSON.read("[]", HOME)).toEqual([]);
  });

  it("OpenCode's JSON: local entries carry the command as one array with their environment, remote ones a url; an empty command is no server", () => {
    const text = '{ "mcp": { "memory": { "type": "local", "command": ["/Users/dev/.local/bin/mem", "--v"], "environment": { "MEM_KEY": "k" }, "enabled": true }, "ctx": { "type": "remote", "url": "https://ctx.example/mcp" }, "none": { "type": "local", "command": [] } } }';
    expect(OPENCODE_JSON.read(text, HOME)).toEqual<McpServer[]>([
      { name: "memory", scope: "user", transport: { kind: "stdio", command: "/Users/dev/.local/bin/mem", args: ["--v"], env: { MEM_KEY: "k" } }, envRefs: [] },
      { name: "ctx", scope: "user", transport: { kind: "http", url: "https://ctx.example/mcp", headers: {} }, envRefs: [] },
    ]);
  });

  it("a header that takes its value from the environment names the variable it reads: ${X} in mcpServers JSON, {env:X} in OpenCode's", () => {
    const claude = MCP_SERVERS_JSON.read(JSON.stringify({ mcpServers: { a: { type: "http", url: "https://a.example/mcp", headers: { Authorization: "Bearer ${A_TOKEN}", "X-Org": "${ORG:-acme}", Plain: "static" } }, b: { type: "http", url: "https://b.example/mcp", headers: { X: "no $REF here" } } } }), HOME);
    expect(claude.map(s => [s.name, s.envRefs])).toEqual([["a", ["A_TOKEN", "ORG"]], ["b", []]]);
    const opencode = OPENCODE_JSON.read(JSON.stringify({ mcp: { c: { type: "remote", url: "https://c.example/mcp", headers: { Authorization: "Bearer {env:C_TOKEN}" } } } }), HOME);
    expect(opencode.map(s => [s.name, s.envRefs])).toEqual([["c", ["C_TOKEN"]]]);
  });

  it("a url that takes part of itself from the environment names the variable, and Gemini CLI's bare $X counts where Claude Code's does not", () => {
    const servers = { u: { url: "https://${MCP_HOST}/mcp" }, h: { httpUrl: "https://h.example/mcp", headers: { Authorization: "Bearer $TOK", "X-Org": "${ORG}" } } };
    const claude = MCP_SERVERS_JSON.read(JSON.stringify({ mcpServers: servers }), HOME);
    expect(claude.map(s => [s.name, s.envRefs])).toEqual([["u", ["MCP_HOST"]], ["h", ["ORG"]]]);
    const gemini = GEMINI_SETTINGS_JSON.read(JSON.stringify({ mcpServers: servers }), HOME);
    expect(gemini.map(s => [s.name, s.envRefs])).toEqual([["u", ["MCP_HOST"]], ["h", ["TOK", "ORG"]]]);
    expect(GEMINI_SETTINGS_JSON.read(JSON.stringify({ mcpServers: { p: { url: "https://p.example/mcp", headers: { X: "costs $5" } } } }), HOME)[0]!.envRefs).toEqual([]);
  });

  it("Codex's TOML: mcp_servers tables with their env, header and bearer sub-keys, quoted names, multi-line arrays and inline tables, in file order", () => {
    const toml = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.grafana]",
      'command = "/opt/homebrew/bin/uvx"',
      'args = ["mcp-grafana", "a\\tb\\u00e9"]',
      "",
      "[mcp_servers.grafana.env]",
      'GRAFANA_SERVICE_ACCOUNT_TOKEN = "glsa_abcdefghij"',
      'GRAFANA_URL = "https://g.example" # keep',
      "",
      "# a remote one",
      "[mcp_servers.sentry]",
      'url = "https://mcp.sentry.dev/mcp?x=1"',
      'bearer_token_env_var = "SENTRY_TOKEN"',
      "",
      "[mcp_servers.sentry.env_http_headers]",
      'X-Org = "SENTRY_ORG"',
      "",
      '[mcp_servers."my server"]',
      "command = 'node'",
      "args = [",
      '  "/Applications/Tool.app/Contents/mcp.js",',
      "]",
      'env = { A_KEY = "1234" }',
      "",
      "[[hooks.SessionStart]]",
      'matcher = "x"',
    ].join("\n");
    expect(CODEX_TOML.read(toml, HOME)).toEqual<McpServer[]>([
      { name: "grafana", scope: "user", transport: { kind: "stdio", command: "/opt/homebrew/bin/uvx", args: ["mcp-grafana", "a\tbé"], env: { GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_abcdefghij", GRAFANA_URL: "https://g.example" } }, envRefs: [] },
      { name: "sentry", scope: "user", transport: { kind: "http", url: "https://mcp.sentry.dev/mcp?x=1", headers: {} }, envRefs: ["SENTRY_TOKEN", "SENTRY_ORG"] },
      { name: "my server", scope: "user", transport: { kind: "stdio", command: "node", args: ["/Applications/Tool.app/Contents/mcp.js"], env: { A_KEY: "1234" } }, envRefs: [] },
    ]);
    expect(CODEX_TOML.read('model = "x"\n', HOME)).toEqual([]);
  });
});

describe("place", () => {
  it("mcpServers JSON (Claude Code, Gemini CLI): a fresh file holds the server; an existing one keeps its keys and other servers, and a rerun replaces", () => {
    const fresh = MCP_SERVERS_JSON.place(undefined, "wsp", SERVER).text;
    expect(JSON.parse(fresh)).toEqual({ mcpServers: { wsp: { command: SERVER.command, args: SERVER.args } } });
    expect(fresh.endsWith("\n")).toBe(true);
    const existing = JSON.stringify({ numStartups: 4, mcpServers: { other: { command: "x", args: [] }, wsp: { command: "old", args: [] } }, projects: { "/a": {} } });
    const placed = JSON.parse(MCP_SERVERS_JSON.place(existing, "wsp", SERVER).text) as Record<string, unknown>;
    expect(placed).toEqual({ numStartups: 4, mcpServers: { other: { command: "x", args: [] }, wsp: { command: SERVER.command, args: SERVER.args } }, projects: { "/a": {} } });
    expect(Object.keys(placed)).toEqual(["numStartups", "mcpServers", "projects"]);
    expect(MCP_SERVERS_JSON.place("", "wsp", SERVER).text).toBe(fresh);
    expect(() => MCP_SERVERS_JSON.place("{ not json", "wsp", SERVER).text).toThrow("the file is not valid JSON; add the server by hand");
    expect(() => MCP_SERVERS_JSON.place("[]", "wsp", SERVER).text).toThrow("the file is not a JSON object; add the server by hand");
  });

  it("OpenCode's JSON: the server is a local mcp entry whose command is one array, enabled", () => {
    const placed = JSON.parse(OPENCODE_JSON.place('{ "$schema": "https://opencode.ai/config.json", "theme": "x" }', "wsp", SERVER).text);
    expect(placed).toEqual({ $schema: "https://opencode.ai/config.json", theme: "x", mcp: { wsp: { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true } } });
  });

  it("a settings file with comments and a trailing comma (OpenCode's jsonc, Gemini CLI's settings) is placed into in place: its comments stay, its other servers intact", () => {
    const jsonc = '{\n  // servers I use\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    /* memory */ "other": { "type": "local", "command": ["x"], "enabled": true },\n  },\n}\n';
    const placed = OPENCODE_JSON.place(jsonc, "wsp", SERVER).text;
    expect(parseJsonc(placed)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { other: { type: "local", command: ["x"], enabled: true }, wsp: { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true } },
    });
    expect(placed).toContain("// servers I use\n");
    expect(placed).toContain('/* memory */ "other": {');
    const gemini = MCP_SERVERS_JSON.place('{ "theme": "dark", // the look\n "mcpServers": { "docs": { "url": "https://docs.example/mcp" }, }, }', "wsp", SERVER).text;
    expect(gemini).toContain("// the look\n");
    expect(parseJsonc(gemini)).toEqual({ theme: "dark", mcpServers: { docs: { url: "https://docs.example/mcp" }, wsp: { command: SERVER.command, args: SERVER.args } } });
    const url = OPENCODE_JSON.place('{ "mcp": { "ctx": { "type": "remote", "url": "https://ctx.example/*/mcp" } }, }', "wsp", SERVER).text;
    expect((parseJsonc(url) as { mcp: { ctx: { url: string } } }).mcp.ctx.url).toBe("https://ctx.example/*/mcp");
  });

  it("an add goes on a line of its own after the last server, so the comment at the end of that server's line stays its own", () => {
    const text = '{\n  "mcpServers": { // header\n    "a": { "command": "x" } // note on a\n  }\n}\n';
    const placed = MCP_SERVERS_JSON.place(text, "w", stdio("n", [])).text;
    expect(placed).toBe('{\n  "mcpServers": { // header\n    "a": { "command": "x" }, // note on a\n    "w": {\n      "command": "n",\n      "args": []\n    }\n  }\n}\n');
    const empty = MCP_SERVERS_JSON.remove(placed, ["a", "w"]).text;
    expect(empty).toBe('{\n  "mcpServers": { // header\n  }\n}\n');
    expect(MCP_SERVERS_JSON.place(empty, "w", stdio("n", [])).text).toBe('{\n  "mcpServers": { // header\n    "w": {\n      "command": "n",\n      "args": []\n    }\n  }\n}\n');
  });

  it("a file that holds the servers' key twice is refused rather than edited into something it was not meant to read as", () => {
    const twice = '{ "mcpServers": { "a": { "command": "x" } }, // mine\n "mcpServers": { "b": { "command": "y" } } }';
    expect(() => MCP_SERVERS_JSON.place(twice, "wsp", SERVER)).toThrow("the file could not be changed in place, which keeps its comments; change it by hand");
    expect(() => MCP_SERVERS_JSON.remove(twice, ["b"])).toThrow("the file could not be changed in place, which keeps its comments; change it by hand");
  });

  it("Codex's TOML: a fresh file is one table; an existing file gets the table appended; a rerun replaces the table and leaves its neighbours", () => {
    const table = `[mcp_servers.wsp]\ncommand = "/usr/local/bin/node"\nargs = ["/opt/wsp/bin.js", "mcp", "--state", "/Users/me/.wsp/state.json"]\n`;
    expect(CODEX_TOML.place(undefined, "wsp", SERVER).text).toBe(table);
    const existing = 'model = "gpt-5"\n\n[projects."/Users/me/proj"]\ntrust_level = "trusted"\n';
    const appended = CODEX_TOML.place(existing, "wsp", SERVER).text;
    expect(appended).toBe(`${existing}\n${table}`);
    const rerun = CODEX_TOML.place(`${appended}\n[mcp_servers.other]\ncommand = "x"\n`, "wsp", stdio("/new/node", ["a"])).text;
    expect(rerun).toBe(`${existing}\n[mcp_servers.wsp]\ncommand = "/new/node"\nargs = ["a"]\n\n[mcp_servers.other]\ncommand = "x"\n`);
    expect(CODEX_TOML.place(rerun, "wsp", stdio("/new/node", ["a"])).text).toBe(rerun);
  });

  it("Codex's TOML quotes a path with a quote or a backslash in it as a basic string", () => {
    const placed = CODEX_TOML.place(undefined, "wsp", stdio('C:\\node "x".exe', [])).text;
    expect(placed).toContain('command = "C:\\\\node \\"x\\".exe"');
  });

  it("Codex's TOML quotes a server name that is not a bare key in the table header, and reads it back; a rerun still replaces it", () => {
    const placed = CODEX_TOML.place(undefined, "my server]\n[mcp_servers.other", SERVER).text;
    expect(placed.split("\n").filter(l => l.startsWith("[")).length).toBe(1);
    expect(placed).toContain('[mcp_servers."my server]\\n[mcp_servers.other"]');
    const spaced = CODEX_TOML.place("[other]\nx = 1\n", "my server", SERVER).text;
    expect(spaced).toContain('[mcp_servers."my server"]\n');
    expect(CODEX_TOML.read(spaced, "/home/u").map(s => s.name)).toEqual(["my server"]);
    const rerun = CODEX_TOML.place(spaced, "my server", stdio("/new/node", [])).text;
    expect(rerun.match(/\[mcp_servers\./g)?.length).toBe(1);
    expect(rerun).toContain('command = "/new/node"');
  });
});

describe("place, every transport a person adds", () => {
  const WITH_ENV: McpTransport = { kind: "stdio", command: "npx", args: ["-y", "@acme/mcp", "--flag"], env: { ACME_KEY: "sk-acme-x", ACME_ORG: "o 1" } };
  const REMOTE: McpTransport = { kind: "http", url: "https://mcp.acme.example/mcp", headers: { Authorization: "Bearer tok-x", "X-Org": "acme" } };
  const BARE_REMOTE: McpTransport = { kind: "http", url: "https://mcp.plain.example/mcp", headers: {} };
  const FORMATS: [string, McpFormat][] = [["Claude Code", MCP_SERVERS_JSON], ["Gemini CLI", GEMINI_SETTINGS_JSON], ["OpenCode", OPENCODE_JSON], ["Codex", CODEX_TOML]];

  it("each format reads back what it placed: a command with its arguments and variables, and an address with its headers", () => {
    for (const [agent, format] of FORMATS) {
      for (const t of [WITH_ENV, REMOTE, BARE_REMOTE, SERVER]) {
        const placed = format.place(undefined, "acme", t).text;
        expect(format.read(placed, HOME).map(s => s.transport), `${agent} ${t.kind}`).toEqual([t]);
      }
    }
  });

  it("Claude Code writes an address as an http entry, Gemini CLI as httpUrl, each with its headers, and a command with its env only where it has one", () => {
    expect(JSON.parse(MCP_SERVERS_JSON.place(undefined, "acme", REMOTE).text)).toEqual({ mcpServers: { acme: { type: "http", url: REMOTE.url, headers: { Authorization: "Bearer tok-x", "X-Org": "acme" } } } });
    expect(JSON.parse(MCP_SERVERS_JSON.place(undefined, "acme", BARE_REMOTE).text)).toEqual({ mcpServers: { acme: { type: "http", url: BARE_REMOTE.url } } });
    expect(JSON.parse(GEMINI_SETTINGS_JSON.place(undefined, "acme", REMOTE).text)).toEqual({ mcpServers: { acme: { httpUrl: REMOTE.url, headers: { Authorization: "Bearer tok-x", "X-Org": "acme" } } } });
    expect(JSON.parse(MCP_SERVERS_JSON.place(undefined, "acme", WITH_ENV).text)).toEqual({ mcpServers: { acme: { command: "npx", args: ["-y", "@acme/mcp", "--flag"], env: { ACME_KEY: "sk-acme-x", ACME_ORG: "o 1" } } } });
    expect(JSON.parse(GEMINI_SETTINGS_JSON.place(undefined, "wsp", SERVER).text)).toEqual({ mcpServers: { wsp: { command: SERVER.command, args: SERVER.args } } });
  });

  it("OpenCode writes a command's variables as its environment and an address as a remote entry, both enabled", () => {
    expect(JSON.parse(OPENCODE_JSON.place(undefined, "acme", WITH_ENV).text)).toEqual({ mcp: { acme: { type: "local", command: ["npx", "-y", "@acme/mcp", "--flag"], enabled: true, environment: { ACME_KEY: "sk-acme-x", ACME_ORG: "o 1" } } } });
    expect(JSON.parse(OPENCODE_JSON.place(undefined, "acme", REMOTE).text)).toEqual({ mcp: { acme: { type: "remote", url: REMOTE.url, enabled: true, headers: { Authorization: "Bearer tok-x", "X-Org": "acme" } } } });
  });

  it("Codex writes a command's variables and an address's headers as inline tables, every key and value quoted", () => {
    expect(CODEX_TOML.place(undefined, "acme", WITH_ENV).text).toBe('[mcp_servers.acme]\ncommand = "npx"\nargs = ["-y", "@acme/mcp", "--flag"]\nenv = { "ACME_KEY" = "sk-acme-x", "ACME_ORG" = "o 1" }\n');
    expect(CODEX_TOML.place(undefined, "acme", REMOTE).text).toBe('[mcp_servers.acme]\nurl = "https://mcp.acme.example/mcp"\nhttp_headers = { "Authorization" = "Bearer tok-x", "X-Org" = "acme" }\n');
    const tricky: McpTransport = { kind: "stdio", command: "x", args: [], env: { K: 'a "quoted" \\ value' } };
    expect(CODEX_TOML.read(CODEX_TOML.place(undefined, "t", tricky).text, HOME)[0]!.transport).toEqual(tricky);
  });

  it("a server placed beside others leaves every other server in the file as it was", () => {
    const claude = JSON.stringify({ numStartups: 2, mcpServers: { mine: { command: "m", args: [] } } });
    expect(JSON.parse(MCP_SERVERS_JSON.place(claude, "acme", REMOTE).text).mcpServers.mine).toEqual({ command: "m", args: [] });
    const codex = '[mcp_servers.mine]\ncommand = "m"\n';
    expect(CODEX_TOML.read(CODEX_TOML.place(codex, "acme", REMOTE).text, HOME).map(s => s.name)).toEqual(["mine", "acme"]);
  });
});

describe("enable", () => {
  it("OpenCode turns a server off and on by its enabled field, and the read says so", () => {
    const text = OPENCODE_JSON.place(OPENCODE_JSON.place(undefined, "a", SERVER).text, "b", REMOTE_B).text;
    const off = OPENCODE_JSON.enable!(text, "a", false);
    expect(OPENCODE_JSON.read(off.text, HOME).map(s => [s.name, s.disabled === true])).toEqual([["a", true], ["b", false]]);
    const on = OPENCODE_JSON.enable!(off.text, "a", true);
    expect(OPENCODE_JSON.read(on.text, HOME).map(s => [s.name, s.disabled === true])).toEqual([["a", false], ["b", false]]);
  });

  it("Codex turns a server off with an enabled line in its own table and on by taking that line out, every other line byte for byte", () => {
    const text = `${CODEX_OWN}\n[mcp_servers.a]\ncommand = "x"\n\n[mcp_servers.a.env]\nK = "v"\n\n[mcp_servers.b]\ncommand = "y"\n`;
    const off = CODEX_TOML.enable!(text, "a", false);
    expect(off.text).toBe(`${CODEX_OWN}\n[mcp_servers.a]\nenabled = false\ncommand = "x"\n\n[mcp_servers.a.env]\nK = "v"\n\n[mcp_servers.b]\ncommand = "y"\n`);
    expect(CODEX_TOML.read(off.text, HOME).map(s => [s.name, s.disabled === true])).toEqual([["mine", false], ["a", true], ["b", false]]);
    expect(CODEX_TOML.enable!(off.text, "a", true).text).toBe(text);
    const written = text.replace('[mcp_servers.a]\ncommand = "x"', '[mcp_servers.a]\ncommand = "x"\nenabled = true # mine');
    expect(CODEX_TOML.enable!(written, "a", false).text).toBe(written.replace("enabled = true # mine", "enabled = false"));
  });

  it("Gemini CLI turns a server off by its name in mcp.excluded and on by taking it out; the read says so", () => {
    const text = JSON.stringify({ theme: "dark", mcp: { allowed: ["b"] }, mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    const off = GEMINI_SETTINGS_JSON.enable!(text, "a", false);
    expect(JSON.parse(off.text)).toEqual({ theme: "dark", mcp: { allowed: ["b"], excluded: ["a"] }, mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    expect(GEMINI_SETTINGS_JSON.read(off.text, HOME).map(s => [s.name, s.disabled === true])).toEqual([["a", true], ["b", false]]);
    expect(JSON.parse(GEMINI_SETTINGS_JSON.enable!(off.text, "a", true).text)).toEqual({ theme: "dark", mcp: { allowed: ["b"], excluded: [] }, mcpServers: { a: { command: "x" }, b: { command: "y" } } });
  });

  it("OpenCode and Gemini CLI flip a switch in place, so a jsonc file keeps its comments", () => {
    const opencode = '{\n  // mine\n  "mcp": { "a": { "type": "local", "command": ["x"], "enabled": true } }\n}\n';
    const off = OPENCODE_JSON.enable!(opencode, "a", false).text;
    expect(off).toBe(opencode.replace('"enabled": true', '"enabled": false'));
    const gemini = '{\n  // mine\n  "mcpServers": { "a": { "command": "x" } }\n}\n';
    const excluded = GEMINI_SETTINGS_JSON.enable!(gemini, "a", false).text;
    expect(excluded).toContain("// mine\n");
    expect(parseJsonc(excluded)).toEqual({ mcpServers: { a: { command: "x" } }, mcp: { excluded: ["a"] } });
    expect(parseJsonc(GEMINI_SETTINGS_JSON.enable!(excluded, "a", true).text)).toEqual({ mcpServers: { a: { command: "x" } }, mcp: { excluded: [] } });
  });

  it("Claude Code keeps no switch a person turns per server, so its format has none, and the agent reads as having none", () => {
    expect(MCP_SERVERS_JSON.enable).toBeUndefined();
    expect(MCP_AGENTS.map(a => [a.id, mcpSwitch(a.id)])).toEqual([["claude", false], ["codex", true], ["gemini", true], ["opencode", true]]);
    expect(mcpSwitch("pi")).toBe(false);
  });
});

const REMOTE_B: McpTransport = { kind: "http", url: "https://b.example/mcp", headers: {} };

const CODEX_OWN = [
  'model = "gpt-5"',
  "",
  '[projects."/private/tmp/proof-907/repo"]',
  'trust_level = "trusted"',
  "",
  "[hooks.state]",
  "enabled = true",
  "",
  "[mcp_servers.mine]",
  'command = "/usr/local/bin/mine"',
  "",
  "[mcp_servers.mine.env]",
  'MINE_KEY = "abc"',
  "",
].join("\n");

const CODEX_TRAVELLED = (args: string[] = ["--stdio"]): string =>
  [
    "[mcp_servers.context7]",
    `command = "${HOME}/.local/bin/context7"`,
    `args = [${args.map(a => `"${a}"`).join(", ")}]`,
    "",
    "[mcp_servers.context7.env]",
    'KEY = "k"',
    "",
    "[mcp_servers.mine]",
    `command = "${HOME}/other"`,
    "",
    "[mcp_servers.gone]",
    'command = "x"',
    "",
  ].join("\n");

/** The machine's own words for a string of this computer's: the home moves, and a command right under a bin
 * directory is on the machine's PATH by name. */
const LIB: McpEditLib = { rewriteString: (s, command) => (command && s === `${HOME}/.local/bin/bare` ? "bare" : s.startsWith(`${HOME}/`) ? `/root/${s.slice(HOME.length + 1)}` : s) };

const CLAUDE_OWN = `${JSON.stringify(
  {
    numStartups: 41,
    oauthAccount: { emailAddress: "he@example.com" },
    mcpServers: { mine: { command: "/usr/local/bin/mine", args: [] } },
    projects: { "/root/work": { history: ["his own turn"] } },
  },
  null,
  2,
)}\n`;

const CLAUDE_TRAVELLED = (gscArgs: string[] = ["--stdio"]): string =>
  `${JSON.stringify(
    {
      numStartups: 3,
      mcpServers: { gsc: { command: `${HOME}/.local/bin/bare`, args: gscArgs }, notion: { command: "npx", args: ["-y", "notion-mcp"] }, mine: { command: `${HOME}/other`, args: [] } },
      projects: { [HOME]: { mcpServers: { zed: { command: `${HOME}/.local/bin/zed`, args: [] } } } },
    },
    null,
    2,
  )}\n`;

/** A jsonc config as a person keeps one: comments above, beside and below its keys and servers. */
const COMMENTS = ["// top of the file", "// beside the theme", "/* before the servers */", "// the person's own server", "// end of mine", "/* his */", "// the end"];
const commented = (key: string, entry: (command: string) => unknown): string =>
  [
    "{",
    "  // top of the file",
    '  "theme": "x", // beside the theme',
    "  /* before the servers */",
    `  ${JSON.stringify(key)}: {`,
    "    // the person's own server",
    `    "mine": ${JSON.stringify(entry("/usr/local/bin/mine"))}, // end of mine`,
    `    "old": ${JSON.stringify(entry("x"))}`,
    "  },",
    '  "projects": { "/root/work": { /* his */ "history": [] } }',
    "}",
    "// the end",
    "",
  ].join("\n");
const JSON_FORMATS: [McpFormat, string, (command: string) => unknown][] = [
  [MCP_SERVERS_JSON, "mcpServers", command => ({ command, args: [] })],
  [GEMINI_SETTINGS_JSON, "mcpServers", command => ({ command, args: [] })],
  [OPENCODE_JSON, "mcp", command => ({ type: "local", command: [command] })],
];

describe("edit", () => {
  it("every JSON format edits a jsonc file in place: each comment outside what it took out stands, a kept server's strings are rewritten where they are, and a folder's servers move", () => {
    for (const [format, key, entry] of JSON_FORMATS) {
      const own = commented(key, entry).replace('"/usr/local/bin/mine"', JSON.stringify(`${HOME}/mine`));
      const edited = format.edit(LIB, { keep: ["mine"], drop: ["old"] }, own);
      expect(edited.results, key).toEqual([{ name: "mine", outcome: "written", command: "/root/mine" }, { name: "old", outcome: "dropped" }]);
      for (const c of COMMENTS) expect(edited.text, c).toContain(c);
      expect((parseJsonc(edited.text) as Record<string, unknown>)[key]).toEqual({ mine: entry("/root/mine") });
      expect(format.edit(LIB, { keep: ["nobody"], drop: [] }, own).text).toBe(own);
    }
    const home = commented("mcpServers", c => ({ command: c })).replace('"projects": { "/root/work"', `"projects": { ${JSON.stringify(HOME)}: { "mcpServers": { "zed": { "command": ${JSON.stringify(`${HOME}/zed`)} } } }, "/root/work"`);
    const moved = MCP_SERVERS_JSON.edit(LIB, { keep: ["zed"], drop: [], project: { from: HOME, to: "/root" } }, home);
    for (const c of COMMENTS) expect(moved.text, c).toContain(c);
    expect((parseJsonc(moved.text) as { projects: Record<string, unknown> }).projects).toEqual({ [HOME]: { mcpServers: {} }, "/root/work": { history: [] }, "/root": { mcpServers: { zed: { command: "/root/zed" } } } });
  });
});

describe("merge", () => {
  it("mcpServers JSON: the agent's own keys and the server the person has stand, wsp's are added, and a second merge over what it landed writes nothing", () => {
    const merged = MCP_SERVERS_JSON.merge(LIB, { keep: ["gsc", "notion", "mine"], drop: [], replace: [] }, CLAUDE_OWN, CLAUDE_TRAVELLED());
    expect(merged.results).toEqual([
      { name: "gsc", outcome: "added", command: "bare" },
      { name: "notion", outcome: "added", command: "npx" },
      { name: "mine", outcome: "theirs", command: `/root/other` },
    ]);
    const root = JSON.parse(merged.text) as { numStartups: number; oauthAccount: unknown; projects: unknown; mcpServers: Record<string, unknown> };
    // Every key of the agent's own stands, the number it keeps for itself included, and its servers keep their order.
    expect(root.numStartups).toBe(41);
    expect(root.oauthAccount).toEqual({ emailAddress: "he@example.com" });
    expect(root.projects).toEqual({ "/root/work": { history: ["his own turn"] } });
    expect(root.mcpServers["mine"]).toEqual({ command: "/usr/local/bin/mine", args: [] });
    expect(Object.keys(root.mcpServers)).toEqual(["mine", "gsc", "notion"]);
    expect(root.mcpServers["gsc"]).toEqual({ command: "bare", args: ["--stdio"] });

    const again = MCP_SERVERS_JSON.merge(LIB, { keep: ["gsc", "notion", "mine"], drop: [], replace: ["gsc", "notion"] }, merged.text, CLAUDE_TRAVELLED());
    expect(again.results.map(r => r.outcome)).toEqual(["same", "same", "theirs"]);
    expect(again.text).toBe(merged.text);
  });

  it("mcpServers JSON: wsp's own entry is written over when this computer's copy changed, and an entry the agent has added a field to is the agent's and left", () => {
    const landed = MCP_SERVERS_JSON.merge(LIB, { keep: ["gsc"], drop: [], replace: [] }, CLAUDE_OWN, CLAUDE_TRAVELLED()).text;
    const changed = MCP_SERVERS_JSON.merge(LIB, { keep: ["gsc"], drop: [], replace: ["gsc"] }, landed, CLAUDE_TRAVELLED(["--stdio", "--verbose"]));
    expect(changed.results.map(r => r.outcome)).toEqual(["replaced"]);
    expect((JSON.parse(changed.text) as { mcpServers: { gsc: { args: string[] } } }).mcpServers.gsc.args).toEqual(["--stdio", "--verbose"]);

    // The entry as the agent wrote it back, with a field of its own on it: its digest is not the one the list holds,
    // so it is not in `replace` and the merge leaves it.
    const theirs = JSON.parse(landed) as { mcpServers: Record<string, Record<string, unknown>> };
    theirs.mcpServers["gsc"] = { ...theirs.mcpServers["gsc"], disabled: false };
    const left = MCP_SERVERS_JSON.merge(LIB, { keep: ["gsc"], drop: [], replace: [] }, JSON.stringify(theirs, null, 2), CLAUDE_TRAVELLED(["--stdio", "--verbose"]));
    expect(left.results.map(r => r.outcome)).toEqual(["theirs"]);
    expect(left.text).toBe(JSON.stringify(theirs, null, 2));
  });

  it("mcpServers JSON: a key's shape is read whatever order the agent wrote it back in, and the entry the list holds is what a merge compares", () => {
    const landed = MCP_SERVERS_JSON.merge(LIB, { keep: ["gsc"], drop: [], replace: [] }, CLAUDE_OWN, CLAUDE_TRAVELLED()).text;
    const rewritten = JSON.stringify({ mcpServers: { gsc: { args: ["--stdio"], command: "bare" } } }, null, 2);
    expect(MCP_SERVERS_JSON.entryOf(rewritten, "gsc")).toBe(MCP_SERVERS_JSON.entryOf(landed, "gsc"));
    expect(MCP_SERVERS_JSON.entryOf(landed, "nobody")).toBeUndefined();
    expect(MCP_SERVERS_JSON.entryOf("{ not json", "gsc")).toBeUndefined();
  });

  it("mcpServers JSON: a server of the person's home folder lands under the machine's own folder, and the folder it travelled from is not made", () => {
    const merged = MCP_SERVERS_JSON.merge(LIB, { keep: ["zed"], drop: [], replace: [], project: { from: HOME, to: "/root" } }, CLAUDE_OWN, CLAUDE_TRAVELLED());
    expect(merged.results.map(r => [r.name, r.outcome])).toEqual([["zed", "added"]]);
    const root = JSON.parse(merged.text) as { projects: Record<string, { mcpServers?: Record<string, unknown>; history?: unknown }>; mcpServers: Record<string, unknown> };
    expect(root.projects["/root"]!.mcpServers).toEqual({ zed: { command: "/root/.local/bin/zed", args: [] } });
    expect(root.projects[HOME]).toBeUndefined();
    expect(root.projects["/root/work"]).toEqual({ history: ["his own turn"] });
    expect(Object.keys(root.mcpServers)).toEqual(["mine"]);
    expect(MCP_SERVERS_JSON.entryOf(merged.text, "zed", "/root")).toBe(MCP_SERVERS_JSON.entryOf(merged.text, "zed", "/root"));
    expect(MCP_SERVERS_JSON.entryOf(merged.text, "zed")).toBeUndefined();
  });

  it("mcpServers JSON: a file that is not there yet is made from wsp's servers alone, and one with nothing to put in it is not made at all", () => {
    const made = MCP_SERVERS_JSON.merge(LIB, { keep: ["notion"], drop: [], replace: [] }, undefined, CLAUDE_TRAVELLED());
    expect(JSON.parse(made.text)).toEqual({ mcpServers: { notion: { command: "npx", args: ["-y", "notion-mcp"] } } });
    expect(MCP_SERVERS_JSON.merge(LIB, { keep: ["nobody"], drop: [], replace: [] }, undefined, CLAUDE_TRAVELLED()).text).toBe("");
    expect(() => MCP_SERVERS_JSON.merge(LIB, { keep: [], drop: [], replace: [] }, "[]", CLAUDE_TRAVELLED())).toThrow("the file is not a JSON object");
  });

  it("every JSON format merges into a jsonc file in place: each comment it did not take out stands, and a folder's servers land under the machine's own", () => {
    for (const [format, key, entry] of JSON_FORMATS) {
      const own = commented(key, entry);
      const travelled = JSON.stringify({ [key]: { gsc: entry(`${HOME}/.local/bin/bare`), old: entry("x") }, projects: { [HOME]: { [key]: { zed: entry(`${HOME}/zed`) } } } });
      const merged = format.merge(LIB, { keep: ["gsc"], drop: ["old"], replace: ["old"] }, own, travelled);
      expect(merged.results.map(r => r.outcome), key).toEqual(["added", "dropped"]);
      for (const c of COMMENTS) expect(merged.text, c).toContain(c);
      expect(parseJsonc(merged.text)).toEqual({ ...(parseJsonc(own) as object), [key]: { mine: entry("/usr/local/bin/mine"), gsc: entry("bare") } });
      if (format === OPENCODE_JSON) continue;
      const home = format.merge(LIB, { keep: ["zed"], drop: [], replace: [], project: { from: HOME, to: "/root" } }, merged.text, travelled);
      for (const c of COMMENTS) expect(home.text, c).toContain(c);
      expect((parseJsonc(home.text) as { projects: Record<string, unknown> }).projects).toEqual({ "/root/work": { history: [] }, "/root": { [key]: { zed: entry("/root/zed") } } });
    }
  });

  it("mcpServers JSON: many servers merged at once land in order after the person's own, on lines or on one line as the table is, comments kept", () => {
    const names = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const travelled = JSON.stringify({ mcpServers: Object.fromEntries(names.map(n => [n, { command: "npx", args: [n] }])), projects: { [HOME]: { mcpServers: Object.fromEntries(names.map(n => [n, { command: "npx", args: [n] }])) } } });
    const want = { mine: { command: "mine", args: [] }, ...Object.fromEntries(names.map(n => [n, { command: "npx", args: [n] }])) };
    for (const own of ['{\n  // mine\n  "mcpServers": {\n    "mine": { "command": "mine", "args": [] } // his\n  }\n}\n', '{ /* mine */ "mcpServers": { "mine": { "command": "mine", "args": [] } } }']) {
      const merged = MCP_SERVERS_JSON.merge(LIB, { keep: names, drop: [], replace: [] }, own, travelled);
      expect(merged.results.every(r => r.outcome === "added")).toBe(true);
      expect(Object.entries((parseJsonc(merged.text) as { mcpServers: object }).mcpServers)).toEqual(Object.entries(want));
      for (const c of ["// mine", "// his", "/* mine */"]) if (own.includes(c)) expect(merged.text).toContain(c);
      const home = MCP_SERVERS_JSON.merge(LIB, { keep: names, drop: [], replace: [], project: { from: HOME, to: "/root" } }, merged.text, travelled);
      expect(Object.keys((parseJsonc(home.text) as { projects: Record<string, { mcpServers: object }> }).projects["/root"]!.mcpServers)).toEqual(names);
    }
  });

  it("Codex's TOML: its trust tables, its hooks state and the person's own server stand line for line, and wsp's tables are appended with their sub-tables", () => {
    const merged = CODEX_TOML.merge(LIB, { keep: ["context7", "mine"], drop: ["gone"], replace: [] }, CODEX_OWN, CODEX_TRAVELLED());
    expect(merged.results).toEqual([
      { name: "context7", outcome: "added", command: "/root/.local/bin/context7" },
      { name: "mine", outcome: "theirs", command: "/root/other" },
      { name: "gone", outcome: "left" },
    ]);
    // Every line the agent and the person wrote is where it was, the table Codex trusts a folder by included.
    expect(merged.text.startsWith(CODEX_OWN)).toBe(true);
    expect(merged.text.slice(CODEX_OWN.length)).toBe(["", "[mcp_servers.context7]", 'command = "/root/.local/bin/context7"', 'args = ["--stdio"]', "", "[mcp_servers.context7.env]", 'KEY = "k"', ""].join("\n"));
    expect(CODEX_TOML.read(merged.text, "/root").map(s => s.name)).toEqual(["mine", "context7"]);

    const again = CODEX_TOML.merge(LIB, { keep: ["context7", "mine"], drop: [], replace: ["context7"] }, merged.text, CODEX_TRAVELLED());
    expect(again.results.map(r => r.outcome)).toEqual(["same", "theirs"]);
    expect(again.text).toBe(merged.text);
  });

  it("Codex's TOML: wsp's own table is written over where it stands and taken out with its sub-tables when it is dropped, and a table it does not own is left", () => {
    const landed = CODEX_TOML.merge(LIB, { keep: ["context7"], drop: [], replace: [] }, CODEX_OWN, CODEX_TRAVELLED()).text;
    const changed = CODEX_TOML.merge(LIB, { keep: ["context7"], drop: [], replace: ["context7"] }, landed, CODEX_TRAVELLED(["--stdio", "--verbose"]));
    expect(changed.results.map(r => r.outcome)).toEqual(["replaced"]);
    expect(changed.text).toBe(landed.replace('args = ["--stdio"]', 'args = ["--stdio", "--verbose"]'));

    const dropped = CODEX_TOML.merge(LIB, { keep: [], drop: ["context7", "mine"], replace: ["context7"] }, landed, CODEX_TRAVELLED());
    expect(dropped.results).toEqual([
      { name: "context7", outcome: "dropped" },
      { name: "mine", outcome: "left" },
    ]);
    expect(dropped.text).toBe(CODEX_OWN);
  });

  it("Codex's TOML: a table reads the same however Codex spaced and commented it, and a field of its own makes it the agent's", () => {
    const landed = CODEX_TOML.merge(LIB, { keep: ["context7"], drop: [], replace: [] }, CODEX_OWN, CODEX_TRAVELLED()).text;
    const rewritten = landed.replace('command = "/root/.local/bin/context7"', '  command = "/root/.local/bin/context7"   # codex wrote this back');
    expect(CODEX_TOML.entryOf(rewritten, "context7")).toBe(CODEX_TOML.entryOf(landed, "context7"));
    expect(CODEX_TOML.entryOf(`${landed}startup_timeout_sec = 30\n`, "context7")).not.toBe(CODEX_TOML.entryOf(landed, "context7"));
    expect(CODEX_TOML.entryOf(landed, "nobody")).toBeUndefined();
  });

  it("Codex's TOML: a file that is not there yet is one table with no blank line in front of it", () => {
    const made = CODEX_TOML.merge(LIB, { keep: ["mine"], drop: [], replace: [] }, undefined, CODEX_TRAVELLED());
    expect(made.text).toBe('[mcp_servers.mine]\ncommand = "/root/other"\n');
    expect(CODEX_TOML.merge(LIB, { keep: ["nobody"], drop: [], replace: [] }, undefined, CODEX_TRAVELLED()).text).toBe("");
  });
});

describe("remove", () => {
  it("mcpServers JSON: the named keys go, under the user scope and the home folder alike, and every other key of the agent's and the person's stands", () => {
    const merged = MCP_SERVERS_JSON.merge(LIB, { keep: ["gsc", "notion"], drop: [], replace: [] }, CLAUDE_OWN, CLAUDE_TRAVELLED()).text;
    const withHome = MCP_SERVERS_JSON.merge(LIB, { keep: ["zed"], drop: [], replace: [], project: { from: HOME, to: "/root" } }, merged, CLAUDE_TRAVELLED()).text;

    const gone = MCP_SERVERS_JSON.remove(withHome, ["gsc", "notion"]).text;
    const root = JSON.parse(gone) as { numStartups: number; oauthAccount: unknown; projects: Record<string, { mcpServers?: Record<string, unknown> }>; mcpServers: Record<string, unknown> };
    expect(Object.keys(root.mcpServers)).toEqual(["mine"]);
    expect(root.numStartups).toBe(41);
    expect(root.oauthAccount).toEqual({ emailAddress: "he@example.com" });
    expect(root.projects["/root/work"]).toEqual({ history: ["his own turn"] });
    // The home folder's servers are the person's own scope and are named there, not under the root key.
    expect(root.projects["/root"]!.mcpServers).toEqual({ zed: { command: "/root/.local/bin/zed", args: [] } });
    const both = MCP_SERVERS_JSON.remove(gone, ["zed"], "/root");
    expect((JSON.parse(both.text) as { projects: Record<string, { mcpServers: Record<string, unknown> }> }).projects["/root"]!.mcpServers).toEqual({});

    // A name the file does not define, a scope it has nothing under, and a file with no servers at all: the text
    // stands as it is rather than being rewritten for nothing.
    expect(MCP_SERVERS_JSON.remove(withHome, ["nobody"]).text).toBe(withHome);
    expect(MCP_SERVERS_JSON.remove(withHome, ["gsc"], "/root/elsewhere").text).toBe(withHome);
    expect(MCP_SERVERS_JSON.remove('{ "theme": "x" }', ["gsc"]).text).toBe('{ "theme": "x" }');
    expect(() => MCP_SERVERS_JSON.remove("[]", ["gsc"])).toThrow("the file is not a JSON object");
  });

  it("OpenCode's JSON: the named keys go from under its own key, every other byte of the file where it was", () => {
    const own = '{\n  "theme": "x",\n  "mcp": { "wsp": { "type": "local", "command": ["wsp", "mcp"] }, "mine": { "type": "local", "command": ["mine"] } }\n}\n';
    const gone = OPENCODE_JSON.remove(own, ["wsp"]);
    expect(JSON.parse(gone.text)).toEqual({ theme: "x", mcp: { mine: { type: "local", command: ["mine"] } } });
    expect(gone.text).toBe('{\n  "theme": "x",\n  "mcp": { "mine": { "type": "local", "command": ["mine"] } }\n}\n');
    expect(OPENCODE_JSON.remove(own, ["nobody"]).text).toBe(own);
  });

  it("a jsonc file keeps its comments when a key comes out of it", () => {
    const own = '{\n  // my own servers\n  "theme": "x",\n  "mcp": { "wsp": { "type": "local", "command": ["wsp", "mcp"] } } // the rest\n}\n';
    const gone = OPENCODE_JSON.remove(own, ["wsp"]).text;
    expect(gone).toContain("// my own servers\n");
    expect(gone).toContain("// the rest\n");
    expect(parseJsonc(gone)).toEqual({ theme: "x", mcp: {} });
    expect(OPENCODE_JSON.remove(own, ["nobody"]).text).toBe(own);
  });

  it("a remove takes out the server's own lines, its comment lines above it and the comment at the end of its line, and no neighbour's comment", () => {
    const claude = [
      "{ // my settings",
      '  "mcpServers": { // header for all my servers',
      "    // about a",
      '    "a": { "command": "x" }, // note on a',
      "    // about b",
      '    "b": { "command": "y" } // note on b',
      "  } // end of servers",
      "}",
      "",
    ].join("\n");
    expect(MCP_SERVERS_JSON.remove(claude, ["b"]).text).toBe(
      ["{ // my settings", '  "mcpServers": { // header for all my servers', "    // about a", '    "a": { "command": "x" } // note on a', "  } // end of servers", "}", ""].join("\n"),
    );
    expect(MCP_SERVERS_JSON.remove(claude, ["a"]).text).toBe(
      ["{ // my settings", '  "mcpServers": { // header for all my servers', "    // about b", '    "b": { "command": "y" } // note on b', "  } // end of servers", "}", ""].join("\n"),
    );
    const middle = '{\n  "mcpServers": {\n    "a": { "command": "x" }, // note on a\n\n    // section two\n    "b": { "command": "y" }, /* note on b */\n    "c": { "command": "z" } // note on c\n  }\n}\n';
    expect(MCP_SERVERS_JSON.remove(middle, ["b"]).text).toBe('{\n  "mcpServers": {\n    "a": { "command": "x" }, // note on a\n\n    "c": { "command": "z" } // note on c\n  }\n}\n');
    const blank = '{\n  "mcpServers": {\n    // my servers\n\n    "a": { "command": "x" }\n  }\n}\n';
    expect(MCP_SERVERS_JSON.remove(blank, ["a"]).text).toBe('{\n  "mcpServers": {\n    // my servers\n\n  }\n}\n');
  });

  it("Gemini CLI turns a server on, and takes a removed one out of mcp.excluded, by that one name, every other name's comment kept", () => {
    const text = [
      "{",
      '  "mcp": {',
      '    "excluded": [ // switched off',
      '      "s", // trying it',
      '      "other" // keep off',
      "    ]",
      "  },",
      '  "mcpServers": { "s": { "command": "x" }, "other": { "command": "y" }, "t": { "command": "z" } }',
      "}",
      "",
    ].join("\n");
    const kept = ['    "excluded": [ // switched off', '      "other" // keep off', "    ]"].join("\n");
    expect(GEMINI_SETTINGS_JSON.enable!(text, "s", true).text).toContain(kept);
    expect(GEMINI_SETTINGS_JSON.remove(text, ["s"]).text).toContain(kept);
    const off = GEMINI_SETTINGS_JSON.enable!(text, "t", false).text;
    expect(off).toContain(['      "s", // trying it', '      "other", // keep off', '      "t"', "    ]"].join("\n"));
    expect(GEMINI_SETTINGS_JSON.enable!('{ "mcp": { "excluded": ["s"] }, "mcpServers": { "t": {} } }', "t", false).text).toBe('{ "mcp": { "excluded": ["s", "t"] }, "mcpServers": { "t": {} } }');
    expect(GEMINI_SETTINGS_JSON.read(off, HOME).map(s => [s.name, s.disabled === true])).toEqual([["s", true], ["other", true], ["t", true]]);
  });

  it("Gemini CLI takes a removed server's name out of mcp.excluded too, so a later server of that name is not born off", () => {
    const text = '{\n  // mine\n  "mcp": { "excluded": ["s", "t"] },\n  "mcpServers": { "s": { "command": "x" }, "t": { "command": "y" } }\n}\n';
    const gone = GEMINI_SETTINGS_JSON.remove(text, ["s"]).text;
    expect(parseJsonc(gone)).toEqual({ mcp: { excluded: ["t"] }, mcpServers: { t: { command: "y" } } });
    expect(gone).toContain("// mine\n");
    const again = GEMINI_SETTINGS_JSON.place(gone, "s", SERVER).text;
    expect(GEMINI_SETTINGS_JSON.read(again, HOME).map(s => [s.name, s.disabled === true])).toEqual([["t", true], ["s", false]]);
    expect(GEMINI_SETTINGS_JSON.remove(text, ["nobody"]).text).toBe(text);
  });

  it("Codex's TOML: the named tables go with their sub-tables, and the person's trust tables, hooks state and own server stay byte for byte", () => {
    const landed = CODEX_TOML.merge(LIB, { keep: ["context7"], drop: [], replace: [] }, CODEX_OWN, CODEX_TRAVELLED()).text;
    expect(landed).toContain("[mcp_servers.context7.env]");
    expect(CODEX_TOML.remove(landed, ["context7"]).text).toBe(CODEX_OWN);
    // A name no table stands for leaves the file exactly as it was, comments and spacing with it.
    expect(CODEX_TOML.remove(landed, ["nobody"]).text).toBe(landed);
    expect(CODEX_TOML.remove(landed, ["mine"]).text).not.toContain("[mcp_servers.mine]");
    expect(CODEX_TOML.remove(landed, ["mine"]).text).toContain('[projects."/private/tmp/proof-907/repo"]');
  });
});
