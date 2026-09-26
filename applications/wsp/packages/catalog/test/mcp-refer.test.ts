// SPDX-License-Identifier: AGPL-3.0-only
// A server's definition as it lands on a machine: every header and every
// variable its command is given written as the name of a variable, in the
// syntax the agent's own file expands, and the values handed back for the
// vault. What the agent reads back is the same server with only names in it.
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { CODEX_TOML, GEMINI_SETTINGS_JSON, MCP_SERVERS_JSON, OPENCODE_JSON, mcpHeaderVariable, parseJsonc, serversByName, type McpFormat } from "../src/index.js";

const HOME = "/Users/dev";
const TOKEN = "lin_api_TESTONLY";
const NOTION = "ntn_TESTONLY";

describe("the name a header's value travels under", () => {
  it("is WSP_MCP_<SERVER>_<HEADER> in capitals, every other character an underscore", async () => {
    expect(mcpHeaderVariable("linear", "Authorization")).toBe("WSP_MCP_LINEAR_AUTHORIZATION");
    expect(mcpHeaderVariable("my-docs.v2", "X-Api-Key")).toBe("WSP_MCP_MY_DOCS_V2_X_API_KEY");
  });
});

describe("Claude Code's reference writer", () => {
  const file = JSON.stringify(
    {
      numStartups: 3,
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${TOKEN}`, "X-Team": "eng" } },
        notion: { command: "npx", args: ["-y", "notion-mcp"], env: { NOTION_TOKEN: NOTION, LOG: "${LOG_LEVEL:-info}" } },
        mine: { type: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer ${MY_TOKEN}" } },
      },
      projects: { [HOME]: { mcpServers: { zomato: { type: "http", url: "https://z.example/mcp", headers: { "X-Key": "zk_TESTONLY" } } } } },
    },
    null,
    2,
  );

  it("writes ${NAME} in headers and env, the bearer's token alone in the vault, and leaves a name the person already wrote as they wrote it", async () => {
    const out = await MCP_SERVERS_JSON.refer(file);
    const root = parseJsonc(out.text) as { mcpServers: Record<string, { headers?: Record<string, string>; env?: Record<string, string> }>; projects: Record<string, { mcpServers: Record<string, { headers: Record<string, string> }> }> };
    expect(root.mcpServers.linear!.headers).toEqual({ Authorization: "Bearer ${WSP_MCP_LINEAR_AUTHORIZATION}", "X-Team": "${WSP_MCP_LINEAR_X_TEAM}" });
    expect(root.mcpServers.notion!.env).toEqual({ NOTION_TOKEN: "${NOTION_TOKEN}", LOG: "${LOG_LEVEL:-info}" });
    expect(root.mcpServers.mine!.headers).toEqual({ Authorization: "Bearer ${MY_TOKEN}" });
    expect(root.projects[HOME]!.mcpServers.zomato!.headers).toEqual({ "X-Key": "${WSP_MCP_ZOMATO_X_KEY}" });
    expect(out.servers).toEqual([
      { name: "linear", values: { WSP_MCP_LINEAR_AUTHORIZATION: TOKEN, WSP_MCP_LINEAR_X_TEAM: "eng" } },
      { name: "notion", values: { NOTION_TOKEN: NOTION } },
      { name: "mine", values: {} },
      { name: "zomato", project: HOME, values: { WSP_MCP_ZOMATO_X_KEY: "zk_TESTONLY" } },
    ]);
    for (const secret of [TOKEN, NOTION, "zk_TESTONLY"]) expect(out.text).not.toContain(secret);
    // The agent's own reader sees the names the definition now reads.
    expect(MCP_SERVERS_JSON.read(out.text, HOME).find(s => s.name === "linear")!.envRefs).toEqual(["WSP_MCP_LINEAR_AUTHORIZATION", "WSP_MCP_LINEAR_X_TEAM"]);
  });

  it("keeps every other key and comment of the file where it was", async () => {
    const text = '{\n  // mine\n  "theme": "dark",\n  "mcpServers": {\n    "a": { "command": "x", "env": { "K": "v1" } } // the a server\n  }\n}\n';
    const out = await MCP_SERVERS_JSON.refer(text);
    expect(out.text).toBe('{\n  // mine\n  "theme": "dark",\n  "mcpServers": {\n    "a": { "command": "x", "env": { "K": "${K}" } } // the a server\n  }\n}\n');
  });

  it("names one server alone when asked, and stands byte for byte where nothing holds a value", async () => {
    expect((await MCP_SERVERS_JSON.refer(file, "notion")).servers.map(s => s.name)).toEqual(["notion"]);
    expect((await MCP_SERVERS_JSON.refer(file, "notion")).text).toContain(TOKEN);
    const plain = '{ "mcpServers": { "a": { "command": "x" } } }';
    expect((await MCP_SERVERS_JSON.refer(plain)).text).toBe(plain);
  });
});

describe("the other JSON formats write their own syntax", () => {
  it("Gemini CLI writes ${NAME}, OpenCode {env:NAME}", async () => {
    const gemini = await GEMINI_SETTINGS_JSON.refer(JSON.stringify({ mcpServers: { l: { httpUrl: "https://l.example", headers: { Authorization: `Bearer ${TOKEN}` } } } }));
    expect(gemini.text).toContain('"Bearer ${WSP_MCP_L_AUTHORIZATION}"');
    const opencode = await OPENCODE_JSON.refer(JSON.stringify({ mcp: { l: { type: "remote", url: "https://l.example", headers: { Authorization: `Bearer ${TOKEN}` } }, n: { type: "local", command: ["npx"], environment: { NOTION_TOKEN: NOTION } } } }));
    const root = parseJsonc(opencode.text) as { mcp: { l: { headers: Record<string, string> }; n: { environment: Record<string, string> } } };
    expect(root.mcp.l.headers).toEqual({ Authorization: "Bearer {env:WSP_MCP_L_AUTHORIZATION}" });
    expect(root.mcp.n.environment).toEqual({ NOTION_TOKEN: "{env:NOTION_TOKEN}" });
    expect(opencode.servers).toEqual([
      { name: "l", values: { WSP_MCP_L_AUTHORIZATION: TOKEN } },
      { name: "n", values: { NOTION_TOKEN: NOTION } },
    ]);
  });
});

describe("Codex's reference writer", () => {
  it("writes bearer_token_env_var, env_http_headers and env_vars in place of the values, every other line as it was", async () => {
    const text = [
      'model = "gpt-5"',
      "",
      "# linear, added by hand",
      "[mcp_servers.linear]",
      'url = "https://mcp.linear.app/mcp"',
      `http_headers = { "Authorization" = "Bearer ${TOKEN}", "X-Team" = "eng" }`,
      "startup_timeout_sec = 20",
      "",
      "[mcp_servers.notion]",
      'command = "npx"',
      'args = ["-y", "notion-mcp"]',
      "",
      "[mcp_servers.notion.env]",
      `NOTION_TOKEN = "${NOTION}"`,
      "",
      "[projects.\"/Users/dev\"]",
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const out = await CODEX_TOML.refer(text);
    expect(out.text).toBe(
      [
        'model = "gpt-5"',
        "",
        "# linear, added by hand",
        "[mcp_servers.linear]",
        'bearer_token_env_var = "WSP_MCP_LINEAR_AUTHORIZATION"',
        'env_http_headers = { "X-Team" = "WSP_MCP_LINEAR_X_TEAM" }',
        'url = "https://mcp.linear.app/mcp"',
        "startup_timeout_sec = 20",
        "",
        "[mcp_servers.notion]",
        'env_vars = ["NOTION_TOKEN"]',
        'command = "npx"',
        'args = ["-y", "notion-mcp"]',
        "",
        "[projects.\"/Users/dev\"]",
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    expect(out.servers).toEqual([
      { name: "linear", values: { WSP_MCP_LINEAR_AUTHORIZATION: TOKEN, WSP_MCP_LINEAR_X_TEAM: "eng" } },
      { name: "notion", values: { NOTION_TOKEN: NOTION } },
    ]);
    const read = CODEX_TOML.read(out.text, HOME);
    expect(read.find(s => s.name === "linear")).toMatchObject({ transport: { kind: "http", headers: {} }, envRefs: ["WSP_MCP_LINEAR_AUTHORIZATION", "WSP_MCP_LINEAR_X_TEAM"] });
    expect(read.find(s => s.name === "notion")).toMatchObject({ transport: { kind: "stdio", env: {} } });
  });

  it("adds to the names a table already reads rather than writing a key twice", async () => {
    const text = ["[mcp_servers.a]", 'url = "https://a.example"', 'bearer_token_env_var = "A_TOKEN"', 'env_http_headers = { "X-One" = "ONE" }', 'http_headers = { "Authorization" = "Bearer x1", "X-Two" = "two" }', ""].join("\n");
    const out = await CODEX_TOML.refer(text);
    expect(out.text).toBe(["[mcp_servers.a]", 'url = "https://a.example"', 'bearer_token_env_var = "A_TOKEN"', 'env_http_headers = { "X-One" = "ONE", "Authorization" = "WSP_MCP_A_AUTHORIZATION", "X-Two" = "WSP_MCP_A_X_TWO" }', ""].join("\n"));
    expect(out.servers[0]!.values).toEqual({ WSP_MCP_A_AUTHORIZATION: "Bearer x1", WSP_MCP_A_X_TWO: "two" });
    const stdio = ["[mcp_servers.b]", 'command = "b"', 'env_vars = ["HOME_DIR"]', 'env = { K = "v" }', ""].join("\n");
    expect((await CODEX_TOML.refer(stdio)).text).toBe(["[mcp_servers.b]", 'command = "b"', 'env_vars = ["HOME_DIR", "K"]', ""].join("\n"));
  });
});

describe("a whole file's servers by name", () => {
  const claude = (servers: Record<string, unknown>): string => JSON.stringify({ mcpServers: servers }, null, 2);
  const rows = (name: string): string | undefined => (name === "GEMINI_API_KEY" ? "Gemini CLI" : undefined);

  it("hands every value to the vault once and takes out a server that sets a name another already holds with another value", async () => {
    const held = new Map<string, { value: string; by: string }>();
    const first = await serversByName(MCP_SERVERS_JSON, claude({ notion: { command: "a", env: { NOTION_TOKEN: NOTION } } }), held, rows);
    expect(first.dropped).toEqual([]);
    const second = await serversByName(CODEX_TOML, ["[mcp_servers.other]", 'command = "b"', `env = { NOTION_TOKEN = "ntn_OTHER" }`, "", "[mcp_servers.same]", 'command = "c"', `env = { NOTION_TOKEN = "${NOTION}" }`, ""].join("\n"), held, rows);
    expect(second.dropped).toEqual([{ name: "other", reason: "sets NOTION_TOKEN, which notion already sets to another value" }]);
    expect(second.text).not.toContain("ntn_OTHER");
    expect(second.text).toContain('[mcp_servers.same]\nenv_vars = ["NOTION_TOKEN"]');
    expect([...held]).toEqual([["NOTION_TOKEN", { value: NOTION, by: "notion" }]]);
  });

  it("takes out of the copy a server that sets a catalog row's own variable, or a value on more than one line, each with its reason", async () => {
    const held = new Map<string, { value: string; by: string }>();
    const out = await serversByName(MCP_SERVERS_JSON, claude({ gem: { command: "gem-mcp", env: { GEMINI_API_KEY: "gem_TESTONLY" } }, pem: { command: "p", env: { KEY: "-----BEGIN\nx\n-----END" } } }), held, rows);
    expect(out.dropped).toEqual([
      { name: "gem", reason: "GEMINI_API_KEY belongs to the Gemini CLI key, so set it there or give the variable another name" },
      { name: "pem", reason: "sets KEY to a value on more than one line, which cannot travel by name" },
    ]);
    expect(out.text).not.toContain("gem_TESTONLY");
    expect(out.text).not.toContain("BEGIN");
    expect(held.size).toBe(0);
  });

  it("throws the format's own words where a file is not the format, so a caller never copies it as it was", async () => {
    const formats: McpFormat[] = [MCP_SERVERS_JSON, GEMINI_SETTINGS_JSON, OPENCODE_JSON];
    for (const f of formats) await expect(serversByName(f, "not json", new Map(), rows)).rejects.toThrow("the file is not valid JSON");
  });
});

describe("what a reference writer refuses rather than guess", () => {
  it("Codex: every TOML spelling of a server's headers and variables reads as one tree, so none of them travels with its value", async () => {
    const spellings: [string, string, Record<string, string>][] = [
      ['mcp_servers.linear = { url = "https://l.example", http_headers = { Authorization = "Bearer tok_INLINE" } }\n', "tok_INLINE", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_INLINE" }],
      ['[mcp_servers]\nlinear = { url = "https://l.example", http_headers = { Authorization = "Bearer tok_BARE" } }\n', "tok_BARE", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_BARE" }],
      ['[mcp_servers]\nlinear.url = "https://l.example"\nlinear.http_headers.Authorization = "Bearer tok_DOTTEDBARE"\n', "tok_DOTTEDBARE", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_DOTTEDBARE" }],
      ['[mcp_servers.linear]\nurl = "https://l.example"\nhttp_headers.Authorization = "Bearer tok_DOTTED"\n', "tok_DOTTED", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_DOTTED" }],
      ['[mcp_servers.notion]\ncommand = "npx"\nenv.NOTION_TOKEN = "ntn_DOTTED"\n', "ntn_DOTTED", { NOTION_TOKEN: "ntn_DOTTED" }],
      ['[mcp_servers.linear]\nurl = "https://l.example"\n\n[mcp_servers.linear."http_headers"]\nAuthorization = "Bearer tok_QUOTED"\n', "tok_QUOTED", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_QUOTED" }],
      ['[mcp_servers.linear]\nurl = "https://l.example"\nhttp_headers = { Authorization = """Bearer tok_MULTILINE""" }\n', "tok_MULTILINE", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_MULTILINE" }],
    ];
    for (const [text, secret, values] of spellings) {
      const out = await CODEX_TOML.refer(text);
      expect(out.text, text).not.toContain(secret);
      expect(out.servers.map(s => s.values), text).toEqual([values]);
      const read = parseToml(out.text) as { mcp_servers: Record<string, Record<string, unknown>> };
      const def = Object.values(read.mcp_servers)[0]!;
      expect(def["http_headers"], text).toBeUndefined();
      expect(def["env"], text).toBeUndefined();
      expect(def["bearer_token_env_var"] ?? def["env_vars"], text).toEqual(Object.keys(values)[0] === "NOTION_TOKEN" ? ["NOTION_TOKEN"] : "WSP_MCP_LINEAR_AUTHORIZATION");
    }
  });

  it("Codex: refuses a server shape it cannot map, so the file stays on this computer rather than travel with its token", async () => {
    const shapes: [string, string][] = [
      ['[[mcp_servers.linear]]\nurl = "https://l.example"\nhttp_headers = { Authorization = "Bearer tok_ARRAYTABLE" }\n', "mcp_servers.linear"],
      ['[[mcp_servers]]\nurl = "https://l.example"\nhttp_headers = { Authorization = "Bearer tok_ARRAYROOT" }\n', "mcp_servers"],
      ['[mcp_servers.linear]\nurl = "https://l.example"\n\n[mcp_servers.linear.http_headers.Authorization]\nvalue = "Bearer tok_NESTED"\n', "mcp_servers.linear"],
    ];
    for (const [text, where] of shapes) await expect(CODEX_TOML.refer(text), text).rejects.toThrow(`${where} is written in a shape wsp does not read, so its values cannot be written by name`);
  });

  it("copies an ordinary config whose unrelated keys and history hold the same short words as a server's values", async () => {
    const claude = JSON.stringify(
      {
        verbose: true,
        numStartups: 1,
        theme: "dev",
        history: ["deploy to production", "run dev with debug on", "true"],
        projects: { "/Users/dev/app": { lastSessionId: "1", allowedTools: ["debug"] } },
        mcpServers: { notion: { command: "npx", env: { DEBUG: "1", STAGE: "dev", NODE_ENV: "production", FLAG: "true" } } },
      },
      null,
      2,
    );
    const out = await MCP_SERVERS_JSON.refer(claude);
    expect(out.servers).toEqual([{ name: "notion", values: { DEBUG: "1", STAGE: "dev", NODE_ENV: "production", FLAG: "true" } }]);
    expect(out.text).toContain('"history": [');
    const codex = '# production box, dev notes\nmodel = "gpt-5"\n\n[mcp_servers.n]\ncommand = "npx"\nenv = { NODE_ENV = "production", DEBUG = "1" }\n';
    expect((await CODEX_TOML.refer(codex)).servers[0]!.values).toEqual({ NODE_ENV: "production", DEBUG: "1" });
  });

  it("refuses the copy where a value still stands in a server's entry, whole or after its scheme word, whatever its length", async () => {
    const said = "s's value still stands in the file after it was written by name, so the file stays on this computer";
    await expect(CODEX_TOML.refer('[mcp_servers.s]\nurl = "https://s.example"\nnote = "Bearer tok1"\nhttp_headers = { Authorization = "Bearer tok1" }\n')).rejects.toThrow(said);
    await expect(CODEX_TOML.refer('[mcp_servers.s]\ncommand = "x"\nargs = ["tok1"]\nenv = { K = "tok1" }\n')).rejects.toThrow(said);
    await expect(MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { command: "x", args: ["--auth", "token sk_TESTONLY_long_value"], env: { K: "sk_TESTONLY_long_value" } } } }))).rejects.toThrow(said);
    await expect(MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { Authorization: "Bearer t1" } }, o: { command: "x", args: ["Basic t1"] } } }))).rejects.toThrow("s's value still stands");
    // A header whose whole value keeps its scheme word, and the credential standing bare elsewhere.
    await expect(MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { "X-Auth": "Basic cred123" } }, o: { command: "x", args: ["cred123"] } } }))).rejects.toThrow("s's value still stands");
  });

  it("two headers of one server that would travel under one name", async () => {
    const text = JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { "X-Api-Key": "a", X_Api_Key: "b" } } } });
    await expect(MCP_SERVERS_JSON.refer(text)).rejects.toThrow("s sends X-Api-Key and X_Api_Key, which would both travel as WSP_MCP_S_X_API_KEY; rename one");
    await expect(CODEX_TOML.refer('[mcp_servers.s]\nurl = "https://s.example"\nhttp_headers = { "X-Api-Key" = "a", "X_Api_Key" = "b" }\n')).rejects.toThrow("s sends X-Api-Key and X_Api_Key, which would both travel as WSP_MCP_S_X_API_KEY; rename one");
  });

  it("a value that mixes a literal with a variable, which cannot travel whole by name", async () => {
    await expect(MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { Authorization: "Bearer lit_${X}" } } } }))).rejects.toThrow("s's Authorization mixes a value with a variable, so it cannot travel by name; make it one or the other");
    await expect(GEMINI_SETTINGS_JSON.refer(JSON.stringify({ mcpServers: { s: { command: "x", env: { K: "ab$cd" } } } }))).rejects.toThrow("s's K mixes a value with a variable, so it cannot travel by name; make it one or the other");
    // A whole reference, a bearer's included, stands as written.
    expect((await MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { Authorization: "Bearer ${X}", Y: "${Y:-d}" } } } }))).servers).toEqual([{ name: "s", values: {} }]);
  });
});
