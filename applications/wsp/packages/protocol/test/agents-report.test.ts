// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { AgentsChangedEvent, AgentsReport, commandWords, AgentsSignInEvent, EventUnion, RuntimeRequest, SECRET_REQUEST_FIELDS, ServerToolsAnswer, SignInLine, SkillHit, SkillPreview, THREAD_OPS, DEVICE_OPS, controlNameRefusal, hasControlChar, withoutControlChars, requestSecrets, serverToolsLateRefusal } from "../src/index.js";

const report = {
  target: { placeId: "here" },
  home: "/Users/ada",
  user: "ada",
  readAt: "2026-09-24T12:00:00.000Z",
  agents: [{ id: "claude", name: "Claude Code", installed: true, version: "2.1.281", road: "own", path: "~/.local/bin/claude", signIn: "signed-in", signInRoad: "token", wspTools: true }],
  skills: [{ name: "pdf", description: "Read PDFs", scope: "user", paths: [{ path: "~/.agents/skills/pdf" }, { path: "~/.claude/skills/pdf", agent: "claude", linkTo: "~/.agents/skills/pdf" }] }],
  servers: [{ agent: "codex", name: "notion", scope: "user", file: "~/.codex/config.toml", transport: { kind: "http", host: "mcp.notion.com" }, envNames: ["NOTION_TOKEN"], auth: "unknown", enabled: true }],
  refused: [],
};

