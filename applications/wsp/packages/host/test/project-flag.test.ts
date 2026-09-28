// SPDX-License-Identifier: AGPL-3.0-only
// --project on the skills and servers lines, and project on their tools: bare,
// the workspace's own project as it always was; a name with --on, that
// computer's project of the name, which rides the target to the host. A name
// with a workspace, and a bare flag with --on, are refused before anything is
// sent.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES, HERE_PLACE_ID } from "@wsp/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { CLI_VERBS, optionalValues, runVerb, type HostClient, type VerbDeps } from "../src/verbs.js";
import { captured } from "./verbs-fixture.js";

const WWW = { id: "pr_www", name: "www", path: "~/www" };
const db = (project?: typeof WWW) => ({ agent: "claude", name: "db", scope: project === undefined ? "user" : "project", file: project === undefined ? "~/.claude.json" : "~/www/.mcp.json", transport: { kind: "stdio", line: "npx db-mcp" }, envNames: [], auth: "open", enabled: true, ...(project === undefined ? {} : { project }) });
const REPORT = {
  target: { placeId: "p_1" },
  home: "/home/ada",
  user: "ada",
  readAt: "2026-09-25T12:00:00.000Z",
  agents: [],
  skills: [{ name: "deploy", scope: "project", paths: [{ path: "~/www/.claude/skills/deploy" }], project: WWW }],
  servers: [db(), db(WWW)],
  refused: [],
  projects: [WWW],
};

