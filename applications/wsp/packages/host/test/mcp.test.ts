// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
// The MCP server over the host: an MCP client calls each tool against a host
// over the fake runtime, through the same socket client and verb logic the
// command line uses; a thread it opens is the local agent's.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { CATALOG, THREAD_AGENTS } from "@wsp/catalog";
import { type ProjectView, HERE_PLACE_ID, noProjectImageLine, projectImageInUseRefusal, projectImageRemoveNotice, projectImageRemovedLine, addedProjectLine, goneRoadRefusal, EMPTY_TASK_LINE, EXIT_CODES, HOST_STOPPING_LINE, NO_SUCH_TURN, noSuchProjectLine, noThreadTargetLine, ProjectGolden, Recipe, registeredLine, registerTakesNoConsentLine, threadOpenedLine, ThreadView, TURN_TOKEN_ENV, workspaceKind, WorkspaceView, type ExitClass } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localWiring, serve } from "../src/cli.js";
import { BUILT_IN_LIST_CLAUSE, c1Escaped, hostPlatform, noHostServingLine } from "../src/verbs.js";
import { placeWiring } from "../src/places.js";
import { dialer, mcpServer, serveMcp } from "../src/mcp.js";
import { RecipeAnswer, RecipeScan, allRows, recipePrintout, scanPrintout } from "../src/recipe-answer.js";
import { WSP_SKILL, instructionsOf } from "../src/skill.js";
import type { HostHandle } from "../src/server.js";
import type { HostClient } from "../src/verbs.js";
import { HERE } from "./recipe-fixture.js";

/** This computer, as the places list names it: the word a caller passes as `on` for the place their own agents run
 * on, which is where a workspace that forks nothing lives. */
const HERE_PLACE = hostname().toLowerCase();
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { copyingFake, createOn, fakeDaemonStart, projectOn, CUT_LINE, EXPORT_SESSION, EXPORT_SOURCE, PAGE, captured, execGuest, exportGuest, launchedScripts, projectBundler, heldAgent, scriptedAgent, stuckAgent, doneOnlyAgent } from "./verbs-fixture.js";

interface Called {
  text: string;
  structured: Record<string, unknown> | undefined;
  isError: boolean;
}

/** A failure as the contract shapes it on the tool door: the line as text, and the failure object with its class beside it. */
const failedWith = (text: string, cls: Exclude<ExitClass, "ok"> = "provider"): Called => ({ text, structured: { error: text, class: cls, exit: EXIT_CODES[cls] }, isError: true });

/** The client side of a stdio pair over two streams: what an agent's process does to `wsp mcp`, in-process. */
function streamTransport(toServer: PassThrough, fromServer: PassThrough): Transport {
  const buffer = new ReadBuffer();
  const t: Transport = {
    start: async () => {
      fromServer.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        for (let msg = buffer.readMessage(); msg !== null; msg = buffer.readMessage()) t.onmessage?.(msg);
      });
    },
    send: async (msg: JSONRPCMessage) => {
      toServer.write(serializeMessage(msg));
    },
    close: async () => {
      toServer.end();
      t.onclose?.();
    },
  };
  return t;
}