describe("the agents report on the wire", () => {
  it("carries names and states, and a value that rode along on a row is dropped by the parse", () => {
    expect(AgentsReport.parse(report)).toEqual(report);
    const leaked = { ...report, servers: [{ ...report.servers[0], env: { NOTION_TOKEN: "ntn_x" }, headers: { Authorization: "Bearer x" } }] };
    expect(JSON.stringify(AgentsReport.parse(leaked))).not.toMatch(/ntn_x|Bearer/);
    expect(AgentsReport.parse({ ...report, stale: "napping" }).stale).toBe("napping");
    expect(() => AgentsReport.parse({ ...report, skills: [{ name: "pdf", scope: "user", paths: [] }] })).toThrow();
    expect(() => AgentsReport.parse({ ...report, agents: [{ ...report.agents[0], signIn: "maybe" }] })).toThrow();
  });

  it("agents.read names a computer or a workspace, never both, and is shut to threads and paired devices", () => {
    expect(RuntimeRequest.parse({ id: "1", op: "agents.read", target: { placeId: "here" } })).toMatchObject({ op: "agents.read", target: { placeId: "here" } });
    expect(RuntimeRequest.parse({ id: "1", op: "agents.read", target: { workspaceId: "ws_1" } })).toMatchObject({ target: { workspaceId: "ws_1" } });
    expect(() => RuntimeRequest.parse({ id: "1", op: "agents.read", target: { placeId: "here", workspaceId: "ws_1" } })).toThrow();
    expect(() => RuntimeRequest.parse({ id: "1", op: "agents.read", target: {} })).toThrow();
    expect(THREAD_OPS).not.toContain("agents.read");
    expect(DEVICE_OPS).not.toContain("agents.read");
  });

  it("servers.tools names one server by its agent on a computer or a workspace, and is shut to threads and paired devices", () => {
    const ask = { id: "1", op: "servers.tools", target: { placeId: "p_spoo" }, agent: "claude", name: "airtable" };
    expect(RuntimeRequest.parse(ask)).toEqual(ask);
    expect(RuntimeRequest.parse({ ...ask, refresh: true })).toMatchObject({ refresh: true });
    expect(() => RuntimeRequest.parse({ ...ask, agent: undefined })).toThrow();
    expect(THREAD_OPS).not.toContain("servers.tools");
    expect(DEVICE_OPS).not.toContain("servers.tools");
  });

  it("a tools answer carries the tools, or the harness that holds the sign-in, or why nothing came back", () => {
    const listed = { auth: "open", tools: [{ name: "list_records", description: "List records" }], readAt: "2026-09-24T12:00:00.000Z" };
    expect(ServerToolsAnswer.parse(listed)).toEqual(listed);
    expect(ServerToolsAnswer.parse({ auth: "signed-in", holder: "claude", readAt: listed.readAt })).toMatchObject({ holder: "claude" });
    expect(ServerToolsAnswer.parse({ auth: "failed", refused: serverToolsLateRefusal(20_000), readAt: listed.readAt }).refused).toBe("Did not answer in 20 s.");
    expect(() => ServerToolsAnswer.parse({ auth: "maybe", readAt: listed.readAt })).toThrow();
  });

  it("the sign-in acts name their target and agent, carry the code and the key in the fields a log hides, and are shut to threads and paired devices", () => {
    const acts = [
      { id: "1", op: "agents.signIn", target: { placeId: "p_spoo" }, agent: "codex" },
      { id: "2", op: "servers.signIn", target: { workspaceId: "ws_1" }, agent: "claude", name: "notion" },
      { id: "3", op: "agents.signInCode", signInId: "si_1", code: "ABCD-1234" },
      { id: "4", op: "agents.signInLine", target: { placeId: "here" }, agent: "opencode" },
      { id: "5", op: "agents.signInLine", target: { placeId: "here" }, agent: "claude", name: "notion" },
      { id: "6", op: "agents.key", agent: "claude", key: "sk-ant-oat01-x" },
      { id: "7", op: "agents.addTools", target: { placeId: "here" }, agent: "codex" },
      { id: "8", op: "agents.signInStop", signInId: "si_1" },
    ];
    for (const act of acts) {
      expect(RuntimeRequest.parse(act)).toEqual(act);
      expect(THREAD_OPS).not.toContain(act.op);
      expect(DEVICE_OPS).not.toContain(act.op);
    }
    expect(SECRET_REQUEST_FIELDS).toEqual(expect.arrayContaining(["code", "key"]));
    expect(requestSecrets(acts[2])).toEqual(["ABCD-1234"]);
    expect(requestSecrets(acts[5])).toEqual(["sk-ant-oat01-x"]);
    expect(() => RuntimeRequest.parse({ id: "8", op: "agents.signIn", target: { placeId: "p" } })).toThrow();
  });

  it("a name holding a control character is caught by one predicate, whichever one it holds, and refused in one sentence naming its file", () => {
    for (const c of ["\x00", "\x03", "\x15", "\r", "\n", "\x1b", "\x7f", "\x80", "\x9b", "\x9f"]) expect(hasControlChar(`notion${c}echo hi`)).toBe(true);
    expect(withoutControlChars("no\x1b[2Jti\x9b31mon\x85\x7f ü")).toBe("no[2Jti31mon ü");
    expect(hasControlChar("notion-2 (work)")).toBe(false);
    expect(hasControlChar("ünïcode")).toBe(false);
    expect(controlNameRefusal("~/.claude.json")).toBe("~/.claude.json names a server with a control character in its name, which was left out.");
  });

  it("a sign-in's progress carries the page, the code it printed and whether a code goes back, and the change event rides the stream", () => {
    const waiting = { type: "agents.signIn", signInId: "si_1", state: "waiting", url: "https://auth.openai.com/device", code: "ABCD-1234", paste: false };
    expect(AgentsSignInEvent.parse(waiting)).toEqual(waiting);
    expect(AgentsSignInEvent.parse({ type: "agents.signIn", signInId: "si_1", state: "failed", said: "Not logged in" }).said).toBe("Not logged in");
    expect(() => AgentsSignInEvent.parse({ ...waiting, state: "maybe" })).toThrow();
    expect(AgentsChangedEvent.parse({ type: "agents.changed", target: { placeId: "here" } })).toMatchObject({ target: { placeId: "here" } });
    expect(EventUnion.parse({ type: "agents.changed", seq: 3 })).toMatchObject({ type: "agents.changed" });
    expect(SignInLine.parse({ command: "codex login --device-auth", env: { CODEX_HOME: "/var/lib/wsp/logins/codex" }, prepare: "mkdir -p x", status: "codex login status" })).toMatchObject({ prepare: "mkdir -p x" });
  });

  it("the skills acts name a target and a skill, the search and the skills.sh read name none, and all are shut to threads and paired devices", () => {
    const acts = [
      { id: "1", op: "skills.search", q: "pdf", limit: 20 },
      { id: "2", op: "skills.get", skill: "anthropics/skills/pdf" },
      { id: "3", op: "skills.preview", target: { placeId: "here" }, name: "pdf" },
      { id: "4", op: "skills.add", target: { workspaceId: "ws_1" }, skill: "anthropics/skills/pdf", agents: ["claude"], project: true },
      { id: "5", op: "skills.remove", target: { placeId: "p_spoo" }, name: "pdf" },
      { id: "6", op: "skills.toggle", target: { placeId: "here" }, name: "pdf", project: false, on: false },
    ];
    for (const act of acts) {
      expect(RuntimeRequest.parse(act)).toEqual(act);
      expect(THREAD_OPS).not.toContain(act.op);
      expect(DEVICE_OPS).not.toContain(act.op);
    }
    expect(() => RuntimeRequest.parse({ id: "1", op: "skills.search", q: "pdf", limit: 500 })).toThrow();
    expect(() => RuntimeRequest.parse({ id: "6", op: "skills.toggle", target: { placeId: "here" }, name: "pdf" })).toThrow();
  });

  it("the server acts name a target, an agent and a server; the values an add carries are the request's secrets; all are shut to threads and paired devices", () => {
    const acts = [
      { id: "1", op: "servers.add", target: { placeId: "here" }, agent: "claude", name: "acme", command: "npx", args: ["-y", "@acme/mcp"], env: { ACME_KEY: "sk-acme-x" } },
      { id: "2", op: "servers.add", target: { workspaceId: "ws_1" }, agent: "codex", name: "remote", project: true, url: "https://mcp.acme.example/mcp", headers: { Authorization: "Bearer tok-acme" } },
      { id: "3", op: "servers.remove", target: { placeId: "p_spoo" }, agent: "claude", name: "acme", scope: "home" },
      { id: "4", op: "servers.toggle", target: { placeId: "here" }, agent: "opencode", name: "acme", on: false },
    ];
    for (const act of acts) {
      expect(RuntimeRequest.parse(act)).toEqual(act);
      expect(THREAD_OPS).not.toContain(act.op);
      expect(DEVICE_OPS).not.toContain(act.op);
    }
    expect(requestSecrets(acts[0])).toEqual(["sk-acme-x"]);
    expect(requestSecrets(acts[1])).toEqual(["Bearer tok-acme"]);
    expect(() => RuntimeRequest.parse({ ...acts[2], scope: "plugin" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: "4", op: "servers.toggle", target: { placeId: "here" }, agent: "opencode", name: "acme" })).toThrow();
  });

  it("a command line a person types splits into its words, quotes kept together and nothing expanded", () => {
    expect(commandWords("npx -y @acme/mcp")).toEqual(["npx", "-y", "@acme/mcp"]);
    expect(commandWords("  uvx  'a b'  \"c \\\" d\" e\\ f $HOME ")).toEqual(["uvx", "a b", 'c " d', "e f", "$HOME"]);
    expect(commandWords("node '' x")).toEqual(["node", "", "x"]);
    expect(commandWords("")).toEqual([]);
    expect(commandWords('x "unclosed')).toBeUndefined();
    expect(commandWords("x 'unclosed")).toBeUndefined();
  });

  it("a skill's folder can be off, a search hit is what skills.sh answers, and a preview carries the file's whole size beside its first part", () => {
    const off = { ...report, skills: [{ name: "pdf", scope: "user", paths: [{ path: "~/.agents/skills/pdf", off: true }] }] };
    expect(AgentsReport.parse(off).skills[0]!.paths[0]!.off).toBe(true);
    const hit = { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 3_600_000 };
    expect(SkillHit.parse(hit)).toEqual(hit);
    expect(() => SkillHit.parse({ ...hit, installs: -1 })).toThrow();
    expect(SkillPreview.parse({ text: "# pdf", size: 130_000 })).toEqual({ text: "# pdf", size: 130_000 });
  });

  it("a computer's report names each project it read, its project rows carry theirs, a target may name one, and a tool carries its parameters", () => {
    const spoo = { id: "pr_1", name: "spoo", path: "~/spoo" };
    const withProjects = {
      ...report,
      projects: [spoo, { id: "pr_2", name: "www", path: "~/www" }],
      skills: [...report.skills, { name: "deploy", scope: "project", paths: [{ path: "~/spoo/.claude/skills/deploy", agent: "claude" }], project: spoo }],
      servers: [...report.servers, { agent: "claude", name: "db", scope: "project", file: "~/spoo/.mcp.json", transport: { kind: "stdio", line: "npx db-mcp" }, envNames: [], auth: "open", enabled: true, project: spoo }],
    };
    expect(AgentsReport.parse(withProjects)).toEqual(withProjects);
    expect(RuntimeRequest.parse({ id: "1", op: "servers.tools", target: { placeId: "p_spoo", project: "pr_1" }, agent: "claude", name: "db" })).toMatchObject({ target: { placeId: "p_spoo", project: "pr_1" } });
    expect(() => RuntimeRequest.parse({ id: "1", op: "agents.read", target: { workspaceId: "ws_1", project: "pr_1" } })).toThrow();
    const tool = { name: "query", description: "Runs a query", params: [{ name: "sql", type: "string", required: true, description: "The query" }, { name: "limit", required: false }] };
    expect(ServerToolsAnswer.parse({ auth: "open", tools: [tool], readAt: "2026-09-25T12:00:00.000Z" }).tools).toEqual([tool]);
  });
});