const dir = mkdtempSync(join(tmpdir(), "wsp-project-flag-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A host that lists two computers and one workspace, records every act it is asked, and answers each the shape its
 * verb reads. */
function fakeHost() {
  const acts: { op: string; params: Record<string, unknown> }[] = [];
  const answers: Record<string, unknown> = {
    "skills.preview": { preview: { text: "# deploy", size: 8 } },
    "skills.add": { added: { path: "~/spoo/.agents/skills/pdf", agents: [] } },
    "skills.remove": { removed: ["~/spoo/.claude/skills/deploy"] },
    "servers.add": { file: "~/spoo/.mcp.json" },
    "servers.remove": { file: "~/spoo/.mcp.json" },
    "servers.toggle": { file: "~/spoo/opencode.json" },
    "servers.tools": { answer: { auth: "open", tools: [], readAt: "2026-09-25T12:00:00.000Z" } },
    "agents.read": { report: REPORT },
  };
  const client = {
    request: async <T,>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (op === "places.list")
        return {
          places: [
            { id: HERE_PLACE_ID, kind: "computer", name: "zingzys-mac", default: true },
            { id: "p_1", kind: "computer", name: "spoo", default: false, present: true },
          ],
        } as T;
      if (op === "workspaces.resolve")
        return { workspace: { id: "ws_1", name: "landing", machineId: "m1", phase: "running", golden: "snap_gold", createdAt: "2026-09-25T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "p_1" } } } as T;
      acts.push({ op, params });
      if (!(op in answers)) throw new Error(`asked for ${op}`);
      return answers[op] as T;
    },
    events: async (): Promise<void> => {},
    onFrame: () => () => {},
    closed: new Promise<void>(() => {}),
    closeWords: () => "closed",
    close: () => {},
    terminate: () => {},
  };
  return { acts, client: client as unknown as HostClient };
}

const run = async (argv: string[]) => {
  const host = fakeHost();
  const io = captured();
  const words = CLI_VERBS.filter(v => v.name.split(" ").every((w, i) => argv[i] === w)).sort((a, b) => b.name.length - a.name.length)[0]!;
  const code = await runVerb(words, argv.includes("--plain") ? argv.filter(w => w !== "--plain") : [...argv, "--json"], io, () => join(dir, "state.json"), { env: {}, dial: async () => host.client });
  return { code, acts: host.acts, errors: io.errors, lines: io.lines };
};

describe("--project on the skills and servers lines", () => {
  it("names a computer's project with --on, which rides the target, on every line with a project act", async () => {
    const lines: [string[], string, Record<string, unknown>][] = [
      [["skills", "show", "deploy"], "skills.preview", { name: "deploy", project: true }],
      [["skills", "add", "acme/skills/pdf"], "skills.add", { skill: "acme/skills/pdf", project: true }],
      [["skills", "remove", "deploy"], "skills.remove", { name: "deploy", project: true }],
      [["servers", "add", "db", "--agent", "claude", "--command", "npx db-mcp"], "servers.add", { name: "db", project: true }],
      [["servers", "remove", "db", "--agent", "claude"], "servers.remove", { name: "db", scope: "project" }],
      [["servers", "disable", "db", "--agent", "opencode"], "servers.toggle", { name: "db", scope: "project", on: false }],
      [["servers", "enable", "db", "--agent", "opencode"], "servers.toggle", { name: "db", scope: "project", on: true }],
      [["servers", "tools", "db", "--agent", "claude"], "servers.tools", { name: "db" }],
    ];
    for (const [words, op, ask] of lines) {
      const { code, acts, errors } = await run([...words, "--on", "spoo", "--project", "www"]);
      expect(code, `${words.join(" ")}: ${errors.join(" ")}`).toBe(0);
      expect(acts, words.join(" ")).toEqual([{ op, params: expect.objectContaining({ target: { placeId: "p_1", project: "www" }, ...ask }) }]);
    }
  });

  it("stays the workspace's own project bare, before or after the workspace, and a word after it is still the workspace", async () => {
    for (const argv of [
      ["skills", "remove", "deploy", "landing", "--project"],
      ["skills", "remove", "deploy", "--project", "landing"],
    ]) {
      const { code, acts } = await run(argv);
      expect(code, argv.join(" ")).toBe(0);
      expect(acts).toEqual([{ op: "skills.remove", params: expect.objectContaining({ target: { workspaceId: "ws_1" }, name: "deploy", project: true }) }]);
    }
    const scoped = await run(["servers", "remove", "db", "landing", "--agent", "claude", "--project"]);
    expect(scoped.acts).toEqual([{ op: "servers.remove", params: expect.objectContaining({ target: { workspaceId: "ws_1" }, scope: "project" }) }]);
  });

  it("refuses a bare --project with --on, a project name beside --scope user, and nothing is sent", async () => {
    const bare = await run(["skills", "remove", "deploy", "--on", "spoo", "--project"]);
    expect(bare.code).toBe(EXIT_CODES.usage);
    expect(bare.acts).toEqual([]);
    expect(bare.errors.join(" ")).toContain("--project with --on names the project");
    const scoped = await run(["servers", "remove", "db", "--agent", "claude", "--on", "spoo", "--project", "www", "--scope", "user"]);
    expect(scoped.code).toBe(EXIT_CODES.usage);
    expect(scoped.acts).toEqual([]);
  });
});

describe("project on the skills and servers tools", () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const host = fakeHost();
    const verb = CLI_VERBS.find(v => v.name === name);
    if (verb === undefined || !("tool" in verb)) throw new Error(`${name} has no tool`);
    const deps = { statePath: join(dir, "state.json"), env: {}, client: async () => host.client } as unknown as VerbDeps;
    const result = await verb.tool.call(args as never, deps);
    return { result, acts: host.acts };
  };

  it("takes true for the workspace's project and a name with on for that computer's", async () => {
    expect((await call("skills remove", { name: "deploy", workspace: "landing", project: true })).acts).toEqual([
      { op: "skills.remove", params: expect.objectContaining({ target: { workspaceId: "ws_1" }, project: true }) },
    ]);
    expect((await call("skills remove", { name: "deploy", on: "spoo", project: "www" })).acts).toEqual([
      { op: "skills.remove", params: expect.objectContaining({ target: { placeId: "p_1", project: "www" }, project: true }) },
    ]);
    expect((await call("servers tools", { name: "db", agent: "claude", on: "spoo", project: "www" })).acts).toEqual([
      { op: "servers.tools", params: expect.objectContaining({ target: { placeId: "p_1", project: "www" } }) },
    ]);
    expect((await call("servers disable", { name: "db", agent: "opencode", on: "spoo", project: "www" })).acts).toEqual([
      { op: "servers.toggle", params: expect.objectContaining({ target: { placeId: "p_1", project: "www" }, scope: "project", on: false }) },
    ]);
  });
});

describe("a flag whose value is optional", () => {
  it("is read off its row in the flag table: bare it stands alone, and it takes the next word only beside the flag its row names", () => {
    const table = { tag: { type: "string" as const, valueWith: "at" }, at: { type: "string" as const }, other: { type: "string" as const } };
    expect(optionalValues(["x", "--tag", "y"], table)).toEqual(["x", "--tag=", "y"]);
    expect(optionalValues(["x", "--at", "box", "--tag", "y"], table)).toEqual(["x", "--at", "box", "--tag", "y"]);
    expect(optionalValues(["--at=box", "--tag"], table)).toEqual(["--at=box", "--tag="]);
    expect(optionalValues(["--at", "box", "--tag", "--json"], table)).toEqual(["--at", "box", "--tag=", "--json"]);
    expect(optionalValues(["--other", "--tag", "--", "--tag"], { other: table.other })).toEqual(["--other", "--tag", "--", "--tag"]);
    expect(optionalValues(["--tag", "--", "--tag"], table)).toEqual(["--tag=", "--", "--tag"]);
  });
});

describe("the skills and servers tables", () => {
  it("name a project's row by its project the same way, so two projects' rows of one name are told apart", async () => {
    const servers = await run(["servers", "--on", "spoo", "--plain"]);
    expect(servers.code, servers.errors.join(" ")).toBe(0);
    const rows = servers.lines.join("\n").split("\n").filter(l => l.startsWith("db"));
    expect(rows.map(l => l.split(/\s{2,}/)[2])).toEqual(["user", "project www"]);
    const skills = await run(["skills", "--on", "spoo", "--plain"]);
    expect(skills.lines.join("\n")).toMatch(/deploy\s+project www\s/);
  });
});