describe("the MCP server over the host", () => {
  let dir: string;
  let statePath: string;
  let backend: StubBackend;
  let store: Store;
  let rt: Runtime;
  /** The project on the computer this host forks at, recorded for every case. */
  let cloud: ProjectView;
  let handle: HostHandle | undefined;
  let claude: ReturnType<typeof scriptedAgent>;
  let codex: ReturnType<typeof scriptedAgent>;
  let client: Client | undefined;
  let server: ReturnType<typeof mcpServer> | undefined;
  /** The environment the tool server runs with: this file's, never the shell that started the run, so a builder with
   * WSP_TURN exported does not have every start refused. The case that means a turn writes that turn's token into it. */
  let env: Record<string, string | undefined>;
  /** The host socket the server last dialled, so a test can wait for the host's close to reach it. */
  let socket: HostClient | undefined;

  beforeEach(async () => {
    env = {};
    dir = mkdtempSync(join(tmpdir(), "wsp-mcp-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_mcp_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    backend = stubBackend();
    store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    claude = scriptedAgent(prompt => (prompt === "die" ? "" : `re: ${prompt}`));
    codex = scriptedAgent(prompt => `codex: ${prompt}`);
    rt = createRuntime({ backend, store, adapters: { claude: claude.adapter, codex: codex.adapter }, local: localWiring(join(dir, "user"), undefined, fakeDaemonStart, undefined, copyingFake()), placeLinks: placeWiring(statePath) });
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    // A workspace is one project's copy, so every call that makes one needs a project first; one project here, so
    // new takes the work alone.
    cloud = await projectOn(rt);
    // The host has its keys; the server never reads any.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(over: Partial<Parameters<typeof mcpServer>[1]> = {}): Promise<Client> {
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    // No starter: this server is held to what it answers with when nothing serves, not to one it would bring up.
    const dial = dialer(statePath);
    server = mcpServer(statePath, { dial: Object.assign(async () => (socket = await dial()), { close: dial.close }), env, ...over });
    await server.connect(toServer);
    client = new Client({ name: "test-agent", version: "0.0.0" });
    await client.connect(toClient);
    return client;
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
    const c = client ?? (await connect());
    const result = await c.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return {
      text: content.map(part => part.text ?? "").join(""),
      structured: result.structuredContent as Record<string, unknown> | undefined,
      isError: result.isError === true,
    };
  }

  async function restartHost(adapters: Parameters<typeof createRuntime>[0]["adapters"]): Promise<void> {
    await handle?.close();
    handle = undefined;
    rt = createRuntime({ backend, store, adapters, local: localWiring(join(dir, "user"), undefined, fakeDaemonStart, undefined, copyingFake()), placeLinks: placeWiring(statePath) });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_mcp_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
  }

  /** A project on the computer the host runs on: a real repo in a folder of its own, since a workspace here is a
   * folder of the person's own worked in place. */
  async function hereProject(): Promise<ProjectView> {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-mcp-here-")));
    execFileSync("git", ["init", "-q", folder]);
    return rt.projects.add({ source: folder });
  }

  it("offers the verbs as tools, each described", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(["agents", "agents_addtools", "bring_back", "computers", "delete", "exec", "export", "folders", "forget", "fork", "image", "image_build", "image_move", "image_remove", "new", "pause", "projects", "projects_add", "projects_remove", "rebuild", "recipe", "recipe_scan", "rename", "run", "send", "servers", "servers_add", "servers_disable", "servers_enable", "servers_remove", "servers_tools", "setup", "skills", "skills_add", "skills_disable", "skills_enable", "skills_remove", "skills_search", "skills_show", "snapshot", "stop", "terminal_config", "thread_allow", "thread_deny", "thread_forget", "thread_read", "thread_rename", "threads", "threads_wait", "wake", "workspaces", "workspaces_agents"]);
    for (const name of ["agents", "skills", "servers"]) expect(Object.keys((tools.find(t => t.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties).sort(), name).toEqual(["on", "workspace"]);
    expect(Object.keys((tools.find(t => t.name === "servers_tools")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["agent", "name", "on", "project", "refresh", "workspace"]);
    expect(Object.keys((tools.find(t => t.name === "folders")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["folder", "hidden", "on", "repos"]);
    expect(Object.keys((tools.find(t => t.name === "terminal_config")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["scheme"]);
    for (const t of tools) expect(t.description, t.name).toMatch(/\S/);
    expect(Object.keys((tools.find(t => t.name === "new")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["engine", "from", "max_depth", "max_machines", "name", "project", "size", "spawn"]);
    expect(Object.keys((tools.find(t => t.name === "rename")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["name", "workspace"]);
    expect(Object.keys((tools.find(t => t.name === "run")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["access", "agent", "cwd", "detach", "effort", "images", "model", "notify", "task", "title", "workspace"]);
    expect(Object.keys((tools.find(t => t.name === "fork")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["access", "agent", "cwd", "effort", "max_depth", "max_machines", "model", "name", "notify", "size", "spawn", "task", "workspace"]);
    // No access among them: a thread's access is the thread's own and a message does not change it.
    expect(Object.keys((tools.find(t => t.name === "send")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["detach", "effort", "images", "message", "model", "thread"]);
    expect(Object.keys((tools.find(t => t.name === "threads_wait")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["threads", "timeout"]);
    expect(Object.keys((tools.find(t => t.name === "exec")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["argv", "cwd", "workspace"]);
    expect(Object.keys((tools.find(t => t.name === "delete")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["confirm", "workspace"]);
    expect(Object.keys((tools.find(t => t.name === "image_remove")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["confirm", "image"]);
    expect(tools.find(t => t.name === "image")!.description).toContain("The project images taken off workspaces are listed under it, each with its snapshot id, the workspace it was taken off, its size where the provider lists one and its date.");
    expect(Object.keys((tools.find(t => t.name === "recipe")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["add", "add_check", "engine", "out", "project", "set", "signin", "tick", "why"]);
    expect(c.getServerVersion()?.name).toBe("wsp");
    expect(c.getInstructions()).toBe(instructionsOf(WSP_SKILL, THREAD_AGENTS));
    expect(c.getInstructions()).toContain("run");
    // The setup sequence an agent follows the first time, so it never has to guess at the order.
    expect(c.getInstructions()).toContain("then `recipe_scan`, which writes nothing");
    expect(c.getInstructions()).toContain("then `recipe` with their answers");
    expect(c.getInstructions()).toContain("wsp init --recipe <path>");
    expect(c.getInstructions()).toContain("snapshot");
    // The instructions and the agent input promise only agents the host has adapters for, from the one list.
    expect(c.getInstructions()).toContain(`take as agent: ${THREAD_AGENTS.join(", ")}.`);
    for (const a of CATALOG.filter(e => e.kind === "agent")) expect(new RegExp(`\\b${a.id}\\b`).test(c.getInstructions()!), a.id).toBe(THREAD_AGENTS.some(id => id === a.id));
    const agentInput = (tools.find(t => t.name === "run")!.inputSchema as { properties: Record<string, { description?: string }> }).properties.agent!;
    expect(agentInput.description).toBe(`the agent to run in the thread, one of ${THREAD_AGENTS.join(", ")}; absent means the host's default`);
    for (const t of tools) expect(WSP_SKILL, t.name).toContain(`\`${t.name}\``);
  });

  it("snapshot takes a project image of the workspace as wsp snapshot does, and new with from forks it by that project's name or the snapshot id", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const taken = await call("snapshot", { workspace: "alpha" });
    expect(taken.isError).toBe(false);
    const [golden] = await rt.golden.projects();
    expect(golden).toMatchObject({ projects: [{ name: alpha!.project.name, dest: alpha!.project.path }], golden: "snap_gold", version: 1, workspaceId: alpha!.id, workspaceName: "alpha" });
    expect(taken.structured).toEqual({ projectGolden: golden });
    expect(ProjectGolden.parse((taken.structured as { projectGolden: unknown }).projectGolden)).toEqual(golden);
    expect(JSON.parse(taken.text)).toEqual(taken.structured);

    const byName = await call("new", { name: "task-a", from: alpha!.project.name });
    expect(byName.isError).toBe(false);
    const taskA = (await rt.workspaces.list()).find(w => w.name === "task-a")!;
    expect(taskA.golden).toBe(golden!.snapshotId);
    expect(byName.structured).toEqual({ workspace: expect.objectContaining({ id: taskA.id, name: "task-a", golden: golden!.snapshotId }) });
    const byId = await call("new", { name: "task-b", from: golden!.snapshotId });
    expect(byId.isError).toBe(false);
    expect((await rt.workspaces.list()).find(w => w.name === "task-b")!.golden).toBe(golden!.snapshotId);

    const missing = await call("new", { name: "task-c", from: "nope" });
    expect(missing).toEqual(failedWith("no project image named nope; wsp snapshot <workspace> takes one"));
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "task-a", "task-b"]);
  });

  it("run with no workspace starts on the workspace of the project the client's folder is, and the first line of the reply says so; a server with no client folder is a tool error in one line", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-mcp-repo-")));
    execFileSync("git", ["init", "-q", folder]);
    mkdirSync(join(folder, "packages", "api"), { recursive: true });
    const project = await rt.projects.add({ source: folder });
    await call("new", { project: project.name, name: "spoo" });
    const [spoo] = (await rt.workspaces.list()).filter(w => w.name === "spoo");
    await client?.close();
    await server?.close();
    await connect({ cwd: join(folder, "packages", "api") });
    const opened = await call("run", { task: "hello from the repo" });
    expect(opened.isError).toBe(false);
    const thread = (await rt.sessions.list()).find(t => t.prompt === "hello from the repo")!;
    expect(thread.workspaceId).toBe(spoo!.id);
    expect(opened.text).toBe(`${threadOpenedLine(thread.threadId!, "spoo", folder)}\nre: hello from the repo`);
    expect(opened.structured).toMatchObject({ threadId: thread.threadId, workspaceId: spoo!.id, text: "re: hello from the repo" });
    await client?.close();
    await server?.close();
    await connect();
    const nowhere = await call("run", { task: "hello from nowhere" });
    expect(nowhere.isError).toBe(true);
    expect((nowhere.structured as { error?: string } | undefined)?.error ?? nowhere.text).toContain(noThreadTargetLine("workspace"));
  });

  it("new and fork take size as <cpu>x<memGb>, which reaches the machine; one the provider does not offer is a tool error naming the list", async () => {
    const big = await call("new", { name: "big", size: "2x8" });
    expect(big.isError).toBe(false);
    expect(backend.machines.at(-1)!.spec).toMatchObject({ cpu: 2, memMb: 8192 });
    const wide = await call("fork", { workspace: "big", name: "wide", size: "4x8" });
    expect(wide.isError).toBe(false);
    expect(backend.machines.at(-1)!.spec).toMatchObject({ cpu: 4, memMb: 8192 });
    const odd = await call("new", { name: "odd", size: "8x16" });
    expect(odd.isError).toBe(true);
    expect(odd.text).toBe("8x16 is not a size this provider offers; the sizes are 2x4 ($0.11/hr), 2x8 ($0.15/hr), 4x8 ($0.22/hr). Name one of those with --size.");
    expect(backend.machines).toHaveLength(2);
  });

  it("a fork the provider refuses at the machine cap is a tool error naming the workspaces holding the slots", async () => {
    await call("new", { name: "first" });
    await call("new", { name: "t-cap" });
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    const refused = await call("fork", { workspace: "first", name: "f2" });
    expect(refused).toMatchObject({ isError: true, text: "both machine slots are in use: first, t-cap. Pause one or wait for a nap." });
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["first", "t-cap"]);
  });

  it("new forks the golden's head into a workspace of that name; workspaces lists it as the app sees it", async () => {
    const made = await call("new", { name: "alpha" });
    expect(made.isError).toBe(false);
    const [ws] = await rt.workspaces.list();
    expect(ws).toMatchObject({ name: "alpha", phase: "running" });
    expect(made.structured).toEqual({ workspace: expect.objectContaining({ id: ws!.id, name: "alpha" }) });
    const listed = await call("workspaces");
    const { workspaces } = listed.structured as { workspaces: WorkspaceView[] };
    expect(workspaces.map(w => WorkspaceView.parse(w).id)).toEqual([ws!.id]);
    expect(JSON.parse(listed.text)).toEqual(listed.structured);
  });

  /** The two urls an agent is promised and should be: a project's own source, the repo the person named, and the
   * pull request a bring back opened, which is a page on the git host and the whole point of the verb. Neither
   * carries a bearer. Every other field ending in url would be a route a provider minted. */
  const OWN_URL = /(\.source\.url|\.pr\.url)$/;

  /** Every field name in a JSON Schema, deep, that reads as a route: what an agent is promised, not what one run answered. */
  const routeFields = (schema: unknown, at: string): string[] => {
    if (typeof schema !== "object" || schema === null) return [];
    const node = schema as Record<string, unknown>;
    const found: string[] = [];
    for (const [name, sub] of Object.entries((node["properties"] as Record<string, unknown> | undefined) ?? {})) {
      if (/url$/i.test(name) && !OWN_URL.test(`${at}.${name}`)) found.push(`${at}.${name}`);
      found.push(...routeFields(sub, `${at}.${name}`));
    }
    if (node["items"] !== undefined) found.push(...routeFields(node["items"], `${at}[]`));
    for (const of of ["anyOf", "oneOf", "allOf"]) for (const sub of (node[of] as unknown[] | undefined) ?? []) found.push(...routeFields(sub, at));
    return found;
  };
  /** The same over an answer, so a field the schema never promised is caught too. */
  const routeValues = (value: unknown, at: string): string[] =>
    typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([k, v]) => [...(/url$/i.test(k) && !OWN_URL.test(`${at}.${k}`) ? [`${at}.${k}`] : []), ...routeValues(v, `${at}.${k}`)])
      : [];

  it("no tool promises or answers with a route the provider minted: no field ends in Url and nothing carries a provider token", async () => {
    // A version sealed from a desktop builder forks desktop machines, and only a desktop machine streams a display.
    const head = SEALED_GOLDEN.versions[0]!;
    await store.put("goldens", copyKey("default", "default"), { ...SEALED_GOLDEN, versions: [{ ...head, kind: "desktop" as const }] });
    const c = await connect();
    for (const t of (await c.listTools()).tools) expect(routeFields(t.outputSchema, t.name), t.name).toEqual([]);

    const opened = await call("new", { name: "alpha" });
    const [ws] = await rt.workspaces.list();
    backend.machines[0]!.previewUrl = async () => ({ url: "http://127.0.0.1:1/?pt_token=stub-bearer", token: "stub-bearer", expiresAt: Date.now() + 3_600_000 });
    // The runtime dialled the provider and holds both routes; the app's own status socket is still handed them.
    const inside = (await rt.status.list()).find(s => s.id === ws!.id)!;
    expect(inside.screen).toEqual({ streamUrl: `wss://stub/stream/${ws!.machineId}` });
    expect(inside.reach.url).toBe("http://127.0.0.1:1/?pt_token=stub-bearer");

    const doors: [string, Record<string, unknown>][] = [
      ["workspaces", {}],
      ["rename", { workspace: "alpha", name: "beta" }],
      ["fork", { workspace: "beta", name: "gamma" }],
      ["pause", { workspace: "gamma" }],
      ["wake", { workspace: "gamma" }],
    ];
    const answers: [string, Called][] = [["new", opened]];
    for (const [name, args] of doors) answers.push([name, await call(name, args)]);
    for (const [name, answered] of answers) {
      expect(answered.isError, name).toBe(false);
      expect(routeValues(answered.structured, name), name).toEqual([]);
      expect(answered.text, name).not.toContain("wss://");
      expect(answered.text, name).not.toContain("pt_token");
    }
    // The words the table turns on are all still there, on the machine whose route the test minted.
    const { workspaces } = (await call("workspaces")).structured as { workspaces: { name: string; machineState: string; reach: Record<string, unknown> }[] };
    expect(workspaces.map(w => w.name)).toEqual(["beta", "gamma"]);
    const listed = workspaces.find(w => w.name === "beta")!;
    expect([listed.machineState, listed.reach["state"]]).toEqual(["running", "unreachable"]);
  });

  it("new on the place this computer is makes this computer, workspaces lists it beside a fork with kind local and no image, and run takes it by name like any workspace", async () => {
    await call("new", { name: "alpha" });
    const made = await call("new", { project: (await hereProject()).name, name: "mac" });
    expect(made.isError).toBe(false);
    const listed = await call("workspaces");
    const { workspaces } = listed.structured as { workspaces: WorkspaceView[] };
    expect(workspaces.map(w => [w.name, workspaceKind(WorkspaceView.parse(w)), w.golden !== ""])).toEqual([
      ["alpha", "cloud", true],
      ["mac", "local", false],
    ]);
    // The listing's own words say a workspace need not be a machine, so a caller holding only the tools reads it here.
    const served = (await client!.listTools()).tools.find(t => t.name === "workspaces")!.description!;
    expect(served).toContain("on the computer the app runs on it is a copy of the project's folder beside it");

    const opened = await call("run", { workspace: "mac", task: "say pong" });
    expect(opened.isError).toBe(false);
    expect(opened.text).toBe("re: say pong");
    const local = workspaces.find(w => w.name === "mac")!;
    expect(opened.structured).toMatchObject({ workspaceId: local.id, harness: "claude", outcome: "started" });
    const rows = (await call("threads")).structured as { threads: { workspaceName: string; startedBy: string }[] };
    expect(rows.threads.map(t => [t.workspaceName, t.startedBy])).toEqual([["mac", "agent"]]);
  });

  it("a thread the tools open on this computer runs every action without asking, and at the word the call names when it names one", async () => {
    await call("new", { project: (await hereProject()).name, name: "mac" });
    expect((await call("run", { workspace: "mac", task: "write the notes" })).isError).toBe(false);
    // The same answer the command line runs: the tools hold no default of their own, they read the workspace's.
    expect(claude.starts.at(-1)!.permissionMode).toBe("bypassPermissions");
    expect((await call("run", { workspace: "mac", task: "read the notes", access: "plan" })).isError).toBe(false);
    expect(claude.starts.at(-1)!.permissionMode).toBe("plan");
    const refused = await call("run", { workspace: "mac", task: "go", access: "yolo" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^access mode "yolo" is not one claude takes/);
    // What the tool's own words promise about naming none, so an agent reading them is told the same rule.
    const served = (await client!.listTools()).tools.find(t => t.name === "run")!.inputSchema.properties as Record<string, { description?: string }>;
    expect(served["access"]?.description).toContain("what a thread on that workspace starts at");
  });

  it("fork makes a sibling from the source's golden version, by name or id, and a task opens its first thread", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const plain = await call("fork", { workspace: "alpha" });
    expect(plain.isError).toBe(false);
    const forks = (await rt.workspaces.list()).filter(w => w.id !== alpha!.id);
    expect(forks.map(w => [w.name, w.golden])).toEqual([["alpha-fork", alpha!.golden]]);
    const sent = await call("fork", { workspace: alpha!.id, name: "worker", task: "build it" });
    expect(sent.isError).toBe(false);
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    const [thread] = await rt.sessions.list(worker.id);
    expect(thread).toMatchObject({ harness: "claude", startedBy: "agent", prompt: "build it", status: "completed" });
    expect(sent.structured).toMatchObject({ workspace: expect.objectContaining({ name: "worker" }), turn: { threadId: thread!.threadId, workspaceId: worker.id, harness: "claude", text: "re: build it", outcome: "started" } });
  });

  it("fork with a task whose first turn fails names the minted workspace beside the reason, so a retry does not mint another", async () => {
    await call("new", { name: "alpha" });
    const failed = await call("fork", { workspace: "alpha", name: "worker", task: "die" });
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    expect(worker).toMatchObject({ phase: "running" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toBe(`created worker ${worker.id}; first turn failed: the harness died`);
    expect(failed.structured).toEqual({ workspace: expect.objectContaining({ id: worker.id, name: "worker" }), failure: "the harness died" });
    expect((await rt.sessions.list(worker.id))[0]).toMatchObject({ startedBy: "agent", status: "failed" });
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha", "worker"]);
  });

  it("fork and run under an agent the host has no adapter for are refused naming the agents it has; no machine is minted or woken", async () => {
    await call("new", { name: "alpha" });
    const refused = await call("fork", { workspace: "alpha", name: "worker", task: "hi", agent: "gpt9" });
    expect(refused).toEqual(failedWith('no adapter registered for harness "gpt9"; agents on this host: claude, codex. Name one of those with --agent.', "usage"));
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    await call("pause", { workspace: "alpha" });
    const opened = await call("run", { workspace: "alpha", task: "hi", agent: "gpt9" });
    expect(opened).toEqual(failedWith('no adapter registered for harness "gpt9"; agents on this host: claude, codex. Name one of those with --agent.', "usage"));
    expect((await rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([["alpha", "napping"]]);
    expect(await rt.sessions.list()).toEqual([]);
  });

  it("an empty or whitespace task or message is refused in words by run, fork and send; no machine is minted or woken and nothing starts", async () => {
    await call("new", { name: "alpha" });
    const first = await call("run", { workspace: "alpha", task: "first" });
    const threadId = (first.structured as { threadId: string }).threadId;
    await call("pause", { workspace: "alpha" });
    for (const task of ["", " \n\t "]) {
      expect(await call("run", { workspace: "alpha", task })).toEqual(failedWith(`${EMPTY_TASK_LINE}. Put it in quotes after the flags.`, "usage"));
      expect(await call("fork", { workspace: "alpha", name: "worker", task })).toEqual(failedWith(`${EMPTY_TASK_LINE}. Put it in quotes after the flags.`, "usage"));
      expect(await call("send", { thread: threadId, message: task })).toEqual(failedWith(`${EMPTY_TASK_LINE}. Put it in quotes after the flags.`, "usage"));
    }
    expect((await rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([["alpha", "napping"]]);
    expect(claude.starts).toHaveLength(1);
    expect(await rt.sessions.list()).toHaveLength(1);
  });

  it("an images list on run and send reads each file here and carries its bytes; a file that is not an image is a tool error", async () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1016, 3)]));
    await call("new", { name: "alpha" });
    const opened = await call("run", { workspace: "alpha", task: "what is this?", images: [path] });
    expect(opened.isError).toBe(false);
    expect(claude.starts.at(-1)!.images).toEqual([{ mediaType: "image/png", bytes: readFileSync(path).toString("base64") }]);
    const threadId = (opened.structured as { threadId: string }).threadId;
    await call("send", { thread: threadId, message: "and this?", images: [path] });
    expect(claude.starts.at(-1)!.images).toHaveLength(1);
    const notes = join(dir, "notes.pdf");
    writeFileSync(notes, "%PDF-1.7 nope");
    expect(await call("send", { thread: threadId, message: "look", images: [notes] })).toEqual(
      failedWith(`${notes} is not PNG, JPEG, GIF or WebP; a message carries those four. Name one of those instead.`, "usage"),
    );
  });

  it("pause naps the workspace; a workspace that is not there is a tool error in one line", async () => {
    await call("new", { name: "alpha" });
    const paused = await call("pause", { workspace: "alpha" });
    expect(paused.isError).toBe(false);
    expect(paused.structured).toEqual({ workspace: expect.objectContaining({ name: "alpha", phase: "napping" }) });
    expect((await rt.workspaces.list())[0]!.phase).toBe("napping");
    const missing = await call("pause", { workspace: "nope" });
    expect(missing).toEqual(failedWith("no workspace nope", "usage"));
  });

  it("wake wakes a paused workspace and returns it running; on a running one it is a no-op that returns it as it is", async () => {
    await call("new", { name: "alpha" });
    await call("pause", { workspace: "alpha" });
    const woken = await call("wake", { workspace: "alpha" });
    expect(woken.isError).toBe(false);
    expect(woken.structured).toEqual({ workspace: expect.objectContaining({ name: "alpha", phase: "running" }) });
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
    expect(backend.machines[0]!.paused).toBe(false);
    const again = await call("wake", { workspace: "alpha" });
    expect(again.structured).toEqual({ workspace: expect.objectContaining({ name: "alpha", phase: "running" }) });
    const missing = await call("wake", { workspace: "nope" });
    expect(missing).toEqual(failedWith("no workspace nope", "usage"));
  });

  it("exec, run and send on a paused workspace wake it first and then run", async () => {
    await call("new", { name: "alpha" });
    await call("pause", { workspace: "alpha" });
    execGuest(backend, "awake-ok\n", 0);
    const ran = await call("exec", { workspace: "alpha", argv: ["echo", "awake-ok"] });
    expect(ran).toEqual({ text: "awake-ok", structured: { exitCode: 0, output: ["awake-ok"], cwd: expect.any(String) }, isError: false });
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
    await call("pause", { workspace: "alpha" });
    const opened = await call("run", { workspace: "alpha", task: "hello" });
    expect(opened.isError).toBe(false);
    expect(opened.text).toBe("re: hello");
    const threadId = (opened.structured as { threadId: string }).threadId;
    await call("pause", { workspace: "alpha" });
    const sent = await call("send", { thread: threadId, message: "again" });
    expect(sent.isError).toBe(false);
    expect(sent.text).toBe("re: again");
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("rebuild puts a new machine under a gone workspace and answers with it; one that still answers is a tool error in the row's own words", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    expect(await call("rebuild", { workspace: "alpha" })).toEqual(failedWith(goneRoadRefusal("running", "rebuild")));
    expect(backend.machines).toHaveLength(1);

    await handle!.close();
    handle = undefined;
    await socket!.closed;
    backend.machines[0]!.killed = true;
    await restartHost({ claude: claude.adapter });
    expect((await rt.workspaces.get(alpha!.id)).phase).toBe("gone");

    const built = await call("rebuild", { workspace: "alpha" });
    expect(built.isError).toBe(false);
    const after = await rt.workspaces.get(alpha!.id);
    expect(after).toMatchObject({ id: alpha!.id, name: "alpha", phase: "running", golden: alpha!.golden });
    expect(after.machineId).not.toBe(alpha!.machineId);
    expect(built.structured).toEqual({ workspace: expect.objectContaining({ id: alpha!.id, machineId: after.machineId, phase: "running" }) });
    expect(built.text).toBe(`alpha running on ${after.machineId}`);
    expect(await call("rebuild", { workspace: "nope" })).toEqual(failedWith("no workspace nope", "usage"));
  });

  it("forget drops a workspace whose machine is gone and says what went; one whose machine exists is a tool error with the reason", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const refused = await call("forget", { workspace: "alpha" });
    expect(refused).toEqual(failedWith("alpha's machine m1 is still running; pause it or delete it at the provider first"));
    expect(await rt.workspaces.list()).toHaveLength(1);

    backend.machines[0]!.killed = true;
    const forgot = await call("forget", { workspace: "alpha" });
    expect(forgot.isError).toBe(false);
    expect(forgot.structured).toEqual({ workspaceId: alpha!.id, name: "alpha", threads: 0 });
    expect(forgot.text).toBe(`forgot alpha ${alpha!.id}: its record and 0 threads are gone from this computer`);
    expect(await rt.workspaces.list()).toEqual([]);
    expect(await store.get("workspaces", alpha!.id)).toBeUndefined();
  });

  it("image_remove without confirm removes nothing and answers with what would go; with confirm it deletes the snapshot and drops the record, and a workspace standing on it refuses", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const golden = await rt.workspaces.snapshot(alpha!.id);

    const asked = await call("image_remove", { image: golden.snapshotId });
    expect(asked.isError).toBe(true);
    expect(asked.text).toBe(`${golden.snapshotId} kept. ${projectImageRemoveNotice(golden)} Ask the person, then call image_remove again with confirm true.`);
    expect(asked.structured).toEqual({ projectGolden: golden, alreadyGone: false });
    expect(backend.snapshots.map(s => s.id)).toContain(golden.snapshotId);

    await call("new", { name: "task-a", from: golden.snapshotId });
    expect(await call("image_remove", { image: golden.snapshotId, confirm: true })).toEqual(failedWith(projectImageInUseRefusal(golden.snapshotId, ["task-a"])));
    await call("delete", { workspace: "task-a", confirm: true });

    const removed = await call("image_remove", { image: golden.snapshotId, confirm: true });
    expect(removed.isError).toBe(false);
    expect(removed.structured).toEqual({ projectGolden: golden, alreadyGone: false });
    expect(removed.text).toBe(projectImageRemovedLine(golden.snapshotId, false));
    expect(backend.snapshots.map(s => s.id)).not.toContain(golden.snapshotId);
    expect(await rt.golden.projects()).toEqual([]);
    expect(await call("image_remove", { image: golden.snapshotId, confirm: true })).toEqual(failedWith(noProjectImageLine(golden.snapshotId), "usage"));
  });

  it("delete without confirm deletes nothing and answers with what would go; with confirm it kills the machine and drops the record and threads", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    await call("run", { workspace: "alpha", task: "build it" });

    const asked = await call("delete", { workspace: "alpha" });
    expect(asked.isError).toBe(true);
    expect(asked.text).toBe("alpha kept. Its computer is deleted in the cloud; its record and 1 thread leave this computer. Ask the person, then call delete again with confirm true.");
    expect(asked.structured).toEqual({ workspaceId: alpha!.id, name: "alpha", machineId: alpha!.machineId, threads: 1 });
    expect(backend.machines[0]!.killed).toBe(false);
    expect(await rt.workspaces.list()).toHaveLength(1);

    const refused = await call("delete", { workspace: "alpha", confirm: false });
    expect(refused.isError).toBe(true);
    expect(backend.machines[0]!.killed).toBe(false);

    const deleted = await call("delete", { workspace: "alpha", confirm: true });
    expect(deleted.isError).toBe(false);
    expect(deleted.structured).toEqual({ workspaceId: alpha!.id, name: "alpha", machineId: alpha!.machineId, threads: 1 });
    expect(deleted.text).toBe(`deleted alpha ${alpha!.id}: computer ${alpha!.machineId} is gone in the cloud, and its record and 1 thread are gone from this computer`);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
    expect(await store.get("workspaces", alpha!.id)).toBeUndefined();
    const missing = await call("delete", { workspace: "nope", confirm: true });
    expect(missing).toEqual(failedWith("no workspace nope", "usage"));
  });

  it("run opens a thread under the named agent, started by the local agent, and returns the reply as the result", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const made = await call("run", { workspace: "alpha", agent: "codex", task: "write tests" });
    expect(made.isError).toBe(false);
    const [row] = await rt.sessions.list(alpha!.id);
    expect(row).toMatchObject({ harness: "codex", startedBy: "agent", prompt: "write tests", status: "completed" });
    expect(codex.starts.map(s => s.prompt)).toEqual(["write tests"]);
    expect(claude.starts).toEqual([]);
    expect(made.text).toBe("codex: write tests");
    expect(made.structured).toEqual({ threadId: row!.threadId, workspaceId: alpha!.id, harness: "codex", text: "codex: write tests", outcome: "started" });
  });

  it("run takes a title, which names the thread as a person's from the first second", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const made = await call("run", { workspace: "alpha", task: "build it", title: "Ticket 411 review" });
    expect(made.isError).toBe(false);
    expect(claude.starts.at(-1)?.title).toBe("Ticket 411 review");
    const [row] = await rt.sessions.list(alpha!.id);
    expect(row).toMatchObject({ harnessTitle: "Ticket 411 review", titleSource: "person" });
  });

  it("run and fork take cwd, the folder the turn starts in; without it the workspace's project folder, else none", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const picked = await call("run", { workspace: "alpha", agent: "codex", task: "write tests", cwd: "/root/work/elsewhere" });
    expect(picked.isError).toBe(false);
    expect(codex.starts.map(s => s.cwd)).toEqual(["/root/work/elsewhere"]);

    const bare = await call("run", { workspace: "alpha", agent: "claude", task: "hello" });
    expect(bare.isError).toBe(false);
    // A thread opens in the workspace's own project, which is what a workspace is a copy for.
    expect(claude.starts.map(s => s.cwd)).toEqual([alpha!.project.path]);

    const forked = await call("fork", { workspace: "alpha", name: "worker", task: "build it", cwd: "/root/work/site" });
    expect(forked.isError).toBe(false);
    expect(claude.starts.at(-1)?.cwd).toBe("/root/work/site");
    const { threads } = (await call("threads", { workspace: "worker" })).structured as { threads: ThreadView[] };
    expect(threads.map(t => t.cwd)).toEqual(["/root/work/site"]);
  });

  it("projects_add records one, a folder here and a repo a computer clones, and the tool door carries it because wsp add also hands out a join code", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-mcp-add-")));
    execFileSync("git", ["init", "-q", folder]);
    const here = await call("projects_add", { source: folder });
    expect(here.isError).toBe(false);
    const recorded = (here.structured as { project: ProjectView }).project;
    expect(recorded).toMatchObject({ source: { kind: "folder", path: folder }, path: folder, computer: HERE_PLACE_ID });
    // The host's own platform word, so this reads the same on the Mac it was written on and on the Linux runner.
    expect(here.text).toBe(addedProjectLine(recorded, new Map(), hostPlatform()));

    // A repo needs the computer that clones it, and the same source twice on one computer is refused.
    const cloned = await call("projects_add", { source: "https://github.com/dev/site.git", on: "default", name: "site", base: "trunk" });
    expect((cloned.structured as { project: ProjectView }).project).toMatchObject({ name: "site", path: "/root/site", base: "trunk", computer: "default" });
    expect(await call("projects_add", { source: "https://github.com/dev/site.git", on: "default" })).toMatchObject({ isError: true });
    expect(await call("projects_add", { source: "https://github.com/dev/other.git" })).toMatchObject({ isError: true });

    const listed = (await call("projects")).structured as { projects: ProjectView[] };
    expect(listed.projects.map(p => p.name)).toContain("site");
  });

  it("projects lists every project this host holds, each on its computer, and new names which one the work is on", async () => {
    const spoo = await projectOn(rt, "default", "https://github.com/dev/spoo.git");
    const wsp = await projectOn(rt, "default", "https://github.com/dev/wsp.git");
    const listed = await call("projects");
    expect(listed.isError).toBe(false);
    expect((listed.structured as { projects: { name: string; path: string }[] }).projects.map(p => [p.name, p.path])).toEqual([[cloud.name, cloud.path], ["spoo", "/root/spoo"], ["wsp", "/root/wsp"]]);
    expect(JSON.parse(listed.text)).toEqual(listed.structured);

    // With more than one project the work has to say which: a name nothing holds is refused with the ones there are.
    expect(await call("new", { name: "alpha" })).toEqual(failedWith(`name the project this work is on: ${cloud.name}, spoo, wsp. Run wsp projects to read them.`, "usage"));
    expect(await call("new", { project: "nope", name: "alpha" })).toMatchObject({ isError: true });
    expect(await call("new", { project: "wsp", name: "alpha" })).toMatchObject({ isError: false });
    const named = await call("run", { workspace: "alpha", task: "build it" });
    expect(named.isError).toBe(false);
    // The thread opens in the workspace's project and nothing else says where.
    expect(claude.starts.map(s => s.cwd)).toEqual([wsp.path]);
    expect(spoo.path).toBe("/root/spoo");
  });

  it("run and fork take model, effort and access, send the first two; a new thread without a model runs the catalog's default and an unlisted value is refused with the list", async () => {
    await call("new", { name: "alpha" });
    const picked = await call("run", { workspace: "alpha", task: "review it", model: "claude-sonnet-5", effort: "low", access: "plan" });
    expect(picked.isError).toBe(false);
    expect(claude.starts.map(s => [s.model, s.effort, s.permissionMode])).toEqual([["claude-sonnet-5", "low", "plan"]]);
    const bare = await call("run", { workspace: "alpha", task: "hello" });
    expect(bare.isError).toBe(false);
    // The model and the effort the composer shows for it, since a tool that names neither runs what the app would.
    expect(claude.starts.at(-1)).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    const threadId = (bare.structured as { threadId: string }).threadId;
    const sent = await call("send", { thread: threadId, message: "now think", model: "claude-fable-5-1", effort: "max" });
    expect(sent.isError).toBe(false);
    expect(claude.starts.at(-1)).toMatchObject({ model: "claude-fable-5-1", effort: "max" });
    expect(claude.starts.at(-1)!.resume).toBeDefined();
    const kept = await call("send", { thread: threadId, message: "go on" });
    expect(kept.isError).toBe(false);
    expect(claude.starts.at(-1)!.model).toBeUndefined();
    // The send tool takes no access, so one named here is not read and the turn runs at the thread's own.
    const own = claude.starts.at(-1)!.permissionMode;
    const named = await call("send", { thread: threadId, message: "and now", access: "plan" });
    expect(named.isError).toBe(false);
    expect(claude.starts.at(-1)!.permissionMode).toBe(own);
    const forked = await call("fork", { workspace: "alpha", name: "worker", task: "build it", model: "claude-sonnet-5", access: "bypassPermissions" });
    expect(forked.isError).toBe(false);
    expect(claude.starts.at(-1)).toMatchObject({ model: "claude-sonnet-5", permissionMode: "bypassPermissions" });

    const before = claude.starts.length;
    const refused = await call("run", { workspace: "alpha", task: "review it", model: "claude-haiku-4-5" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^model "claude-haiku-4-5" is not one claude takes; one of: Opus 5\.5 \(claude-opus-5-5\), Fable 5\.1 \(claude-fable-5-1\), Sonnet 5 \(claude-sonnet-5\), Haiku 4\.5 \(claude-haiku-4-5-20251001\); legacy: Opus 5 \(claude-opus-5\), /);
    expect(refused.text.endsWith(`${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`)).toBe(true);
    const mode = await call("run", { workspace: "alpha", task: "go", access: "yolo" });
    expect(mode.isError).toBe(true);
    expect(mode.text).toMatch(/^access mode "yolo" is not one claude takes; one of: Default \(default\), /);
    const minted = (await rt.workspaces.list()).map(w => w.name);
    const fork = await call("fork", { workspace: "alpha", name: "cheap", task: "review", model: "claude-haiku-4-5" });
    expect(fork.isError).toBe(true);
    expect(fork.text).toBe(refused.text);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(minted);
    expect(claude.starts).toHaveLength(before);
  });

  it("a cwd that is not absolute is refused by run and fork before anything is created or started", async () => {
    await call("new", { name: "alpha" });
    const relative = await call("run", { workspace: "alpha", task: "look here", cwd: "packages/host" });
    expect(relative.isError).toBe(true);
    expect(relative.text).toContain('cwd is a path on the machine, absolute, and got "packages/host"');
    const forked = await call("fork", { workspace: "alpha", name: "worker", task: "build it", cwd: "packages/host" });
    expect(forked.isError).toBe(true);
    expect(forked.text).toContain('cwd is a path on the machine, absolute, and got "packages/host"');
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await rt.sessions.list()).toEqual([]);
    expect(claude.starts).toEqual([]);
  });

  it("threads is the sidebar's data with the workspace's name on each row; the local agent's threads say so", async () => {
    await call("new", { name: "alpha" });
    await call("new", { name: "beta" });
    const [alpha, beta] = await rt.workspaces.list();
    await call("run", { workspace: "alpha", task: "first task" });
    await (await rt.sessions.start(beta!.id, { prompt: "from the app", harness: "codex" })).finished;
    const all = await call("threads");
    const { threads } = all.structured as { threads: (ThreadView & { workspaceName: string; projectName: string; computerName: string })[] };
    expect(threads.map(t => [t.projectName, t.workspaceName, t.computerName, t.harness, t.startedBy, t.title])).toEqual([
      [alpha!.project.name, "alpha", alpha!.project.computer, "claude", "agent", "first task"],
      [beta!.project.name, "beta", beta!.project.computer, "codex", "person", "from the app"],
    ]);
    for (const t of threads) {
      const { workspaceName: _name, projectName: _p, computerName: _c, ...view } = t;
      expect(ThreadView.parse(view)).toEqual(view);
    }
    const scoped = await call("threads", { workspace: "beta" });
    expect((scoped.structured as { threads: ThreadView[] }).threads.map(t => t.workspaceId)).toEqual([beta!.id]);
  });

  it("send resumes the thread's latest session under its own agent and returns the reply; the thread keeps who opened it", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    await call("run", { workspace: "alpha", agent: "codex", task: "first" });
    await (await rt.sessions.start(alpha!.id, { prompt: "from the app", harness: "claude" })).finished;
    const [byAgent, byPerson] = await rt.sessions.list();
    const reply = await call("send", { thread: byAgent!.threadId!, message: "second" });
    expect(reply.isError).toBe(false);
    expect(reply.text).toBe("codex: second");
    expect(reply.structured).toEqual({ threadId: byAgent!.threadId, workspaceId: alpha!.id, harness: "codex", text: "codex: second", outcome: "started" });
    expect(codex.starts.map(s => [s.prompt, s.resume])).toEqual([["first", undefined], ["second", byAgent!.claudeSessionId]]);
    const followUp = await call("send", { thread: byPerson!.threadId!.slice(0, 8), message: "and this" });
    expect(followUp.text).toBe("re: and this");
    // The server's starts carry their own request ids, like the command line's; the app's start through the runtime sent none.
    const requestIds = (await rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start").map(e => e.requestId);
    expect(requestIds.map(id => typeof id)).toEqual(["string", "undefined", "string", "string"]);
    expect(new Set(requestIds).size).toBe(4);
    const { threads } = (await call("threads")).structured as { threads: ThreadView[] };
    expect(threads.map(t => [t.harness, t.startedBy, t.title, t.turns])).toEqual([
      ["codex", "agent", "first", 1],
      ["claude", "person", "from the app", 1],
    ]);
    const missing = await call("send", { thread: "nope", message: "x" });
    expect(missing).toEqual(failedWith("no thread nope", "usage"));
  });

  it("send into a thread whose last turn was cut puts the cut line first in the result text and flags it; the send after that is plain", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const cut = await call("run", { workspace: "alpha", task: "cut" });
    expect(cut).toMatchObject({ isError: true, text: CUT_LINE });
    const [row] = await rt.sessions.list();
    const resumed = await call("send", { thread: row!.threadId!, message: "again" });
    expect(resumed.isError).toBe(false);
    expect(resumed.text).toBe("previous turn was cut; resuming\nre: again");
    expect(resumed.structured).toEqual({ threadId: row!.threadId, workspaceId: alpha!.id, harness: "claude", text: "re: again", outcome: "started", afterCut: true });
    const next = await call("send", { thread: row!.threadId!, message: "once more" });
    expect(next.text).toBe("re: once more");
    expect(next.structured).not.toHaveProperty("afterCut");
  });

  it("send into a thread whose turn runs joins that turn when the agent steers and returns the running turn's reply; no second start", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await call("new", { name: "alpha" });
    const first = call("run", { workspace: "alpha", task: "loop, then say done" });
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const sent = call("send", { thread: row!.threadId!, message: "end with STEERED" });
    await vi.waitFor(() => expect(held.steered).toEqual(["end with STEERED"]));
    held.release(0, "done STEERED");
    expect((await first).text).toBe("done STEERED");
    const joined = await sent;
    expect(joined.isError).toBe(false);
    expect(joined.structured).toEqual({ threadId: row!.threadId, workspaceId: row!.workspaceId, harness: "claude", text: "done STEERED", outcome: "steered" });
    expect(held.starts).toHaveLength(1);
    expect((await rt.sessions.history(row!.workspaceId)).map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
  });

  it("stop ends the thread's running turn and returns the outcome; the waiting run is a tool error saying interrupted; a second stop says not-running and is no error", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await call("new", { name: "alpha" });
    const first = call("run", { workspace: "alpha", task: "loop forever" });
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const stopped = await call("stop", { thread: row!.threadId!.slice(0, 8) });
    expect(stopped).toEqual({ text: `thread ${row!.threadId} stopped`, structured: { threadId: row!.threadId, outcome: "accepted" }, isError: false });
    expect(held.interrupted).toEqual([row!.id]);
    expect(await first).toEqual(failedWith("turn interrupted"));
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
    const idle = await call("stop", { thread: row!.threadId! });
    expect(idle).toEqual({ text: `thread ${row!.threadId} not running`, structured: { threadId: row!.threadId, outcome: "not-running" }, isError: false });
    expect(held.interrupted).toHaveLength(1);
    const missing = await call("stop", { thread: "nope" });
    expect(missing).toEqual(failedWith("no thread nope", "usage"));
  });

  it("thread_rename names the thread in the agent's own store and returns the outcome; an agent that keeps no name is an answer, not an error", async () => {
    const named = scriptedAgent(prompt => `re: ${prompt}`, () => ({ kind: "written" }));
    await restartHost({ claude: named.adapter, codex: scriptedAgent(prompt => `codex: ${prompt}`).adapter });
    await call("new", { name: "alpha" });
    await call("run", { workspace: "alpha", task: "build it" });
    const [row] = await rt.sessions.list();
    const renamed = await call("thread_rename", { thread: row!.threadId!.slice(0, 8), title: "the name he typed" });
    expect(renamed).toEqual({
      text: `thread ${row!.threadId} named the name he typed, in Claude Code too`,
      structured: { threadId: row!.threadId, title: "the name he typed", harness: "claude", outcome: "renamed" },
      isError: false,
    });
    expect(named.renames).toEqual([{ sessionId: row!.claudeSessionId, title: "the name he typed" }]);
    expect(((await call("threads")).structured as { threads: ThreadView[] }).threads.map(t => t.title)).toEqual(["the name he typed"]);

    await call("run", { workspace: "alpha", task: "build it there", agent: "codex" });
    const codexRow = (await rt.sessions.list()).find(v => v.harness === "codex")!;
    const unsupported = await call("thread_rename", { thread: codexRow.threadId!, title: "the name" });
    expect(unsupported).toEqual({
      text: `thread ${codexRow.threadId} not named: Codex keeps no name of a person's for a session`,
      structured: { threadId: codexRow.threadId, title: "the name", harness: "codex", outcome: "unsupported" },
      isError: false,
    });
    expect(await call("thread_rename", { thread: "nope", title: "the name" })).toEqual(failedWith("no thread nope", "usage"));
  });

  it("thread_read answers with the thread's messages as the app lists them, its tool call one row, and with last the whole final message alone", async () => {
    await call("new", { name: "alpha" });
    const opened = await call("run", { workspace: "alpha", task: "build it" });
    const [row] = await rt.sessions.list();
    const read = await call("thread_read", { thread: row!.threadId!.slice(0, 8) });
    expect(read.isError).toBe(false);
    const { messages } = read.structured as { threadId: string; messages: { who: string; at: number; text: string }[] };
    expect(messages.map(m => [m.who, m.text])).toEqual([
      ["person", "build it"],
      ["agent", "re: "],
      ["tool", "$ ls"],
      ["agent", "build it"],
      ["turn", "completed"],
    ]);
    for (const m of messages) expect(m.at, m.text).toEqual(expect.any(Number));
    expect(read.structured!["threadId"]).toBe(row!.threadId);
    expect(read.text.split("\n\n").map(block => block.split("\n").slice(1).join("\n"))).toEqual(["build it", "re: ", "$ ls", "build it", "completed"]);

    const last = await call("thread_read", { thread: row!.threadId!, last: true });
    expect(last.structured).toEqual({ threadId: row!.threadId, messages: [{ who: "agent", at: expect.any(Number), text: "re: build it" }] });
    // The reply the start returned and the reply a read of it gives are the same message, whole.
    expect(last.text.split("\n").slice(1).join("\n")).toBe(opened.text);
    expect(launchedScripts(backend).filter(script => script.includes("sessions"))).toEqual([]);
    expect(await call("thread_read", { thread: "nope" })).toEqual(failedWith("no thread nope", "usage"));
  });

  it("run with notify tells that thread when the new one ends, through the same start the CLI makes: the running parent is steered the line and the child's transcript names the parent", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await call("new", { name: "alpha" });
    const parent = call("run", { workspace: "alpha", task: "orchestrate" });
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    const kid = call("run", { workspace: "alpha", task: "build it", notify: [parentRow!.threadId!.slice(0, 8)] });
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    expect((await kid).structured).toEqual({ threadId: kidRow.threadId, workspaceId: kidRow.workspaceId, harness: "claude", text: "all green", outcome: "started" });
    held.release(0, "read it");
    expect((await parent).text).toBe("read it");
    const history = await rt.sessions.history(kidRow.workspaceId);
    expect(history.find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });
    expect(history.find(e => e.type === "session.steer")).toMatchObject({ threadId: parentRow!.threadId, prompt: line });
    expect(held.starts).toHaveLength(2);

    const missing = await call("run", { workspace: "alpha", task: "x", notify: ["nope"] });
    expect(missing).toEqual(failedWith("no thread nope", "usage"));
  });

  it("run with notify me, called by an agent inside a turn, names that turn's thread: the server reads the token off the environment it runs with", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await call("new", { name: "alpha" });
    const parent = call("run", { workspace: "alpha", task: "orchestrate" });
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    // The MCP server this agent runs is a child of that turn's process, so it holds the turn's own variable.
    env[TURN_TOKEN_ENV] = held.envs[0]![TURN_TOKEN_ENV]!;
    const kid = call("run", { workspace: "alpha", task: "build it", notify: ["me"] });
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "Ran the gate.\nAll 12 tests green.");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): Ran the gate.\nAll 12 tests green.`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    expect((await kid).isError).toBe(false);
    expect((await rt.sessions.history(kidRow.workspaceId)).find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });
    held.release(0, "read it");
    await parent;
    // A token no turn carries is refused on this door in the contract's own shape.
    env[TURN_TOKEN_ENV] = "f".repeat(32);
    expect(await call("run", { workspace: "alpha", task: "x", notify: ["me"] })).toEqual(failedWith(NO_SUCH_TURN));
  });

  it("fork with a task and notify me records the first turn's end in the new thread for the person", async () => {
    await call("new", { name: "alpha" });
    const sent = await call("fork", { workspace: "alpha", name: "worker", task: "build it", notify: ["me"] });
    expect(sent.isError).toBe(false);
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    const [row] = await rt.sessions.list(worker.id);
    expect((await rt.sessions.history(worker.id)).find(e => e.type === "session.notify")).toMatchObject({ threadId: row!.threadId, notify: "me", text: `thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it` });
  });

  it("run and send return the reply on the turn's session.done; a session.end that never comes is not waited for", async () => {
    const agent = doneOnlyAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter });
    await call("new", { name: "alpha" });
    const made = await call("run", { workspace: "alpha", task: "first" });
    expect(made.isError).toBe(false);
    expect(made.text).toBe("re: first");
    const [row] = await rt.sessions.list();
    const sent = await call("send", { thread: row!.threadId!, message: "second" });
    expect(sent.isError).toBe(false);
    expect(sent.text).toBe("re: second");
    expect(agent.starts.map(s => s.prompt)).toEqual(["first", "second"]);
    expect((await rt.sessions.history(row!.workspaceId)).map(e => e.type)).not.toContain("session.end");
  });

  it("run and send with detach answer with the thread id the moment the turn is started, without the reply; threads_wait then answers with the first named thread to finish, in the notify line's words, and with timedOut when the seconds pass first", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await call("new", { name: "alpha" });
    const opened = await call("run", { workspace: "alpha", task: "build a", detach: true });
    expect(held.starts).toHaveLength(1);
    const [a] = await rt.sessions.list();
    expect(a).toMatchObject({ status: "running", startedBy: "agent" });
    expect(opened).toEqual({ text: `thread ${a!.threadId}`, structured: { threadId: a!.threadId, workspaceId: a!.workspaceId, harness: "claude", outcome: "started" }, isError: false });
    const forked = await call("run", { workspace: "alpha", task: "build b", detach: true });
    const b = (await rt.sessions.list()).find(r => r.threadId !== a!.threadId)!;
    expect(forked.structured).toMatchObject({ threadId: b.threadId });

    const timedOut = await call("threads_wait", { threads: [a!.threadId!, b.threadId!.slice(0, 8)], timeout: 0.05 });
    expect(timedOut).toEqual({ text: "2 threads still running after 50ms", structured: { timedOut: true }, isError: false });

    const waiting = call("threads_wait", { threads: [a!.threadId!, b.threadId!] });
    await new Promise(r => setTimeout(r, 30));
    held.release(1, "b: all green\nreport posted");
    const first = await waiting;
    expect(first).toEqual({
      text: `thread ${b.threadId!.slice(0, 8)} finished (completed): report posted`,
      structured: { finished: { threadId: b.threadId, status: "completed", reply: "report posted" } },
      isError: false,
    });
    // b is over: named again it comes back at once, so the caller drops it and waits on a alone.
    expect((await call("threads_wait", { threads: [a!.threadId!, b.threadId!], timeout: 5 })).structured).toEqual({ finished: { threadId: b.threadId, status: "completed", reply: "report posted" } });
    const sent = await call("send", { thread: b.threadId!, message: "and the docs", detach: true });
    expect(sent).toEqual({ text: `thread ${b.threadId}`, structured: { threadId: b.threadId, workspaceId: b.workspaceId, harness: "claude", outcome: "started" }, isError: false });
    expect(held.starts.map(s => s.prompt)).toEqual(["build a", "build b", "and the docs"]);
    held.release(0, "a done");
    held.release(2, "docs done");
    expect((await call("threads_wait", { threads: [a!.threadId!] })).text).toBe(`thread ${a!.threadId!.slice(0, 8)} finished (completed): a done`);
    expect((await call("threads_wait", { threads: [b.threadId!] })).text).toBe(`thread ${b.threadId!.slice(0, 8)} finished (completed): docs done`);
    expect(await call("threads_wait", { threads: ["nope"] })).toEqual(failedWith("no thread nope", "usage"));
  });

  it("a failed turn is a tool error carrying the harness's reason", async () => {
    await call("new", { name: "alpha" });
    const failed = await call("run", { workspace: "alpha", task: "die" });
    expect(failed).toEqual(failedWith("the harness died"));
    expect((await rt.sessions.list())[0]).toMatchObject({ startedBy: "agent", status: "failed" });
  });

  it("export brings the folder and the sessions keyed to it home and returns the done line with the result; an existing folder is a tool error naming it", async () => {
    exportGuest(backend);
    await call("new", { name: "alpha" });
    const dest = join(dir, "out", "proj");
    const exported = await call("export", { workspace: "alpha", folder: dest, from: EXPORT_SOURCE });
    expect(exported.isError).toBe(false);
    expect(exported.text).toBe(`2 files, 28 B, landed at ${dest}; 1 cache left behind; sessions: Claude Code (1 session) moved.`);
    expect(exported.structured).toEqual({ dest, files: 2, bytes: 28, excluded: ["node_modules"], agents: [{ agent: "claude", files: 1, bytes: EXPORT_SESSION(realpathSync(dest)).length, outcome: "moved", sessions: 1 }] });
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const a = 1;\n");
    const key = realpathSync(dest).replace(/[^A-Za-z0-9]/g, "-");
    expect(readFileSync(join(dir, "user", ".claude", "projects", key, "S1.jsonl"), "utf8")).toBe(EXPORT_SESSION(realpathSync(dest)));
    const again = await call("export", { workspace: "alpha", folder: dest, from: EXPORT_SOURCE });
    expect(again.isError).toBe(true);
    expect(again.text).toBe(`${dest} already exists on this computer with 2 files; export with replace to overwrite it`);
  });

  it("exec runs the command on the workspace's machine as argv and returns its output and exit code; a non-zero exit is a result, not an error", async () => {
    await call("new", { name: "alpha" });
    execGuest(backend, "one\ntwo\n", 3);
    const ran = await call("exec", { workspace: "alpha", argv: ["sh", "-c", "printf 'one\\ntwo\\n'; exit 3"] });
    expect(ran.isError).toBe(false);
    expect(ran.text).toBe("one\ntwo");
    expect(ran.structured).toEqual({ exitCode: 3, output: ["one", "two"], cwd: expect.any(String) });
    const launch = backend.machines[0]!.execLog.find(cmd => cmd.includes("base64 -d"))!;
    expect(Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(launch)![1]!, "base64").toString("utf8")).toContain("'sh' '-c' 'printf '\\''one\\ntwo\\n'\\''; exit 3'\n");
  });

  it("exec takes cwd, the folder the command runs in; without it the workspace's project folder; the result says which, and a relative one is refused", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const held = alpha!.project.path;
    execGuest(backend, "", 0);
    const inProject = await call("exec", { workspace: "alpha", argv: ["git", "status"] });
    expect(inProject).toEqual({ text: "", structured: { exitCode: 0, output: [], cwd: held }, isError: false });
    expect(launchedScripts(backend).at(-1)).toContain(`\ncd '${held}' && 'git' 'status'\n`);

    const named = await call("exec", { workspace: "alpha", argv: ["git", "status"], cwd: "/root/work/else where" });
    expect(named.structured).toEqual({ exitCode: 0, output: [], cwd: "/root/work/else where" });
    expect(launchedScripts(backend).at(-1)).toContain("\ncd '/root/work/else where' && 'git' 'status'\n");

    execGuest(backend, "fatal: not a git repository\n", 128);
    const failing = await call("exec", { workspace: "alpha", argv: ["git", "status"] });
    expect(failing).toEqual({ text: "fatal: not a git repository", structured: { exitCode: 128, output: ["fatal: not a git repository"], cwd: held }, isError: false });

    const relative = await call("exec", { workspace: "alpha", argv: ["git", "status"], cwd: "packages/host" });
    expect(relative.isError).toBe(true);
  });

  it("the workspace going away under a running exec ends the tool with the reason as an error", async () => {
    await call("new", { name: "alpha" });
    execGuest(backend, "", undefined);
    const running = call("exec", { workspace: "alpha", argv: ["sleep", "600"] });
    await new Promise(r => setTimeout(r, 300));
    const [alpha] = await rt.workspaces.list();
    await rt.workspaces.delete(alpha!.id);
    expect(await running).toEqual(failedWith("machine deleted while the agent was working"));
  });

  it("a dead host is a tool error, not a hang: no host serving, then the host stopping mid-turn, then a host that came back", async () => {
    await call("new", { name: "alpha" });
    await handle!.close();
    handle = undefined;
    await socket!.closed;
    const gone = await call("workspaces");
    expect(gone).toEqual(failedWith(noHostServingLine(statePath)));

    await restartHost({ claude: stuckAgent() });
    const turn = call("run", { workspace: "alpha", task: "hang" });
    await new Promise(r => setTimeout(r, 300));
    await handle!.close();
    handle = undefined;
    expect(await turn).toEqual(failedWith(HOST_STOPPING_LINE));

    await restartHost({ claude: claude.adapter });
    const back = await call("threads");
    expect(back.isError).toBe(false);
    expect((back.structured as { threads: ThreadView[] }).threads).toHaveLength(1);
  });

  it("wsp mcp speaks the protocol over stdio and returns when its stdin ends, closing the host socket", async () => {
    await call("new", { name: "alpha" });
    await client!.close();
    client = undefined;
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const served = serveMcp(statePath, { env }, { input: toServer, output: fromServer });
    const stdio = new Client({ name: "test-agent", version: "0.0.0" });
    await stdio.connect(streamTransport(toServer, fromServer));
    const result = await stdio.callTool({ name: "workspaces", arguments: {} });
    expect((result.structuredContent as { workspaces: WorkspaceView[] }).workspaces.map(w => w.name)).toEqual(["alpha"]);
    await stdio.close();
    await expect(served).resolves.toBeUndefined();
  });

  it("recipe reads this computer, writes the file and answers with the same table the command line prints, set and all", async () => {
    const out = join(dir, "recipe.json");
    // The scan this server was handed, which is what a set word naming a package this computer has is answered against.
    const diskbloom = { id: "brew/zingzy/tap/diskbloom", name: "zingzy/tap/diskbloom", manager: "brew" as const, group: "Homebrew formulae", install: "brew install zingzy/tap/diskbloom", check: "brew list --versions zingzy/tap/diskbloom", size: 4 * 1024 * 1024 };
    await connect({ alsoHere: async () => [diskbloom] });
    const first = await call("recipe", { out });
    const table = RecipeAnswer.parse(first.structured);
    expect(table.tick).toBe("used");
    expect(table.out).toBe(out);
    expect(allRows(table).map(r => r.id).sort()).toEqual(CATALOG.map(e => e.id).sort());
    expect(first.text).toBe(recipePrintout(table).join("\n"));
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).tick).toBe("used");

    const flipped = RecipeAnswer.parse((await call("recipe", { out, set: ["java=on"] })).structured);
    expect(allRows(flipped).find(r => r.id === "java")).toMatchObject({ on: true, size: 613280230 });
    expect(flipped.heavy.map(r => r.id)).toContain("java");
    // A word no row of any kind answers is a tool error in one line, not a rewritten file.
    expect(await call("recipe", { out, set: ["jaava=on"] })).toMatchObject({ isError: true, text: `--set jaava=on: "jaava" is no catalog row and no row of ${out} outside the catalog, and no package a manager on ${HERE} has that id. Run wsp recipe scan to read the rows this computer offers.` });
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).rows.find(r => r.id === "java")?.on).toBe(true);

    // The id the scan gives a package this computer has ticks that package's own row, the road the Also screen takes.
    const ticked = RecipeAnswer.parse((await call("recipe", { out, set: [`${diskbloom.id}=on`] })).structured);
    expect(allRows(ticked).some(r => r.id === diskbloom.id)).toBe(false);
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).rows.find(r => r.id === "tools/brew/zingzy/tap/diskbloom")).toMatchObject({ on: true, kind: "tool" });
    // An add for the same package is refused in one line naming the set word, since it is a row already.
    expect(await call("recipe", { out, add: [`${diskbloom.id}=${diskbloom.install}`] })).toMatchObject({ isError: true, text: `--add ${diskbloom.id}: a package manager on ${HERE} already has ${diskbloom.id}, so it is a row of its own. Tick it with --set ${diskbloom.id}=on.` });
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).custom ?? []).toEqual([]);
  });

  it("recipe refuses a relative out or project by name: this server's own folder is wherever the agent launched it", async () => {
    expect(await call("recipe", { out: "recipe.json" })).toMatchObject({ isError: true, text: 'out is a path on this computer, absolute, and got "recipe.json". Give a path that opens with /, since whoever reads it works in a folder this line cannot see.' });
    expect(await call("recipe", { out: join(dir, "r.json"), project: ["../elsewhere"] })).toMatchObject({ isError: true, text: 'project is a folder on this computer, absolute, and got "../elsewhere". Give a path that opens with /, since whoever reads it works in a folder this line cannot see.' });
    expect(await call("recipe_scan", { project: ["packages/host"] })).toMatchObject({ isError: true, text: 'project is a folder on this computer, absolute, and got "packages/host". Give a path that opens with /, since whoever reads it works in a folder this line cannot see.' });
  });

  it("recipe_scan answers with every option and a recommendation per row, and writes nothing", async () => {
    const out = join(dir, "untouched.json");
    // No scanner is handed to this server, so nothing looked for tools outside the catalog and it says so.
    const result = await call("recipe_scan", {});
    const scan = RecipeScan.parse(result.structured);
    expect(existsSync(out)).toBe(false);
    expect(scan.tick).toBe("used");
    expect(scan.agents.map(r => r.id).sort()).toEqual(CATALOG.filter(e => e.kind === "agent").map(e => e.id).sort());
    expect(scan.tools.map(r => r.id).sort()).toEqual(CATALOG.filter(e => e.kind === "tool").map(e => e.id).sort());
    expect(scan.alsoHere).toEqual({ scanned: false, managers: [] });
    for (const row of [...scan.agents, ...scan.tools]) expect(row.recommended.value, row.id).toBe(row.on ? "on" : "off");
    expect(result.text).toBe(scanPrintout(scan, hostPlatform()).join("\n"));
    expect(result.text).toContain("nothing looked for them here");
  });
});

describe("the MCP server never talks to the provider", () => {
  it("imports the protocol, the collector, the verbs' client and the SDK only: no runtime, engine, backend or key loading", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const src = (file: string): URL => new URL(`../src/${file}`, import.meta.url);
    // What a module really pulls in at run time: a type-only import is erased by the build and carries nothing.
    const read = (file: string): string[] =>
      [...readFileSync(src(file), "utf8").matchAll(/(?:^|\n)(?:import|export)([^;]*?) from "([^"]*)";/gs)].flatMap(m => (m[1]!.trimStart().startsWith("type ") ? [] : [m[2]!]));
    // Every local module the server pulls in, however deep: a new import three files down is caught here too.
    const closure = (entry: string): Map<string, string[]> => {
      const seen = new Map<string, string[]>();
      const walk = (file: string): void => {
        if (seen.has(file)) return;
        const imports = read(file);
        seen.set(file, imports);
        for (const i of imports) {
          if (!i.startsWith("./")) continue;
          const local = `${i.slice(2, -3)}.ts`;
          if (existsSync(src(local))) walk(local);
        }
      };
      walk(entry);
      return seen;
    };
    const walked = closure("mcp.ts");
    // The tools are the verb table's; the collector reads this computer for the recipe verbs and depends on the
    // catalog and the protocol and nothing else. The catalog is rows and ids alone (the agents a thread can take),
    // so the list the agent argument names reaches no provider either.
    expect(walked.get("mcp.ts")!.filter(i => i.startsWith("@wsp/"))).toEqual([]);
    // The keys package is node crypto and nothing else: a tool server holds a host to the key it pinned before it
    // sends that host a token, and loads no runtime, engine or provider key to do it.
    expect(walked.get("verbs.ts")!.filter(i => i.startsWith("@wsp/"))).toEqual(["@wsp/catalog", "@wsp/collect", "@wsp/keys", "@wsp/protocol"]);
    expect([...walked.keys()].sort()).toContain("recipe-answer.ts");
    expect([...walked.keys()].sort()).toContain("init-layout.ts");
    // The adapter packages come from the one registry's list of agents, so a new agent is banned here without an edit.
    const banned = new RegExp(`@wsp/(runtime|engine|daemon|web|${THREAD_AGENTS.map(a => `adapter-${a}`).join("|")})`);
    for (const [file, imports] of walked) {
      for (const i of imports) expect(`${i} in ${file}`).not.toMatch(banned);
    }
  });
});

describe("what the MCP server writes to its agent", () => {
  it("carries no raw C1 control character on stdio, since a script that prints the JSON is a terminal too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-mcp-c1-"));
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const read: Buffer[] = [];
    fromServer.on("data", (b: Buffer) => read.push(b));
    const served = serveMcp(join(dir, "state.json"), { env: {} }, { input: toServer, output: fromServer });
    const stdio = new Client({ name: "test-agent", version: "0.0.0" });
    await stdio.connect(streamTransport(toServer, fromServer));
    // The SDK's own answer to a tool it has none of names the tool, so the name comes back in a frame as it was sent.
    await stdio.callTool({ name: "no-such\x9b2J\x85tool", arguments: {} }).catch(() => undefined);
    await stdio.close();
    await served;
    const text = Buffer.concat(read).toString("utf8");
    expect(text).toContain("no-such");
    expect(text).not.toMatch(/[\x7f-\x9f]/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("escapes a character split across two writes as a whole", async () => {
    const out = new PassThrough();
    const read: Buffer[] = [];
    out.on("data", (b: Buffer) => read.push(b));
    const safe = c1Escaped(out);
    const bytes = Buffer.from('{"a":"caf\u00e9\u009b"}\n', "utf8");
    const at = bytes.indexOf(0xc3) + 1;
    await new Promise<void>(done => safe.write(bytes.subarray(0, at), () => done()));
    await new Promise<void>(done => safe.write(bytes.subarray(at), () => done()));
    expect(JSON.parse(Buffer.concat(read).toString("utf8"))).toEqual({ a: "caf\u00e9\u009b" });
    expect(Buffer.concat(read).toString("utf8")).not.toMatch(/[\x7f-\x9f]/);
  });
});
