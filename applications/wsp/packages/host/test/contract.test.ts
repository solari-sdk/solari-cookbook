// SPDX-License-Identifier: AGPL-3.0-only
// The one contract an agent reads wsp by, held on both doors against a host
// over the fake runtime: with --json stdout is JSON only and ends with the
// object the verb's MCP tool answers with; every refusal is one line on stderr
// and the exit code is its class's, the same class the tool error carries.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { type AddressInfo } from "node:net";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DAEMON_TOKEN_PATH, EXIT_CODES, FORWARD_ENV, SCOPED_MCP_ARG, scopedNoPairLine, HERE_PLACE_ID, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, shellQuote, TURN_TOKEN_ENV, VerbFailure } from "@wsp/protocol";
import { copyKey, createRuntime, DAEMON_TOKEN_SET, memoryStore, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { daemonBinaryHere } from "../src/assets.js";
import { cli, doctorKeyAsk, jsonCliIO, serve } from "../src/cli.js";
import type { HostStarter } from "../src/host-start.js";
import { writeHost } from "../src/hosts.js";
import { placeWiring } from "../src/places.js";
import { hostTokenPath, lockPathFor } from "../src/host-lock.js";
import { mcpServer } from "../src/mcp.js";
import type { HostHandle } from "../src/server.js";
import { CLI_VERBS, hasTool, noHostServingLine, type DialOpts, type HostClient } from "../src/verbs.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { ASKS, EXPORT_SOURCE, PAGE, SCRIPTED_ASK, bornDeadAgent, captured, execGuest, exportGuest, scriptedAgent, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { agentHome, type AgentHome } from "../../collect/test/agent-home.js";
import { agentsReader } from "../src/agents-reader.js";
import { hostActs } from "../src/agents-signin.js";
import { skillsActs } from "../src/skills-acts.js";
import { serversActs } from "../src/servers-acts.js";
import type { SkillsFetch } from "../src/skills-sh.js";

/** skills.sh as far as this test asks it: one search and one skill's folder. */
const skillsSh: SkillsFetch = async url => {
  const at = new URL(url);
  if (at.pathname === "/api/search") return new Response(JSON.stringify({ skills: [{ id: "acme/skills/memo", source: "acme/skills", skillId: "memo", name: "memo", installs: 12 }] }));
  if (at.pathname === "/api/download/acme/skills/memo") return new Response(JSON.stringify({ files: [{ path: "SKILL.md", contents: "---\nname: memo\ndescription: Keep notes\n---\n# memo\n" }] }));
  return new Response("{}", { status: 404 });
};
import { nodeHost, type Host } from "@wsp/collect";

/** This computer's own Host over a fixture home, with the fixture's agents on its PATH. */
function fixtureHost(at: AgentHome): Host {
  const live = nodeHost();
  return { ...live, home: at.home, exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home, ...o?.env } }) } };
}

/** The fingerprint a pairing pinned, which every record written since wsp pinned keys carries. */
const HOST_KEY = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";

runsFromItsOwnFolder();

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** The wsp command as the app puts it on PATH: the daemon binary's forwarder in front of the wsp it runs. */
const forwarder = (wsp: readonly string[]): string[] => [daemonBinaryHere(), "forward", ...wsp.flatMap(word => ["--wsp-argv", word])];

/** This process's environment less every variable that aims a line at a host, so a spawned wsp reaches the host this
 * case serves and no other. */
const ownEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => ![HOST_URL_ENV, HOST_TOKEN_ENV, HOST_KEY_ENV, TURN_TOKEN_ENV, FORWARD_ENV, "WSP_HOST", "WSP_STARTED_BY"].includes(name)));

/** One stdio session with a tool server: each line written in turn, and the lines it printed once it has answered
 * every request among them; then its stdin closes and its code is read. */
