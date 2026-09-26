// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS, MCP_SERVERS_JSON, type McpAgent, type McpFormat, type McpServer } from "@wsp/catalog";
import { detectMcp, linuxFit, mcpRemoteHash } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

const HOME = "/Users/dev";
const NOTION = "https://mcp.notion.com/mcp";
const hash = (url: string): string => createHash("md5").update(url).digest("hex");

const claudeJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    numStartups: 3,
    mcpServers: {
      github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_x".padEnd(40, "x"), GITHUB_HOST: "github.com" } },
      notion: { type: "http", url: NOTION },
      gsc: { command: "uvx", args: ["mcp-search-console"], env: { GSC_CREDENTIALS_PATH: `${HOME}/.config/gsc/creds.json` } },
      notes: { command: `${HOME}/Library/Application Support/Notes/mcp`, args: [] },
    },
    projects: {
      [HOME]: { allowedTools: [], mcpServers: { zomato: { type: "stdio", command: "npx", args: ["mcp-remote", "https://mcp.zomato.com/mcp"] } } },
      [`${HOME}/code/mono`]: { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/sse" } } },
    },
    ...over,
  });

describe("mcp servers", () => {
  it("Claude Code: one row per user-scope server and per server local to the home folder, ticked when it runs on Linux, secrets named by size", async () => {
    const host = fakeHost({
      files: {
        "~/.claude.json": claudeJson(),
        "~/.config/gsc/creds.json": 2100,
        [`~/.mcp-auth/mcp-remote-v1/${hash("https://mcp.zomato.com/mcp")}_tokens.json`]: 1400,
        [`~/.mcp-auth/mcp-remote-v1/${hash("https://mcp.zomato.com/mcp")}_client_info.json`]: 300,
        [`~/.mcp-auth/mcp-remote-v1/${hash("https://mcp.zomato.com/mcp")}_lock.json`]: 60,
        [`~/.mcp-auth/mcp-remote-v1/${hash("https://mcp.zomato.com/mcp")}_code_verifier_2f1.txt`]: 100,
        "~/.mcp-auth/mcp-remote-0.1.37/abc_tokens.json": 900,
      },
    });
    const rows = await detectMcp(host);
    expect(rows.map(r => r.id)).toEqual([
      "agents/mcp/claude/github", "agents/mcp/claude/notion", "agents/mcp/claude/gsc", "agents/mcp/claude/notes", "agents/mcp/claude/home/zomato", "agents/mcp/mcp-remote",
    ]);
    expect(rows[0]).toEqual({
      rung: "agents", id: "agents/mcp/claude/github", label: "github", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", consent: true,
      detail: "stdio: npx @modelcontextprotocol/server-github; runs via npx; carries a secret: env GITHUB_TOKEN (40 B)",
    });
    expect(rows[1]).toEqual({
      rung: "agents", id: "agents/mcp/claude/notion", label: "notion", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring",
      detail: "http: mcp.notion.com/mcp; nothing to install; its sign-in is kept with the Claude Code login",
    });
    // The file a secret-named env value points at travels on the row; the path itself is rewritten on the machine.
    expect(rows[2]).toEqual({
      rung: "agents", id: "agents/mcp/claude/gsc", label: "gsc", group: "Claude Code MCP servers", paths: ["~/.config/gsc/creds.json"], bytes: 2100, default: "bring", consent: true,
      detail: "stdio: uvx mcp-search-console; needs uv, installed on the machine when missing; carries a secret: the file GSC_CREDENTIALS_PATH points at (2 KB)",
    });
    expect(rows[3]).toEqual({
      rung: "agents", id: "agents/mcp/claude/notes", label: "notes", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "skip",
      reason: "command ~/Library/Application Support/Notes/mcp is macOS-only, will not run",
      detail: "stdio: ~/Library/Application Support/Notes/mcp; carries no secret",
    });
    expect(rows[4]).toEqual({
      rung: "agents", id: "agents/mcp/claude/home/zomato", label: "zomato", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", consent: true,
      detail: "local to ~; stdio: npx mcp-remote …; runs via npx; carries a secret: arg 2 (26 B); its saved sign-in (1 KB) travels on the mcp-remote sign-ins row",
    });
    // The whole store is claimed; only what the current bridge reads travels.
    expect(rows[5]).toEqual({
      rung: "agents", id: "agents/mcp/mcp-remote", label: "mcp-remote sign-ins", group: "MCP sign-ins", paths: ["~/.mcp-auth"],
      excludes: ["~/.mcp-auth/mcp-remote-0.1.37", `~/.mcp-auth/mcp-remote-v1/${hash("https://mcp.zomato.com/mcp")}_lock.json`],
      bytes: 1800, default: "bring", consent: true,
      detail: "browser sign-ins saved by mcp-remote for remote servers: 1 token (1 KB), for zomato; older bridge versions' folders stay here",
    });
    // The config itself is never listed here; it travels with the agent's row. No token file is read.
    expect(host.calls.filter(c => c.startsWith("read "))).toEqual([`read ${HOME}/.claude.json`]);
  });

  it("a server local to another project stays behind: its repo is not on the machine", async () => {
    const rows = await detectMcp(fakeHost({ files: { "~/.claude.json": claudeJson() } }));
    expect(rows.map(r => r.label)).not.toContain("linear");
  });

  it("an mcp-remote server without a saved sign-in says the browser sign-in runs again; a store with nothing the bridge reads is a locked row", async () => {
    const rows = await detectMcp(fakeHost({ files: { "~/.claude.json": claudeJson({ projects: {} }), "~/.mcp-auth/mcp-remote-0.1.37/abc_tokens.json": 900 } }));
    const remote = rows.find(r => r.id === "agents/mcp/mcp-remote")!;
    expect(remote).toEqual({
      rung: "agents", id: "agents/mcp/mcp-remote", label: "mcp-remote sign-ins", group: "MCP sign-ins", paths: ["~/.mcp-auth"], excludes: ["~/.mcp-auth/mcp-remote-0.1.37"], bytes: 0,
      default: "skip", reason: "no saved sign-in the current bridge reads; older versions' folders are left here",
    });
    const viaRemote = await detectMcp(fakeHost({ files: { "~/.claude.json": JSON.stringify({ mcpServers: { z: { command: "npx", args: ["-y", "mcp-remote", "https://z.example/mcp"] } } }) } }));
    expect(viaRemote.map(r => r.detail)).toEqual(["stdio: npx mcp-remote …; runs via npx; carries a secret: arg 3 (21 B); no saved sign-in; the browser sign-in runs again on the machine"]);
  });

  it("Codex: mcp_servers tables in config.toml, env sub-tables included, with the bearer variable named as something to set", async () => {
    const toml = [
      "model = \"gpt-5\"",
      "",
      "[mcp_servers.grafana]",
      "command = \"/opt/homebrew/bin/uvx\"",
      "args = [\"mcp-grafana\"]",
      "",
      "[mcp_servers.grafana.env]",
      "GRAFANA_SERVICE_ACCOUNT_TOKEN = \"glsa_abcdefghij\"",
      "GRAFANA_URL = \"https://g.example\"",
      "",
      "# a remote one",
      "[mcp_servers.sentry]",
      "url = \"https://mcp.sentry.dev/mcp?x=1\"",
      "bearer_token_env_var = \"SENTRY_TOKEN\"",
      "",
      "[mcp_servers.\"my server\"]",
      "command = \"node\"",
      "args = [",
      "  \"/Applications/Tool.app/Contents/mcp.js\",",
      "]",
      "env = { A_KEY = \"1234\" }",
      "",
      "[[hooks.SessionStart]]",
      "matcher = \"x\"",
    ].join("\n");
    const rows = await detectMcp(fakeHost({ files: { "~/.codex/config.toml": toml } }));
    expect(rows.map(r => [r.id, r.default, r.reason, r.detail])).toEqual([
      ["agents/mcp/codex/grafana", "bring", undefined, "stdio: /opt/homebrew/bin/uvx mcp-grafana; needs uv, installed on the machine when missing; carries a secret: env GRAFANA_SERVICE_ACCOUNT_TOKEN (15 B)"],
      ["agents/mcp/codex/sentry", "bring", undefined, "http: mcp.sentry.dev/mcp; nothing to install; reads SENTRY_TOKEN from the environment, set it on the machine; carries no secret"],
      ["agents/mcp/codex/my server", "skip", "path /Applications/Tool.app/Contents/mcp.js is macOS-only, will not run", "stdio: node …; carries secrets: env A_KEY (4 B), arg 1 (38 B)"],
    ]);
  });

  it("Gemini CLI and OpenCode: mcpServers and mcp, comments and trailing commas allowed, a bare binary named as what the machine needs", async () => {
    const gemini = '{\n  // my servers\n  "mcpServers": { "memory": { "command": "~/.local/bin/codebase-memory-mcp" }, "docs": { "httpUrl": "https://docs.example/mcp", "headers": { "Authorization": "Bearer abcdef" } }, },\n}\n';
    const opencode = '{ "mcp": { "memory": { "type": "local", "command": ["/Users/dev/.local/bin/codebase-memory-mcp", "--v"], "environment": { "MEM_KEY": "k" }, "enabled": true }, "ctx": { "type": "remote", "url": "https://ctx.example/mcp" } } }';
    const rows = await detectMcp(fakeHost({ files: { "~/.gemini/settings.json": gemini, "~/.config/opencode/opencode.jsonc": opencode } }));
    expect(rows.map(r => [r.id, r.group, r.detail])).toEqual([
      ["agents/mcp/gemini/memory", "Gemini CLI MCP servers", "stdio: ~/.local/bin/codebase-memory-mcp; needs codebase-memory-mcp on the machine; carries no secret"],
      ["agents/mcp/gemini/docs", "Gemini CLI MCP servers", "http: docs.example/mcp; nothing to install; carries a secret: header Authorization (13 B)"],
      ["agents/mcp/opencode/memory", "OpenCode MCP servers", "stdio: ~/.local/bin/codebase-memory-mcp --v; needs codebase-memory-mcp on the machine; carries a secret: env MEM_KEY (1 B)"],
      ["agents/mcp/opencode/ctx", "OpenCode MCP servers", "http: ctx.example/mcp; nothing to install; carries no secret"],
    ]);
  });

  it("a value after a secret-named flag, or inside a secret-named assignment, is a secret: hidden on the row and counted by size", async () => {
    const rows = await detectMcp(fakeHost({ files: { "~/.claude.json": JSON.stringify({ mcpServers: { s: { command: "npx", args: ["-y", "some-server", "--api-key", "sk-123", "--token=abcdef", "API_KEY=zzz"] } } }) } }));
    expect(rows.map(r => r.detail)).toEqual(["stdio: npx some-server --api-key … --token=… API_KEY=…; runs via npx; carries secrets: flag --api-key (6 B), flag --token (6 B), arg API_KEY (3 B)"]);
    expect(JSON.stringify(rows)).not.toMatch(/sk-123|abcdef|zzz/);
  });

  it("an argument the definition does not name is a value, hidden and counted so the row takes the copy answer; a flag's value is the flag's word", async () => {
    const config = JSON.stringify({
      mcpServers: {
        bare: { command: "npx", args: ["-y", "some-server", "sk-test-bare-token"] },
        port: { command: "npx", args: ["-y", "some-server", "--port", "3000"] },
        verbose: { command: "npx", args: ["-y", "some-server", "--verbose", "sk-test-token"] },
        own: { command: `${HOME}/bin/server`, args: ["sk-test-token"] },
        docker: { command: "docker", args: ["run", "-i", "--rm", "-e", "GITHUB_TOKEN=ghp-test-flag-secret", "ghcr.io/x/y"] },
        dockerEq: { command: "docker", args: ["run", "--env=GITHUB_TOKEN=ghp-test-eq-secret", "ghcr.io/x/y"] },
        env: { command: "npx", args: ["-y", "some-server", "--env", "API_KEY=sk-test-flag-secret"] },
        dashes: { command: "npx", args: ["-y", "some-server", "--", "--verbose", "sk-after-dashes"] },
      },
    });
    const rows = await detectMcp(fakeHost({ files: { "~/.claude.json": config } }));
    expect(rows.map(r => [r.detail, r.consent])).toEqual([
      ["stdio: npx some-server …; runs via npx; carries a secret: arg 3 (18 B)", true],
      ["stdio: npx some-server --port 3000; runs via npx; carries no secret", undefined],
      // A flag's value is the flag's word: the definition names it, so it is shown whatever it holds.
      ["stdio: npx some-server --verbose sk-test-token; runs via npx; carries no secret", undefined],
      ["stdio: ~/bin/server …; needs ~/bin/server on the machine; carries a secret: arg 1 (13 B)", true],
      // A flag's value is read like any other argument, so a variable set behind -e or --env is a variable.
      ["stdio: docker … -i --rm -e GITHUB_TOKEN=… …; needs docker on the machine; carries secrets: arg 1 (3 B), arg GITHUB_TOKEN (20 B), arg 6 (11 B)", true],
      // The short spelling of the same argument reads the same as the spaced one.
      ["stdio: docker … --env=GITHUB_TOKEN=… …; needs docker on the machine; carries secrets: arg 1 (3 B), arg GITHUB_TOKEN (18 B), arg 3 (11 B)", true],
      ["stdio: npx some-server --env API_KEY=…; runs via npx; carries a secret: arg API_KEY (19 B)", true],
      // Past the two dashes there are no flags left: what follows is the program's own, whatever it is spelled like.
      ["stdio: npx some-server -- … …; runs via npx; carries secrets: arg 4 (9 B), arg 5 (15 B)", true],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/sk-test-bare-token|ghp-test-flag-secret|ghp-test-eq-secret|sk-test-flag-secret|sk-after-dashes/);
  });

  it("a secret-named env value pointing outside home is named without its value; a home path the server runs against is a dependency, or unticks the row without locking it when it is not here yet", async () => {
    const config = JSON.stringify({
      mcpServers: {
        outside: { command: "npx", args: ["x"], env: { CREDENTIALS_PATH: "/etc/creds.json" } },
        whatsapp: { command: `${HOME}/.local/bin/uv`, args: ["--directory", `${HOME}/whatsapp-mcp/server`, "run", "main.py"] },
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { MEMORY_FILE_PATH: `${HOME}/.claude/memory.json` } },
        sqlite: { command: "uvx", args: ["mcp-server-sqlite", "--db-path", "~/notes.db"] },
      },
    });
    const rows = await detectMcp(fakeHost({ files: { "~/.claude.json": config, "/etc/creds.json": 10, "~/whatsapp-mcp/server/main.py": 20 } }));
    expect(rows.map(r => [r.default, r.reason, r.detail])).toEqual([
      ["bring", undefined, "stdio: npx x; runs via npx; the file CREDENTIALS_PATH points at is outside your home and is not copied"],
      ["bring", undefined, "stdio: ~/.local/bin/uv --directory ~/whatsapp-mcp/server run …; needs uv, installed on the machine when missing; depends on ~/whatsapp-mcp/server, which comes along only if a row carries it; carries a secret: arg 4 (7 B)"],
      ["skip", undefined, "stdio: npx @modelcontextprotocol/server-memory; runs via npx; ~/.claude/memory.json is not on this computer; unticked, tick it if the server creates it on first start; carries no secret"],
      ["skip", undefined, "stdio: uvx mcp-server-sqlite --db-path ~/notes.db; needs uv, installed on the machine when missing; ~/notes.db is not on this computer; unticked, tick it if the server creates it on first start; carries no secret"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("/etc/creds.json");
  });

  it("mcp-remote's --static-oauth-client-info blob is a secret whatever its name says; a secret-shaped switch with no value hides nothing", async () => {
    const config = JSON.stringify({
      mcpServers: {
        remote: { command: "npx", args: ["mcp-remote", NOTION, "--static-oauth-client-info", '{"client_id":"abc","client_secret":"shh-secret"}'] },
        sw: { command: "npx", args: ["some-server", "--auth", "--transport", "http-only"] },
      },
    });
    const rows = await detectMcp(fakeHost({ files: { "~/.claude.json": config } }));
    expect(rows.map(r => r.detail)).toEqual([
      "stdio: npx mcp-remote … --static-oauth-client-info …; runs via npx; carries secrets: arg 2 (26 B), flag --static-oauth-client-info (48 B); no saved sign-in; the browser sign-in runs again on the machine",
      "stdio: npx some-server --auth --transport http-only; runs via npx; carries no secret",
    ]);
    expect(JSON.stringify(rows)).not.toContain("shh-secret");
  });

  it("a config that does not parse, or has no servers, adds no row", async () => {
    expect(await detectMcp(fakeHost({ files: { "~/.claude.json": "{not json", "~/.gemini/settings.json": "{}", "~/.codex/config.toml": "model = \"x\"\n" } }))).toEqual([]);
    expect(await detectMcp(fakeHost())).toEqual([]);
  });

  it("an agent the catalog gains with a format of its own is read through its module: one row per server it names, under the agent's group,", async () => {
    const lines: McpFormat = {
      read: text => text.split("\n").filter(l => l !== "").map((l): McpServer => {
        const [name, command, ...args] = l.split(" ");
        return { name: name!, scope: "user", transport: { kind: "stdio", command: command!, args, env: {} }, envRefs: [] };
      }),
      place: () => ({ text: "" }),
      edit: (_lib, _scope, text) => ({ text, results: [] }),
      // The collector asks a format to read and nothing else: what writes a file is the install helper's and the
      // machine's, and this row's module is here to be read through.
      entryOf: () => undefined,
      merge: (_lib, _scope, own) => ({ text: own ?? "", results: [], commentsDropped: false }),
      remove: text => ({ text }),
      refer: async text => ({ text, servers: [], entries: [] }),
    };
    const entry: McpAgent = { ...CATALOG_AGENTS.find(a => a.id === "pi")!, id: "lines", name: "Lines", mcp: { format: lines, files: ["~/.lines/servers.txt"], scope: "one file" } };
    const host = fakeHost({ files: { "~/.lines/servers.txt": "alpha npx -y pkg\nbeta /Applications/B.app/b\n", "~/.claude.json": claudeJson() } });
    const rows = await detectMcp(host, [entry]);
    expect(rows.map(r => [r.id, r.group, r.default, r.detail])).toEqual([
      ["agents/mcp/lines/alpha", "Lines MCP servers", "bring", "stdio: npx pkg; runs via npx; carries no secret"],
      ["agents/mcp/lines/beta", "Lines MCP servers", "skip", "stdio: /Applications/B.app/b; carries no secret"],
    ]);
  });

  it("an http server's sign-in note is what the agent's mcp module says; an entry that says nothing gets none", async () => {
    const remote = (httpAuth?: string): McpAgent => ({ ...CATALOG_AGENTS.find(a => a.id === "gemini")!, id: "remote", name: "Remote", mcp: { format: MCP_SERVERS_JSON, files: ["~/.remote.json"], scope: "user scope", ...(httpAuth !== undefined ? { httpAuth } : {}) } });
    const host = fakeHost({ files: { "~/.remote.json": JSON.stringify({ mcpServers: { notion: { type: "http", url: NOTION } } }) } });
    expect((await detectMcp(host, [remote("its sign-in is kept with the Remote login")]))[0]?.detail).toBe("http: mcp.notion.com/mcp; nothing to install; its sign-in is kept with the Remote login");
    expect((await detectMcp(host, [remote()]))[0]?.detail).toBe("http: mcp.notion.com/mcp; nothing to install; carries no secret");
  });

  it("linuxFit: home paths and Homebrew's prefix have a Linux equivalent, Library and Applications do not", () => {
    const stdio = (command: string, args: string[] = [], env: Record<string, string> = {}): McpServer => ({ name: "s", scope: "user", transport: { kind: "stdio", command, args, env }, envRefs: [] });
    expect(linuxFit(stdio("npx", ["-y", "pkg"]), HOME)).toEqual({ ok: true, needs: "runs via npx" });
    expect(linuxFit(stdio(`${HOME}/.local/bin/uv`, ["--directory", `${HOME}/code/x`, "run", "main.py"]), HOME)).toEqual({ ok: true, needs: "needs uv, installed on the machine when missing" });
    expect(linuxFit(stdio("/opt/homebrew/bin/node", ["server.js"]), HOME)).toEqual({ ok: true, needs: "needs node on the machine" });
    expect(linuxFit(stdio("npx", ["pkg"], { CONF: `${HOME}/Library/Preferences/x.plist` }), HOME)).toEqual({ ok: false, reason: "path ~/Library/Preferences/x.plist is macOS-only, will not run" });
    expect(linuxFit(stdio("/Applications/X.app/Contents/MacOS/x"), HOME)).toEqual({ ok: false, reason: "command /Applications/X.app/Contents/MacOS/x is macOS-only, will not run" });
    expect(linuxFit({ name: "h", scope: "user", transport: { kind: "http", url: "https://h", headers: {} }, envRefs: [] }, HOME)).toEqual({ ok: true, needs: "nothing to install" });
  });

  it("mcpRemoteHash matches the bridge's store: md5 of the url, resource, sorted authorize params, sorted headers and client metadata url", () => {
    expect(mcpRemoteHash(["-y", "mcp-remote", NOTION])).toBe(hash(NOTION));
    expect(mcpRemoteHash(["mcp-remote@0.8.3", NOTION, "--header", "X-B: 2", "--header", "A: 1"])).toBe(createHash("md5").update(`${NOTION}|${JSON.stringify({ A: "1", "X-B": "2" })}`).digest("hex"));
    expect(mcpRemoteHash(["mcp-remote", NOTION, "--client-metadata-url", "https://m.example/c.json", "--resource", "https://r.example", "--authorize-param", "b=2", "--authorize-param", "a=1", "--header", "K: v"])).toBe(
      createHash("md5").update(`${NOTION}|https://r.example|${JSON.stringify({ a: "1", b: "2" })}|${JSON.stringify({ K: "v" })}|https://m.example/c.json`).digest("hex"),
    );
    expect(mcpRemoteHash(["-y", "@scope/other", NOTION])).toBeUndefined();
  });
});