async function served(argv: readonly string[], env: NodeJS.ProcessEnv, lines: readonly Record<string, unknown>[]): Promise<{ out: string[]; code: number | null }> {
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["pipe", "pipe", "inherit"] });
  const out: string[] = [];
  let held = "";
  child.stdout.on("data", (chunk: Buffer) => {
    held += chunk.toString("utf8");
    for (let at = held.indexOf("\n"); at !== -1; at = held.indexOf("\n")) {
      out.push(held.slice(0, at));
      held = held.slice(at + 1);
    }
  });
  const exited = new Promise<number | null>(done => child.once("exit", code => done(code)));
  try {
    for (const line of lines) {
      const answered = out.length + ("id" in line ? 1 : 0);
      child.stdin.write(`${JSON.stringify(line)}\n`);
      await vi.waitFor(() => expect(out.length).toBe(answered), { timeout: 15_000, interval: 20 });
    }
    child.stdin.end();
    return { out, code: await exited };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

/** A serving host as the doctor's computer road meets one: the rows it holds, the lines its road says and the code
 * it answers with. Nothing is dialled and no host is started; what the fake was asked is what the road asked. */
function fakeDoctorHost(o: { code?: number; lines?: readonly (readonly [string, "out" | "err"])[] } = {}) {
  const asked: string[] = [];
  const doctored: { placeId: string; project?: string }[] = [];
  const listeners = new Set<(frame: Record<string, unknown>) => void>();
  const places = [
    { id: HERE_PLACE_ID, kind: "computer", name: "zingzys-mac", default: true },
    { id: "p_1", kind: "computer", name: "spoo", default: false, present: true },
  ];
  let closed = 0;
  const client = {
    request: async <T extends Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
      asked.push(op);
      if (op === "places.list") return { places } as unknown as T;
      if (op !== "places.doctor") throw new Error(`the doctor asked this host for ${op}`);
      doctored.push({ placeId: params["placeId"] as string, ...(params["project"] === undefined ? {} : { project: params["project"] as string }) });
      for (const [line, stream] of o.lines ?? []) for (const fn of [...listeners]) fn({ type: "doctor.line", doctorId: params["doctorId"], line, stream });
      return { code: o.code ?? 0 } as unknown as T;
    },
    events: async (): Promise<void> => {},
    onFrame: (fn: (frame: Record<string, unknown>) => void): (() => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    closed: new Promise<void>(() => {}),
    closeWords: () => "the host closed the connection",
    close: () => void closed++,
    terminate: () => void closed++,
  };
  const dialled: { statePath: string; aim: unknown }[] = [];
  return {
    asked,
    doctored,
    dialled,
    get closed() {
      return closed;
    },
    deps: {
      dial: async (statePath: string, opts: DialOpts) => {
        dialled.push({ statePath, aim: opts.aim });
        return client as unknown as HostClient;
      },
    },
  };
}

/** The image record a host owns once a seal has written one, with the recipe a copy would be built from; the hashes
 * are plainly fake, as every fixture key here is. */
const RECORD = {
  name: "default",
  version: 1,
  hash: "a".repeat(64),
  recipeHash: "rh",
  recipe: { version: 1, at: "2026-09-12T00:00:00.000Z", histories: [], rows: [] },
  logins: [],
  sealedAt: "2026-09-12T00:00:00.000Z",
  sealedFrom: "h1",
  vault: { sha256: "b".repeat(64), bytes: 10, paths: 1, takenAt: "2026-09-12T00:00:00.000Z" },
};

describe("the agent contract on the command line and the tool door", () => {
  let dir: string;
  let statePath: string;
  let backend: StubBackend;
  let store: Store;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  /** What the workspace's daemon refuses a pull request with, where a case wants the pull request half refused. */
  let prRefusal: string | undefined;

  beforeEach(async () => {
    prRefusal = undefined;
    dir = mkdtempSync(join(tmpdir(), "wsp-contract-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_contract_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    backend = stubBackend();
    store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    const claude = scriptedAgent(prompt => (prompt === "die" ? "" : `re: ${prompt}`), () => ({ kind: "written" }));
    // The confirming read a gone verdict waits for runs on the same tick: this backend's 404 is the whole truth, so
    // the wait only buys the contract a five second pause on the road to a rebuild.
    const agents = agentHome(join(dir, "agents"));
    rt = createRuntime({
      backend,
      store,
      adapters: { claude: claude.adapter, codex: bornDeadAgent(prompt => `re: ${prompt}`).adapter },
      goneConfirmMs: 0,
      // The daemon inside a workspace, as far as the one verb that asks it anything is concerned. Its pull request
      // half refuses where a case sets that, since the two halves of a bring back are answered apart.
      daemonChannel: async () => ({
        send: async frame =>
          frame.op === "git.push"
            ? { id: 1, ok: true, branch: "work", base: "main", remote: "origin", ahead: 1, uncommitted: 0, stat: [" a.ts | 2 +-"] }
            : prRefusal === undefined
              ? { id: 1, ok: true, pr: { number: 3, url: "https://github.com/dev/alpha/pull/3", state: "open", host: "github.com" }, created: true }
              : { id: 1, ok: false as const, error: prRefusal },
        close: () => {},
        // Nothing here ends of its own: the runtime closes the channel when the verb it opened it for is done.
        closed: new Promise(() => {}),
      }),
      placeLinks: placeWiring(statePath),
      // What stands on this computer, read off a home six harnesses left and the agents on its own PATH.
      agentsReader: agentsReader({ vault: () => ({}), here: () => fixtureHost(agents) }),
      // The wsp tools land in a config under this test's own home, never the person's.
      agentsActs: hostActs({ vaultFile: join(dir, ".env"), home: () => join(dir, "user"), wspServer: () => ({ command: "wsp", args: ["mcp"] }) }),
      // A skill lands in the fixture's home, never the person's, off a skills.sh that answers from this file.
      skillsActs: skillsActs({ fetch: skillsSh, here: () => fixtureHost(agents) }),
      // A server lands in the fixture's agents' configs, never the person's.
      serversActs: serversActs({ here: () => fixtureHost(agents) }),
      // Two places over one backend: this host's own, and one more for the image build road, which never boots a
      // machine here because the place already stands on the record.
      places: { wired: "default", backend: place => (place === "default" || place === "elsewhere" ? backend : undefined), list: () => ["default", "elsewhere"] },
    });
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    // A workspace is one project's copy, so every line that makes one needs a project first.
    await rt.projects.add({ source: "https://github.com/dev/alpha.git", on: "default" });
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** --state goes before any `--`, where exec's command begins. */
  async function run(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    const cut = argv.indexOf("--");
    const at = cut === -1 ? argv.length : cut;
    const code = await cli([...argv.slice(0, at), "--state", statePath, ...argv.slice(at)], io);
    return { code, io };
  }
  const objects = (io: Captured): unknown[] => io.lines.map(l => JSON.parse(l) as unknown);
  const failure = (io: Captured): VerbFailure => {
    expect(io.errors).toHaveLength(1);
    return VerbFailure.parse(JSON.parse(io.errors[0]!));
  };

  it("with --json every command-line verb prints JSON alone on stdout and its last object is the one its MCP tool answers with", async () => {
    const covered = new Map<string, unknown>();
    const last = async (verb: string, ...argv: string[]): Promise<unknown> => {
      const cut = argv.indexOf("--");
      const at = cut === -1 ? argv.length : cut;
      const { code, io } = await run(...argv.slice(0, at), "--json", ...argv.slice(at));
      expect(code, `wsp ${argv.join(" ")}: ${io.errors.join("\n")}`).toBe(0);
      const values = objects(io);
      expect(values.length, `wsp ${argv.join(" ")} printed nothing`).toBeGreaterThan(0);
      covered.set(verb, values.at(-1));
      return values.at(-1);
    };
    const proj = join(dir, "proj");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "index.ts"), "export const a = 1;\n");
    const guest = exportGuest(backend);
    expect(guest.sources).toEqual([]);

    const created = (await last("new", "new", "alpha")) as { workspace: { id: string } };
    const alpha = created.workspace.id;
    await last("workspaces", "workspaces");
    // The one verb that asks the workspace's own daemon anything: the guest carries this host's token and the
    // machine has a route, which is what the channel behind a bring back is opened on.
    const machine = backend.machines[0]!;
    const noRoute = machine.previewUrl;
    const guestSoFar = backend.execImpl;
    machine.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
    backend.execImpl = (m, cmd) => (cmd.includes(DAEMON_TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : guestSoFar(m, cmd));
    expect(await last("bring back", "bring", "back", "alpha")).toEqual({
      branch: "work",
      base: "main",
      ahead: 1,
      uncommitted: 0,
      stat: [" a.ts | 2 +-"],
      pr: { number: 3, url: "https://github.com/dev/alpha/pull/3", state: "open", host: "github.com" },
    });
    // The route goes again with the guest that answered for it: a machine wearing one has every later verb wait on
    // a daemon that is not there, which is the rest of this run.
    machine.previewUrl = noRoute;
    backend.execImpl = guestSoFar;
    expect(await last("workspaces agents", "workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "2")).toEqual({
      workspace: expect.objectContaining({ name: "alpha", agents: { spawn: true, maxMachines: 2, maxDepth: 1 } }),
    });
    await last("workspaces agents", "workspaces", "agents", "alpha", "--spawn", "off");
    await last("threads", "threads");
    await last("computers", "computers");
    await last("setup", "setup");
    // One level of this computer's own folders: the home folder this test stubbed, with a folder inside it to list.
    mkdirSync(join(dir, "user", "code"), { recursive: true });
    await last("folders", "folders");
    await last("terminal config", "terminal", "config");
    await last("agents", "agents");
    await last("skills", "skills", "--on", HERE_PLACE_ID);
    await last("servers", "servers");
    expect(await last("skills search", "skills", "search", "memo")).toEqual({ skills: [expect.objectContaining({ id: "acme/skills/memo" })] });
    expect(await last("skills show", "skills", "show", "acme/skills/memo")).toMatchObject({ size: expect.any(Number) });
    expect(await last("skills add", "skills", "add", "acme/skills/memo", "--agent", "claude")).toEqual({ path: "~/.agents/skills/memo", agents: [{ agent: "claude", path: "~/.claude/skills/memo" }] });
    await last("skills show", "skills", "show", "memo");
    expect(await last("skills disable", "skills", "disable", "memo")).toEqual({ paths: ["~/.agents/skills/memo"] });
    expect(await last("skills enable", "skills", "enable", "memo")).toEqual({ paths: ["~/.agents/skills/memo"] });
    expect(await last("skills remove", "skills", "remove", "memo")).toEqual({ removed: expect.arrayContaining(["~/.agents/skills/memo", "~/.claude/skills/memo"]) });
    expect(await last("agents addtools", "agents", "addtools", "codex")).toEqual({ file: "~/.codex/config.toml" });
    // A value an add names is read off the environment by its name, lands in the file and is never printed.
    vi.stubEnv("ACME_KEY", "sk-acme-contract-x");
    expect(await last("servers add", "servers", "add", "acme", "--agent", "codex", "--command", "npx -y @acme/mcp", "--env", "ACME_KEY")).toEqual({ file: "~/.codex/config.toml" });
    expect(readFileSync(join(dir, "agents", "home", ".codex", "config.toml"), "utf8")).toContain('env = { "ACME_KEY" = "sk-acme-contract-x" }');
    expect(JSON.stringify([...covered.values()])).not.toContain("sk-acme-contract-x");
    expect(await last("servers disable", "servers", "disable", "acme", "--agent", "codex")).toEqual({ file: "~/.codex/config.toml" });
    expect(await last("servers enable", "servers", "enable", "acme", "--agent", "codex")).toEqual({ file: "~/.codex/config.toml" });
    expect(await last("servers remove", "servers", "remove", "acme", "--agent", "codex")).toEqual({ file: "~/.codex/config.toml" });
    expect(readFileSync(join(dir, "agents", "home", ".codex", "config.toml"), "utf8")).not.toContain("acme");
    // The one verb that starts a server: the fixture's runner exits at once, so the answer is why no tools came back.
    expect(await last("servers tools", "servers", "tools", "local", "--agent", "claude")).toMatchObject({ auth: "failed", refused: expect.any(String) });
    expect(await last("projects", "projects")).toEqual({ projects: [expect.objectContaining({ name: "alpha", computer: "default" })] });
    // A second project, recorded and dropped, so the verb that takes one out is run under --json too.
    await rt.projects.add({ source: "https://github.com/dev/spare.git", on: "default" });
    // The sentence a remove answers with comes off the wire, so the verb and the tool say the same thing about
    // what went on the computer holding it.
    expect(await last("projects remove", "projects", "remove", "spare")).toEqual({ project: expect.objectContaining({ name: "spare" }), said: expect.stringContaining("is no longer a project") });
    // Renamed and named back, so the rest of this run still addresses it as alpha.
    expect(await last("rename", "rename", "alpha", "renamed")).toMatchObject({ was: "alpha", workspace: { name: "renamed" } });
    await last("rename", "rename", "renamed", "alpha");
    // A snapshot takes a first-life machine, so it comes before the pause that resumes it.
    const { projectGolden } = (await last("snapshot", "snapshot", "alpha")) as { projectGolden: { snapshotId: string } };
    await last("pause", "pause", "alpha");
    await last("wake", "wake", "alpha");
    // Already on the golden's head, so the move is the answer alone: the workspace untouched and nothing kept.
    expect(await last("image move", "image", "move", "alpha")).toEqual({ workspace: expect.objectContaining({ name: "alpha" }), moved: false, kept: [] });
    // The seeded golden was sealed before records existed, so the record reads off its head and holds no sign-ins.
    expect(await last("image", "image")).toMatchObject({ image: expect.objectContaining({ version: 1 }), copies: [expect.objectContaining({ place: "default" })], projects: expect.any(Array) });
    expect(await last("image remove", "image", "remove", projectGolden.snapshotId, "--yes")).toEqual({ projectGolden: expect.objectContaining({ snapshotId: projectGolden.snapshotId }), alreadyGone: false });
    // A place already standing on the record answers with the copy it holds and builds nothing, which is the road
    // that costs no machine: the record and that place's copy are written here at one hash.
    await store.put("images", "default", RECORD);
    await store.put("goldens", copyKey("elsewhere", "default"), { ...SEALED_GOLDEN, versions: [{ ...SEALED_GOLDEN.versions[0]!, snapshotId: "snap_elsewhere", imageHash: RECORD.hash }] });
    expect(await last("image build", "image", "build", "elsewhere")).toEqual({ copy: expect.objectContaining({ place: "elsewhere", version: 1, hash: RECORD.hash }), built: false });
    const opened = (await last("run", "run", "alpha", "hello")) as { threadId: string; text: string };
    expect(opened).toMatchObject({ threadId: expect.any(String), text: "re: hello", outcome: "started" });
    await last("send", "send", opened.threadId, "again");
    // The turn is over, so the wait answers off the transcript at once.
    expect(await last("threads wait", "threads", "wait", opened.threadId)).toEqual({ finished: { threadId: opened.threadId, status: "completed", reply: "re: again" } });
    // The read is off the transcript the host holds: the same turn, its rows, and its reply whole under --last.
    expect(await last("thread read", "thread", "read", opened.threadId, "--last")).toEqual({ threadId: opened.threadId, messages: [{ who: "agent", at: expect.any(Number), text: "re: again" }] });
    await last("thread read", "thread", "read", opened.threadId);
    await last("stop", "stop", opened.threadId);
    // A thread stopped on a permission question, answered from here the way the app's own buttons answer it.
    for (const [verb, task] of [["thread allow", "allow"], ["thread deny", "deny"]] as const) {
      const asking = (await last("run", "run", "alpha", "--detach", ASKS)) as { threadId: string };
      await vi.waitFor(async () => expect((await rt.sessions.list()).find(v => v.threadId === asking.threadId)!.asking).toBeDefined());
      expect(await last(verb, "thread", task, asking.threadId)).toEqual({ threadId: asking.threadId, askId: SCRIPTED_ASK.askId, optionId: expect.any(String) });
    }
    await last("thread rename", "thread", "rename", opened.threadId, "the name he typed");
    // A launch that never started its agent leaves a row with no turn on it, which is the one a forget takes.
    const dead = await run("run", "alpha", "--agent", "codex", "never gets going", "--json");
    expect(dead.code).toBe(1);
    const junk = (await rt.sessions.list()).find(v => v.harness === "codex")!.threadId!;
    expect(await last("thread forget", "thread", "forget", junk)).toEqual({ threadId: junk, workspaceId: alpha });
    await last("export", "export", "alpha", join(dir, "out", "proj"), "--from", EXPORT_SOURCE);
    execGuest(backend, "ok\n", 0);
    // A streamed verb's frames carry the output and its result leaves it out, so no line prints twice.
    const ran = await run("exec", "alpha", "--json", "--", "true");
    expect(ran.code).toBe(0);
    expect(objects(ran.io)).toEqual([{ type: "exec.output", execId: expect.any(String), text: "ok" }, { exitCode: 0, cwd: "/root/alpha" }]);
    covered.set("exec", objects(ran.io).at(-1));
    const forked = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--json");
    expect(forked.code).toBe(0);
    const forkLines = objects(forked.io) as Record<string, unknown>[];
    expect(forkLines.filter(o => "workspace" in o)).toEqual([{ workspace: expect.objectContaining({ name: "worker" }) }]);
    expect(forkLines.at(-1)).toEqual({ turn: expect.objectContaining({ text: "re: build it", outcome: "started" }) });
    covered.set("fork", forkLines.at(-1));
    const plain = await run("fork", "alpha", "--name", "sibling", "--json");
    expect(plain.code).toBe(0);
    expect(objects(plain.io).at(-1)).toEqual({ workspace: expect.objectContaining({ name: "sibling" }) });
    // Recipe verbs read the computer HOME and PATH name: an empty one here, so nothing of this box is read.
    const empty = join(dir, "empty");
    mkdirSync(join(empty, "bin"), { recursive: true });
    vi.stubEnv("HOME", empty);
    vi.stubEnv("PATH", join(empty, "bin"));
    await last("recipe scan", "recipe", "scan");
    await last("recipe", "recipe", "--tick", "default");
    for (const m of backend.machines) m.killed = true;
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    await last("forget", "forget", worker.id, "--yes");
    // A machine killed at the provider settles its record on the next verb that reads the machine, and gone is the
    // one state a rebuild takes; the workspace comes back on a fresh machine under the same id.
    const stale = await run("wake", "alpha", "--json");
    expect(stale.code).toBe(1);
    const rebuilt = (await last("rebuild", "rebuild", alpha)) as { workspace: { id: string; machineId: string } };
    expect(rebuilt.workspace.id).toBe(alpha);
    await last("delete", "delete", alpha, "--yes");
    const served = CLI_VERBS.filter(hasTool);
    expect(served.filter(v => v.tool.stream !== undefined).map(v => [v.name, v.tool.stream])).toEqual([["fork", ["workspace", "notice"]], ["exec", ["output"]]]);

    for (const verb of served) {
      const value = covered.get(verb.name);
      expect(value, `no --json run of wsp ${verb.name} in this test`).toBeDefined();
      const shape = z.object(verb.tool.output);
      const parsed = shape.omit(Object.fromEntries((verb.tool.stream ?? []).map(field => [field, true]))).strict().safeParse(value);
      expect(parsed.success, `wsp ${verb.name} --json ends with ${JSON.stringify(value)}\n${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
    expect([...covered.keys()].sort()).toEqual(served.map(v => v.name).sort());
  });

  it("the lists of what stands on a computer refuse a workspace and a computer together, and a computer nobody holds, as usage", async () => {
    await run("new", "alpha");
    const both = await run("agents", "alpha", "--on", HERE_PLACE_ID, "--json");
    expect(both.code).toBe(EXIT_CODES.usage);
    expect(failure(both.io).error).toContain("give the workspace or --on <computer>, not both");
    const nobody = await run("skills", "--on", "nowhere", "--json");
    expect(nobody.code).toBe(EXIT_CODES.usage);
    expect(failure(nobody.io).error).toContain("nowhere");
    const two = await run("servers", "alpha", "beta");
    expect(two.code).toBe(EXIT_CODES.usage);
    const prose = await run("servers");
    expect(prose.code).toBe(0);
    expect(prose.io.lines.join("\n")).toMatch(/airtable\s+Claude Code\s+user\s+stdio npx airtable-mcp-server\s+~\/\.claude\.json\s+open/);
    expect(prose.io.lines.join("\n")).not.toContain("SECRET");
  });

  it("a usage refusal exits 3: the parser's, a verb's own before anything is dialled, and a confirmation nobody is there to give; under --json the one stderr line is the failure object", async () => {
    const flag = await run("threads", "--nope", "--json");
    expect(flag.code).toBe(EXIT_CODES.usage);
    expect(flag.io.lines).toEqual([]);
    expect(failure(flag.io)).toEqual({ error: expect.stringContaining("Unknown option '--nope'"), class: "usage", exit: 3 });

    const bare = await run("new");
    expect(bare.code).toBe(3);
    expect(bare.io.errors).toEqual([expect.stringMatching(/^wsp new takes the work you are doing/)]);

    await run("new", "alpha");
    const unasked = await run("delete", "alpha", "--json");
    expect(unasked.code).toBe(3);
    expect(failure(unasked.io)).toEqual({ error: "Delete alpha? There is no terminal to answer on. Pass --yes to say yes.", class: "usage", exit: 3 });
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);

    const relative = await run("exec", "alpha", "--cwd", "packages", "--json", "--", "true");
    expect(relative.code).toBe(3);
    expect(failure(relative.io).class).toBe("usage");
    const dangling = await run("fork", "alpha", "--model", "claude-sonnet-5", "--json");
    expect(dangling.code).toBe(3);
    expect(failure(dangling.io)).toEqual({ error: '--model says how a thread opens, and this line opens none. Add --send "<task>", or drop --model.', class: "usage", exit: 3 });

    // A name this host holds nothing by is a value nothing takes, however far down the line it was read.
    const missing = await run("pause", "nope", "--json");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.lines).toEqual([]);
    expect(failure(missing.io)).toEqual({ error: "no workspace nope", class: "usage", exit: 3 });
  });

  it("an auth refusal exits 2: the host refusing the token, or no token file to read", async () => {
    writeFileSync(hostTokenPath(statePath), "not-the-token\n");
    const wrong = await run("threads", "--json");
    expect(wrong.code).toBe(EXIT_CODES.auth);
    expect(wrong.io.lines).toEqual([]);
    expect(failure(wrong.io)).toEqual({ error: "unauthorized", class: "auth", exit: 2 });
    const prose = await run("threads");
    expect(prose.code).toBe(2);
    expect(prose.io.errors).toEqual(["wsp threads: unauthorized"]);

    rmSync(hostTokenPath(statePath));
    const missing = await run("threads", "--json");
    expect(missing.code).toBe(2);
    expect(failure(missing.io)).toEqual({ error: `the host's token file is missing: ${hostTokenPath(statePath)}`, class: "auth", exit: 2 });
  });

  it("a host of an older version refuses the token with the close code alone, and that is auth too; a plain refusal that closes normally stays the provider's", async () => {
    await handle!.close();
    handle = undefined;
    writeFileSync(hostTokenPath(statePath), "tok\n");
    const serve = async (answer: (socket: import("ws").WebSocket, id: number) => void): Promise<{ code: number; io: Captured }> => {
      const old = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>(r => old.once("listening", r));
      const wsPort = (old.address() as AddressInfo).port;
      writeFileSync(lockPathFor(statePath), JSON.stringify({ pid: process.pid, port: wsPort, wsPort, startedAt: new Date().toISOString() }));
      old.on("connection", socket => socket.once("message", raw => answer(socket, (JSON.parse(String(raw)) as { id: number }).id)));
      try {
        return await run("threads", "--json");
      } finally {
        for (const client of old.clients) client.terminate();
        await new Promise(r => old.close(r));
      }
    };
    const frameThenClose = await serve((socket, id) => {
      socket.send(JSON.stringify({ id, ok: false, error: "unauthorized" }));
      socket.close(4401, "unauthorized");
    });
    expect(frameThenClose.code).toBe(2);
    expect(failure(frameThenClose.io)).toEqual({ error: "unauthorized", class: "auth", exit: 2 });
    const closeAlone = await serve(socket => socket.close(4401, "unauthorized"));
    expect(closeAlone.code).toBe(2);
    expect(failure(closeAlone.io)).toEqual({ error: "the host closed the connection", class: "auth", exit: 2 });
    const refused = await serve((socket, id) => {
      socket.send(JSON.stringify({ id, ok: false, error: "no such op" }));
      socket.close(1000, "done");
    });
    expect(refused.code).toBe(1);
    expect(failure(refused.io)).toEqual({ error: "no such op", class: "provider", exit: 1 });
  });

  it("a provider failure exits 1: the machine cap, no host serving, and a turn that failed", async () => {
    await run("new", "alpha");
    const died = await run("run", "alpha", "die");
    expect(died.code).toBe(1);
    expect(died.io.errors).toEqual(["wsp run: the harness died"]);

    await handle!.close();
    handle = undefined;
    const gone = captured();
    expect(await cli(["threads", "--json", "--state", statePath], gone, undefined, process.env, false)).toBe(1);
    expect(failure(gone)).toEqual({ error: noHostServingLine(statePath), class: "provider", exit: 1 });
  });

  it("a bring back whose pull request half refused carries both halves on the JSON and exits 1, the push's fields with it", async () => {
    await run("new", "alpha");
    const machine = backend.machines[0]!;
    const guestSoFar = backend.execImpl;
    machine.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
    backend.execImpl = (m, cmd) => (cmd.includes(DAEMON_TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : guestSoFar(m, cmd));
    prRefusal = "gh said: could not create pull request";
    const { code, io } = await run("bring", "back", "alpha", "--json");
    // The push landed, so its own fields are on the object beside the refusal and the verb still exits 1.
    expect(objects(io).at(-1)).toEqual({
      branch: "work",
      base: "main",
      ahead: 1,
      uncommitted: 0,
      stat: [" a.ts | 2 +-"],
      refused: prRefusal,
    });
    expect(code).toBe(1);
    expect(io.errors).toEqual([]);

    // The tool door carries the same answer with isError on it: a caller reading the structured content gets the
    // push's own fields, not a failure object, since the branch is on the remote whatever the other half said.
    const server = mcpServer(statePath, { env: {} });
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract-bring-back", version: "0" });
    await server.connect(toServer);
    await client.connect(toClient);
    try {
      const answer = await client.callTool({ name: "bring_back", arguments: { workspace: "alpha" } });
      expect(answer.isError).toBe(true);
      expect(answer.structuredContent).toEqual({ branch: "work", base: "main", ahead: 1, uncommitted: 0, stat: [" a.ts | 2 +-"], refused: prRefusal });
      expect((answer.content as { text?: string }[]).map(part => part.text ?? "").join("")).toContain(prRefusal!);
      // The note is the other half's other answer and is no error: the pull request waits and nothing failed.
      prRefusal = undefined;
      const noted = await client.callTool({ name: "bring_back", arguments: { workspace: "alpha" } });
      expect(noted.isError).not.toBe(true);
      expect(noted.structuredContent).toMatchObject({ branch: "work", pr: { number: 3 } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("the shared parse and the commands answer under the same classes: a bad flag, an unknown command, --json on a prose command and a word wsp doctor cannot read are usage", async () => {
    const io = captured();
    expect(await cli(["--nope"], io)).toBe(3);
    expect(io.errors).toEqual([expect.stringContaining("Unknown option '--nope'")]);
    const unknown = captured();
    expect(await cli(["nope"], unknown)).toBe(3);
    expect(unknown.errors[0]).toContain("unknown command: nope");
    const prose = captured();
    expect(await cli(["status", "--json", "--state", statePath], prose)).toBe(3);
    expect(prose.errors[0]).toContain("Unknown option '--json' for wsp status");
    const both = captured();
    expect(await cli(["init", "--yes", "--json", "--state", statePath], both)).toBe(3);
    expect(both.errors).toEqual([expect.stringContaining("Drop one of them.")]);
    // The doctor's three usage roads, each read before a key is asked for. Every road but a cloud row's forks
    // nothing and bills nothing, so a person with a computer of their own and no cloud account is asked for no
    // key: the IO below refuses any question as auth, so its silence is the proof that nothing asked. The auth
    // class itself is pinned end to end by the missing token file above, which is the road a person meets it on.
    const err = new PassThrough();
    const said: string[] = [];
    err.on("data", (c: Buffer) => said.push(c.toString()));
    const fresh = join(dir, "other.json");
    // The word is resolved off the host that holds the links, so the fake below is the whole host this road meets.
    const host = fakeDoctorHost();
    expect(await cli(["doctor", "nosuchbox", "--state", fresh], jsonCliIO(err), undefined, process.env, false, {}, host.deps)).toBe(EXIT_CODES.usage);
    expect(await cli(["doctor", "nosuchbox", "extra", "--state", fresh], jsonCliIO(err), undefined, process.env, false, {}, host.deps)).toBe(EXIT_CODES.usage);
    expect(await cli(["doctor", "--project", "www", "--state", fresh], jsonCliIO(err), undefined, process.env, false, {}, host.deps)).toBe(EXIT_CODES.usage);
    // One list read for the word, nothing else asked of that host, and no host of this computer's started for it.
    expect(host.asked).toEqual(["places.list"]);
    expect(host.closed).toBe(1);
    expect(existsSync(lockPathFor(fresh))).toBe(false);
    expect(said.join("")).toContain("no place named nosuchbox");
    expect(said.join("")).toContain("wsp doctor proves one computer, and it was given 2 words");
    expect(said.join("")).toContain("no computer was named");
    // Not one key question on any of the three, which off a terminal would have been the auth class and this line.
    expect(said.join("")).not.toContain("--json asks nothing");
  });

  it("hands a computer somebody joined to the host that holds its link and prints the lines it says, exiting with what that road came to", async () => {
    const host = fakeDoctorHost({ code: 1, lines: [["spoo answers", "out"], ["DOCTOR FAIL: spoo", "err"]] });
    const io = captured();
    const fresh = join(dir, "over-the-host.json");
    expect(await cli(["doctor", "spoo", "--project", "spoo-landing", "--state", fresh], io, undefined, process.env, false, {}, host.deps)).toBe(1);
    expect(io.lines).toContain("spoo answers");
    expect(io.errors).toContain("DOCTOR FAIL: spoo");
    expect(host.asked).toEqual(["places.list", "places.doctor"]);
    expect(host.doctored).toEqual([{ placeId: "p_1", project: "spoo-landing" }]);
    // Nothing of the road ran here: no runtime of this line's own touched the state file.
    expect(existsSync(fresh)).toBe(false);
    expect(host.closed).toBe(1);
  });

  it("dials the host on this computer for that road, whatever the environment names and whatever alias is the default", async () => {
    const host = fakeDoctorHost();
    const fresh = join(dir, "aimed-here.json");
    // A turn's launch environment names the host that started it, and a person may have named one in WSP_HOST; this
    // line proves a computer whose link only the host on this computer holds, so neither moves where it dials.
    expect(await cli(["doctor", "spoo", "--state", fresh], captured(), undefined, { ...process.env, WSP_HOST: "somewhere-else" }, false, {}, host.deps)).toBe(0);
    expect(host.dialled).toEqual([{ statePath: fresh, aim: { kind: "here" } }]);
    expect(host.doctored).toEqual([{ placeId: "p_1" }]);
  });

  it("asks for a provider key on the doctor road that forks at one and on no other", () => {
    // A cloud row's road forks a live machine and bills while it runs; every other road is this computer or a
    // computer the person owns. A cloud row is in the places list only once its key is held, so this rule is what
    // says which road would ask rather than a state a run can be put in.
    expect(doctorKeyAsk({ kind: "provider" })).toEqual({ anthropic: true });
    expect(doctorKeyAsk({ kind: "computer" })).toEqual({ anthropic: false, noSolari: "local" });
    expect(doctorKeyAsk()).toEqual({ anthropic: false, noSolari: "local" });
  });

  it("the tool door answers a failure as a tool error whose structured content is the same object with the same class", async () => {
    const server = mcpServer(statePath, { env: {} });
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract", version: "0" });
    await server.connect(toServer);
    await client.connect(toClient);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        return { text: (r.content as { text?: string }[]).map(p => p.text ?? "").join(""), structured: r.structuredContent, isError: r.isError === true };
      };
      expect(await call("pause", { workspace: "nope" })).toEqual({ text: "no workspace nope", structured: { error: "no workspace nope", class: "usage", exit: 3 }, isError: true });
      await call("new", { name: "alpha" });
      const relative = await call("exec", { workspace: "alpha", argv: ["true"], cwd: "packages" });
      const cwdRefusal = '--cwd is a path on the machine, absolute, and got "packages". Give a path that opens with /, since whoever reads it works in a folder this line cannot see.';
      expect(relative).toEqual({ text: cwdRefusal, structured: { error: cwdRefusal, class: "usage", exit: 3 }, isError: true });
      writeFileSync(hostTokenPath(statePath), "not-the-token\n");
      const fresh = mcpServer(statePath, { env: {} });
      const [c2, s2] = InMemoryTransport.createLinkedPair();
      const client2 = new Client({ name: "contract-2", version: "0" });
      await fresh.connect(s2);
      await client2.connect(c2);
      try {
        const r = await client2.callTool({ name: "threads", arguments: {} });
        expect(r.isError).toBe(true);
        expect(r.structuredContent).toEqual({ error: "unauthorized", class: "auth", exit: 2 });
      } finally {
        await client2.close();
        await fresh.close();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("a scoped tool server with no launch pair refuses in one line and never serves as the host", async () => {
    const io = captured();
    const inTurn = { ...ownEnv(), [TURN_TOKEN_ENV]: "f".repeat(32) };
    expect(await cli(["mcp", SCOPED_MCP_ARG, "--state", statePath], io, undefined, inTurn, false)).toBe(EXIT_CODES.auth);
    expect(io.errors).toEqual([scopedNoPairLine]);
    expect(io.lines).toEqual([]);
    // Under --json the refusal is the failure object on stderr, in the class and exit code the contract names.
    const json = captured();
    expect(await cli(["mcp", SCOPED_MCP_ARG, "--json", "--state", statePath], json, undefined, inTurn, false)).toBe(EXIT_CODES.auth);
    expect(json.errors.map(line => JSON.parse(line) as unknown)).toEqual([{ error: scopedNoPairLine, class: "auth", exit: EXIT_CODES.auth }]);
    expect(json.lines).toEqual([]);
  });

  it("the forwarder's ask of the command line answers the host serving this state file on this computer, and nothing for any other line", async () => {
    const asked = async (argv: string[], ask: string, start?: HostStarter | false, io: Captured = captured()): Promise<Captured> => {
      expect(await cli(argv, io, undefined, { ...ownEnv(), [FORWARD_ENV]: ask }, start)).toBe(0);
      return io;
    };
    const door = await asked(["mcp", "--state", statePath], "door");
    expect(door.lines.map(line => JSON.parse(line) as unknown)).toEqual([{ url: `ws://127.0.0.1:${handle!.wsPort}`, token: readFileSync(hostTokenPath(statePath), "utf8").trim() }]);
    expect(door.errors).toEqual([]);
    // A stdout that is a terminal gets nothing, since the line carries the host's token.
    const screen = await asked(["mcp", "--state", statePath], "door", undefined, { ...captured(), redraw: { write: () => undefined, columns: () => 80 } });
    expect([screen.lines, screen.errors]).toEqual([[], []]);
    // Every other line of the word is the command line's to answer, which the forwarder runs next: the ask says
    // nothing, writes nothing and serves nothing.
    // A scoped line is the thread's own tools: never the host's token, so the forwarder runs the wsp that decides.
    for (const argv of [["mcp", "install", "--agent", "claude", "--state", statePath], ["mcp", "--help"], ["mcp", "--nope"], ["mcp", "--host", "nowhere"], ["mcp", "--scoped", "--state", statePath]]) {
      const said = await asked(argv, "door");
      expect([said.lines, said.errors], argv.join(" ")).toEqual([[], []]);
    }
    expect(existsSync(join(dir, "user", ".claude.json"))).toBe(false);
    // A state file nothing serves: the ask for a door starts nothing, and the ask to start brings one up first.
    const none = join(dir, "none", "state.json");
    const starts: string[] = [];
    const starter: HostStarter = async path => {
      starts.push(path);
      throw new Error("this stand-in starts nothing");
    };
    expect((await asked(["mcp", "--state", none], "door", starter)).lines).toEqual([]);
    expect(starts).toEqual([]);
    const failed = await asked(["mcp", "--state", none], "start", starter);
    expect([failed.lines, failed.errors]).toEqual([[], ["this stand-in starts nothing"]]);
    expect(starts).toEqual([none]);
  });

  it("the tool server answers through the forwarder in the same bytes as on stdio, in a process that serves nothing itself", async () => {
    expect(existsSync(BIN), `${BIN} is missing: run pnpm build first`).toBe(true);
    // The wsp the forwarder runs, writing down every time it ran and what it was asked.
    const log = join(dir, "ran.log");
    const wrapper = join(dir, "wsp.sh");
    writeFileSync(wrapper, `#!/bin/sh\necho "\${${FORWARD_ENV}:-run} $*" >> ${shellQuote(log)}\nexec ${shellQuote(process.execPath)} ${shellQuote(BIN)} "$@"\n`, { mode: 0o755 });
    const lines = [
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "threads", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pause", arguments: { workspace: "nope" } } },
    ];
    const line = ["mcp", "--state", statePath];
    const stdio = await served([process.execPath, BIN, ...line], ownEnv(), lines);
    const forwarded = await served([...forwarder([wrapper]), "--", ...line], ownEnv(), lines);
    expect(stdio.out).toHaveLength(4);
    expect(forwarded.out).toEqual(stdio.out);
    expect([forwarded.code, stdio.code]).toEqual([0, 0]);
    // Asked once, and never run to serve: the host served the session.
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([`door ${line.join(" ")}`]);
  });

  it.each(["the command line", "the forwarder"] as const)("%s, built, carries the code out of the process: stdout empty, one JSON line on stderr, exit 3 on a usage refusal and 1 on a host that does not answer", async road => {
    expect(existsSync(BIN), `${BIN} is missing: run pnpm build first`).toBe(true);
    const exec = promisify(execFile);
    const [command, ...lead] = road === "the command line" ? [process.execPath, BIN] : [...forwarder([process.execPath, BIN]), "--"];
    const outcome = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const { stdout, stderr } = await exec(command!, [...lead, ...args]);
        return { code: 0, stdout, stderr };
      } catch (e) {
        const failed = e as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
    };
    const usage = await outcome(["threads", "--nope", "--json", "--state", join(dir, "none.json")]);
    expect(usage.code).toBe(3);
    expect(usage.stdout).toBe("");
    expect(VerbFailure.parse(JSON.parse(usage.stderr))).toMatchObject({ class: "usage", exit: 3 });
    // A host on another computer, which no line on this one starts: the road carries nothing and the failure is
    // the provider's. A state file nothing serves is no longer a failure at all, since the verb starts a host.
    writeHost(join(dir, "home"), "nowhere", { url: "http://127.0.0.1:1", deviceToken: "tok", deviceId: "d1", hostKey: HOST_KEY, pairedAt: new Date().toISOString(), via: { kind: "account", hostId: "hnowhere" } });
    const noHost = await outcome(["threads", "--json", "--host", "nowhere"]);
    expect(noHost.code).toBe(1);
    expect(noHost.stdout).toBe("");
    expect(VerbFailure.parse(JSON.parse(noHost.stderr))).toMatchObject({ class: "provider", exit: 1 });
    expect(VerbFailure.parse(JSON.parse(noHost.stderr)).error).toContain("127.0.0.1:1");
    const ok = await outcome(["--version"]);
    expect(ok.code).toBe(0);
  });
});
