// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { type fakeCopier, NapRefusedError, NoProviderBackend, passphraseCipher, type MachineBackend } from "@wsp/engine";
import { type ProjectView, type DaemonErrorCode, noProjectImageLine, projectImageInUseRefusal, projectImageRemoveNotice, projectImageRemovedLine, DAEMON_TOKEN_PATH, noHostCliLine, napRefusedLine, copyPathFor, madeOfWord, portsWord, HERE_PLACE_ID, LIST_PRICE_WORD, goneRoadRefusal, notAnsweringYet, runForTheList, askingLine, needsYouLine, QUESTION_TOOL, permissionModeOptionLabel, PERMISSION_DENY, type PermissionAsk, DEFAULT_PREFERENCES, PERMISSION_ALLOW, effortsFor, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, noWorkspaceRefusal, EMPTY_TASK_LINE, EXIT_CODES, IMAGE_NO_VAULT, IMAGE_PASSPHRASE_ENV, IMAGE_PASSPHRASE_MIN, HOST_STOPPING_LINE, IMAGE_ALREADY_NEWEST, IMAGE_MOVE_CONFIRM, imageKeptLine, markedDefault, NO_SUCH_TURN, noReplyLine, noThreadTargetLine, notifyLine, noWorkspaceForFolderLine, fmtSize, kindWords, RuntimeRequest, threadStateWord, whereWord, workspaceStateOf, workspaceWord, type WorkspaceListing, placeBuildsNoImageLine, registeredLine, REGISTERING_LINE, registerTakesNoConsentLine, signInRefusalLine, threadForgetRefusal, threadOpenedLine, threadWithoutIdRefusal, ThreadView, TURN_TOKEN_ENV, unknownAgentLine, workspaceAsleepAgainLine, workspaceKind, thisComputer, copyTakesNone, type WorkspaceOut, WorkspaceView, forgetUndrivenRefusal, THIS_COMPUTER, noSuchPlaceRefusal, type PlaceView, localRunsOneFix, localRunsOneLine, placeForksNothingPickLine, MEMORY_KEPT_CLAUSE, projectRemovedOnComputerLine, type HarnessCatalogAnswer } from "@wsp/protocol";
import { copyKey, createRuntime, DAEMON_TOKEN_SET, harnessCatalog, memoryStore, type DaemonChannel, type HarnessAdapterFactory, type PlaceBackends, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { HELP, agentPage, cli, commandPage, COMMANDS_FOR_HELP, localWiring, localWorkFolder, serve } from "../src/cli.js";
import { hostKeyHere, placeWiring } from "../src/places.js";
import { hostTokenPath, lockPathFor } from "../src/host-lock.js";
import type { HostHandle } from "../src/server.js";
import { awake, BUILT_IN_LIST_CLAUSE, BUILT_IN_TABLE_CLAUSE, CLI_VERBS, hasTool, VERBS, runVerb, PLAN_ONLY, ANSWER_IN_THE_APP, answerKeysLine, answerVerbsLine, answeredLine, noSuchAnswerLine, deleteQuestion, deletedLine, dialHost, firstEnded, messageTo, napAfterDeadLaunch, noHostServingLine, noOpenAskLine, threadRows, threadTree, threadsOf, workspaceLine, type HostClient } from "../src/verbs.js";
import { HOST_SIDE_VAULT, hostPlatform, THREAD_PREFIX_WORD } from "../src/verbs.js";
import { hostSideOnlyFix, hostSideOnlyLine } from "../src/hosts.js";
import type { WatchSignals } from "../src/watch.js";
import { writeHost } from "../src/hosts.js";
import { withRefused } from "../../runtime/test/fs-refusal.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { guestAnswer, stubBackend, type StubBackend } from "./stub-backend.js";
import { copyingFake, createOn, fakeDaemonStart, projectOn, CUT_LINE, EXPORT_SESSION, EXPORT_SOURCE, PAGE, UNREACHED_LINE, bornDeadAgent, captured, doneOnlyAgent, execGuest, exportGuest, heldAgent, launchedScript, launchedScripts, projectBundler, sayingAgent, scriptedAgent, stuckAgent, toolingAgent, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

/** A daemon inside a workspace that answers the two frames a bring back sends, so the verb's own line is read here
 * without a machine: the push, then the pull request or the sentence that says none was opened. */
function fakeGitDaemon(): { open: () => Promise<DaemonChannel>; pr: { refuse?: { error: string; code?: DaemonErrorCode } } } {
  const state: { refuse?: { error: string; code?: DaemonErrorCode } } = {};
  return {
    pr: state,
    open: async () => ({
      send: async (frame: { op: string }) => {
        if (frame.op === "git.push") {
          return { id: 1, ok: true, branch: "pricing-page", base: "main", remote: "origin", ahead: 2, uncommitted: 1, stat: [" src/page.tsx | 4 ++--", " 1 file changed, 2 insertions(+), 2 deletions(-)"] };
        }
        if (state.refuse !== undefined) return { id: 1, ok: false as const, ...state.refuse };
        return { id: 1, ok: true, pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "open", host: "github.com" }, created: true };
      },
      close: () => {},
      // Nothing here ends of its own: the runtime closes the channel when the verb it opened it for is done.
      closed: new Promise(() => {}),
    }),
  };
}

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

/** This computer, as the places list names it: the word a person types after --on for the place their own agents
 * run on, which is the road wsp new --local used to take. */
const HERE = hostname().toLowerCase();

/** The fingerprint a pairing pinned, which every record written since wsp pinned keys carries. */
const HOST_KEY = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";

/** What the codex here asks its machine; the stub guest answers nothing to it unless a test puts a catalog there. */
const PROBE_CMD = "codex --describe";

/** An agent whose binary can be made to answer: its probe reads the machine's stdout as the answer itself, so a test
 * can put a machine's own catalog in front of the verbs. Nothing on the guest answers by default, which leaves the
 * runtime's table standing, exactly as an adapter with no probe at all does. */
const probing =
  (factory: HarnessAdapterFactory): HarnessAdapterFactory =>
  ctx => ({ ...factory(ctx), probeCatalog: exec => exec(PROBE_CMD).then(out => (out.trim() === "" ? null : (JSON.parse(out) as HarnessCatalogAnswer))) });

describe("wsp verbs over the host", () => {
  let dir: string;
  let statePath: string;
  let backend: StubBackend;
  let store: Store;
  /** The copy road this host is wired with: a stand-in, so a second piece of work on a project here is a copy the
   * case can read back and nothing on this machine is actually cloned. */
  let copier: ReturnType<typeof fakeCopier>;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let claude: ReturnType<typeof scriptedAgent>;
  let codex: ReturnType<typeof scriptedAgent>;
  /** The environment every verb here runs with: this file's, never the shell that started the run, so a builder with
   * WSP_TURN exported does not have every start refused. A case that means a turn writes that turn's token into it. */
  let env: Record<string, string | undefined>;
  let daemon: ReturnType<typeof fakeGitDaemon>;

  beforeEach(async () => {
    asked.length = 0;
    env = {};
    dir = mkdtempSync(join(tmpdir(), "wsp-verbs-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    backend = stubBackend();
    store = memoryStore();
    copier = copyingFake();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    claude = scriptedAgent(prompt => (prompt === "die" ? "" : `re: ${prompt}`));
    codex = scriptedAgent(prompt => `codex: ${prompt}`);
    daemon = fakeGitDaemon();
    rt = createRuntime({ backend, store, adapters: { claude: claude.adapter, codex: probing(codex.adapter) }, local: localWiring(join(dir, "user"), process.env, fakeDaemonStart, undefined, copier), placeLinks: placeWiring(statePath), daemonChannel: daemon.open });
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    // A workspace is one project's copy, so every line that makes one needs a project first; one project here, so
    // wsp new takes the work alone.
    cloud = await projectOn(rt);
    // The host has its keys; the verbs never read any.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A verb still in flight: its io is readable while it runs, so a test can wait on a line it has already printed.
   * --state goes before any `--`, where exec's command begins. */
  function starting(...argv: string[]): { io: Captured; ended: Promise<number> } {
    const io = captured();
    const cut = argv.indexOf("--");
    const at = cut === -1 ? argv.length : cut;
    return { io, ended: cli([...argv.slice(0, at), "--state", statePath, ...argv.slice(at)], io, undefined, env) };
  }
  async function run(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const { io, ended } = starting(...argv);
    return { code: await ended, io };
  }
  /** The project on the computer this host forks at, recorded for every case: one project, so wsp new takes the
   * work alone until a case records a second. */
  let cloud: ProjectView;

  /** A project on this computer and its workspace: a workspace here is a copy of a folder of the person's, so a
   * test that wants one records a repo of its own first. */
  async function macProject(name: string): Promise<{ code: number; io: Captured; folder: string }> {
    const folder = realpathSync(mkdtempSync(join(dir, `repo-${name}-`)));
    execFileSync("git", ["init", "-q", folder]);
    const project = await projectOn(rt, HERE_PLACE_ID, folder);
    return { ...(await run("new", project.name, name)), folder };
  }

  /** A line exactly as it was typed, with nothing moved or added: where a shared flag sits is the question here, so
   * the helpers that put --state at the end are no use. */
  async function typed(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli(argv, io, undefined, env), io };
  }
  const json = (io: Captured): unknown[] => io.lines.map(l => JSON.parse(l) as unknown);
  /** The workspace column of the table wsp workspaces prints, which is the list a person reads names off. */
  const names = (listed: { io: Captured }): string[] => listed.io.lines[0]!.split("\n").slice(1).map(row => row.split(/\s+/)[0]!);
  /** A verb run with a person at the keyboard: every question it asks is recorded and answered with reply. */
  const asked: string[] = [];
  async function answer(reply: string, ...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    io.isTTY = true;
    io.ask = async q => {
      asked.push(q);
      return reply;
    };
    return { code: await cli([...argv, "--state", statePath], io, undefined, env), io };
  }
  const head = (m: typeof SEALED_GOLDEN) => m.versions.find(v => v.version === m.head)!;
  /** An image record with a vault of `bytes`, for the export roads; the hashes are plainly fake. */
  const RECORD = (bytes: number) => ({ name: "default", version: 1, hash: "a".repeat(64), recipeHash: "rh", logins: [{ name: "codex", state: "copied" as const }], sealedAt: "2026-09-12T00:00:00.000Z", sealedFrom: "h1", vault: { sha256: "b".repeat(64), bytes, paths: 2, takenAt: "2026-09-12T00:00:00.000Z" } });

  /** The host again on the same state file, over a runtime with these adapters; the verbs still see no key. */
  async function restartHost(adapters: Parameters<typeof createRuntime>[0]["adapters"], over: Store = store, places?: PlaceBackends, wired: MachineBackend = backend): Promise<void> {
    await handle?.close();
    handle = undefined;
    rt = createRuntime({ backend: wired, store: over, adapters, local: localWiring(join(dir, "user"), process.env, fakeDaemonStart, undefined, copier), placeLinks: placeWiring(statePath), ...(places !== undefined ? { places } : {}) });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
    // A restart on a fresh store holds no project, and a workspace is one project's copy; one that kept the store
    // keeps the project it already had, since a second would make every wsp new ambiguous.
    const held = await rt.projects.list();
    cloud = held[0] ?? (await projectOn(rt));
  }

  it("new forks the golden's head into a workspace of that name, streams the create's stages and prints the id", async () => {
    const { code, io } = await run("new", "alpha");
    expect(code).toBe(0);
    const [ws] = await rt.workspaces.list();
    expect(ws).toMatchObject({ name: "alpha", golden: head(SEALED_GOLDEN).snapshotId, phase: "running" });
    expect(io.lines).toEqual([`created alpha ${ws!.id}, a copy of ${ws!.project.name} at ${ws!.project.path}`]);
    expect(io.streamed).toContain("\n");
    expect(io.errors).toEqual([]);

    const again = await run("new", "beta", "--json");
    expect(again.code).toBe(0);
    const values = json(again.io) as { type?: string; name?: string; workspace?: unknown }[];
    expect(values.length).toBeGreaterThan(1);
    expect(values.slice(0, -1).every(v => v.type === "workspace.creating" && v.name === "beta")).toBe(true);
    expect(values.at(-1)).toEqual({ workspace: expect.objectContaining({ name: "beta" }) });
    expect(again.io.streamed).toBe("");
  });

  it("new and fork take --size as <cpu>x<memGb>, which reaches the create's size; a size the provider does not offer, or no size at all, is refused in one line naming the list, and nothing is minted", async () => {
    const big = await run("new", "big", "--size", "2x8");
    expect(big.code).toBe(0);
    expect(backend.machines.at(-1)!.spec).toMatchObject({ cpu: 2, memMb: 8192 });
    const [status] = await rt.status.list();
    expect(status).toMatchObject({ name: "big", size: { cpu: 2, memMb: 8192 } });

    const forked = await run("fork", "big", "--name", "wide", "--size", "4x8");
    expect(forked.code).toBe(0);
    expect(backend.machines.at(-1)!.spec).toMatchObject({ cpu: 4, memMb: 8192 });
    expect((await rt.status.list()).find(w => w.name === "wide")!.size).toEqual({ cpu: 4, memMb: 8192 });

    const list = "the sizes are 2x4 ($0.11/hr), 2x8 ($0.15/hr), 4x8 ($0.22/hr)";
    const odd = await run("new", "odd", "--size", "8x16");
    expect(odd.code).toBe(3);
    expect(odd.io.errors).toEqual([`wsp new: 8x16 is not a size this provider offers; ${list}. Name one of those with --size.`]);
    const word = await run("fork", "big", "--size", "large");
    expect(word.code).toBe(3);
    expect(word.io.errors).toEqual([`wsp fork: large is not a size this provider offers; ${list}. Name one of those with --size.`]);
    expect(backend.machines).toHaveLength(2);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["big", "wide"]);

    // Without --size the golden's own size stands.
    await run("new", "plain");
    expect(backend.machines.at(-1)!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
  });

  it("new --engine reaches the create's spec, and a recipe that asks for the engine gives every fork one without the flag", async () => {
    await run("new", "plain");
    expect(backend.machines.at(-1)!.spec.engine).toBeUndefined();
    const asked = await run("new", "eng", "--engine");
    expect(asked.code).toBe(0);
    expect(backend.machines.at(-1)!.spec).toMatchObject({ engine: true });
    // The sealed image's small recipe asks for the engine: a fork made without the flag gets one too.
    await store.put("images", "default", { ...RECORD(3), recipe: { version: 1, at: "2026-09-12T00:00:00.000Z", histories: [], rows: [], engine: true } });
    const viaRecipe = await run("new", "viarecipe");
    expect(viaRecipe.code).toBe(0);
    expect(backend.machines.at(-1)!.spec).toMatchObject({ engine: true });
    await store.delete("images", "default");
    await run("new", "afterwards");
    expect(backend.machines.at(-1)!.spec.engine).toBeUndefined();
  });

  it("a fork the provider refuses at the machine cap is one line naming the workspaces holding the slots, never the provider's sentence", async () => {
    await run("new", "first");
    await run("new", "t-cap");
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    const refused = await run("fork", "first", "--name", "f2");
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual(["wsp fork: both machine slots are in use: first, t-cap. Pause one or wait for a nap."]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["first", "t-cap"]);
  });

  it("takes the workspace first on run and threads, and names the swap when the two words are the other way round", async () => {
    await run("new", "alpha");
    const opened = await run("run", "alpha", "hello");
    expect(opened.code).toBe(0);
    expect(opened.io.lines.at(-1)).toBe("re: hello");
    // The second word is a workspace and the first is not, so the line is named rather than run.
    const swapped = await run("run", "fix the tests", "alpha");
    expect(swapped.code).toBe(EXIT_CODES.usage);
    expect(swapped.io.errors[0]).toBe('wsp run takes the workspace first; "fix the tests" reads as one and alpha as the task. Run wsp run alpha "fix the tests".');
    // The workspace is the first word on threads too.
    const listed = await run("threads", "alpha");
    expect(listed.code).toBe(0);
    expect(listed.io.lines[0]!.split("\n").slice(1).every(r => r.includes("alpha"))).toBe(true);
  });

  it("a project on the computer the app runs on gets a copy of its folder for every piece of work, the first included, and the created line names the copy", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-here-")));
    execFileSync("git", ["init", "-q", folder]);
    const project = await projectOn(rt, HERE_PLACE_ID, folder);
    const { code, io } = await run("new", project.name, "mac");
    expect(code, io.errors.join("\n")).toBe(0);
    expect(io.lines[0]).toBe(`created mac ${(await rt.workspaces.list()).find(w => w.name === "mac")!.id}, a copy of ${project.name} at ${copyPathFor(folder, "mac")}`);
    expect((await rt.workspaces.list()).map(w => [w.name, w.kind, w.machineId])).toEqual([["mac", "local", "local"]]);
    expect(copier.asks.map(a => a.to)).toEqual([copyPathFor(folder, "mac")]);
    // The second piece of work on that project is a second copy at its own sibling path.
    const again = await run("new", project.name, "other");
    expect(again.code, again.io.errors.join("\n")).toBe(0);
    expect(copier.asks.map(a => a.to)).toEqual([copyPathFor(folder, "mac"), copyPathFor(folder, "other")]);
    expect((await rt.workspaces.list()).find(w => w.name === "other")!.copy?.road).toBe("clonefile");
    // A word that names no project is refused with the ones there are.
    const nowhere = await run("new", "srv", "x");
    expect(nowhere.code).not.toBe(0);
    expect(nowhere.io.errors[0]).toContain('no project "srv"');
    rmSync(folder, { recursive: true, force: true });
  });

  it("this computer's row carries Running while its daemon answers and the reach word when it does not, as every other row does", () => {
    const here = { id: "ws_1", name: "mac", machineId: "local", phase: "running" as const, kind: "local" as const, golden: "", createdAt: "2026-09-12T00:00:00.000Z", machineState: "running" as const, size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, project: { id: "pr_1", name: "wsp", path: "/Users/dev/wsp", computer: "here" } };
    expect(workspaceLine({ ...here, reach: { state: "reachable" } })[7]).toBe("Running");
    expect(workspaceLine({ ...here, reach: { state: "no-daemon" } })[7]).toBe("Unreachable");
    expect(workspaceLine({ ...here, reach: { state: "unreachable" } })[7]).toBe("Unreachable");
  });

  it("a row's copy and ports cells read the one word table the app's own row reads", () => {
    const shape = { id: "ws_1", name: "qr codes", machineId: "local", phase: "running" as const, kind: "local" as const, golden: "", createdAt: "2026-09-17T00:00:00.000Z", machineState: "running" as const, size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, reach: { state: "reachable" as const }, project: { id: "pr_1", name: "wsp", path: "/Users/dev/wsp", computer: "here" } };
    const shares = { copies: true, ownNetwork: false };
    const cloned = { ...shape, portBase: 3100, copy: { road: "clonefile" as const, path: "/Users/dev/wsp-qr-codes", source: "/Users/dev/wsp", base: "abc", branch: "main", carried: "deps-and-config" as const } };
    expect(workspaceLine(cloned, new Map(), shares).slice(4, 6)).toEqual([madeOfWord("clonefile"), portsWord(shares, 3100, hostPlatform())]);
    expect(workspaceLine({ ...cloned, copy: { ...cloned.copy, road: "worktree" } }, new Map(), shares)[4]).toBe(madeOfWord("worktree"));
    // A copy whose record carries no port base says the ports alone.
    const { portBase: _none, ...noBase } = cloned;
    expect(workspaceLine(noBase, new Map(), shares).slice(4, 6)).toEqual([madeOfWord("clonefile"), portsWord(shares, undefined, hostPlatform())]);
    // A computer whose copies each get a network of their own says that instead.
    expect(workspaceLine(cloned, new Map(), { copies: true, ownNetwork: true }).slice(4, 6)).toEqual([madeOfWord("clonefile"), "own network"]);
    // A fork has no copy of a folder on this computer, so both cells are empty.
    expect(workspaceLine(shape, new Map(), shares).slice(4, 6)).toEqual(["", ""]);
  });

  it("workspaces gives every row one state word, where it runs in the person's words and its shape apart from it, and the machine id only in the json", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-mac-")));
    execFileSync("git", ["init", "-q", folder]);
    await run("new", cloud.name, "alpha");
    const here = await projectOn(rt, HERE_PLACE_ID, folder);
    await run("new", here.name, "mac");
    const listed = await run("workspaces");
    expect(listed.code).toBe(0);
    const [heading, ...rows] = listed.io.lines[0]!.split("\n");
    expect(heading!.split(/ {2,}/)).toEqual(["WORKSPACE", "ID", "PROJECT", "COMPUTER", "COPY", "PORTS", "SIZE", "STATE", "AGENTS"]);
    // One kind of thing per column: the project it holds, the computer it runs on, what its copy of that project
    // is and what that copy shares, the shape, then one state word per row, this computer's included. A fork
    // carries no copy of a folder on this computer, so its two copy cells are empty and the split drops them. The
    // id the provider minted for the machine is on no row.
    const cells = (row: string): string[] => row.split(/ {2,}/);
    expect(rows.map(cells)).toEqual([
      ["alpha", expect.stringMatching(/^ws_/), expect.stringMatching(/^\S+$/), expect.stringMatching(/^\S+$/), expect.stringMatching(/^\d+ vCPU, \d+ GB$/), expect.stringMatching(/^\S+$/)],
      [
        "mac",
        expect.stringMatching(/^ws_/),
        here.name,
        expect.stringMatching(/^this (?:Mac|computer)$/),
        madeOfWord("clonefile"),
        expect.stringMatching(/^shares this (?:Mac|computer)'s ports, PORT \d+$/),
        expect.stringMatching(/^\d+ cores, \d+ GB$/),
        expect.stringMatching(/^\S+$/),
      ],
    ]);
    expect(listed.io.errors).toEqual([]);
    rmSync(folder, { recursive: true, force: true });

    const raw = await run("workspaces", "--json");
    const rawRows = (json(raw.io)[0] as { workspaces: WorkspaceListing[] }).workspaces;
    expect(listed.io.lines[0]).not.toContain(rawRows[0]!.machineId);
    expect(cells(rows[0]!)[3]).toBe(whereWord(rawRows[0]!));
    expect(cells(rows[1]!)[3]).toBe(whereWord(rawRows[1]!));
    expect(cells(rows[1]!)[6]).toBe(fmtSize(rawRows[1]!.size, kindWords("local").cpu));
    // Which word each row carries is the one predicate's, read off that row's own status: what this computer's
    // daemon is doing on the machine this test runs on decides the word, and never whether there is a word. The
    // state is a row's last cell either way, since nothing here has turned its agents on.
    expect(rows.map(r => cells(r).at(-1))).toEqual(rawRows.map(w => workspaceWord(workspaceStateOf(w, w))));
    expect(rawRows.map(w => [w.name, workspaceKind(w), w.golden])).toEqual([
      ["alpha", "cloud", head(SEALED_GOLDEN).snapshotId],
      ["mac", "local", ""],
    ]);

    const opened = await run("run", "mac", "say pong");
    expect(opened.code).toBe(0);
    expect(opened.io.errors).toEqual([]);
    const threads = await threadRows(await dialHost(statePath));
    expect(threads.map(t => [t.workspaceName, t.harness, t.startedBy])).toEqual([["mac", "claude", "cli"]]);
    expect(opened.io.lines).toEqual([expect.stringMatching(/^thread /), "re: say pong"]);
  });

  it("workspaces --watch and threads --watch redraw the same table where it stands until Ctrl-C, on one socket", async () => {
    await run("new", "alpha");
    for (const word of ["workspaces", "threads"] as const) {
      const frames: string[] = [];
      const io: Captured = { ...captured(), redraw: { write: text => void frames.push(text), columns: () => 100 } };
      // Ctrl-C, without a real signal: one would take the test runner with it.
      const held = new Set<() => void>();
      const signals: WatchSignals = {
        on: (_s, l) => {
          held.add(l);
          return undefined;
        },
        off: (_s, l) => held.delete(l),
      };
      // Every socket this line opens to the host, counted: a watch that dialled per frame would be a number here.
      let dials = 0;
      const dial: typeof dialHost = (path, opts) => {
        dials++;
        return dialHost(path, opts);
      };
      const verb = CLI_VERBS.find(v => v.name === word)!;
      const watching = runVerb(verb, [word, "--watch", "--state", statePath], io, () => statePath, { cwd: dir, env, signals, dial });
      // Past the one second tick, so what is waited for is a second frame and not the first one twice over.
      await vi.waitFor(() => expect(frames.filter(f => f.includes("\n")).length).toBeGreaterThan(1), { timeout: 5_000 });
      for (const stop of [...held]) stop();
      expect(await watching, word).toBe(0);
      // The cursor comes off the screen for the frames and is back on the last write.
      expect(frames[0], word).toBe("\x1b[?25l");
      expect(frames.at(-1), word).toBe("\x1b[?25h");
      const drawn = frames.slice(1, -1);
      expect(drawn.length, word).toBeGreaterThan(1);
      expect(drawn[0], word).toContain(word === "workspaces" ? "WORKSPACE" : "THREAD");
      // The first frame has nothing above it; every frame after it rewinds the rows it drew, so the table never
      // walks down the screen.
      expect(drawn[0]!.startsWith("\x1b["), word).toBe(false);
      for (const frame of drawn.slice(1)) {
        expect(frame, word).toMatch(/^\x1b\[\d+A\x1b\[G\x1b\[J/);
        expect(frame, word).toContain(word === "workspaces" ? "WORKSPACE" : "THREAD");
      }
      // One socket for every frame of it, which is the whole of why the flag is worth having.
      expect(dials, word).toBe(1);
      // Nothing went to stdout as lines: a watched list is frames, and only frames.
      expect(io.lines, word).toEqual([]);
    }
  });

  it("--watch is refused off a terminal and beside --json, each in two halves, and nothing is drawn", async () => {
    await run("new", "alpha");
    const noTerminal = await run("workspaces", "--watch");
    expect(noTerminal.code).toBe(EXIT_CODES.usage);
    expect(noTerminal.io.errors).toEqual(["wsp workspaces --watch redraws where it stands, and this run has no terminal to redraw on. Run wsp workspaces without --watch to print the list once."]);
    expect(noTerminal.io.lines).toEqual([]);

    const io: Captured = { ...captured(), redraw: { write: () => {}, columns: () => 100 } };
    const asJson = await cli(["threads", "--watch", "--json", "--state", statePath], io, undefined, env);
    expect(asJson).toBe(EXIT_CODES.usage);
    expect(io.errors.map(l => (JSON.parse(l) as { error: string }).error)).toEqual(["wsp threads --watch redraws a table and --json answers with objects. Take one of the two: wsp threads --watch at a terminal, or wsp threads --json for the objects."]);
  });

  it("the STATE cell reads the machine and the daemon beside the phase: a machine the provider paused says Paused and one whose daemon has gone dark says Unreachable, both while the record still reads running", async () => {
    await run("new", "napped");
    await run("new", "dark");
    // Every cloud machine has an edge route, and a prompt 502 on it is the edge dialling the guest and finding
    // nothing on the daemon's port.
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      const port = (edge.address() as AddressInfo).port;
      const route = async (): Promise<{ url: string; token: string; expiresAt: number }> => ({ url: `http://127.0.0.1:${port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const [napped, dark] = backend.machines;
      napped!.previewUrl = route;
      dark!.previewUrl = route;
      // A pause the provider made, not one wsp asked for: nothing wrote the record, so its phase still reads running.
      napped!.paused = true;

      const listed = await run("workspaces");
      expect(listed.code).toBe(0);
      expect((await rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([
        ["napped", "running"],
        ["dark", "running"],
      ]);
      const [, ...rows] = listed.io.lines[0]!.split("\n");
      expect(rows.map(r => r.split(/ {2,}/).slice(0, 2).concat(r.split(/ {2,}/)[5]!))).toEqual([
        // The provider this host forks on keeps a paused machine's memory, so its nap reads paused here as it
        // does on the app's row, off the pause mode the landing carries for that project.
        ["napped", expect.stringMatching(/^ws_/), "Paused"],
        ["dark", expect.stringMatching(/^ws_/), "Unreachable"],
      ]);

      // The same two words reach an agent reading the table over the tool, off the machine state and reach the row read.
      const raw = await run("workspaces", "--json");
      const statuses = (json(raw.io)[0] as { workspaces: { name: string; machineState: string; reach: { state: string } }[] }).workspaces;
      expect(statuses.map(w => [w.name, w.machineState, w.reach.state])).toEqual([
        ["napped", "paused", "no-daemon"],
        ["dark", "running", "no-daemon"],
      ]);
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  it("neither door hands over the route the reach carries: the table and the tool answer the state alone, with no url and no provider token", async () => {
    await run("new", "alpha");
    const edge = createHttpServer((_req, res) => {
      res.writeHead(426).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      const port = (edge.address() as AddressInfo).port;
      // What the provider mints: the route with its own bearer in the query and an hour on it.
      backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${port}/?pt_token=stub-bearer`, token: "stub-bearer", expiresAt: Date.now() + 3_600_000 });

      const raw = await run("workspaces", "--json");
      expect(raw.code).toBe(0);
      const [line] = raw.io.lines;
      expect(line).not.toContain("pt_token");
      expect(line).not.toContain("stub-bearer");
      const rows = (JSON.parse(line!) as { workspaces: { name: string; machineState: string; reach: Record<string, unknown> }[] }).workspaces;
      // The state the row turns on is there; the route it was read over is not.
      expect(rows.map(w => [w.name, w.machineState, w.reach])).toEqual([["alpha", "running", { state: "reachable" }]]);

      const listed = await run("workspaces");
      expect(listed.io.lines[0]).not.toContain("pt_token");
      expect(listed.io.lines[0]!.split("\n")[1]!.split(/ {2,}/)[5]).toBe("Running");
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  it("new without --on is gated on the place the fork lands on, not on the provider this host forks on: a host whose own provider forks nothing names the place that does", async () => {
    const none = new NoProviderBackend();
    const elsewhere = stubBackend();
    await restartHost({}, memoryStore(), { wired: "none", backend: p => (p === "none" ? none : p === "elsewhere" ? elsewhere : undefined), list: () => ["none", "elsewhere"] }, none);
    // The project stands on the provider this host forks on, which forks nothing, while another provider does.
    await rt.projects.remove(cloud.id);
    cloud = await projectOn(rt, "none");
    const bare = await run("new", "alpha");
    expect(bare.code).toBe(1);
    expect(bare.io.errors).toEqual([`wsp new: ${placeForksNothingPickLine("none", ["elsewhere"])}`]);
    expect([bare.io.lines, bare.io.streamed]).toEqual([[], ""]);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("new refuses in one line when there is no golden", async () => {
    await restartHost({}, memoryStore());
    const { code, io } = await run("new", "alpha");
    expect(code).toBe(1);
    expect(io.errors).toEqual(["wsp new: no image yet; run wsp init"]);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("fork makes a sibling from the source's own golden version, by name or id, and --send opens its first thread", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const plain = await run("fork", "alpha");
    expect(plain.code).toBe(0);
    const forks = (await rt.workspaces.list()).filter(w => w.id !== alpha!.id);
    expect(forks.map(w => [w.name, w.golden])).toEqual([["alpha-fork", alpha!.golden]]);
    // A fork is a child of the workspace it was forked from: the record says so, and a bring back from it reads
    // that parent's own branch as the base its work lands in.
    expect(forks[0]!.parentWorkspaceId).toBe(alpha!.id);
    expect(plain.io.lines).toEqual([`created alpha-fork ${forks[0]!.id}, a copy of ${forks[0]!.project.name} at ${forks[0]!.project.path}`]);

    const sent = await run("fork", alpha!.id, "--name", "worker", "--send", "build it");
    expect(sent.code).toBe(0);
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    const [thread] = await rt.sessions.list(worker.id);
    expect(thread).toMatchObject({ harness: "claude", startedBy: "cli", prompt: "build it", status: "completed" });
    expect(sent.io.lines).toEqual([`created worker ${worker.id}, a copy of ${worker.project.name} at ${worker.project.path}`, `thread ${thread!.threadId} · ${THREAD_PREFIX_WORD}`, "re: build it"]);
    expect(sent.io.streamed.endsWith("ready\nre: \n$ ls\nbuild it\ncompleted\n")).toBe(true);
  });

  it("bring back prints where the branch went, the diffstat under it and the pull request, and the note when a machine has no command line for the host", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    backend.machines.at(-1)!.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
    // The guest carries this host's daemon token, which is what the channel the bring back opens is authed with.
    backend.execImpl = (_m, cmd) => (cmd.includes(DAEMON_TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : guestAnswer(cmd));
    const brought = await run("bring", "back", "alpha");
    expect(brought.io.errors.join("|")).toBe("");
    expect(brought.code).toBe(0);
    expect(brought.io.lines.join("\n").split("\n")).toEqual([
      `${alpha!.name}: pricing-page pushed, 2 commits over main`,
      " src/page.tsx | 4 ++--",
      " 1 file changed, 2 insertions(+), 2 deletions(-)",
      "https://github.com/o/r/pull/12 (open)",
      "1 change left in the workspace; nothing uncommitted travels",
    ]);
    // The push landed either way, so a machine with no gh on it reads as a branch and a sentence, not a failure.
    daemon.pr.refuse = { error: noHostCliLine("github.com"), code: "no-host-cli" };
    const noCli = await run("bring", "back", "alpha");
    expect(noCli.code).toBe(0);
    expect(noCli.io.lines.join("\n").split("\n").at(-2)).toBe(noHostCliLine("github.com"));
    // Any other refusal of the pull request half prints under the same push lines and is what the verb exits on:
    // the branch is on the remote, and a person reading this has both halves.
    daemon.pr.refuse = { error: "gh said: could not create pull request" };
    const refused = await run("bring", "back", "alpha");
    expect(refused.code).toBe(1);
    expect(refused.io.lines.join("\n").split("\n")).toEqual([
      `${alpha!.name}: pricing-page pushed, 2 commits over main`,
      " src/page.tsx | 4 ++--",
      " 1 file changed, 2 insertions(+), 2 deletions(-)",
      "gh said: could not create pull request",
      "1 change left in the workspace; nothing uncommitted travels",
    ]);
    expect(refused.io.errors.join("|")).toBe("");
    // And a refusal of the push itself is the verb's refusal, in the daemon's own words.
    daemon.pr.refuse = undefined;
  });

  it("run --title names the thread from the first second, in the agent's own launch and in the table", async () => {
    await run("new", "alpha");
    const opened = await run("run", "alpha", "--title", "Ticket 411 review", "build it");
    expect(opened.code).toBe(0);
    expect(claude.starts.at(-1)?.title).toBe("Ticket 411 review");
    const [row] = await rt.sessions.list();
    expect(row).toMatchObject({ harnessTitle: "Ticket 411 review", titleSource: "person" });
    const listed = await run("threads");
    expect(listed.io.lines.join("\n")).toContain("Ticket 411 review");
  });

  it("fork, run, exec and wake refuse a workspace whose machine is gone, quoting the provider, with no waking line", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    await handle!.close();
    handle = undefined;
    backend.machines[0]!.killed = true; // deleted at the provider while no host ran
    await restartHost({ claude: claude.adapter });
    const words = (await rt.workspaces.get(alpha!.id)).gone!;
    expect(words).toMatch(new RegExp(`^machine ${alpha!.machineId} is gone at the provider: the record load found it gone at \\S+Z \\(404 gone\\)$`));
    const forked = await run("fork", "alpha");
    expect(forked.code).toBe(1);
    expect(forked.io.errors).toEqual([`wsp fork: Workspace machine is gone; rebuild it to fork (${words})`]);
    const opened = await run("run", "alpha", "do it");
    expect(opened.code).toBe(1);
    expect(opened.io.errors).toEqual([`wsp run: Workspace machine is gone; rebuild it to send (${words})`]);
    const ran = await run("exec", "alpha", "--", "echo", "hi");
    expect(ran.code).toBe(1);
    expect(ran.io.errors).toEqual([`wsp exec: Workspace machine is gone; rebuild it to exec (${words})`]);
    // The workspace is on the listing throughout: what the machine is, is the machine's trouble to say, and no verb
    // answers for a machine by calling the workspace missing.
    expect(names(await run("workspaces"))).toEqual(["alpha"]);
    const woken = await run("wake", "alpha");
    expect(woken.code).toBe(1);
    expect(woken.io.errors).toEqual([`wsp wake: Workspace machine is gone; rebuild it to wake (${words})`]);
    expect((await rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([["alpha", "gone"]]);
  });

  it("rebuild is the road out of gone: a new machine under the same workspace, its id and state printed; a machine that answers is refused in the row's own words", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const refused = await run("rebuild", "alpha");
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp rebuild: ${goneRoadRefusal("running", "rebuild")}`]);
    expect(backend.machines).toHaveLength(1);

    await handle!.close();
    handle = undefined;
    backend.machines[0]!.killed = true; // deleted at the provider while no host ran
    await restartHost({ claude: claude.adapter });
    expect((await rt.workspaces.get(alpha!.id)).phase).toBe("gone");

    const built = await run("rebuild", "alpha");
    expect(built.code).toBe(0);
    expect(built.io.errors).toEqual([]);
    const after = await rt.workspaces.get(alpha!.id);
    expect(after).toMatchObject({ id: alpha!.id, name: "alpha", phase: "running", golden: alpha!.golden });
    expect(after.machineId).not.toBe(alpha!.machineId);
    expect(built.io.lines).toEqual([`alpha running on ${after.machineId}`]);
    // The verb every other one sends a gone workspace to now answers on it.
    const woken = await run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.lines).toEqual(["alpha running"]);

    const asJson = await run("rebuild", "alpha", "--json");
    expect(asJson.code).toBe(1);
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors.map(l => JSON.parse(l) as unknown)).toEqual([{ error: goneRoadRefusal("running", "rebuild"), class: "provider", exit: EXIT_CODES.provider }]);
    const missing = await run("rebuild", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp rebuild: no workspace nope"]);
    const extra = await run("rebuild", "alpha", "beta");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors).toEqual(["wsp rebuild takes one workspace. usage: wsp rebuild <workspace>"]);
  });

  it("rebuild refuses a workspace whose machine stopped answering in the words the row shows, not in the words for one that answers", async () => {
    await run("new", "dark");
    // Every cloud machine has an edge route, and a prompt 502 on it is the edge dialling the guest and finding
    // nothing on the daemon's port: the machine runs, the record reads running, and nothing answers on it.
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      const port = (edge.address() as AddressInfo).port;
      backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const listed = await run("workspaces");
      expect(listed.io.lines[0]!.split("\n")[1]!.split(/ {2,}/)[5]).toBe("Unreachable");

      const refused = await run("rebuild", "dark");
      expect(refused.code).toBe(1);
      expect(refused.io.errors).toEqual([`wsp rebuild: ${notAnsweringYet("rebuild")}`]);
      // The machine the provider still holds is not replaced by a refusal.
      expect(backend.machines).toHaveLength(1);
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  it("wsp image reads the record off the seeded golden's head, says no sign-ins are held, and names the copy at this host's place", async () => {
    const listed = await run("image");
    expect(listed.code).toBe(0);
    const lines = listed.io.lines.join("\n").split("\n");
    expect(lines[0]).toContain("default v1");
    expect(lines[0]).toContain(IMAGE_NO_VAULT);
    expect(lines[0]).not.toContain("sign-in held");
    expect(lines[1]).toMatch(/^default  v1/);
    const [view] = json((await run("image", "--json")).io) as [{ image: { version: number; vault?: unknown }; copies: { place: string }[] }];
    expect(view.image.version).toBe(1);
    expect(view.image.vault).toBeUndefined();
    expect(view.copies.map(c => c.place)).toEqual(["default"]);
  });

  it("wsp image lists what each row installed at the seal under the copies, by the catalog's name, with the checksum where a road recorded one and the latest mark in the road's words", async () => {
    const pins = [
      { id: "claude", tag: "2.1.3", latest: true as const, road: "script" },
      { id: "gh", tag: "v2.86.0", sha256: "b".repeat(64), road: "release" },
      { id: "wrangler", tag: "4.1.0", road: "npm" },
      { id: "tools/brew/zingzy/tap/diskbloom", tag: "0.1.0", latest: true as const, road: "brew" },
    ];
    await store.put("images", "default", { ...RECORD(3), pins });
    const listed = await run("image");
    expect(listed.code).toBe(0);
    const lines = listed.io.lines.join("\n").split("\n");
    expect(lines.slice(2)).toEqual([
      "  Claude Code  2.1.3  installs latest by its own installer",
      "  GitHub CLI  v2.86.0  checksum bbbbbbbbbbbb",
      "  Cloudflare Wrangler  4.1.0",
      "  zingzy/tap/diskbloom  0.1.0  installs latest with Homebrew",
    ]);
    const [view] = json((await run("image", "--json")).io) as [{ image: { pins: unknown } }];
    expect(view.image.pins).toEqual(pins);
  });

  it("wsp image build refuses in one line for a place this host has not got and a place that takes no copy; the place it forks on is a place like any other", async () => {
    // Three places over one host: the one it forks on, one more that could build, and this computer, which forks
    // nothing and copies no disk.
    const elsewhere = stubBackend();
    const here = new NoProviderBackend();
    await restartHost(
      {},
      store,
      { wired: "default", backend: p => (p === "default" ? backend : p === "elsewhere" ? elsewhere : p === "here" ? here : undefined), list: () => ["default", "elsewhere", "here"] },
    );

    const nowhere = await run("image", "build", "nowhere");
    expect(nowhere.code).toBe(1);
    expect(nowhere.io.errors.join("")).toContain("no place named nowhere");

    // The provider this host forks on takes a copy build too; this record was backfilled off its own golden and
    // carries no recipe, so the build stops at the record and boots nothing.
    const wired = await run("image", "build", "default");
    expect(wired.code).toBe(1);
    expect(wired.io.errors.join("")).toContain("was sealed before the image record kept the recipe");

    const cannot = await run("image", "build", "here");
    expect(cannot.code).toBe(1);
    expect(cannot.io.errors.join("")).toContain(placeBuildsNoImageLine("here"));

    // Nothing was forked at any of them, and this computer was never read for a recipe.
    expect(elsewhere.machines).toEqual([]);

    const usage = await run("image", "build");
    expect(usage.code).toBe(EXIT_CODES.usage);
    expect(usage.io.errors.join("")).toContain("wsp image build takes one place.");
  });

  it("wsp image build on a host that has sealed nothing says so, whatever place is named", async () => {
    const elsewhere = stubBackend();
    await restartHost({}, memoryStore(), {
      wired: "default",
      backend: p => (p === "default" ? backend : p === "elsewhere" ? elsewhere : undefined),
      list: () => ["default", "elsewhere"],
    });
    const none = await run("image", "build", "elsewhere");
    expect(none.code).toBe(1);
    expect(none.io.errors.join("")).toContain("this host owns no image named default yet");
    expect(elsewhere.machines).toEqual([]);
  });

  it("wsp image export refuses a record with no sign-ins to export, and says so rather than writing an empty file", async () => {
    env[IMAGE_PASSPHRASE_ENV] = "a-long-enough-passphrase";
    const dest = join(dir, "image.wsp");
    const refused = await run("image", "export", dest);
    expect(refused.code).not.toBe(0);
    expect(refused.io.errors.at(-1)).toContain("sealed before its sign-ins were held");
    expect(existsSync(dest)).toBe(false);
  });

  it("wsp image export writes one file whose header parses and whose body the passphrase opens back to the vault", async () => {
    const tar = Buffer.from("the person's sign-ins as the seal took them");
    const record = RECORD(tar.length);
    await store.put("images", "default", record);
    await store.putBlob("image-vaults", "default@v1", tar);
    env[IMAGE_PASSPHRASE_ENV] = "a-long-enough-passphrase";
    const dest = join(dir, "out", "image.wsp");
    const done = await run("image", "export", dest);
    expect(done.code).toBe(0);
    const bytes = readFileSync(dest);
    expect(JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString("utf8"))).toMatchObject({ format: "wsp-vault-1", to: "passphrase" });
    // A login the copy road put on the machine counts as held, as one signed in there does.
    expect((await run("image")).io.lines.join("\n")).toContain("1 sign-in held, 2 paths");
    const opened = passphraseCipher.open(bytes, "a-long-enough-passphrase");
    expect(opened.plain.equals(tar)).toBe(true);
    expect(opened.image).toEqual(record);
    expect(bytes.includes(tar)).toBe(false);
    expect(done.io.lines.at(-1)).toContain(dest);
  });

  it("wsp image export asks the passphrase twice at a terminal, and refuses when the second does not match", async () => {
    const tar = Buffer.from("the person's sign-ins as the seal took them");
    await store.put("images", "default", RECORD(tar.length));
    await store.putBlob("image-vaults", "default@v1", tar);
    const asks: string[] = [];
    const typed = async (...answers: string[]): Promise<{ code: number; io: Captured }> => {
      const io = captured();
      io.isTTY = true;
      io.askSecret = async q => {
        asks.push(q.split("\n")[0]!);
        return answers[asks.length - 1] ?? "";
      };
      return { code: await cli(["image", "export", join(dir, `${asks.length}-out.wsp`), "--state", statePath], io, undefined, env), io };
    };
    const mismatched = await typed("a-long-enough-passphrase", "a-different-passphrase");
    expect(mismatched.code).toBe(EXIT_CODES.usage);
    expect(asks).toEqual(["A passphrase for this export", "The same passphrase again"]);
    expect(mismatched.io.errors.at(-1)).toContain("the two passphrases are not the same");

    asks.length = 0;
    const short = await typed("short", "short");
    expect(short.code).toBe(EXIT_CODES.usage);
    expect(asks).toEqual(["A passphrase for this export"]);
    expect(short.io.errors.at(-1)).toContain(`${IMAGE_PASSPHRASE_MIN} characters at least`);

    asks.length = 0;
    const done = await typed("a-long-enough-passphrase", "a-long-enough-passphrase");
    expect(done.code).toBe(0);
    expect(asks).toEqual(["A passphrase for this export", "The same passphrase again"]);
  });

  it("wsp image export aimed at a host on another computer is answered here, and nothing of this computer's crosses to it", async () => {
    // A host this computer really holds, so the answer is the sentence and not the refusal for a name nobody knows.
    // The aim reads the home off the run's own environment, which this file hands every verb.
    env["WSP_HOME"] = join(dir, "home");
    writeHost(join(dir, "home"), "box", { url: "http://box.local:4400", deviceId: "d_box", deviceToken: "tok-box", hostKey: HOST_KEY, pairedAt: "2026-09-11T10:00:00.000Z", via: { kind: "account", hostId: "hbox" } });
    const dest = join(dir, "elsewhere.wsp");
    const line = `${hostSideOnlyLine("image export", "box")} ${hostSideOnlyFix(HOST_SIDE_VAULT)}`;
    // Every way a line is aimed reads the same: the flag and the variable.
    const flagged = await run("image", "export", dest, "--host", "box");
    expect(flagged.code).toBe(EXIT_CODES.usage);
    expect(flagged.io.errors.at(-1)).toBe(line);

    env["WSP_HOST"] = "box";
    const named = await run("image", "export", dest);
    expect(named.code).toBe(EXIT_CODES.usage);
    expect(named.io.errors.at(-1)).toBe(line);
    delete env["WSP_HOST"];

    expect(existsSync(dest)).toBe(false);
    delete env["WSP_HOME"];
    // Only the export is held here: wsp image is a reading and answers against whichever host the line names.
    expect(CLI_VERBS.filter(v => "hostSide" in v && v.hostSide !== undefined).map(v => v.name)).toEqual(["agents key", "image export"]);
  });

  it("wsp image export with nobody at the terminal and no passphrase in the environment refuses before anything is read", async () => {
    const refused = await run("image", "export", join(dir, "image.wsp"));
    expect(refused.code).toBe(EXIT_CODES.usage);
    expect(refused.io.errors.at(-1)).toContain(IMAGE_PASSPHRASE_ENV);
  });

  it("wsp image export refuses a passphrase under the minimum, and a destination that already holds something", async () => {
    env[IMAGE_PASSPHRASE_ENV] = "short";
    const tooShort = await run("image", "export", join(dir, "image.wsp"));
    expect(tooShort.code).toBe(EXIT_CODES.usage);
    expect(tooShort.io.errors.at(-1)).toContain(`${IMAGE_PASSPHRASE_MIN} characters at least`);

    const taken = join(dir, "taken.wsp");
    writeFileSync(taken, "mine");
    env[IMAGE_PASSPHRASE_ENV] = "a-long-enough-passphrase";
    const refused = await run("image", "export", taken);
    expect(refused.code).not.toBe(0);
    expect(readFileSync(taken, "utf8")).toBe("mine");
  });

  it("image move puts the workspace on the newest version, says up front what moves, and names the files of the image's own it kept", async () => {
    const sha = (c: string): string => c.repeat(64);
    const v1 = { ...head(SEALED_GOLDEN), owned: [{ path: ".zshrc", sha256: sha("1") }, { path: ".gitconfig", sha256: sha("2") }] };
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [v1] });
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    // The fork rewrote its own gitconfig and left the image's zshrc as it was.
    backend.execImpl = (m, cmd) =>
      cmd.includes("xargs -0 -r sha256sum") ? { exitCode: 0, stdout: `${sha("1")}  .zshrc\n${sha("f")}  .gitconfig\n`, stderr: "" } : guestAnswer(cmd);
    await store.put("goldens", copyKey("default", "default"), {
      head: 2,
      versions: [v1, { ...v1, version: 2, snapshotId: "snap_gold2", owned: [{ path: ".zshrc", sha256: sha("9") }, { path: ".gitconfig", sha256: sha("2") }] }],
    });

    const moved = await run("image", "move", "alpha");
    expect(moved.io.errors).toEqual([IMAGE_MOVE_CONFIRM]);
    expect(moved.code).toBe(0);
    // Said once the workspace resolved, so a name nothing here holds hears the refusal alone.
    expect((await run("image", "move", "nope")).io.errors).toEqual(["wsp image move: no workspace nope"]);
    const after = await rt.workspaces.get(alpha!.id);
    expect(after).toMatchObject({ id: alpha!.id, name: "alpha", phase: "running", golden: "snap_gold2" });
    expect(moved.io.lines).toEqual([`alpha running on ${after.machineId}; ${imageKeptLine([".gitconfig"])}`]);

    // The answer says for itself whether a machine was replaced, so an agent reading the object never has to compare
    // the image it read a moment before against the one it got back.
    const asJson = await run("image", "move", "alpha", "--json");
    expect(json(asJson.io)).toEqual([{ workspace: expect.objectContaining({ golden: "snap_gold2" }), moved: false, kept: [] }]);
    // Nothing to move to now, and the line says that rather than claiming the image's files came across.
    const again = await run("image", "move", "alpha");
    expect(again.code).toBe(0);
    expect(again.io.lines).toEqual([`alpha running on ${after.machineId}; ${IMAGE_ALREADY_NEWEST}`]);
    const extra = await run("image", "move", "alpha", "beta");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors.at(-1)).toBe("wsp image move takes one workspace. usage: wsp image move <workspace>");
  });

  it("fork's help says it makes a new machine from the source's image version, on the agent page and in wsp fork --help", async () => {
    const line = "a new machine from the source's image version";
    expect(agentPage()).toContain(line);
    const { code, io } = await run("fork", "--help");
    expect(code).toBe(0);
    expect(io.lines[0]).toContain(line);
  });

  it("wsp init --help names the screens of the wizard in order, as it draws them, with no count since a screen with nothing to pick is not shown", () => {
    const init = commandPage("init", COMMANDS_FOR_HELP["init"]!).replace(/\s+/g, " ");
    expect(init).not.toMatch(/(three|five|six) screens/);
    expect(init).toContain("one screen at a time: Agents, Tools, Also on this computer, Sign-ins, wsp for your agents on this computer, each shown when it has a row to pick, then Build");
    // The road a run that asks nothing takes is a question the screens ask a person; the flag is how the answer is given.
    expect(init).toContain("--rebuild");
    expect(init).toContain("seal the next version from a fresh machine rather than from your image plus the changes");
  });

  it("every line of wsp --help fits 100 columns", () => {
    const wide = HELP.split("\n").filter(l => l.length > 100);
    expect(wide).toEqual([]);
  });

  it("pause naps the workspace and says so in the state vocabulary", async () => {
    await run("new", "alpha");
    const { code, io } = await run("pause", "alpha");
    expect(code).toBe(0);
    expect(io.lines).toEqual(["alpha paused"]);
    expect((await rt.workspaces.list())[0]!.phase).toBe("napping");
    const missing = await run("pause", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp pause: no workspace nope"]);
  });

  it("pause on a machine the provider will not pause refuses with the sentence that says why, class provider, in one stderr line, and --json carries it", async () => {
    await run("new", "alpha");
    const m = backend.machines[0]!;
    m.pause = async () => {
      throw new NapRefusedError(m.id, "Not pausable");
    };
    const refused = await run("pause", "alpha");
    expect(refused.code).toBe(EXIT_CODES.provider);
    expect(refused.io.lines).toEqual([]);
    expect(refused.io.errors).toEqual([`wsp pause: ${napRefusedLine("Not pausable")}`]);
    const asJson = await run("pause", "alpha", "--json");
    expect(asJson.code).toBe(EXIT_CODES.provider);
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors.map(l => JSON.parse(l) as unknown)).toEqual([{ error: napRefusedLine("Not pausable"), class: "provider", exit: EXIT_CODES.provider }]);
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("wake wakes a paused workspace, one line on stderr while it does, and prints its state after; on a running one the runtime is asked and the state printed is the one read", async () => {
    await run("new", "alpha");
    await run("pause", "alpha");
    const woken = await run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.errors).toEqual(["waking alpha"]);
    expect(woken.io.lines).toEqual(["alpha running"]);
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
    expect(backend.machines[0]!.paused).toBe(false);
    const again = await run("wake", "alpha", "--json");
    expect(again.code).toBe(0);
    expect(again.io.errors).toEqual([]);
    expect(json(again.io)).toEqual([{ workspace: expect.objectContaining({ name: "alpha", phase: "running" }) }]);
    const plain = await run("wake", "alpha");
    expect(plain.io.lines).toEqual(["alpha running"]);
    const missing = await run("wake", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp wake: no workspace nope"]);
  });

  it("wake prints the word the next workspaces will print, and says a machine that came up and answers nothing is up and not answering yet", async () => {
    await run("new", "alpha");
    await run("pause", "alpha");
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      const port = (edge.address() as AddressInfo).port;
      backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const woken = await run("wake", "alpha");
      expect(woken.code).toBe(0);
      // The provider started it, so the phase alone would say running; nothing on it answers, so the table says
      // Unreachable, and the wake says the same thing in a sentence rather than a second word for one machine.
      expect(woken.io.lines).toEqual(["alpha is up and not answering yet"]);
      const listed = await run("workspaces");
      expect(listed.io.lines[0]!.split("\n")[1]!.split(/ {2,}/)[5]).toBe("Unreachable");
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  it("a machine the provider paused on its own, under a record that says running, is woken by wake and by exec: the runtime's one state read settles it", async () => {
    await run("new", "alpha");
    backend.machines[0]!.paused = true;
    execGuest(backend, "awake-ok\n", 0);
    const ran = await run("exec", "alpha", "--", "echo", "awake-ok");
    expect(ran.code).toBe(0);
    expect(ran.io.lines).toEqual(["awake-ok"]);
    expect(backend.machines[0]!.paused).toBe(false);
    backend.machines[0]!.paused = true;
    const woken = await run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.lines).toEqual(["alpha running"]);
    expect(woken.io.errors).toEqual([]);
    expect(backend.machines[0]!.paused).toBe(false);
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("exec on a paused workspace wakes it first, says so on stderr, then runs the command; a running one is not woken", async () => {
    await run("new", "alpha");
    await run("pause", "alpha");
    execGuest(backend, "awake-ok\n", 0);
    const { code, io } = await run("exec", "alpha", "--", "echo", "awake-ok");
    expect(code).toBe(0);
    expect(io.errors).toEqual(["waking alpha"]);
    expect(io.lines).toEqual(["awake-ok"]);
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
    const again = await run("exec", "alpha", "--", "echo", "awake-ok");
    expect(again.code).toBe(0);
    expect(again.io.errors).toEqual([]);
  });

  it("a record that says paused while the provider runs the machine: exec goes on without a resume and the store ends running; pause pauses for real", async () => {
    await run("new", "alpha");
    await run("pause", "alpha");
    const m = backend.machines[0]!;
    // The nap never took at the provider, and a resume on a running machine is refused.
    const runningAtProvider = (): void => {
      m.paused = false;
      m.resume = async () => {
        throw Object.assign(new Error("Sandbox is not paused"), { kind: "conflict", status: 409 });
      };
    };
    runningAtProvider();
    execGuest(backend, "awake-ok\n", 0);
    const ran = await run("exec", "alpha", "--", "echo", "awake-ok");
    expect(ran.code).toBe(0);
    expect(ran.io.lines).toEqual(["awake-ok"]);
    const [alpha] = await rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
    expect(await store.get("workspaces", alpha!.id)).toMatchObject({ phase: "running" });

    await run("pause", "alpha");
    expect(m.paused).toBe(true);
    runningAtProvider();
    const paused = await run("pause", "alpha");
    expect(paused.code).toBe(0);
    expect(paused.io.lines).toEqual(["alpha paused"]);
    expect(m.paused).toBe(true);
    expect((await rt.workspaces.list())[0]!.phase).toBe("napping");
  });

  it("run and send on a paused workspace wake it first, one line on stderr, then run the turn", async () => {
    await run("new", "alpha");
    await run("pause", "alpha");
    const opened = await run("run", "alpha", "hello");
    expect(opened.code).toBe(0);
    expect(opened.io.errors).toEqual(["waking alpha"]);
    expect(opened.io.lines[1]).toBe("re: hello");
    const [row] = await rt.sessions.list();
    await run("pause", "alpha");
    const sent = await run("send", row!.threadId!, "again");
    expect(sent.code).toBe(0);
    expect(sent.io.errors).toEqual(["waking alpha"]);
    expect(sent.io.lines).toEqual(["re: again"]);
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("rename names the workspace and prints both names; a name another workspace holds and a blank one are refused and nothing is renamed", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    const alpha = (await rt.workspaces.list()).find(w => w.name === "alpha")!;

    const named = await run("rename", "alpha", "the name he typed");
    expect(named.code).toBe(0);
    expect(named.io.lines).toEqual([`alpha is now the name he typed ${alpha.id}`]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["beta", "the name he typed"]);
    // The name is how a workspace is addressed, so every later verb takes the one it now carries.
    expect((await run("pause", "the name he typed")).io.lines).toEqual(["the name he typed paused"]);

    const taken = await run("rename", "beta", "the name he typed");
    expect(taken.code).toBe(1);
    expect(taken.io.errors).toEqual(["wsp rename: the name he typed is already a workspace; pick another name, or delete it first"]);
    const blank = await run("rename", "beta", "  ");
    expect(blank.code).toBe(1);
    expect(blank.io.errors).toEqual(["wsp rename: a workspace name cannot be blank"]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["beta", "the name he typed"]);

    const asJson = await run("rename", "beta", "gamma", "--json");
    expect(asJson.code).toBe(0);
    expect(json(asJson.io)).toMatchObject([{ was: "beta", workspace: { name: "gamma" } }]);

    const missing = await run("rename", "nope", "a");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp rename: no workspace nope"]);
    const short = await run("rename", "gamma");
    expect(short.code).toBe(3);
    expect(short.io.errors).toEqual(["wsp rename takes a workspace and one name. usage: wsp rename <workspace> \"<name>\""]);
  });

  it("forget asks once, naming what goes, drops a workspace whose machine is gone, and is refused with the reason while the machine exists", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    await run("run", "alpha", "build it");
    const alpha = (await rt.workspaces.list()).find(w => w.name === "alpha")!;
    const live = await run("forget", "alpha", "--yes");
    expect(live.code).toBe(1);
    expect(live.io.errors).toEqual(["wsp forget: alpha's machine m1 is still running; pause it or delete it at the provider first"]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);

    backend.machines[0]!.killed = true;
    const kept = await answer("no", "forget", "alpha");
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual(["alpha kept"]);
    expect(asked).toEqual(["Forget alpha?\nIts record and 1 thread leave this computer; the computer it ran on is already gone."]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);

    const forgot = await answer("yes", "forget", alpha.id);
    expect(forgot.code).toBe(0);
    expect(forgot.io.lines).toEqual([`forgot alpha ${alpha.id}: its record and 1 thread are gone from this computer`]);
    expect(forgot.io.errors).toEqual([]);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["beta"]);
    expect(await rt.sessions.list(alpha.id)).toEqual([]);
    expect(await store.get("workspaces", alpha.id)).toBeUndefined();
    expect(await store.get("transcripts", alpha.id)).toBeUndefined();

    backend.machines[1]!.killed = true;
    const beta = (await rt.workspaces.list())[0]!;
    const asJson = await run("forget", "beta", "--yes", "--json");
    expect(asJson.code).toBe(0);
    expect(json(asJson.io)).toEqual([{ workspaceId: beta.id, name: "beta", threads: 0 }]);
    expect(await rt.workspaces.list()).toEqual([]);

    const missing = await run("forget", "nope", "--yes");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp forget: no workspace nope"]);
  });

  it("the delete question and its line say what the delete does to this kind's machine, the ssh sweep included", () => {
    const workspace = { id: "ws_mine", name: "box", machineId: "ssh://dev@box:22", phase: "running", kind: "ssh", golden: "", createdAt: "2026-09-08T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "default" } } as const;
    // What wsp put on a machine somebody owns comes off with the record; the machine is theirs and stays.
    expect(deleteQuestion({ workspace, threads: 1 })).toBe(
      "Delete box?\nIts daemon, its unit and its login line come off the computer, which is otherwise left as it is; its record and 1 thread leave this computer.",
    );
    expect(deletedLine({ workspace, threads: 1 })).toBe(
      "deleted box ws_mine: its daemon, its unit and its login line come off the computer, which is otherwise left as it is, and its record and 1 thread are gone from this computer",
    );
    // This computer took no daemon of wsp's and no line in a login file, so nothing comes off it.
    const here = { ...workspace, kind: "local", machineId: "local" } as const;
    expect(deleteQuestion({ workspace: here, threads: 1 })).toBe("Delete box?\nIts computer is left as it is; its record and 1 thread leave this computer.");
    expect(deletedLine({ workspace: here, threads: 1 })).toBe("deleted box ws_mine: its computer is left as it is, and its record and 1 thread are gone from this computer");
    // A workspace that is a copy of a project folder takes the copy with it; the folder it was copied from stays.
    const copied = { ...here, copy: { road: "clonefile", path: "/Users/dev/api-fix", source: "/Users/dev/api", base: "0".repeat(40), branch: "main", carried: "deps-and-config" } } as const;
    expect(deleteQuestion({ workspace: copied, threads: 1 })).toBe("Delete box?\nIts copy at /Users/dev/api-fix is removed and the project folder is left as it is; its record and 1 thread leave this computer.");
    expect(deletedLine({ workspace: copied, threads: 1 })).toBe("deleted box ws_mine: its copy at /Users/dev/api-fix is removed and the project folder is left as it is, and its record and 1 thread are gone from this computer");
    // A fork is wsp's to take away, and its line still names the machine that goes.
    const fork = { ...workspace, kind: "cloud", machineId: "m_ab12" } as const;
    expect(deletedLine({ workspace: fork, threads: 0 })).toBe("deleted box ws_mine: computer m_ab12 is gone in the cloud, and its record and 0 threads are gone from this computer");
  });

  it("delete asks once in the words the app shows, kills the machine at the provider, and drops the record and its threads", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    await run("run", "alpha", "build it");
    const alpha = (await rt.workspaces.list()).find(w => w.name === "alpha")!;

    const kept = await answer("no", "delete", "alpha");
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual(["alpha kept"]);
    expect(asked).toEqual([`Delete alpha?\nIts computer is deleted in the cloud; its record and 1 thread leave this computer.`]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);
    expect(backend.machines[0]!.killed).toBe(false);

    const deleted = await answer("yes", "delete", alpha.id);
    expect(deleted.code).toBe(0);
    expect(deleted.io.errors).toEqual([]);
    expect(deleted.io.lines).toEqual([
      `deleted alpha ${alpha.id}: computer ${alpha.machineId} is gone in the cloud, and its record and 1 thread are gone from this computer`,
    ]);
    expect(backend.machines[0]!.killed).toBe(true);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["beta"]);
    expect(await rt.sessions.list(alpha.id)).toEqual([]);
    expect(await store.get("workspaces", alpha.id)).toBeUndefined();

    const beta = (await rt.workspaces.list())[0]!;
    const asJson = await run("delete", "beta", "--yes", "--json");
    expect(asJson.code).toBe(0);
    expect(json(asJson.io)).toEqual([{ workspaceId: beta.id, name: "beta", machineId: beta.machineId, threads: 0 }]);
    expect(backend.machines[1]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);

    const missing = await run("delete", "nope", "--yes");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp delete: no workspace nope"]);
  });

  it("forget on a workspace that runs on a computer sends the person to delete, the one road that takes it away", async () => {
    await macProject("mac");
    const here = (await rt.workspaces.list())[0]!;
    const sent = await run("forget", "mac", "--yes");
    expect(sent.code).toBe(1);
    expect(sent.io.errors).toEqual([`wsp forget: ${forgetUndrivenRefusal("mac", THIS_COMPUTER)}`]);
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([here.id]);

    const deleted = await run("delete", "mac", "--yes");
    expect(deleted.code).toBe(0);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  /** The prompt the persona's turn stopped on, as the claude adapter's control channel hands one over: a command to
   * run, with allow, deny and the mode the harness offers beside them. */
  const RUN_ASK: PermissionAsk = {
    askId: "ask_1",
    toolName: "Bash",
    input: JSON.stringify({ command: "wc -l < /etc/hosts" }),
    options: [
      { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
      { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
      { id: "mode:acceptEdits", label: "the adapter's own words for this one", effect: "mode", mode: "acceptEdits" },
    ],
  };

  it("the thread id is printed the moment the thread exists, ahead of the turn's first delta", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const started = starting("run", "alpha", "print the number of lines in /etc/hosts");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    // The id is on stdout while the turn has said nothing: a person watching knows what to stop and what to read.
    await vi.waitFor(() => expect(started.io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`]));
    expect(started.io.streamed).toBe("");

    held.release(0, "10");
    expect(await started.ended).toBe(0);
    expect(started.io.screen.startsWith(`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}\n10`)).toBe(true);
  });

  it("a turn stopped on a prompt says so in the terminal that is blocked, with the keys that answer it, and a typed y answers it", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    let type: (key: string | undefined) => void = () => {};
    const offered: string[][] = [];
    io.answerKey = (accept, until) => {
      offered.push([...accept]);
      return new Promise<string | undefined>(resolve => {
        type = resolve;
        void until.then(() => resolve(undefined));
      });
    };
    const ended = cli(["run", "alpha", "print the number of lines in /etc/hosts", "--state", statePath], io, undefined, env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));

    held.ask(0, RUN_ASK);
    await vi.waitFor(() => expect(io.streamed).toContain(needsYouLine(RUN_ASK)));
    // The mode road has no words of its own: the runtime lends the option the words the app's own picker shows for
    // that mode, and the line under the prompt reads them rather than guessing what the mode does.
    const lent = { ...RUN_ASK, options: RUN_ASK.options.map(o => (o.effect === "mode" ? { ...o, label: permissionModeOptionLabel("Accept edits") } : o)) };
    expect(io.streamed.split("\n").slice(-3, -1)).toEqual([needsYouLine(RUN_ASK), answerKeysLine(lent.options)]);
    expect(answerKeysLine(lent.options)).toBe("answer here: type y to run it, n to refuse it, a to allow, then Accept edits");
    expect(offered).toEqual([["y", "n", "a"]]);

    type("y");
    await vi.waitFor(() => expect(held.answers).toEqual([{ askId: "ask_1", optionId: PERMISSION_ALLOW, outcome: "allowed" }]));
    held.release(0, "10");
    expect(await ended).toBe(0);
  });

  it("a turn stopped on two prompts is waiting on the older one, and the line that answers closes the one the listing named", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const running = starting("run", "alpha", "count both files");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const thread = row!.threadId!;
    const older: PermissionAsk = { ...RUN_ASK, askId: "ask_older" };
    const newer: PermissionAsk = { ...RUN_ASK, askId: "ask_newer", input: JSON.stringify({ command: "wc -l < /etc/passwd" }) };

    held.ask(0, older);
    held.ask(0, newer);
    await vi.waitFor(async () => expect((await rt.sessions.list())[0]!.asking).toBe(askingLine(older)));

    const allowed = await run("thread", "allow", thread);
    expect(allowed.code).toBe(0);
    expect(allowed.io.lines).toEqual([answeredLine(thread, older, "allowed")]);
    expect(held.answers).toEqual([{ askId: "ask_older", optionId: PERMISSION_ALLOW, outcome: "allowed" }]);
    // The newer one leads now, and the same line answers that.
    await vi.waitFor(async () => expect((await rt.sessions.list())[0]!.asking).toBe(askingLine(newer)));

    held.release(0, "10");
    expect(await running.ended).toBe(0);
  });

  it("a prompt that asks the person something rather than for consent says so: no key and no verb here stands for its own answers", async () => {
    const asked: PermissionAsk = {
      askId: "ask_q",
      toolName: QUESTION_TOOL,
      input: JSON.stringify({ questions: [{ question: "Which one?", header: "Pick", options: [{ label: "the first" }, { label: "the second" }] }] }),
      options: [
        { id: "q:0", label: "the first", effect: "answer" },
        { id: "q:1", label: "the second", effect: "answer" },
      ],
    };
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const running = starting("run", "alpha", "ask me which one");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const thread = row!.threadId!;

    held.ask(0, asked);
    await vi.waitFor(() => expect(running.io.streamed).toContain(needsYouLine(asked)));
    expect(running.io.streamed.split("\n").slice(-3, -1)).toEqual([needsYouLine(asked), ANSWER_IN_THE_APP]);

    const refused = await run("thread", "allow", thread);
    expect(refused.code).toBe(EXIT_CODES.provider);
    expect(refused.io.errors).toEqual([`wsp thread allow: ${noSuchAnswerLine(thread, "allow")}`]);

    held.release(0, "done");
    expect(await running.ended).toBe(0);
  });

  it("--json at a terminal offers no keys and waits on none: it writes the events and no stream, so its caller answers by the verb", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const offered: string[][] = [];
    io.answerKey = accept => {
      offered.push([...accept]);
      return new Promise<string | undefined>(() => {});
    };
    const ended = cli(["run", "alpha", "print the number of lines in /etc/hosts", "--json", "--state", statePath], io, undefined, env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();

    held.ask(0, RUN_ASK);
    await vi.waitFor(() => expect(io.lines.some(l => l.includes('"session.permission"'))).toBe(true));
    expect(offered).toEqual([]);
    expect(io.streamed).toBe("");

    expect((await run("thread", "allow", row!.threadId!)).code).toBe(0);
    held.release(0, "10");
    expect(await ended).toBe(0);
  });

  it("a caller with no terminal gets the same words and the verbs that answer by thread id, and those verbs answer the open prompt", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const running = starting("run", "alpha", "print the number of lines in /etc/hosts");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const thread = row!.threadId!;

    held.ask(0, RUN_ASK);
    await vi.waitFor(() => expect(running.io.streamed).toContain(needsYouLine(RUN_ASK)));
    expect(running.io.streamed.split("\n").slice(-3, -1)).toEqual([needsYouLine(RUN_ASK), answerVerbsLine(thread)]);

    const allowed = await run("thread", "allow", thread);
    expect(allowed.code).toBe(0);
    expect(allowed.io.lines).toEqual([answeredLine(thread, RUN_ASK, "allowed")]);
    expect(held.answers).toEqual([{ askId: "ask_1", optionId: PERMISSION_ALLOW, outcome: "allowed" }]);

    // The prompt is closed, so the same line again has nothing to answer and says so rather than answering twice.
    const twice = await run("thread", "allow", thread);
    expect(twice.code).toBe(EXIT_CODES.provider);
    expect(twice.io.errors).toEqual([`wsp thread allow: ${noOpenAskLine(thread)}`]);

    const second: PermissionAsk = { ...RUN_ASK, askId: "ask_2" };
    held.ask(0, second);
    await vi.waitFor(async () => expect((await rt.sessions.list())[0]!.asking).toBe(askingLine(RUN_ASK)));
    const denied = await run("thread", "deny", thread);
    expect(denied.code).toBe(0);
    expect(denied.io.lines).toEqual([answeredLine(thread, second, "denied")]);
    expect(held.answers.at(-1)).toEqual({ askId: "ask_2", optionId: PERMISSION_DENY, outcome: "denied" });

    held.release(0, "10");
    expect(await running.ended).toBe(0);
  });

  it("a name nothing here holds is refused before anything ran, on every verb that resolves one: the usage class, never the provider's", async () => {
    await run("new", "alpha");
    await run("run", "alpha", "build it");
    const folder = join(dir, "here");
    mkdirSync(folder, { recursive: true });
    const workspaceLines: [string, string[]][] = [
      ["exec", ["exec", "nope", "--", "true"]],
      ["pause", ["pause", "nope"]],
      ["wake", ["wake", "nope"]],
      ["rename", ["rename", "nope", "other"]],
      ["forget", ["forget", "nope", "--yes"]],
      ["delete", ["delete", "nope", "--yes"]],
      ["rebuild", ["rebuild", "nope"]],
      ["run", ["run", "nope", "build it"]],
      ["threads", ["threads", "nope"]],
      ["fork", ["fork", "nope", "--name", "child"]],
      ["export", ["export", "nope", folder, "--from", "/root/work/proj"]],
      ["image move", ["image", "move", "nope"]],
    ];
    const walked = async (lines: [string, string[]][]): Promise<[string, number, string[]][]> => {
      const refused: [string, number, string[]][] = [];
      for (const [verb, argv] of lines) {
        const { code, io } = await run(...argv);
        refused.push([verb, code, io.errors]);
      }
      return refused;
    };
    expect(await walked(workspaceLines)).toEqual(workspaceLines.map(([verb]) => [verb, EXIT_CODES.usage, [`wsp ${verb}: ${noWorkspaceRefusal("nope")}`]]));
    const threadLines: [string, string[]][] = [
      ["thread read", ["thread", "read", "nope"]],
      ["thread rename", ["thread", "rename", "nope", "other"]],
      ["thread forget", ["thread", "forget", "nope"]],
      ["thread allow", ["thread", "allow", "nope"]],
      ["thread deny", ["thread", "deny", "nope"]],
      ["send", ["send", "nope", "hello"]],
      ["stop", ["stop", "nope"]],
    ];
    expect(await walked(threadLines)).toEqual(threadLines.map(([verb]) => [verb, EXIT_CODES.usage, [`wsp ${verb}: no thread nope`]]));
  });

  it("run opens a thread under the named agent, announces it, streams the reply and prints the last message", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const { code, io } = await run("run", "alpha", "--agent", "codex", "write tests");
    expect(code).toBe(0);
    const [row] = await rt.sessions.list(alpha!.id);
    expect(row).toMatchObject({ harness: "codex", startedBy: "cli", prompt: "write tests", status: "completed" });
    expect(codex.starts.map(s => s.prompt)).toEqual(["write tests"]);
    expect(claude.starts).toEqual([]);
    expect(io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`, "codex: write tests"]);
    expect(io.streamed).toBe("code\n$ ls\nx: write tests\ncompleted\n");
    expect(io.errors).toEqual([]);
  });

  it("a turn watched at a terminal shows its reply once: the prose as it streamed, ended on a line of its own, and the finished line under it carries no copy of it", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const ended = cli(["run", "alpha", "print the kernel version and nothing else", "--state", statePath], io, undefined, env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    held.release(0, "25.4.0");
    expect(await ended).toBe(0);
    expect(io.screen).toBe(`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}\n25.4.0\ncompleted\n`);
    expect(io.screen.split("25.4.0")).toHaveLength(2);
    expect(io.screen.endsWith("\n")).toBe(true);
    expect(io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`]);
  });

  it("a turn watched at a terminal that streamed no prose prints its reply once under the work it showed, since nothing on the screen carries it yet", async () => {
    await restartHost({ claude: toolingAgent([{ toolName: "Bash", input: { command: "uname -r" }, output: "25.4.0" }], { status: "completed", text: "the kernel is 25.4.0" }) });
    await run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    expect(await cli(["run", "alpha", "print the kernel version and nothing else", "--state", statePath], io, undefined, env)).toBe(0);
    const [row] = await rt.sessions.list();
    expect(io.screen).toBe(`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}\n$ uname -r\n25.4.0\nthe kernel is 25.4.0\ncompleted\n`);
    expect(io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`, "the kernel is 25.4.0"]);
  });

  it("wsp send at a terminal prints the reply once, the copy that streamed, and down a pipe prints it whole at the end", async () => {
    // Marco read each send's reply twice and called it noise. A terminal has the streamed prose in front of the
    // same eyes, so stdout adds no copy of it; a pipe is somebody else's reader and carries the reply whole.
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    await run("run", "alpha", "--detach", "build it");
    const [row] = await rt.sessions.list();
    held.release(0, "first turn done");

    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const ended = cli(["send", row!.threadId!, "and now the second", "--state", statePath], io, undefined, env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    held.release(1, "the answer is 42");
    expect(await ended).toBe(0);
    expect(io.screen).toBe("the answer is 42\ncompleted\n");
    expect(io.screen.split("the answer is 42")).toHaveLength(2);
    expect(io.lines).toEqual([]);

    const piped = starting("send", row!.threadId!, "and a third");
    await vi.waitFor(() => expect(held.starts).toHaveLength(3));
    held.release(2, "the answer is still 42");
    expect(await piped.ended).toBe(0);
    expect(piped.io.lines).toEqual(["the answer is still 42"]);
    expect(piped.io.streamed).toBe("the answer is still 42\ncompleted\n");
  });

  it("a turn whose stdout is a pipe prints the reply once, at the end, with the stream beside it the person's own view of the work", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const piped = starting("run", "alpha", "print the kernel version and nothing else");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    held.release(0, "25.4.0");
    expect(await piped.ended).toBe(0);
    expect(piped.io.sameScreen).toBeUndefined();
    expect(piped.io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`, "25.4.0"]);
    expect(piped.io.streamed).toBe("25.4.0\ncompleted\n");
  });

  it("a reply printed under a stream that stopped mid-line starts its own line, so the answer is never glued to the work above it", async () => {
    await run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    const ended = cli(["run", "alpha", "build it", "--state", statePath], io, undefined, env);
    expect(await ended).toBe(0);
    const [row] = await rt.sessions.list();
    expect(io.screen).toBe(`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}\nre: \n$ ls\nbuild it\nre: build it\ncompleted\n`);
    expect(io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`, "re: build it"]);
  });

  it("--json prints the turn's events and its one turn value, at a terminal as into a pipe, and writes no stream", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const ended = cli(["run", "alpha", "print the kernel version and nothing else", "--json", "--state", statePath], io, undefined, env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    held.release(0, "25.4.0");
    expect(await ended).toBe(0);
    const values = json(io) as { type?: string; kind?: string; result?: { text?: string } }[];
    expect(values.map(v => v.type)).toEqual(["thread", "session.start", "session.delta", "session.done", undefined]);
    expect(values[2]).toMatchObject({ kind: "text", text: "25.4.0" });
    expect(values[3]!.result).toMatchObject({ status: "completed", text: "25.4.0" });
    expect(values.at(-1)).toEqual({ threadId: row!.threadId, workspaceId: row!.workspaceId, harness: "claude", text: "25.4.0", outcome: "started" });
    expect(io.streamed).toBe("");
  });

  it("a turn on this computer prices its figure as the agent's list price, and a turn at a provider leaves the figure alone", async () => {
    // A turn here runs on the person's own sign-in, so nobody is billed for it and the number is the agent's own
    // table, which is the word the app's footer already gives the figure. A fork is billed and says nothing extra.
    await restartHost({ claude: toolingAgent([], { status: "completed", text: "had a look", durationMs: 72_000, costUsd: 0.19 }) });
    await macProject("mac");
    const here = captured();
    expect(await cli(["run", "mac", "look around", "--state", statePath], here, undefined, env)).toBe(0);
    expect(here.streamed).toContain(`completed  Worked for 1m 12s  $0.19 ${LIST_PRICE_WORD}`);

    await run("new", cloud.name, "alpha");
    const forked = captured();
    expect(await cli(["run", "alpha", "look around", "--state", statePath], forked, undefined, env)).toBe(0);
    expect(forked.streamed).toContain("completed  Worked for 1m 12s  $0.19\n");
    expect(forked.streamed).not.toContain(LIST_PRICE_WORD);
  });

  it("a turn's two replies stream as two paragraphs: what the agent said while its background command ran, then what it said when that command woke it", async () => {
    await restartHost({
      claude: sayingAgent(
        [
          { kind: "text", text: "Waiting for the 90-second hold to complete.", messageId: "msg_a" },
          { kind: "text", text: "Done. The hold completed with exit code 0.", messageId: "msg_b" },
        ],
        { status: "completed", text: "Done. The hold completed with exit code 0." },
      ),
    });
    await run("new", "alpha");
    const { code, io } = await run("run", "alpha", "hold for 90 seconds");
    expect(code).toBe(0);
    expect(io.streamed.split("\n")).toEqual([
      "Waiting for the 90-second hold to complete.",
      "",
      "Done. The hold completed with exit code 0.",
      "completed",
      "",
    ]);
  });

  it("a turn whose messages sit either side of a tool call prints no blank line: the call's own lines have parted them already", async () => {
    await restartHost({
      claude: sayingAgent(
        [
          { kind: "text", text: "Looking.", messageId: "msg_a" },
          { toolName: "Bash", input: { command: "ls" }, output: "a.txt" },
          { kind: "text", text: "One file.", messageId: "msg_b" },
        ],
        { status: "completed", text: "One file." },
      ),
    });
    await run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["run", "alpha", "what is here", "--state", statePath], io, undefined, env)).toBe(0);
    expect(io.streamed.split("\n")).toEqual(["Looking.", "~$ ls~", "~a.txt~", "One file.", "~completed~", ""]);
  });

  it("a harness's note about itself streams muted above the reply, with no word of failure, and the turn reads completed", async () => {
    const warning = "loading hooks from both /root/.codex/hooks.json and /root/.codex/config.toml; prefer a single representation for this layer";
    await restartHost({ claude: sayingAgent([{ kind: "note", text: warning }, { kind: "text", text: "ready", messageId: "msg_a" }], { status: "completed", text: "ready" }) });
    await run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["run", "alpha", "say ready", "--state", statePath], io, undefined, env)).toBe(0);
    expect(io.streamed.split("\n")).toEqual([`~${warning}~`, "ready", "~completed~", ""]);
    expect(io.streamed).not.toContain("failed");
  });

  it("a turn's tool calls stream one muted line each as they land, what each answered behind it, and its end reads as the app's status line", async () => {
    await restartHost({
      claude: toolingAgent(
        [
          { toolName: "Bash", input: { command: "git status\n--porcelain" }, output: "On branch main\nnothing to commit" },
          { toolName: "Read", input: { file_path: "packages/engine/src/golden-mcp.ts" }, output: "" },
          { toolName: "Write", input: { file_path: "kai.txt" }, output: "File created successfully at: kai.txt" },
          { toolName: "Grep", input: { pattern: "shellQuote" }, output: "packages/host/src/exec.ts:12:  shellQuote(argv)" },
          { toolName: "Wombat", input: { fur: "grey" }, output: "no tool by that name", failed: true },
        ],
        { status: "completed", text: "had a look", durationMs: 72_000, costUsd: 0.22 },
      ),
    });
    await run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["run", "alpha", "look around", "--state", statePath], io, undefined, env)).toBe(0);
    // Every call opens in the present, before it has run and before any prompt it waits on is answered; a call that
    // changed a file says what it changed once its result says it did, and every other call says what came back.
    expect(io.streamed.split("\n")).toEqual([
      "~$ git status~",
      "~On branch main~",
      "~reading packages/engine/src/golden-mcp.ts~",
      "~writing kai.txt~",
      "~wrote kai.txt~",
      "~searching code for shellQuote~",
      "~packages/host/src/exec.ts:12: shellQuote(argv)~",
      "~Wombat~",
      "~failed: no tool by that name~",
      "~completed  Worked for 1m 12s  $0.22~",
      "",
    ]);
    expect(io.lines).toEqual([expect.stringMatching(/^thread /), "had a look"]);
    expect(io.errors).toEqual([]);

    // --json keeps stdout the raw deltas and writes no line of its own.
    const asJson = await run("run", "alpha", "again", "--json");
    expect(asJson.io.streamed).toBe("");
    const calls = (json(asJson.io) as { type?: string; kind?: string; toolName?: string }[]).filter(e => e.type === "session.delta");
    expect(calls.map(e => [e.kind, e.toolName])).toEqual([
      ["tool_use", "Bash"], ["tool_result", undefined],
      ["tool_use", "Read"], ["tool_result", undefined],
      ["tool_use", "Write"], ["tool_result", undefined],
      ["tool_use", "Grep"], ["tool_result", undefined],
      ["tool_use", "Wombat"], ["tool_result", undefined],
    ]);
  });

  it("run without an agent takes the runtime's default; an agent the host has no adapter for is refused naming the agents it has, before a napping machine is woken", async () => {
    await run("new", "alpha");
    const ok = await run("run", "alpha", "hello");
    expect(ok.code).toBe(0);
    expect((await rt.sessions.list())[0]).toMatchObject({ harness: "claude", startedBy: "cli" });
    await run("pause", "alpha");
    const refused = await run("run", "alpha", "--agent", "gemini", "hello");
    expect(refused.code).toBe(3);
    expect(refused.io.errors).toEqual(['wsp run: no adapter registered for harness "gemini"; agents on this host: claude, codex. Name one of those with --agent.']);
    expect((await rt.workspaces.list())[0]!.phase).toBe("napping");
    expect(await rt.sessions.list()).toHaveLength(1);
  });

  it("fork --send under an agent the host has no adapter for is refused naming the agents it has, and no machine is minted", async () => {
    await run("new", "alpha");
    const refused = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--agent", "gemini");
    expect(refused.code).toBe(3);
    expect(refused.io.errors).toEqual(['wsp fork: no adapter registered for harness "gemini"; agents on this host: claude, codex. Name one of those with --agent.']);
    expect(refused.io.lines).toEqual([]);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await rt.sessions.list()).toEqual([]);
  });

  it("an empty or whitespace task or message is refused in words by run, fork --send and send; no machine is minted or woken and nothing starts", async () => {
    await run("new", "alpha");
    await run("run", "alpha", "first");
    const [row] = await rt.sessions.list();
    await run("pause", "alpha");
    for (const task of ["", "  \n\t"]) {
      const opened = await run("run", "alpha", task);
      expect(opened.code).toBe(3);
      expect(opened.io.errors).toEqual([`wsp run: ${EMPTY_TASK_LINE}. Put it in quotes after the flags.`]);
      const forked = await run("fork", "alpha", "--name", "worker", "--send", task);
      expect(forked.code).toBe(3);
      expect(forked.io.errors).toEqual([`wsp fork: ${EMPTY_TASK_LINE}. Put it in quotes after the flags.`]);
      const sent = await run("send", row!.threadId!, task);
      expect(sent.code).toBe(3);
      expect(sent.io.errors).toEqual([`wsp send: ${EMPTY_TASK_LINE}. Put it in quotes after the flags.`]);
    }
    expect((await rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([["alpha", "napping"]]);
    expect(claude.starts).toHaveLength(1);
    expect(await rt.sessions.list()).toHaveLength(1);
  });

  it("a failed turn exits 1 with the error on stderr and no last message", async () => {
    await run("new", "alpha");
    const { code, io } = await run("run", "alpha", "die");
    expect(code).toBe(1);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toMatch(/^thread /);
    expect(io.errors).toEqual(["wsp run: the harness died"]);
  });

  it("a turn the agent refused for want of a sign-in reads failed, exits with the auth code and says the refusal once, on the command line and in the read alike", async () => {
    const refusal = `Not logged in · Please run /login; ${signInRefusalLine({ kind: "local" })}`;
    await restartHost({ claude: toolingAgent([], { status: "failed", durationMs: 88, costUsd: 0, error: refusal, refusal: "sign-in" }) });
    await run("new", "alpha");

    const { code, io } = await run("run", "alpha", "say hi");
    expect(code).toBe(EXIT_CODES.auth);
    expect(io.lines).toEqual([expect.stringMatching(/^thread /)]);
    expect(io.streamed.split("\n").filter(l => l !== "")).toEqual(["failed  Worked for 88ms  $0.00"]);
    expect(io.errors).toEqual([`wsp run: ${refusal}`]);

    const [row] = await rt.sessions.list();
    const read = await run("thread", "read", row!.threadId!);
    expect(read.code).toBe(0);
    expect(read.io.lines.join("\n")).toContain(`failed  Worked for 88ms  $0.00: ${refusal}`);
    expect(read.io.lines.join("\n").split("Not logged in")).toHaveLength(2);
  });

  it("a refusal the agent named no cause for exits the provider code, so the auth code says a sign-in and nothing else", async () => {
    await restartHost({ claude: toolingAgent([], { status: "failed", durationMs: 40, error: "API Error: 529 overloaded" }) });
    await run("new", "alpha");

    const { code, io } = await run("run", "alpha", "say hi");
    expect(code).toBe(EXIT_CODES.provider);
    expect(io.errors).toEqual(["wsp run: API Error: 529 overloaded"]);

    const asJson = await run("run", "alpha", "again", "--json");
    expect(asJson.code).toBe(EXIT_CODES.provider);
    expect(JSON.parse(asJson.io.errors.at(-1)!)).toMatchObject({ class: "provider", exit: EXIT_CODES.provider });
  });

  it("a send into a thread whose last turn was cut says so on stderr before the reply; the send after that says nothing", async () => {
    await run("new", "alpha");
    const cut = await run("run", "alpha", "cut");
    expect(cut.code).toBe(1);
    expect(cut.io.errors).toEqual([`wsp run: ${CUT_LINE}`]);
    const [row] = await rt.sessions.list();
    const resumed = await run("send", row!.threadId!, "again");
    expect(resumed.code).toBe(0);
    expect(resumed.io.errors).toEqual(["previous turn was cut; resuming"]);
    expect(resumed.io.lines).toEqual(["re: again"]);
    const next = await run("send", row!.threadId!, "once more");
    expect(next.code).toBe(0);
    expect(next.io.errors).toEqual([]);
    const asJson = await run("send", row!.threadId!, "and json", "--json");
    expect(json(asJson.io).filter(e => (e as { type: string }).type === "session.start")).toEqual([expect.not.objectContaining({ afterCut: true })]);
  });

  it("a send into a thread whose launch never reached the machine runs the message as that thread's first turn, on the same thread, instead of refusing", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter, codex: codex.adapter });
    await run("new", "alpha");
    const dead = await run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
    const [row] = await rt.sessions.list();
    expect(row!.claudeSessionId).toBeUndefined();
    const sent = await run("send", row!.threadId!, "again");
    expect(sent.code).toBe(0);
    expect(sent.io.errors).toEqual([]);
    expect(sent.io.lines).toEqual(["re: again"]);
    expect(agent.starts.map(s => s.resume)).toEqual([undefined, undefined]);
    const rows = await rt.sessions.list();
    expect(rows.map(r => [r.prompt, r.status, r.threadId])).toEqual([
      ["hello", "failed", row!.threadId],
      ["again", "completed", row!.threadId],
    ]);
    const more = await run("send", row!.threadId!, "once more");
    expect(more.io.lines).toEqual(["re: once more"]);
    expect(agent.starts[2]!.resume).toBe(rows[1]!.claudeSessionId);
  });

  it("a launch that never reached the agent on a workspace it woke puts that workspace back to sleep and says so on its last line", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter });
    await run("new", "alpha");
    const alpha = (await rt.workspaces.list())[0]!;
    await rt.workspaces.nap(alpha.id);
    expect((await rt.workspaces.get(alpha.id)).phase).toBe("napping");

    const dead = await run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    // The machine the launch woke is back where it found it, so no idle window bills for a turn that never ran.
    expect((await rt.workspaces.get(alpha.id)).phase).toBe("napping");
    // The failure still stands whole; the nap is the line under it, which is the last thing the run prints.
    expect(dead.io.errors).toEqual(["waking alpha", `wsp run: ${UNREACHED_LINE}\n${workspaceAsleepAgainLine("alpha")}`]);
  });

  it("a launch that never reached the agent leaves a workspace it did not wake alone and says nothing about it", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter });
    await run("new", "alpha");
    const alpha = (await rt.workspaces.list())[0]!;

    const dead = await run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
    expect((await rt.workspaces.get(alpha.id)).phase).toBe("running");
  });

  it("a launch that dies on a running machine whose daemon is dark leaves that machine up: an unreachable machine is not one this launch woke", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter });
    await run("new", "alpha");
    const alpha = (await rt.workspaces.list())[0]!;
    // The machine is up and nothing on it answers, which is the state word Unreachable and never a machine asleep.
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${(edge.address() as AddressInfo).port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const dead = await run("run", "alpha", "hello");
      expect(dead.code).toBe(1);
      expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
      expect((await rt.workspaces.get(alpha.id)).phase).toBe("running");
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  describe("which caller a wake belongs to", () => {
    /** A host that answers the wake with the phase given, so the transition is what each case turns on. */
    const host = (after: string): HostClient => ({ request: async () => ({ workspace: { id: "ws_1", name: "alpha", phase: after } }) }) as unknown as HostClient;
    const view = (phase: string): WorkspaceView => ({ id: "ws_1", name: "alpha", phase, kind: "cloud", golden: "", createdAt: "2026-09-13T00:00:00.000Z", machineId: "m1" }) as unknown as WorkspaceView;

    it("is the caller's only where the machine was down before it and running after: a machine already up, or one another caller is waking, was woken by neither", async () => {
      // The one this road owes a nap back to, and the one the nap the person asked for was cut short on.
      expect((await awake(host("running"), view("napping"), "send", () => {})).woke).toBe(true);
      expect((await awake(host("running"), view("pausing"), "send", () => {})).woke).toBe(true);
      // Already up is the person's own machine; waking is another caller's wake in flight, not this one's doing.
      expect((await awake(host("running"), view("running"), "send", () => {})).woke).toBe(false);
      expect((await awake(host("running"), view("waking"), "send", () => {})).woke).toBe(false);
      // A wake the provider did not finish started nothing, so there is nothing for this caller to put back.
      expect((await awake(host("napping"), view("napping"), "send", () => {})).woke).toBe(false);
    });

    it("says it is waking on every state that is not running, whoever the wake belongs to", async () => {
      const said: string[] = [];
      for (const phase of ["napping", "pausing", "waking", "running"]) await awake(host("running"), view(phase), "send", line => said.push(line));
      expect(said).toEqual(["waking alpha", "waking alpha", "waking alpha"]);
    });
  });

  describe("what a dead launch does about the machine it woke", () => {
    const woken = { workspace: { id: "ws_1", name: "alpha" } as unknown as WorkspaceOut, woke: true };
    /** A host answering only the two ops this road asks, so the road itself is what the case turns on. */
    const host = (answers: Record<string, unknown>): HostClient => ({ request: async (op: string) => (answers[op] ?? Promise.reject(new Error(`no ${op}`))) as never }) as unknown as HostClient;
    const turnOf = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "s_1", workspaceId: "ws_1", harness: "claude", status, ...extra });

    it("naps it where nothing else is running there", async () => {
      const asked: { op: string; workspaceId?: unknown }[] = [];
      const client = {
        request: async (op: string, params?: Record<string, unknown>) => {
          asked.push({ op, workspaceId: params?.["workspaceId"] });
          return (op === "sessions.list" ? { sessions: [turnOf("failed", { threadId: "t_1" })] } : {}) as never;
        },
      } as unknown as HostClient;
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe(workspaceAsleepAgainLine("alpha"));
      expect(asked).toContainEqual({ op: "workspaces.nap", workspaceId: "ws_1" });
    });

    it("leaves it up where another thread is working there, and says when the idle window takes it", async () => {
      const client = host({
        "sessions.list": { sessions: [turnOf("failed", { threadId: "t_mine" }), turnOf("running", { id: "s_2", threadId: "t_other" })] },
        // Half a minute past the window, so the whole minutes the line reads in do not turn on this test's clock.
        "status.list": { statuses: [{ id: "ws_1", idleAt: Date.now() + 20 * 60_000 + 30_000 }] },
      });
      // Nothing is napped under a turn that is still going, so the line says what the machine costs until then.
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe("alpha stays awake, naps in 20m");
    });

    it("says the machine is up with no countdown where the host answers no nap time for it", async () => {
      const client = host({
        "sessions.list": { sessions: [turnOf("running", { threadId: "t_other" })] },
        "status.list": { statuses: [{ id: "ws_1" }] },
      });
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe("alpha stays awake");
    });

    it("answers the same where the host cannot be reached at all, so the failure the run is reporting is never lost to a second one", async () => {
      const client = host({});
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe("alpha stays awake");
    });
  });

  it("thread forget drops the row a launch that never got going left, and refuses a thread whose turn did work and a row from before threads", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter });
    await run("new", "alpha");
    const dead = await run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
    const junk = (await rt.sessions.list())[0]!.threadId!;
    expect((await run("threads")).io.lines[0]).toContain(junk);

    const forgot = await run("thread", "forget", junk.slice(0, 8));
    expect(forgot.code).toBe(0);
    expect(forgot.io.lines).toEqual([`forgot thread ${junk}: no turn ever ran on it, so nothing of its work is gone`]);
    expect((await run("threads")).io.lines[0]).not.toContain(junk);
    expect(await rt.sessions.list()).toEqual([]);

    // The next launch works, so its thread is one a turn ran on: the runtime's own sentence comes back.
    await run("run", "alpha", "build it");
    const ran = (await rt.sessions.list())[0]!.threadId!;
    const refused = await run("thread", "forget", ran);
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp thread forget: ${threadForgetRefusal(ran)}`]);
    expect((await rt.sessions.list()).map(r => r.threadId)).toEqual([ran]);

    const missing = await run("thread", "forget", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp thread forget: no thread nope"]);
    // A turn from before threads folds under its own id and no thread here answers to it; the verb says that
    // rather than dialling for a thread nobody has, which is the guard the app's row makes.
    const alpha = (await rt.workspaces.list())[0]!.id;
    await store.put("sessions", alpha, { workspaceId: alpha, sessions: [{ id: "s_old", workspaceId: alpha, harness: "claude", status: "failed", prompt: "from before threads" }] });
    await restartHost({ claude: agent.adapter });
    const before = await run("thread", "forget", "s_old");
    expect(before.code).toBe(1);
    expect(before.io.errors).toEqual([`wsp thread forget: ${threadWithoutIdRefusal("s_old")}`]);
    const none = await run("thread", "forget");
    expect(none.code).toBe(3);
    expect(none.io.errors).toEqual(["wsp thread forget takes one thread. usage: wsp thread forget <thread>"]);
  });

  it("threads is the sidebar's data: one row per thread with agent, state, who opened it and its folder, filtered by --in", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    const [alpha, beta] = await rt.workspaces.list();
    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    await run("run", "alpha", "first task");
    await (await rt.sessions.start(beta!.id, { prompt: "from the app", harness: "codex" })).finished;
    const { code, io } = await run("threads");
    expect(code).toBe(0);
    const rows = io.lines[0]!.split("\n");
    expect(rows[0]).toMatch(/^PROJECT\s+WORKSPACE\s+THREAD\s+AGENT\s+STATE\s+BY\s+COMPUTER\s+TITLE$/);
    const [a] = await rt.sessions.list(alpha!.id);
    const [b] = await rt.sessions.list(beta!.id);
    // Each row reads project, workspace, thread, agent, state, who opened it, the computer and the title.
    expect(rows.slice(1).map(r => r.split(/ {2,}/))).toEqual([
      [alpha!.project.name, "alpha", a!.threadId!, "claude", "Idle", "cli", alpha!.project.computer, "first task"],
      [beta!.project.name, "beta", b!.threadId!, "codex", "Idle", "person", beta!.project.computer, "from the app"],
    ]);

    const scoped = await run("threads", "beta", "--json");
    expect(scoped.code).toBe(0);
    const [{ threads }] = json(scoped.io) as [{ threads: (ThreadView & { workspaceName: string; projectName: string; computerName: string })[] }];
    // The rows the tool answers with: the sidebar's view plus the three names the table shows beside it.
    const bare = ({ workspaceName: _w, projectName: _p, computerName: _c, ...t }: (typeof threads)[number]) => t;
    expect(threads.map(t => ThreadView.parse(bare(t)))).toEqual(threads.map(bare));
    expect(threads).toEqual([
      expect.objectContaining({ id: b!.threadId, workspaceId: beta!.id, workspaceName: "beta", projectName: beta!.project.name, computerName: beta!.project.computer, harness: "codex", startedBy: "person", turns: 1 }),
    ]);
  });

  it("threads reads a thread stopped on a permission prompt as needing the person, and as working again once it is answered", async () => {
    const ASKED: PermissionAsk = { askId: "ask_1", toolName: "Write", detail: "out.txt", input: '{"file_path":"/root/out.txt"}', options: [{ id: PERMISSION_ALLOW, label: "Allow", effect: "allow" }] };
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const started = starting("run", "alpha", "write the file");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const working = await run("threads");
    expect(working.io.lines[0]!.split("\n")[1]).toContain("Working");

    held.ask(0, ASKED);
    await vi.waitFor(async () => expect((await rt.sessions.list())[0]!.asking).toBe(askingLine(ASKED)));
    const waiting = await run("threads");
    expect(waiting.io.lines[0]!.split("\n")[1]).toContain("Needs you");

    held.release(0, "written");
    expect(await started.ended).toBe(0);
    const after = await run("threads");
    expect(after.io.lines[0]!.split("\n")[1]).toContain("Idle");
  });

  it("run --cwd is the folder the turn starts in, the same field the app's composer sends; without it the workspace's project folder, else none and the harness starts in its own home", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const picked = await run("run", "alpha", "--agent", "codex", "--cwd", "/root/work/elsewhere", "write tests");
    expect(picked.code).toBe(0);
    expect(codex.starts.map(s => s.cwd)).toEqual(["/root/work/elsewhere"]);

    const bare = await run("run", "alpha", "--agent", "claude", "hello");
    expect(bare.code).toBe(0);
    // No folder named: the thread opens in the workspace's project, which is what the workspace is a copy for.
    expect(claude.starts.map(s => s.cwd)).toEqual([alpha!.project.path]);
    const rows = await rt.sessions.list(alpha!.id);
    expect(rows.map(r => r.cwd)).toEqual(["/root/work/elsewhere", alpha!.project.path]);
    // A line that names no agent runs the one the last thread on this project used.
    expect((await run("run", "alpha", "again")).code).toBe(0);
    expect(claude.starts).toHaveLength(2);
  });

  it("run with no folder named starts the thread in the workspace's project, and --cwd wins over it", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const named = await run("run", "alpha", "build it");
    expect(named.code).toBe(0);
    expect(named.io.errors).toEqual([]);
    expect(claude.starts.map(s => s.cwd)).toEqual([alpha!.project.path]);
    const both = await run("run", "alpha", "--cwd", "/root/elsewhere", "build it");
    expect(both.code).toBe(0);
    expect(claude.starts.at(-1)!.cwd).toBe("/root/elsewhere");
    // The workspace is where the last thread went, which is what a run from nowhere takes.
    expect((await rt.preferences.get()).target).toEqual({ workspace: alpha!.id });
  });

  it("run from inside a project folder on this computer starts on that project's workspace and says so; outside a repo, or in one no project holds, it is refused in one line and nothing starts", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-repo-")));
    execFileSync("git", ["init", "-q", folder]);
    mkdirSync(join(folder, "packages", "api"), { recursive: true });
    const project = await projectOn(rt, HERE_PLACE_ID, folder);
    await run("new", project.name, "spoo");
    await run("new", cloud.name, "beta");
    const [spoo] = (await rt.workspaces.list()).filter(w => w.name === "spoo");
    const cwd = vi.spyOn(process, "cwd");
    try {
      // The git root is what is matched, from anywhere inside it.
      cwd.mockReturnValue(join(folder, "packages", "api"));
      const inferred = await run("run", "hello from the repo");
      expect(inferred.io.errors).toEqual([]);
      expect(inferred.code).toBe(0);
      const opened = (await rt.sessions.list()).find(t => t.prompt === "hello from the repo")!;
      expect(opened.workspaceId).toBe(spoo!.id);
      expect(claude.starts.at(-1)!.cwd).toBe(copyPathFor(folder, "spoo"));
      // A workspace named on the line still wins over the folder the run is in.
      const named = await run("run", "beta", "--agent", "claude", "named anyway");
      expect(named.code, named.io.errors.join("\n")).toBe(0);
      expect((await rt.sessions.list()).find(t => t.prompt === "named anyway")!.workspaceId).not.toBe(spoo!.id);

      const before = (await rt.sessions.list()).length;
      const other = join(dir, "code", "other");
      mkdirSync(join(other, ".git"), { recursive: true });
      cwd.mockReturnValue(other);
      const unheld = await run("run", "nowhere to go");
      expect(unheld.code).toBe(1);
      expect(unheld.io.errors).toEqual([`wsp run: ${noWorkspaceForFolderLine(other, "<workspace>")}`]);
      cwd.mockReturnValue(join(dir, "code"));
      const noRepo = await run("run", "nowhere to go");
      expect(noRepo.code).toBe(EXIT_CODES.usage);
      expect(noRepo.io.errors[0]).toContain(noThreadTargetLine("<workspace>"));
      expect((await rt.sessions.list()).length).toBe(before);
    } finally {
      cwd.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("a copy of a folder here takes none of the words a fork takes, and says which to drop", async () => {
    const folder = realpathSync(mkdtempSync(join(dir, "repo-flags-")));
    execFileSync("git", ["init", "-q", folder]);
    const here = await projectOn(rt, HERE_PLACE_ID, folder);
    for (const [word, value] of [["--from", "snap_p"], ["--size", "2x4"]] as const) {
      const said = await run("new", here.name, "work", word, value);
      expect(said.code).toBe(EXIT_CODES.usage);
      expect(said.io.errors[0]).toContain(copyTakesNone(here.name, [word]));
    }
    const engined = await run("new", here.name, "work", "--engine");
    expect(engined.code).toBe(EXIT_CODES.usage);
    expect(engined.io.errors[0]).toContain(copyTakesNone(here.name, ["--engine"]));
    // Nothing was made by any of the three, so the folder is still free for the workspace that names none of them.
    expect((await rt.workspaces.list()).filter(w => w.project.id === here.id)).toEqual([]);
    expect((await run("new", here.name, "work")).code).toBe(0);
  });

  it("projects lists every project this host holds, each on its computer, and a workspace row names the one it holds", async () => {
    const spoo = await projectOn(rt, undefined, "https://github.com/dev/spoo.git");
    await run("new", spoo.name, "alpha");
    const listed = await run("projects");
    expect(listed.code).toBe(0);
    expect(listed.io.errors).toEqual([]);
    const [heading, ...rows] = listed.io.lines[0]!.split("\n");
    expect(heading!.split(/ {2,}/)).toEqual(["PROJECT", "ID", "COMPUTER", "SOURCE", "PATH", "BASE", "WORKSPACES"]);
    expect(rows.map(r => r.split(/ {2,}/)).find(r => r[0] === "spoo")).toEqual(["spoo", spoo.id, spoo.computer, "https://github.com/dev/spoo.git", "/root/spoo", "1"]);

    // The computer's own word, never the place id: a project on the computer the host runs on reads as that
    // computer's own word, the same one the workspaces table gives its row.
    const folder = realpathSync(mkdtempSync(join(dir, "repo-here-")));
    execFileSync("git", ["init", "-q", folder]);
    const here = await projectOn(rt, HERE_PLACE_ID, folder);
    const both = await run("projects");
    const cell = both.io.lines[0]!.split("\n").map(r => r.split(/ {2,}/)).find(r => r[0] === here.name)!;
    // The host's own platform word: this Mac where the host runs on one, this computer on a Linux runner.
    expect(cell[2]).toBe(thisComputer(hostPlatform()));
    expect(cell[2]).not.toBe(HERE_PLACE_ID);
    const raw = await run("projects", "--json");
    expect((json(raw.io)[0] as { projects: { name: string }[] }).projects.map(p => p.name)).toContain("spoo");

    const workspaces = await run("workspaces");
    const table = workspaces.io.lines[0]!.split("\n");
    expect(table[0]!.split(/ {2,}/)).toEqual(["WORKSPACE", "ID", "PROJECT", "COMPUTER", "COPY", "PORTS", "SIZE", "STATE", "AGENTS"]);
    expect(table[1]!.split(/ {2,}/).slice(0, 3)).toEqual(["alpha", expect.stringMatching(/^ws_/), "spoo"]);
    // The verb takes no positional: the projects are the host's, not a workspace's.
    const extra = await run("projects", "nope");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors[0]).toMatch(/^wsp projects takes no positional arguments/);
  });

  it("fork --send --cwd starts the first thread in that folder; without it, in the project the fork holds", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const picked = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--cwd", "/root/work/site");
    expect(picked.code).toBe(0);
    expect(claude.starts.map(s => s.cwd)).toEqual(["/root/work/site"]);

    const plain = await run("fork", "alpha", "--name", "other", "--send", "build it");
    expect(plain.code).toBe(0);
    // A fork is a workspace of the same project, so its first thread opens in that project's folder.
    expect(claude.starts.map(s => s.cwd)).toEqual(["/root/work/site", alpha!.project.path]);
    const other = (await rt.workspaces.list()).find(w => w.name === "other")!;
    expect(other.project.id).toBe(alpha!.project.id);
  });

  it("--model, --effort and --access on run, fork --send and send reach the start as the fields the composer sends; a new thread without them runs the catalog's defaults, the ones the composer shows", async () => {
    await run("new", "alpha");
    const picked = await run("run", "alpha", "--model", "claude-sonnet-5", "--effort", "low", "--access", "plan", "review it");
    expect(picked.code).toBe(0);
    expect(claude.starts.map(s => [s.model, s.effort, s.permissionMode])).toEqual([["claude-sonnet-5", "low", "plan"]]);

    const bare = await run("run", "alpha", "hello");
    expect(bare.code).toBe(0);
    const shown = markedDefault(harnessCatalog("claude")!.models)!.value;
    expect(shown).toBe("claude-opus-5-5");
    const level = markedDefault(effortsFor(harnessCatalog("claude")!, markedDefault(harnessCatalog("claude")!.models) ?? null))!.value;
    expect(claude.starts.at(-1)).toMatchObject({ model: shown, effort: level });
    // The access is named too, and named explicitly: an unnamed one reached the adapter as nothing, which every
    // adapter here reads as its own skip-everything flag, so the picker's word and the CLI's flag could differ. It
    // is read off the workspace's own catalog, the list the composer draws, since which mode a start with no flag
    // runs at belongs to the kind of workspace the thread is on.
    const [alpha] = await rt.workspaces.list();
    const access = markedDefault((await rt.harnesses.list(alpha!.id)).find(c => c.harness === "claude")!.permissionModes)!.value;
    expect(access).toBe("bypassPermissions");
    expect(claude.starts.at(-1)!.permissionMode).toBe(access);
    const [, thread] = await rt.sessions.list();

    const same = await run("send", thread!.threadId!, "go on");
    expect(same.code).toBe(0);
    // A send that names nothing keeps the thread's own access rather than dropping back to the adapter's default.
    expect(claude.starts.at(-1)).toMatchObject({ resume: thread!.claudeSessionId, permissionMode: access });
    expect(claude.starts.at(-1)!.model).toBeUndefined();
    const changed = await run("send", thread!.threadId!, "--model", "claude-fable-5-1", "--effort", "max", "now think");
    expect(changed.code).toBe(0);
    // The access is not among them: the thread keeps its own, whichever door the message came through.
    expect(claude.starts.at(-1)).toMatchObject({ resume: thread!.claudeSessionId, model: "claude-fable-5-1", effort: "max", permissionMode: access });
    const named = await run("send", thread!.threadId!, "--access", "acceptEdits", "and now");
    expect(named.code).toBe(3);
    expect(named.io.errors).toEqual(['--access belongs to wsp fork and wsp run; wsp send does not read it. usage: wsp send <thread> [--model, --effort <value>] [--image <path>] [--detach] "<message>"']);

    const forked = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--model", "claude-sonnet-5", "--access", "bypassPermissions");
    expect(forked.code).toBe(0);
    expect(claude.starts.at(-1)).toMatchObject({ model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: level });
  });

  it("a thread on this computer runs every action without asking when the line names no access, and at the word the line names when it does", async () => {
    await macProject("mac");
    const bare = await run("run", "mac", "write the notes");
    expect(bare.code).toBe(0);
    // The owner's word for his own computer: a thread here does what a session he starts in his own terminal does.
    expect(claude.starts.at(-1)!.permissionMode).toBe("bypassPermissions");
    const picked = await run("run", "mac", "--access", "plan", "read the notes");
    expect(picked.code).toBe(0);
    expect(claude.starts.at(-1)!.permissionMode).toBe("plan");
    // The command line reads it off the same catalog the app's composer draws, so neither holds a default of its own.
    const [mac] = await rt.workspaces.list();
    const shown = (await rt.harnesses.list(mac!.id)).find(c => c.harness === "claude")!;
    expect(markedDefault(shown.permissionModes)?.value).toBe("bypassPermissions");
  });

  it("a model, effort or access mode the agent's catalog does not list is refused with that list, in the composer's words, and nothing starts", async () => {
    await run("new", "alpha");
    const model = await run("run", "alpha", "--model", "claude-haiku-4-5", "review it");
    expect(model.code).toBe(3);
    expect(model.io.errors).toEqual([`wsp run: model "claude-haiku-4-5" is not one claude takes; one of: Opus 5.5 (claude-opus-5-5), Fable 5.1 (claude-fable-5-1), Sonnet 5 (claude-sonnet-5), Haiku 4.5 (claude-haiku-4-5-20251001); legacy: Opus 5 (claude-opus-5), Opus 4.8 (claude-opus-4-8), Opus 4.7 (claude-opus-4-7), Opus 4.6 (claude-opus-4-6), Opus 4.5 (claude-opus-4-5), Fable 5 (claude-fable-5), Sonnet 4.6 (claude-sonnet-4-6), Sonnet 4.5 (claude-sonnet-4-5)${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`]);
    const effort = await run("run", "alpha", "--effort", "ultra", "review it");
    expect(effort.code).toBe(3);
    expect(effort.io.errors).toEqual([`wsp run: effort "ultra" is not one Opus 5.5 takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max)${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`]);
    const access = await run("fork", "alpha", "--send", "build it", "--access", "yolo");
    expect(access.code).toBe(3);
    expect(access.io.errors[0]).toMatch(/^wsp fork: access mode "yolo" is not one claude takes; one of: Default \(default\), Accept edits \(acceptEdits\), /);
    // Checked against the table before the fork is minted, for the named agent or the default one.
    const other = await run("fork", "alpha", "--send", "build it", "--agent", "codex", "--effort", "minimal");
    expect(other.code).toBe(3);
    expect(other.io.errors).toEqual([
      `wsp fork: effort "minimal" is not one GPT-5.6-Sol takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max), Ultra (ultra)${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`,
    ]);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(claude.starts).toEqual([]);
    expect(codex.starts).toEqual([]);
    expect(await rt.sessions.list()).toEqual([]);
    const dangling = await run("fork", "alpha", "--model", "claude-sonnet-5");
    expect(dangling.code).toBe(3);
    expect(dangling.io.errors).toEqual(['wsp fork: --model says how a thread opens, and this line opens none. Add --send "<task>", or drop --model.']);
  });

  it("a refusal off wsp's built-in list says so, and one off the machine's own answer does not", async () => {
    await run("new", "alpha");
    const described = { version: "0.153.0", models: [{ slug: "gpt-5.6-sol", label: "GPT-5.6-Sol", contextWindows: [], isDefault: true }], efforts: ["low", "high"], permissionModes: ["read-only"] };
    backend.execImpl = (_m, cmd) => (cmd === PROBE_CMD ? { exitCode: 0, stdout: JSON.stringify(described), stderr: "" } : guestAnswer(cmd));
    const [alpha] = await rt.workspaces.list();
    // The claude here describes nothing, so the list its refusal quotes is wsp's own table; the codex describes
    // itself, so its refusal quotes the machine's own answer.
    const listed = await rt.harnesses.list(alpha!.id);
    expect(listed.find(c => c.harness === "claude")!.source).toBe("table");
    expect(listed.find(c => c.harness === "codex")!.source).toBe("harness");
    const table = await run("run", "alpha", "--model", "claude-opus-4-1", "review it");
    expect(table.code).toBe(3);
    expect(table.io.errors[0]).toContain("that list is wsp's built-in one");
    expect(table.io.errors[0]).toContain("the agent on its machine may take more");
    expect(table.io.errors).toHaveLength(1);

    const own = await run("run", "alpha", "--agent", "codex", "--model", "gpt-4", "review it");
    expect(own.code).toBe(3);
    // The machine's own agent named its models, so there is nothing to warn the person about.
    expect(own.io.errors).toEqual(['wsp run: model "gpt-4" is not one codex takes; one of: GPT-5.6-Sol (gpt-5.6-sol). Drop the flag, or give it a value the agent offers.']);
    expect(claude.starts).toEqual([]);
    expect(codex.starts).toEqual([]);
  });

  it("a refusal off wsp's built-in list that quotes no list says whose word it is, as one sentence", async () => {
    await run("new", "alpha");
    const none = await run("run", "alpha", "--model", "claude-haiku-4-5-20251001", "--effort", "high", "review it");
    expect(none.code).toBe(3);
    expect(none.io.errors).toEqual([`wsp run: Haiku 4.5 takes no effort${BUILT_IN_TABLE_CLAUSE}. Drop the flag, or give it a value the agent offers.`]);
    expect(BUILT_IN_TABLE_CLAUSE).toBe("; wsp's built-in table says so, since no agent on that workspace described itself");
    expect(claude.starts).toEqual([]);
  });

  it("runs a legacy model at an effort the binary lists for it", async () => {
    await run("new", "alpha");
    const older = await run("run", "alpha", "--model", "claude-opus-5", "--effort", "high", "review it");
    expect(older.code).toBe(0);
    expect(claude.starts.map(s => [s.model, s.effort])).toEqual([["claude-opus-5", "high"]]);
  });

  it("checks a pick against the workspace's own machine, so a model only that machine knows is taken here as the app takes it", async () => {
    await run("new", "alpha");
    // A machine routed to another model provider: its codex names a model no table carries, and the app's composer
    // takes it because sessions.start checks the probed catalog. The command line has to agree with the app.
    const routed = {
      version: "0.153.0",
      models: [{ slug: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", contextWindows: [], isDefault: true }],
      efforts: ["low", "high"],
      permissionModes: ["read-only"],
    };
    backend.execImpl = (_m, cmd) => (cmd === PROBE_CMD ? { exitCode: 0, stdout: JSON.stringify(routed), stderr: "" } : guestAnswer(cmd));
    const opened = await run("run", "alpha", "--agent", "codex", "--model", "anthropic/claude-sonnet-4.5", "--effort", "high", "go");
    expect(opened.code).toBe(0);
    expect(codex.starts.at(-1)).toMatchObject({ model: "anthropic/claude-sonnet-4.5", effort: "high" });
    // The same list refuses a table model that machine does not have, naming the machine's own, and a fork checks
    // the workspace it forks from, whose golden the new machine comes from.
    const forked = await run("fork", "alpha", "--send", "go", "--agent", "codex", "--model", "gpt-5.5");
    expect(forked.code).toBe(3);
    expect(forked.io.errors).toEqual(['wsp fork: model "gpt-5.5" is not one codex takes; one of: anthropic/claude-sonnet-4.5 (anthropic/claude-sonnet-4.5). Drop the flag, or give it a value the agent offers.']);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
  });

  it("a --cwd that is not absolute is refused with the usage line before anything is created, started or dialled; fork's --cwd needs --send", async () => {
    await run("new", "alpha");
    const relative = await run("run", "alpha", "--cwd", "packages/host", "look here");
    expect(relative.code).toBe(3);
    // The usage the refusal carries is the verb's own, whatever its groups are; the words before it are the rule.
    expect(relative.io.errors).toEqual([`--cwd is a path on the machine, absolute, and got "packages/host". Give a path that opens with /, since whoever reads it works in a folder this line cannot see. usage: ${CLI_VERBS.find(v => v.name === "run")!.usage}`]);
    const forked = await run("fork", "alpha", "--send", "build it", "--cwd", "packages/host");
    expect(forked.code).toBe(3);
    expect(forked.io.errors[0]).toMatch(/^--cwd is a path on the machine, absolute, and got "packages\/host"\..* usage: wsp fork /);
    const dangling = await run("fork", "alpha", "--cwd", "/root/work");
    expect(dangling.code).toBe(3);
    expect(dangling.io.errors).toEqual(['wsp fork: --cwd says how a thread opens, and this line opens none. Add --send "<task>", or drop --cwd.']);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await rt.sessions.list()).toEqual([]);
    expect(claude.starts).toEqual([]);
  });

  it("projects shortens a path that would not fit its column with an ellipsis at the front, keeping the end a person recognises", async () => {
    const deep = await projectOn(rt, undefined, "https://github.com/dev/a-project-with-a-very-long-name-indeed-and-then-some-more.git", { name: "a-project-with-a-very-long-name-indeed-and-then-some-more-again" });
    const { io } = await run("projects");
    const line = io.lines[0]!.split("\n").find(r => r.startsWith(deep.name))!;
    expect(line).toContain("…");
    expect(line).toContain(deep.path.slice(-20));
    expect(line).not.toContain(deep);
    // The path is cut for the column and whole on the wire.
    const asJson = await run("projects", "--json");
    const [{ projects }] = json(asJson.io) as [{ projects: { name: string; path: string }[] }];
    expect(projects.find(p => p.name === deep.name)!.path).toBe(deep.path);
  });

  it("threads shows a multi-paragraph brief as one row, titled by the protocol's rule: its first sentence cut at a word to 48 characters, the same title the sidebar shows", async () => {
    await run("new", "alpha");
    const brief = "You are a builder for the wsp repo, which is at /Users/zingzy/wsp on this machine.\n\nTicket: Zingzy/wsp-map#292.\nBuild: the fix.";
    await run("run", "alpha", brief);
    const { io } = await run("threads");
    const rows = io.lines[0]!.split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/  You are a builder for the wsp repo, which is at…\s*$/);
    const asJson = await run("threads", "--json");
    const [{ threads }] = json(asJson.io) as [{ threads: ThreadView[] }];
    expect(threads[0]!.title).toBe("You are a builder for the wsp repo, which is at…");
  });

  it("send resumes the thread's latest session under its own agent; the thread keeps its id and who opened it", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    await run("run", "alpha", "--agent", "codex", "first");
    await (await rt.sessions.start(alpha!.id, { prompt: "from the app", harness: "claude" })).finished;
    const [byCli, byPerson] = await rt.sessions.list();
    const { code, io } = await run("send", byCli!.threadId!, "second");
    expect(code).toBe(0);
    expect(codex.starts.map(s => [s.prompt, s.resume])).toEqual([["first", undefined], ["second", byCli!.claudeSessionId]]);
    expect(io.lines).toEqual(["codex: second"]);
    expect(io.streamed).toBe("code\n$ ls\nx: second\ncompleted\n");
    const followUp = await run("send", byPerson!.threadId!, "and this");
    expect(followUp.code).toBe(0);
    expect(claude.starts.map(s => [s.prompt, s.resume])).toEqual([["from the app", undefined], ["and this", byPerson!.claudeSessionId]]);

    // Every start the verbs made carries its own request id on the wire and on the recorded start, so an app view with
    // the same text in flight cannot take it for its own; the app's start through the runtime sent none.
    const requestIds = (await rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start").map(e => e.requestId);
    expect(requestIds.map(id => typeof id)).toEqual(["string", "undefined", "string", "string"]);
    expect(new Set(requestIds).size).toBe(4);

    // A resumed turn takes over its thread's row, as the app sees it too: one row per thread, the opener kept.
    const listed = await run("threads", "--json");
    const [{ threads }] = json(listed.io) as [{ threads: ThreadView[] }];
    expect(threads.map(t => [t.id, t.harness, t.startedBy, t.title, t.turns])).toEqual([
      [byCli!.threadId, "codex", "cli", "first", 1],
      [byPerson!.threadId, "claude", "person", "from the app", 1],
    ]);

    const prefixed = await run("send", byCli!.threadId!.slice(0, 8), "third");
    expect(prefixed.code).toBe(0);
    const missing = await run("send", "nope", "x");
    expect(missing.io.errors).toEqual(["wsp send: no thread nope"]);
  });

  it("send into a thread whose turn runs joins that turn when the agent steers: one stderr line, the running turn's reply, one session.start and one session.steer", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const first = run("run", "alpha", "loop for a minute, then say done");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const sent = run("send", row!.threadId!, "--model", "claude-sonnet-5", "--effort", "low", "end your last line with STEERED");
    await vi.waitFor(() => expect(held.steered).toEqual(["end your last line with STEERED"]));
    expect(held.starts).toHaveLength(1);
    held.release(0, "done STEERED");
    const opened = await first;
    const joined = await sent;
    expect(joined.code).toBe(0);
    // The picks cannot change a turn already running; the one line says which were dropped.
    expect(joined.io.errors).toEqual(["joined the running turn; --model, --effort dropped, it keeps its own model, effort and access"]);
    expect(joined.io.lines).toEqual(["done STEERED"]);
    expect(joined.io.streamed).toBe("done STEERED\ncompleted\n");
    expect(opened.io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`, "done STEERED"]);
    const [alpha] = await rt.workspaces.list();
    const history = await rt.sessions.history(alpha!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
    expect(history[1]).toMatchObject({ type: "session.steer", prompt: "end your last line with STEERED", requestId: expect.any(String) });
    expect(await rt.sessions.list()).toHaveLength(1);
  });

  it("a message that joined a turn stopped on a prompt says the turn is waiting on the person, so the quiet has a reason", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const first = run("run", "alpha", "write it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    held.ask(0, { askId: "a1", toolName: "Write", input: JSON.stringify({ file_path: "kai.txt" }), options: [{ id: "allow", label: "Yes", effect: "allow" }, { id: "deny", label: "No", effect: "deny" }] });
    const [row] = await rt.sessions.list();
    const io = captured();
    const sent = cli(["send", row!.threadId!, "yes", "--state", statePath], io, undefined, env);
    await vi.waitFor(() => expect(io.errors).toEqual(["joined the running turn", `the turn is waiting on a permission; wsp threads shows it as ${threadStateWord("waiting")}`]));
    held.release(0, "done");
    expect(await sent).toBe(0);
    await first;
  });

  it("send into a thread whose turn runs on an agent that cannot steer waits for that turn, then starts its own: one stderr line, the second start after the first done", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const first = run("run", "alpha", "one");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const sent = run("send", row!.threadId!, "two");
    await new Promise(r => setTimeout(r, 50));
    expect(held.starts).toHaveLength(1);
    held.release(0, "one done");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    expect(held.starts.map(s => [s.prompt, s.resume])).toEqual([["one", undefined], ["two", row!.claudeSessionId]]);
    expect((await first).io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`, "one done"]);
    held.release(1, "two done");
    const queued = await sent;
    expect(queued.code).toBe(0);
    expect(queued.io.errors).toEqual(["waiting behind the running turn", "queued behind the running turn; it has ended and this turn started"]);
    expect(queued.io.lines).toEqual(["two done"]);
    const [alpha] = await rt.workspaces.list();
    expect((await rt.sessions.history(alpha!.id)).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end", "session.start", "session.delta", "session.done", "session.end"]);
    expect(held.steered).toEqual([]);
  });

  it("stop ends the thread's running turn through the runtime and says so; a thread whose turn is over says not running; the machine stays up", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const first = run("run", "alpha", "loop forever");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const stopped = await run("stop", row!.threadId!.slice(0, 8));
    expect(stopped.code).toBe(0);
    expect(stopped.io.lines).toEqual([`thread ${row!.threadId} stopped`]);
    expect(held.interrupted).toEqual([row!.id]);
    const opened = await first;
    expect(opened.code).toBe(1);
    expect(opened.io.errors).toEqual(["wsp run: turn interrupted"]);
    expect((await rt.sessions.list())[0]).toMatchObject({ id: row!.id, status: "interrupted" });
    const [alpha] = await rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
    expect(backend.machines[0]).toMatchObject({ paused: false, killed: false });

    const idle = await run("stop", row!.threadId!, "--json");
    expect(idle.code).toBe(0);
    expect(json(idle.io)).toEqual([{ threadId: row!.threadId, outcome: "not-running" }]);
    expect(held.interrupted).toHaveLength(1);
    const missing = await run("stop", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp stop: no thread nope"]);
  });

  it("thread rename names the thread in the agent's own store and says so; an agent that keeps no name, one whose store has no such session, and an unknown thread each say why", async () => {
    const named = scriptedAgent(prompt => `re: ${prompt}`, title => (title === "nowhere" ? { kind: "no-session" } : title === "locked" ? { kind: "failed", error: "database is locked" } : { kind: "written" }));
    await restartHost({ claude: named.adapter, codex: codex.adapter });
    await run("new", "alpha");
    await run("run", "alpha", "build it");
    const [row] = await rt.sessions.list();

    const renamed = await run("thread", "rename", row!.threadId!.slice(0, 8), "the name he typed");
    expect(renamed.code).toBe(0);
    expect(renamed.io.lines).toEqual([`thread ${row!.threadId} named the name he typed, in Claude Code too`]);
    expect(named.renames).toEqual([{ sessionId: row!.claudeSessionId, title: "the name he typed" }]);
    expect(ThreadView.parse((await threadRows(await dialHost(statePath)))[0]).title).toBe("the name he typed");

    const nowhere = await run("thread", "rename", row!.threadId!, "nowhere", "--json");
    expect(nowhere.code).toBe(0);
    expect(json(nowhere.io)).toEqual([{ threadId: row!.threadId, title: "nowhere", harness: "claude", outcome: "no-session" }]);

    // A store that refused the write says nothing about its sessions, so its own line is the answer, not "no such session".
    const locked = await run("thread", "rename", row!.threadId!, "locked");
    expect(locked.code).toBe(0);
    expect(locked.io.lines).toEqual([`thread ${row!.threadId} not named: database is locked`]);
    expect(json((await run("thread", "rename", row!.threadId!, "locked", "--json")).io)).toEqual([
      { threadId: row!.threadId, title: "locked", harness: "claude", outcome: "failed", error: "database is locked" },
    ]);

    await run("run", "alpha", "--agent", "codex", "build it there");
    const codexRow = (await rt.sessions.list()).find(v => v.harness === "codex")!;
    const unsupported = await run("thread", "rename", codexRow.threadId!, "the name");
    expect(unsupported.code).toBe(0);
    expect(unsupported.io.lines).toEqual([`thread ${codexRow.threadId} not named: Codex keeps no name of a person's for a session`]);

    const missing = await run("thread", "rename", "nope", "the name");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp thread rename: no thread nope"]);
    const short = await run("thread", "rename", row!.threadId!);
    expect(short.code).toBe(3);
    expect(short.io.errors).toEqual(["wsp thread rename takes a thread and one name. usage: wsp thread rename <thread> \"<title>\""]);
  });

  it("thread rename wakes a napping workspace first, since the name goes into a store on its machine", async () => {
    const named = scriptedAgent(prompt => `re: ${prompt}`, () => ({ kind: "written" }));
    await restartHost({ claude: named.adapter });
    await run("new", "alpha");
    await run("run", "alpha", "build it");
    const [row] = await rt.sessions.list();
    await run("pause", "alpha");
    const renamed = await run("thread", "rename", row!.threadId!, "the name");
    expect(renamed.code).toBe(0);
    expect(renamed.io.errors).toEqual(["waking alpha"]);
    expect(named.renames).toEqual([{ sessionId: row!.claudeSessionId, title: "the name" }]);
    const [alpha] = await rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
  });

  it("run --notify me prints the thread's end once on stderr, after the reply, and records it in the thread", async () => {
    await run("new", "alpha");
    const { code, io } = await run("run", "alpha", "--notify", "me", "build it");
    expect(code).toBe(0);
    const [row] = await rt.sessions.list();
    const line = `thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`;
    expect(io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`, "re: build it"]);
    expect(io.errors).toEqual([line]);
    const [alpha] = await rt.workspaces.list();
    const history = await rt.sessions.history(alpha!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.notify", "session.done", "session.end"]);
    expect(history[4]).toMatchObject({ type: "session.notify", notify: "me", text: line, threadId: row!.threadId });

    const later = await run("send", row!.threadId!, "and the docs");
    expect(later.io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: and the docs`]);
    expect(later.io.lines).toEqual(["re: and the docs"]);
  });

  it("run --notify <thread> tells that thread, by a prefix of its id, when the child ends: the running parent takes the line as a steer and the child's command prints no notice", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const parent = run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    const kid = run("run", "alpha", "--notify", parentRow!.threadId!.slice(0, 8), "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    const built = await kid;
    expect(built.code).toBe(0);
    expect(built.io.lines).toEqual([`thread ${kidRow.threadId} · ${THREAD_PREFIX_WORD}`, "all green"]);
    expect(built.io.errors).toEqual([]);
    held.release(0, "read the report");
    expect((await parent).io.lines).toEqual([`thread ${parentRow!.threadId} · ${THREAD_PREFIX_WORD}`, "read the report"]);
    expect(held.starts).toHaveLength(2);
    const [alpha] = await rt.workspaces.list();
    const history = await rt.sessions.history(alpha!.id);
    expect(history.filter(e => e.threadId === parentRow!.threadId).map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
    expect(history.find(e => e.type === "session.steer")).toMatchObject({ prompt: line });
    expect(history.find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });

    const missing = await run("run", "alpha", "--notify", "nope", "x");
    expect(missing.io.errors).toEqual(["wsp run: no thread nope"]);
    expect(held.starts).toHaveLength(2);
  });

  it("--notify me run inside a turn names that turn's thread: the command line reads the token off the environment it runs with, and the parent is steered the child's report whole", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const parent = run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    // The environment the host launched that turn under is the one a wsp inside it would run with.
    const token = held.envs[0]![TURN_TOKEN_ENV]!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    env[TURN_TOKEN_ENV] = token;
    const kid = run("run", "alpha", "--notify", "me", "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "Ran the gate.\nAll 12 tests green.");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): Ran the gate.\nAll 12 tests green.`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    const built = await kid;
    expect(built.code).toBe(0);
    // The child's own command prints no notice: the line went to the thread that asked for it, not to the person.
    expect(built.io.errors).toEqual([]);
    const [alpha] = await rt.workspaces.list();
    expect((await rt.sessions.history(alpha!.id)).find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });
    held.release(0, "read the report");
    await parent;
  });

  // The one command line that reads the process's own environment is the one a person runs: every case here hands
  // its environment in, so without this case a refactor could take TURN_TOKEN_ENV away from the real command line and
  // nothing would say so. It sets the variable it reads, in its own process, which is what the environment law asks.
  it("cli called with no environment of its own reads this process's, which is what a shell gives it", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const parent = run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    vi.stubEnv(TURN_TOKEN_ENV, held.envs[0]![TURN_TOKEN_ENV]!);
    // No fourth argument: the default, which is this process's environment and nothing the case handed in.
    const io = captured();
    const kid = cli(["run", "alpha", "--notify", "me", "build it", "--state", statePath], io);
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    // The token arrived: the runtime resolved NOTIFY_ME to the turn it named and steered that thread.
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    expect(await kid).toBe(0);
    held.release(0, "read the report");
    await parent;
  });

  it("--notify repeats: a builder's end reaches the orchestrator that started it and a reviewer thread, each once", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const orchestrator = run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const reviewer = run("run", "alpha", "review what lands");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const rows = await rt.sessions.list();
    const [leadRow, reviewRow] = rows;
    env[TURN_TOKEN_ENV] = held.envs[0]![TURN_TOKEN_ENV]!;
    const kid = run("run", "alpha", "--notify", "me", "--notify", reviewRow!.threadId!.slice(0, 8), "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(3));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== leadRow!.threadId && r.threadId !== reviewRow!.threadId)!;
    held.release(2, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line, line]));
    expect((await kid).code).toBe(0);
    const [alpha] = await rt.workspaces.list();
    const told = (await rt.sessions.history(alpha!.id)).filter(e => e.type === "session.notify");
    expect(told.map(e => e.notify)).toEqual([leadRow!.threadId, reviewRow!.threadId]);
    expect(told.map(e => e.text)).toEqual([line, line]);
    held.release(0, "read the report");
    held.release(1, "reviewed");
    await orchestrator;
    await reviewer;
  });

  it("--notify me with no token in the environment is still the person's, so a person's own shell and the app are unchanged", async () => {
    await run("new", "alpha");
    expect(env[TURN_TOKEN_ENV]).toBeUndefined();
    const { code, io } = await run("run", "alpha", "--notify", "me", "build it");
    expect(code).toBe(0);
    const [row] = await rt.sessions.list();
    expect(io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`]);
    const [alpha] = await rt.workspaces.list();
    expect((await rt.sessions.history(alpha!.id)).find(e => e.type === "session.notify")).toMatchObject({ notify: "me" });
  });

  it("a token no turn on this host carries is refused, and nothing starts", async () => {
    await run("new", "alpha");
    env[TURN_TOKEN_ENV] = "f".repeat(32);
    const { code, io } = await run("run", "alpha", "--notify", "me", "build it");
    expect(code).toBe(EXIT_CODES.provider);
    expect(io.errors).toEqual([`wsp run: ${NO_SUCH_TURN}`]);
    expect(io.lines).toEqual([]);
    expect(await rt.sessions.list()).toEqual([]);
  });

  it("fork --send --notify me prints the first turn's end on stderr as run does; a bad --notify fails before any machine is minted", async () => {
    await run("new", "alpha");
    const { code, io } = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--notify", "me");
    expect(code).toBe(0);
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    const [row] = await rt.sessions.list(worker.id);
    expect(io.lines).toEqual([`created worker ${worker.id}, a copy of ${worker.project.name} at ${worker.project.path}`, `thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`, "re: build it"]);
    expect(io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`]);

    const bad = await run("fork", "alpha", "--name", "never", "--send", "build it", "--notify", "nope");
    expect(bad.code).toBe(EXIT_CODES.usage);
    expect(bad.io.lines).toEqual([]);
    expect(bad.io.errors).toEqual(["wsp fork: no thread nope"]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "worker"]);
  });

  it("send --json prints the turn's raw events and nothing else", async () => {
    await run("new", "alpha");
    await run("run", "alpha", "first");
    const [first] = await rt.sessions.list();
    const { code, io } = await run("send", first!.threadId!, "second", "--json");
    expect(code).toBe(0);
    const events = json(io) as { type: string; threadId?: string; kind?: string; text?: string }[];
    expect(events.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.done", undefined]);
    expect(events.at(-1)).toEqual({ threadId: first!.threadId, workspaceId: first!.workspaceId, harness: "claude", text: "re: second", outcome: "started" });
    expect(new Set(events.map(e => e.threadId))).toEqual(new Set([first!.threadId]));
    expect(events[1]).toMatchObject({ kind: "text", text: "re: " });
    expect(io.streamed).toBe("");
  });

  it("run --detach and send --detach print the thread id and return the moment the turn is started, before it ends; nothing streams", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const opened = await run("run", "alpha", "--detach", "build it");
    expect(held.starts).toHaveLength(1);
    const [row] = await rt.sessions.list();
    expect(row).toMatchObject({ status: "running", startedBy: "cli", prompt: "build it" });
    expect(opened.code).toBe(0);
    expect(opened.io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`]);
    expect(opened.io.errors).toEqual([]);
    expect(opened.io.streamed).toBe("");
    held.release(0, "first done");
    expect((await rt.sessions.list())[0]!.status).toBe("completed");
    const sent = await run("send", row!.threadId!.slice(0, 8), "--detach", "--json", "more");
    expect(held.starts.map(s => s.prompt)).toEqual(["build it", "more"]);
    expect(sent.code).toBe(0);
    expect(json(sent.io)).toEqual([{ threadId: row!.threadId, workspaceId: row!.workspaceId, harness: "claude", outcome: "started" }]);
    expect((await rt.sessions.list())[0]!.status).toBe("running");
    held.release(1, "second done");
    // A detached send that meets a running turn on an agent that cannot steer waits for its own start, as a followed one does, and says so.
    const third = await run("send", row!.threadId!, "--detach", "third");
    expect(third.io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`]);
    expect(held.starts).toHaveLength(3);
    const fourth = starting("send", row!.threadId!, "--detach", "fourth");
    // The waiting line is the runtime's answer that this start is behind the running turn: releasing that turn before
    // the line lands leaves the fourth start nothing to queue behind, so the fact is waited on and not a sleep.
    await vi.waitFor(() => expect(fourth.io.errors).toEqual(["waiting behind the running turn"]), { timeout: 10_000, interval: 10 });
    expect(held.starts).toHaveLength(3);
    held.release(2, "third done");
    await fourth.ended;
    expect(fourth.io.errors).toEqual(["waiting behind the running turn", "queued behind the running turn; it has ended and this turn started"]);
    expect(fourth.io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`]);
    expect(held.starts.map(s => s.prompt)).toEqual(["build it", "more", "third", "fourth"]);
    held.release(3, "fourth done");
  });

  it("threads wait returns the first of two threads to finish, in the notify line's words, then the second; a thread already over comes back at once from its transcript; a timeout prints nothing on stdout and says so on stderr", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    await run("run", "alpha", "--detach", "--notify", "me", "build a");
    await run("run", "alpha", "--detach", "build b");
    const [a, b] = await rt.sessions.list();
    const timedOut = await run("threads", "wait", a!.threadId!, b!.threadId!.slice(0, 8), "--timeout", "0.05");
    expect(timedOut.code).toBe(0);
    expect(timedOut.io.lines).toEqual([]);
    expect(timedOut.io.errors).toEqual(["2 threads still running after 50ms"]);
    const asJson = await run("threads", "wait", a!.threadId!, "--timeout", "0.05", "--json");
    expect(json(asJson.io)).toEqual([{ timedOut: true }]);
    expect(asJson.io.errors).toEqual([`thread ${a!.threadId!.slice(0, 8)} still running after 50ms`]);

    const waiting = run("threads", "wait", a!.threadId!, b!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    held.release(1, "b is green\nall done for b");
    const first = await waiting;
    expect(first.code).toBe(0);
    // The whole reply under the finished line, not its last line: Marco waited on two threads and read a closing
    // remark off one and a code fence off the other, with the answers he was waiting for nowhere on his screen.
    expect(first.io.lines).toEqual([`thread ${b!.threadId!.slice(0, 8)} finished (completed): b is green\nall done for b`]);
    expect(first.io.lines[0]).toBe(notifyLine(b!.threadId!, { status: "completed", text: "b is green\nall done for b" }, "whole"));
    expect(first.io.errors).toEqual([]);
    // --tail is the last line alone, the line a notify sends; b is over, so it comes back at once.
    const tail = await run("threads", "wait", b!.threadId!, "--tail");
    expect(tail.code).toBe(0);
    expect(tail.io.lines).toEqual([`thread ${b!.threadId!.slice(0, 8)} finished (completed): all done for b`]);
    // b is over, so a wait naming both comes back with b at once, read off the transcript; the JSON is the tool's object.
    const again = await run("threads", "wait", a!.threadId!, b!.threadId!, "--json");
    expect(again.code).toBe(0);
    expect(json(again.io)).toEqual([{ finished: { threadId: b!.threadId, status: "completed", reply: "all done for b" } }]);

    const onlyA = run("threads", "wait", a!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    held.release(0, "a done");
    const second = await onlyA;
    expect(second.io.lines).toEqual([`thread ${a!.threadId!.slice(0, 8)} finished (completed): a done`]);
    // The words are the one formatter's: the line the runtime recorded for a's --notify me is the line the wait printed.
    const history = await rt.sessions.history(a!.workspaceId);
    expect(history.find(e => e.type === "session.notify" && e.threadId === a!.threadId)).toMatchObject({ text: second.io.lines[0] });
    expect(second.io.lines[0]).toBe(notifyLine(a!.threadId!, { status: "completed", text: "a done" }));
    expect(held.starts).toHaveLength(2);

    const none = await run("threads", "wait");
    expect(none.code).toBe(3);
    expect(none.io.errors[0]).toContain("wsp threads wait takes one thread or more");
    const soon = await run("threads", "wait", a!.threadId!, "--timeout", "soon");
    expect(soon.code).toBe(3);
    expect(soon.io.errors[0]).toContain('--timeout takes seconds, a number above zero, and got "soon".');
    const missing = await run("threads", "wait", a!.threadId!, "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp threads wait: no thread nope"]);
    // One word is the workspace it lists; two is more than the line takes.
    const stray = await run("threads", "nope", "also");
    expect(stray.code).toBe(3);
    expect(stray.io.errors[0]).toContain("wsp threads takes at most one workspace; wsp threads wait is its one subcommand");
    // Marco typed wsp threads read <thread> and this refusal was where he learned there was no such line; it names
    // the one there is.
    expect(stray.io.errors[0]).toContain("wsp thread read <thread> prints what one said");
  });

  it("threads wait on a thread whose first turn has not reached the machine blocks for that turn; the same thread once its turn is over comes back at once with its finished line", async () => {
    const held = heldAgent(false);
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    // The harness's own lists come off the machine before the turn is launched: seconds on a real machine, and the
    // window this case is about.
    await restartHost({ claude: ctx => ({ ...held.adapter(ctx), probeCatalog: async () => (await probed, null) }) });
    await run("new", "alpha");
    const [ws] = await rt.workspaces.list();
    const starting = rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await rt.sessions.list())[0]!.threadId!;
    expect(held.starts).toHaveLength(0);

    let answered = false;
    const waiting = run("threads", "wait", thread, "--timeout", "3600").then(r => ((answered = true), r));
    await new Promise(r => setTimeout(r, 50));
    expect(answered).toBe(false);
    letProbe();
    await starting;
    expect(held.starts.map(s => s.prompt)).toEqual(["build it"]);
    // Still nothing: the turn the wait was told to wait for is only now running.
    await new Promise(r => setTimeout(r, 50));
    expect(answered).toBe(false);
    held.release(0, "all green");
    const finished = await waiting;
    expect(finished.code).toBe(0);
    expect(finished.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);

    const again = await run("threads", "wait", thread);
    expect(again.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);

    // A thread whose launch never reached the machine has no turn and never will; the wait answers at once for it too.
    await restartHost({ claude: bornDeadAgent(prompt => `re: ${prompt}`).adapter });
    await run("run", "alpha", "--detach", "never lands");
    const stillborn = (await rt.sessions.list()).find(r => r.prompt === "never lands")!;
    const atOnce = await run("threads", "wait", stillborn.threadId!);
    expect(atOnce.code).toBe(0);
    expect(atOnce.io.lines).toEqual([`thread ${stillborn.threadId!.slice(0, 8)} finished (failed): ${UNREACHED_LINE}`]);
  });

  it("a wait in flight on a thread whose launch gives up gets that thread's finished line, with the reason the start failed with", async () => {
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const WOULD_NOT_LAUNCH = "the agent binary is not on this machine";
    await restartHost({
      claude: () => ({
        steers: false,
        probeCatalog: async () => (await probed, null),
        start: () => {
          throw new Error(WOULD_NOT_LAUNCH);
        },
      }),
    });
    await run("new", "alpha");
    const [ws] = await rt.workspaces.list();
    const giving = rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await rt.sessions.list())[0]!.threadId!;

    let answered = false;
    const waiting = run("threads", "wait", thread, "--timeout", "3600").then(r => ((answered = true), r));
    await new Promise(r => setTimeout(r, 50));
    expect(answered).toBe(false);
    letProbe();
    await expect(giving).rejects.toThrow(WOULD_NOT_LAUNCH);
    // The turn will never run, so the wait is answered rather than left holding a thread that went away under it.
    const finished = await waiting;
    expect(finished.code).toBe(0);
    expect(finished.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (failed): ${WOULD_NOT_LAUNCH}`]);
    expect(finished.io.errors).toEqual([]);
    // No turn ran under it, so the thread is not one the sidebar lists or a later wait can name.
    expect(await threadRows(await dialHost(statePath))).toEqual([]);
    const later = await run("threads", "wait", thread);
    expect(later.code).toBe(EXIT_CODES.usage);
    expect(later.io.errors).toEqual([`wsp threads wait: no thread ${thread}`]);
  });

  it("a wait whose thread gives up between naming it and subscribing to it answers finished (failed) at once: a named thread with no row on the second read is over", async () => {
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    await restartHost({
      claude: () => ({
        steers: false,
        probeCatalog: async () => (await probed, null),
        start: () => {
          throw new Error("the agent binary is not on this machine");
        },
      }),
    });
    await run("new", "alpha");
    const [ws] = await rt.workspaces.list();
    const giving = rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await rt.sessions.list())[0]!.threadId!;
    const client = await dialHost(statePath);
    try {
      // The verb's two steps, with the give-up between them: the thread is named off one listing, and by the time
      // the wait subscribes and lists again, the row and the end that answered for it are both gone.
      const named = await threadsOf(client, [thread]);
      expect(named.map(t => t.status)).toEqual(["running"]);
      letProbe();
      await expect(giving).rejects.toThrow("the agent binary is not on this machine");
      expect(await firstEnded(client, named, 1_000)).toEqual({ ended: { threadId: thread, result: { status: "failed" } } });
    } finally {
      client.close();
    }
  });

  it("a send that never launches on a thread that has worked leaves every reading of its last turn alone: the table, the read, the reply and the wait all say what that turn came to", async () => {
    const held = heldAgent(false);
    let launches = 0;
    await restartHost({
      claude: ctx => {
        const inner = held.adapter(ctx);
        return {
          ...inner,
          start: o => {
            if (++launches > 1) throw new Error("the harness would not launch");
            return inner.start(o);
          },
        };
      },
    });
    await run("new", "alpha");
    await run("run", "alpha", "--detach", "build it");
    const thread = (await rt.sessions.list())[0]!.threadId!;
    held.release(0, "the build is green\nall green");
    await vi.waitFor(async () => expect((await rt.sessions.list())[0]!.status).toBe("completed"), { timeout: 10_000, interval: 10 });

    const [ws] = await rt.workspaces.list();
    await expect(rt.sessions.start(ws!.id, { prompt: "and then this", thread })).rejects.toThrow("the harness would not launch");

    // One fact, how the thread's last turn went, and every door still gives the same answer.
    const listed = await threadRows(await dialHost(statePath));
    expect(listed.map(t => [t.id, t.status, t.turns])).toEqual([[thread, "completed", 1]]);
    expect((await run("thread", "read", thread, "--last")).io.lines[0]).toContain("the build is green\nall green");
    expect((await run("thread", "read", thread)).io.lines[0]).toContain("the build is green\nall green");
    expect((await run("threads", "wait", thread)).io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): the build is green\nall green`]);
    expect((await run("threads", "wait", thread, "--tail")).io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);
  });

  it("threads wait on a turn the runtime ended says failed with the runtime's reason, as the notify line would; a turn the transport cut says the cut line", async () => {
    await restartHost({ claude: stuckAgent() });
    await run("new", "alpha");
    await run("run", "alpha", "--detach", "loop forever");
    const [row] = await rt.sessions.list();
    const waiting = run("threads", "wait", row!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    await run("pause", "alpha");
    const paused = await waiting;
    expect(paused.code).toBe(0);
    expect(paused.io.lines).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (failed): machine paused while the agent was working`]);
    const later = await run("threads", "wait", row!.threadId!, "--json");
    expect(json(later.io)).toEqual([{ finished: { threadId: row!.threadId, status: "failed", reply: "machine paused while the agent was working" } }]);

    await restartHost({ claude: claude.adapter });
    await run("run", "alpha", "--detach", "cut");
    const cut = (await rt.sessions.list()).find(r => r.prompt === "cut")!;
    const cutWait = await run("threads", "wait", cut.threadId!);
    expect(cutWait.io.lines).toEqual([`thread ${cut.threadId!.slice(0, 8)} finished (failed): ${CUT_LINE}`]);
  });

  it("thread read prints the thread's messages as the app lists them, one line per tool call, --last the whole final message alone, and a thread that has not replied says so", async () => {
    await run("new", "alpha");
    await run("run", "alpha", "build it");
    const [row] = await rt.sessions.list();
    const id = row!.threadId!;
    const read = await run("thread", "read", id.slice(0, 8));
    expect(read.code).toBe(0);
    expect(read.io.errors).toEqual([]);
    const blocks = read.io.lines[0]!.split("\n\n").map(block => block.split("\n"));
    // Who spoke and the clock head each block; the text of the block is what was said.
    expect(blocks.map(block => block[0])).toEqual(["person", "agent", "tool", "agent", "turn"].map(who => expect.stringMatching(new RegExp(`^${who} \\d\\d:\\d\\d:\\d\\d$`))));
    expect(blocks.map(block => block.slice(1).join("\n"))).toEqual(["build it", "re: ", "$ ls", "build it", "completed"]);
    // The events the app reads are the events this read folded: nothing on the machine was asked for it.
    expect(launchedScripts(backend).filter(script => script.includes("sessions"))).toEqual([]);

    const last = await run("thread", "read", id, "--last", "--json");
    expect(json(last.io)).toEqual([{ threadId: id, messages: [{ who: "agent", at: expect.any(Number), text: "re: build it" }] }]);
    // The whole final message is the one the finished line carries, so a read of the reply and a wait on it agree.
    expect(notifyLine(id, { status: "completed", text: "re: build it" }, "whole")).toContain("re: build it");

    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("run", "alpha", "--detach", "hold on");
    const pending = (await rt.sessions.list()).find(session => session.prompt === "hold on")!;
    const nothing = await run("thread", "read", pending.threadId!, "--last");
    expect(nothing.code).toBe(0);
    expect(nothing.io.lines).toEqual([noReplyLine(pending.threadId!)]);
    const running = await run("thread", "read", pending.threadId!, "--json");
    expect(json(running.io)).toEqual([{ threadId: pending.threadId, messages: [{ who: "person", at: expect.any(Number), text: "hold on" }] }]);
    held.release(0, "held no longer");

    const none = await run("thread", "read");
    expect(none.code).toBe(3);
    expect(none.io.errors[0]).toContain("wsp thread read takes one thread");
    const missing = await run("thread", "read", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp thread read: no thread nope"]);
  });

  it("takes --state wherever it sits: before the verb's words, between them and after them", async () => {
    await run("new", "alpha");
    await run("run", "alpha", "build it");
    const id = (await rt.sessions.list())[0]!.threadId!;

    const before = await typed("--state", statePath, "thread", "read", id);
    const between = await typed("thread", "--state", statePath, "read", id);
    const after = await typed("thread", "read", id, "--state", statePath);
    expect([before.code, between.code, after.code]).toEqual([0, 0, 0]);
    expect([before.io.errors, between.io.errors, after.io.errors]).toEqual([[], [], []]);
    expect(before.io.lines).toEqual(after.io.lines);
    expect(between.io.lines).toEqual(after.io.lines);
    expect(after.io.lines[0]).toContain("build it");
  });

  it("takes --json wherever it sits, so a line that asks for JSON before the verb's words prints JSON", async () => {
    await run("new", "alpha");
    await run("run", "alpha", "build it");
    const id = (await rt.sessions.list())[0]!.threadId!;
    const answer = [{ threadId: id, messages: [{ who: "agent", at: expect.any(Number), text: "re: build it" }] }];

    const before = await typed("--json", "thread", "read", id, "--last", "--state", statePath);
    const between = await typed("thread", "--json", "read", id, "--last", "--state", statePath);
    const after = await typed("thread", "read", id, "--last", "--json", "--state", statePath);
    expect([before.code, between.code, after.code]).toEqual([0, 0, 0]);
    expect(json(before.io)).toEqual(answer);
    expect(json(between.io)).toEqual(answer);
    expect(json(after.io)).toEqual(answer);
  });

  it("hands the verb the rest of the line in the order it was typed, so its own flags are read beside a shared one", async () => {
    await run("new", "alpha");
    await run("run", "alpha", "build it");
    const id = (await rt.sessions.list())[0]!.threadId!;

    // The shared flag between the verb's words, the verb's own flag at the end.
    const { code, io } = await typed("thread", "--state", statePath, "read", id, "--last");
    expect(code).toBe(0);
    expect(io.errors).toEqual([]);
    expect(io.lines).toEqual([expect.stringContaining("re: build it")]);
  });

  it("refuses a shared flag left at the end of the line by its own name, never reading the verb's word as its value", async () => {
    for (const name of ["--state", "--host"]) {
      const { code, io } = await typed("thread", "read", "th_one", name);
      const refusal = io.errors.join("\n");
      expect(code, name).toBe(EXIT_CODES.usage);
      expect(refusal, name).toContain(`Option '${name} <value>' argument missing`);
      // The word the verb was given is its own, so nothing about it is read back as the flag's value.
      expect(refusal, name).not.toContain("th_one");
    }
  });

  it("refuses a misspelt shared flag by the word that was typed, in two halves, wherever it sits", async () => {
    const threads = CLI_VERBS.find(v => v.name === "threads")!;
    for (const [argv, fix] of [
      [["--stat", statePath, "threads"], runForTheList("wsp --help")],
      [["thread", "--stat", statePath, "read", "th_one"], runForTheList("wsp --help")],
      [["threads", "--stat", statePath], `usage: ${threads.usage}`],
    ] as [string[], string][]) {
      const { code, io } = await typed(...argv);
      const refusal = io.errors.join("\n");
      expect(code, argv.join(" ")).toBe(EXIT_CODES.usage);
      // Two halves: the word as it was typed, then what to do about it after it.
      expect(refusal, argv.join(" ")).toContain("--stat'");
      expect(refusal.indexOf(fix), argv.join(" ")).toBeGreaterThan(refusal.indexOf("--stat'"));
    }
  });

  it("run, send and fork --send return with the reply on the turn's session.done; a session.end that never comes is not waited for", async () => {
    const agent = doneOnlyAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter });
    await run("new", "alpha");
    const opened = await run("run", "alpha", "first");
    const [row] = await rt.sessions.list();
    expect(opened.code).toBe(0);
    expect(opened.io.lines).toEqual([`thread ${row!.threadId} · ${THREAD_PREFIX_WORD}`, "re: first"]);
    expect(opened.io.errors).toEqual([]);
    const sent = await run("send", row!.threadId!, "second", "--json");
    expect(sent.code).toBe(0);
    expect((json(sent.io) as { type: string }[]).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", undefined]);
    const forked = await run("fork", "alpha", "--name", "worker", "--send", "third");
    expect(forked.code).toBe(0);
    expect(forked.io.lines.slice(1)).toEqual([expect.stringMatching(/^thread /), "re: third"]);
    expect(agent.starts.map(s => s.prompt)).toEqual(["first", "second", "third"]);
    expect((await rt.sessions.history(row!.workspaceId)).map(e => e.type)).not.toContain("session.end");
  });

  it("exec runs the command on the workspace's machine, streams its output and exits with its code", async () => {
    await run("new", "alpha");
    execGuest(backend, "one\ntwo\n", 3);
    const { code, io } = await run("exec", "alpha", "--", "sh", "-c", "printf 'one\\ntwo\\n'; exit 3");
    expect(code).toBe(3);
    expect(io.lines).toEqual(["one", "two"]);
    expect(launchedScript(backend)).toContain("'sh' '-c' 'printf '\\''one\\ntwo\\n'\\''; exit 3'\n");

    const raw = await run("exec", "alpha", "--json", "--", "true");
    expect(raw.code).toBe(3);
    expect(json(raw.io)).toEqual([
      { type: "exec.output", execId: expect.any(String), text: "one" },
      { type: "exec.output", execId: expect.any(String), text: "two" },
      // The command ran in the workspace's project, and the reply says where rather than restating the rule.
      { exitCode: 3, cwd: (await rt.workspaces.list())[0]!.project.path },
    ]);
    const bare = await run("exec", "alpha");
    expect(bare.code).toBe(3);
    expect(bare.io.errors).toEqual(["wsp exec takes a workspace, then -- and the command. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
  });

  describe("one list behind every verb", () => {
    /** The workspace a thread of this host's runs on, its agents allowed to spawn. */
    async function leadWorkspace(): Promise<WorkspaceView> {
      await run("new", "alpha", "--spawn", "on");
      return (await rt.workspaces.list()).find(w => w.name === "alpha")!;
    }
    /** What a turn's launch hands the thread running on that workspace: the address of this host and a token scoped
     * to the thread, which is the pair a wsp line inside a turn dials with. Every line after this runs as that thread. */
    async function asThread(workspace: WorkspaceView, threadId: string): Promise<void> {
      const scoped = await rt.devices.mint(`thread ${threadId}`, { kind: "thread", threadId, workspaceId: workspace.id, rootThreadId: threadId }, Date.now());
      env[HOST_URL_ENV] = `ws://127.0.0.1:${handle!.wsPort}`;
      env[HOST_TOKEN_ENV] = scoped.deviceToken;
      // The fingerprint of the key this host proves rides the launch beside them, and the line holds the host to
      // it before the token crosses: a turn on a machine reaches this host over a road somebody else carries.
      env[HOST_KEY_ENV] = hostKeyHere(statePath);
    }
    /** A line as that thread types it: no --state, since the pair in its environment says which host it runs against. */
    async function line(...argv: string[]): Promise<{ code: number; io: Captured }> {
      const io = captured();
      return { code: await cli(argv, io, undefined, env), io };
    }

    it("every verb takes the workspaces the caller's own listing prints, by name and by id", async () => {
      const alpha = await leadWorkspace();
      await run("run", "alpha", "hello");
      const [row] = await rt.sessions.list();
      await asThread(alpha, "t_lead");
      expect(names(await line("workspaces"))).toEqual(["alpha"]);
      execGuest(backend, "Linux\n", 0);
      expect((await line("exec", "alpha", "--", "uname")).io.lines).toEqual(["Linux"]);
      expect((await line("exec", alpha.id, "--", "uname")).io.lines).toEqual(["Linux"]);
      const listedThreads = await line("threads", "alpha", "--json");
      expect(listedThreads.code, listedThreads.io.errors.join("\n")).toBe(0);
      // The person's own thread is another tree on the same workspace: the caller's listing leaves it out and its
      // id reads as no thread at all, so a thread cannot send into one it did not open.
      expect(json(listedThreads.io)).toEqual([{ threads: [] }]);
      expect((await line("send", row!.threadId!, "and the rest")).io.errors).toEqual([`wsp send: no thread ${row!.threadId}`]);
      // The thread it opened for itself is the one it drives, on the same ids the same listing prints.
      const opened = await line("run", "alpha", "kid");
      expect(opened.code, opened.io.errors.join("\n")).toBe(0);
      const kid = (await rt.sessions.list()).find(r => r.threadId !== row!.threadId)!;
      expect(json(await line("threads", "alpha", "--json").then(r => r.io))).toEqual([{ threads: [expect.objectContaining({ threadId: kid.threadId })] }]);
      expect((await line("send", kid.threadId!, "and the rest")).code).toBe(0);
    });

    it("a workspace the caller's reach hides reads to a thread exactly as one that does not exist", async () => {
      const alpha = await leadWorkspace();
      await run("new", "beta");
      const beta = (await rt.workspaces.list()).find(w => w.name === "beta")!;
      await asThread(alpha, "t_lead");
      // The listing leaves beta out, and every word for it reads as absent: the name, the whole id and the start of
      // one alike, so walking this host's ids tells a thread nothing about what stands outside its tree.
      expect(names(await line("workspaces"))).toEqual(["alpha"]);
      expect((await line("exec", "beta", "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal("beta")}`]);
      expect((await line("exec", beta.id, "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal(beta.id)}`]);
      expect((await line("exec", beta.id.slice(0, 6), "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal(beta.id.slice(0, 6))}`]);
      expect((await line("threads", "beta")).io.errors).toEqual([`wsp threads: ${noWorkspaceRefusal("beta")}`]);
      // A name nothing here carries reads the same, which is the whole of what the two have to say to a thread.
      expect((await line("exec", "gamma", "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal("gamma")}`]);
    });
  });

  it("exec hands the machine each argument as it was given: a quoted word stays one word", async () => {
    await run("new", "alpha");
    execGuest(backend, "", 0);
    const { code } = await run("exec", "alpha", "--", "grep", "a b", "file.txt");
    expect(code).toBe(0);
    const held = (await rt.workspaces.list())[0]!.project.path;
    expect(launchedScript(backend)).toContain(`\ncd '${held}' && 'grep' 'a b' 'file.txt'\n`);
  });

  it("exec runs in --cwd when given, else in the workspace's project folder; a failing command says on stderr where it ran", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const held = alpha!.project.path;
    execGuest(backend, "", 0);
    const inProject = await run("exec", "alpha", "--", "git", "status");
    expect(inProject.code).toBe(0);
    expect(inProject.io.errors).toEqual([]);
    expect(launchedScripts(backend).at(-1)).toContain(`\ncd '${held}' && 'git' 'status'\n`);

    const named = await run("exec", "alpha", "--cwd", "/root/work/else where", "--", "git", "status");
    expect(named.code).toBe(0);
    expect(launchedScripts(backend).at(-1)).toContain("\ncd '/root/work/else where' && 'git' 'status'\n");

    execGuest(backend, "fatal: not a git repository\n", 128);
    const failing = await run("exec", "alpha", "--", "git", "status");
    expect(failing.code).toBe(128);
    expect(failing.io.lines).toEqual(["fatal: not a git repository"]);
    expect(failing.io.errors).toEqual([`ran in ${held}`]);

    const overridden = await run("exec", "alpha", "--cwd", "/root", "--", "git", "status");
    expect(overridden.code).toBe(128);
    expect(launchedScripts(backend).at(-1)).toContain("\ncd '/root' && 'git' 'status'\n");
    expect(overridden.io.errors).toEqual(["ran in /root"]);

    const relative = await run("exec", "alpha", "--cwd", "packages/host", "--", "git", "status");
    expect(relative.code).toBe(3);
    expect(relative.io.errors).toEqual(['--cwd is a path on the machine, absolute, and got "packages/host". Give a path that opens with /, since whoever reads it works in a folder this line cannot see. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>']);
  });

  it("a failing exec says the folder the host ran it in, which on this computer is the copy beside the project's folder", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-exec-")));
    execFileSync("git", ["init", "-q", folder]);
    const here = await projectOn(rt, HERE_PLACE_ID, folder);
    await run("new", here.name, "mac");
    const local = await run("exec", "mac", "--", "false");
    expect(local.code).toBe(1);
    expect(local.io.errors).toEqual([`ran in ${copyPathFor(folder, "mac")}`]);
    const raw = await run("exec", "mac", "--json", "--", "false");
    expect(json(raw.io).at(-1)).toEqual({ exitCode: 1, cwd: copyPathFor(folder, "mac") });
    rmSync(folder, { recursive: true, force: true });
  });

  it("a host that stops under a turn says so and that the turn goes on, in one line with exit 1 instead of hanging", async () => {
    await restartHost({ claude: stuckAgent() });
    await run("new", "alpha");
    execGuest(backend, "", undefined);
    const turn = run("run", "alpha", "hang");
    const command = run("exec", "alpha", "--", "sleep", "600");
    await new Promise(r => setTimeout(r, 300));
    await handle!.close();
    handle = undefined;
    const [t, c] = await Promise.all([turn, command]);
    expect(t.code).toBe(1);
    expect(t.io.errors).toEqual([`wsp run: ${HOST_STOPPING_LINE}`]);
    expect(t.io.lines).toHaveLength(1);
    expect(c.code).toBe(1);
    expect(c.io.errors).toEqual([`wsp exec: ${HOST_STOPPING_LINE}`]);
  });

  it("the workspace being deleted under a running exec fails the verb with the reason and exit 1", async () => {
    await run("new", "alpha");
    execGuest(backend, "", undefined);
    const command = run("exec", "alpha", "--", "sleep", "600");
    await new Promise(r => setTimeout(r, 300));
    const [alpha] = await rt.workspaces.list();
    await rt.workspaces.delete(alpha!.id);
    const c = await command;
    expect(c.code).toBe(1);
    expect(c.io.errors).toEqual(["wsp exec: machine deleted while the agent was working"]);
  });

  it("a host whose sessions.start reply has no turn id or outcome is refused in one line before the follow, never printed as undefined", async () => {
    await handle!.close();
    handle = undefined;
    const old = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => old.once("listening", r));
    const wsPort = (old.address() as AddressInfo).port;
    writeFileSync(hostTokenPath(statePath), "tok\n");
    writeFileSync(lockPathFor(statePath), JSON.stringify({ pid: process.pid, port: wsPort, wsPort, startedAt: new Date().toISOString() }));
    const workspace = { id: "ws_1", name: "alpha", machineId: "m1", phase: "running", golden: "snap_gold", createdAt: "2026-09-06T00:00:00.000Z" };
    const session = { id: "s_1", workspaceId: "ws_1", harness: "claude", status: "running", threadId: "t_1" };
    old.on("connection", socket => {
      socket.on("message", raw => {
        const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
        const reply =
          op === "workspaces.list"
            ? { workspaces: [workspace] }
            : op === "workspaces.resolve" || op === "workspaces.wake"
              ? { workspace }
              : op === "harnesses.list"
                ? { harnesses: [] }
                : op === "sessions.start"
                  ? { session }
                  : {};
        socket.send(JSON.stringify({ id, ok: true, ...reply }));
      });
    });
    try {
      const { code, io } = await run("run", "alpha", "first");
      expect(code).toBe(1);
      expect(io.lines).toEqual([]);
      expect(io.streamed).toBe("");
      expect(io.errors).toEqual(["wsp run: the host answered workspaces.resolve in a shape this wsp does not read; it runs another version of wsp, restart it with wsp up"]);
    } finally {
      for (const client of old.clients) client.terminate();
      await new Promise(r => old.close(r));
    }
  });

  it("a request the host's own validator refuses reads as one line naming what it would not take and the form the verb takes, never the wire's schema", async () => {
    await handle!.close();
    handle = undefined;
    const old = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => old.once("listening", r));
    const wsPort = (old.address() as AddressInfo).port;
    writeFileSync(hostTokenPath(statePath), "tok\n");
    writeFileSync(lockPathFor(statePath), JSON.stringify({ pid: process.pid, port: wsPort, wsPort, startedAt: new Date().toISOString() }));
    const workspace = { id: "ws_1", name: "alpha", machineId: "m1", phase: "running", golden: "snap_gold", createdAt: "2026-09-06T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "default" } };
    // The validator's own words, off the very schema the host parses a request with.
    let refusal = RuntimeRequest.safeParse({ id: 1, op: "workspaces.exec" }).error!.message;
    old.on("connection", socket => {
      socket.on("message", raw => {
        const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
        if (op === "workspaces.exec") return void socket.send(JSON.stringify({ id, ok: false, error: refusal }));
        const reply = op === "workspaces.resolve" || op === "workspaces.wake" ? { workspace } : {};
        socket.send(JSON.stringify({ id, ok: true, ...reply }));
      });
    });
    try {
      const ran = await run("exec", "alpha", "--", "ls");
      expect(ran.code).toBe(EXIT_CODES.usage);
      expect(ran.io.errors).toEqual(["wsp exec: the host would not read the workspace and the command on this line. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
      // None of the wire's own words reach the person: not a field name, not a code, not one of the ops it listed.
      expect(ran.io.errors[0]).not.toContain("workspaceId");
      expect(ran.io.errors[0]).not.toContain("invalid_type");

      // An op the host does not know is the two builds differing, which no argument of the line can fix.
      refusal = RuntimeRequest.safeParse({ id: 1, op: "a.verb.this.host.has.never.served" }).error!.message;
      const skewed = await run("exec", "alpha", "--", "ls");
      expect(skewed.code).toBe(EXIT_CODES.usage);
      expect(skewed.io.errors).toEqual(["wsp exec: the host does not serve this line; it runs another version of wsp, restart it with wsp up. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
      expect(skewed.io.errors[0]).not.toContain("discriminator");
      expect(skewed.io.errors[0]).not.toContain("workspaces.createLocal");
    } finally {
      for (const client of old.clients) client.terminate();
      await new Promise(r => old.close(r));
    }
  });

  it("a port that accepts but never answers fails the dial within its deadline, before and after the handshake", async () => {
    await handle!.close();
    handle = undefined;
    const accepted: Socket[] = [];
    const silent = createServer(socket => accepted.push(socket));
    await new Promise<void>(r => silent.listen(0, "127.0.0.1", r));
    const mute = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => mute.once("listening", r));
    writeFileSync(hostTokenPath(statePath), "tok\n");
    try {
      for (const server of [silent, mute]) {
        const wsPort = (server.address() as AddressInfo).port;
        writeFileSync(lockPathFor(statePath), JSON.stringify({ pid: process.pid, port: wsPort, wsPort, startedAt: new Date().toISOString() }));
        await expect(dialHost(statePath, { deadlineMs: 200 })).rejects.toThrow(`the host at 127.0.0.1:${wsPort} did not answer: nothing came back within 200 ms`);
      }
    } finally {
      for (const client of mute.clients) client.terminate();
      for (const socket of accepted) socket.destroy();
      await new Promise(r => mute.close(r));
      await new Promise(r => silent.close(r));
    }
  });

  it("snapshot takes a project golden of the workspace it names and says how to fork it; a workspace that was resumed is refused in one line", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const { code, io } = await run("snapshot", "alpha");
    expect(code, io.errors.join("\n")).toBe(0);
    const [golden] = await rt.golden.projects();
    expect(golden).toMatchObject({ projects: [{ name: alpha!.project.name, dest: alpha!.project.path }], golden: "snap_gold", version: 1, workspaceId: alpha!.id, workspaceName: "alpha" });
    expect(io.lines).toEqual([
      `project image ${golden!.snapshotId}: image v1 plus ${alpha!.project.name} imported ${golden!.projects[0]!.importedAt.slice(0, 10)}, taken from alpha\nfork it with: wsp new <name> --from ${alpha!.project.name}`,
    ]);
    expect(io.errors).toEqual([]);

    const asJson = await run("snapshot", alpha!.id, "--json");
    expect(asJson.code).toBe(0);
    expect(json(asJson.io)).toEqual([{ projectGolden: expect.objectContaining({ projects: golden!.projects, golden: "snap_gold" }) }]);

    await rt.workspaces.nap(alpha!.id);
    await rt.workspaces.wake(alpha!.id);
    const resumed = await run("snapshot", "alpha");
    expect(resumed.code).toBe(1);
    expect(resumed.io.errors).toHaveLength(1);
    expect(resumed.io.errors[0]).toMatch(/^wsp snapshot: snapshot \S+ refused: machine m\d+ is not first-life/);
    expect(await rt.golden.projects()).toHaveLength(2);
  });

  it("new --from forks a project image of that project, by its name or its snapshot id, and refuses one taken of another project", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const taken = await rt.workspaces.snapshot(alpha!.id);
    const byName = await run("new", cloud.name, "task-a", "--from", alpha!.project.name);
    expect(byName.code, byName.io.errors.join("\n")).toBe(0);
    const taskA = (await rt.workspaces.list()).find(w => w.name === "task-a")!;
    expect(taskA.golden).toBe(taken.snapshotId);

    const byId = await run("new", cloud.name, "task-b", "--from", taken.snapshotId);
    expect(byId.code).toBe(0);
    expect((await rt.workspaces.list()).find(w => w.name === "task-b")!.golden).toBe(taken.snapshotId);

    // A project image of another project would put the wrong work in place, so it is refused naming both.
    const other = await projectOn(rt, undefined, "https://github.com/dev/other.git");
    const wrong = await run("new", other.name, "task-c", "--from", taken.snapshotId);
    expect(wrong.code).not.toBe(0);
    expect(wrong.io.errors[0]).toContain(`is a project image of ${alpha!.project.name}, and this workspace is for ${other.name}`);

    const missing = await run("new", cloud.name, "task-d", "--from", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp new: no project image named nope; wsp snapshot <workspace> takes one"]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "task-a", "task-b"]);
  });

  it("wsp image lists every project image by its id, project, size and date; image remove asks once, deletes the snapshot at the provider and drops the record, and is refused while a workspace stands on it", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const taken = await rt.workspaces.snapshot(alpha!.id);
    const listed = await run("image");
    expect(listed.io.lines.join("\n").split("\n")).toContain(`${taken.snapshotId}  project alpha  ${alpha!.project.name}  7.5 GB  ${taken.createdAt}`);

    expect((await run("new", cloud.name, "task-a", "--from", taken.snapshotId)).code).toBe(0);
    const standing = await run("image", "remove", taken.snapshotId, "--yes");
    expect(standing.code).toBe(1);
    expect(standing.io.errors).toEqual([`wsp image remove: ${projectImageInUseRefusal(taken.snapshotId, ["task-a"])}`]);
    expect(backend.snapshots.map(s => s.id)).toContain(taken.snapshotId);
    expect((await run("delete", "task-a", "--yes")).code).toBe(0);

    const kept = await answer("no", "image", "remove", taken.snapshotId);
    const asJson = await run("image", "remove", taken.snapshotId, "--json");
    expect(asJson.code).toBe(EXIT_CODES.usage);
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual([`${taken.snapshotId} kept`]);
    expect(asked.at(-1)).toBe(`Remove project image ${taken.snapshotId}?\n${projectImageRemoveNotice(taken)}`);
    expect(backend.snapshots.map(s => s.id)).toContain(taken.snapshotId);

    const removed = await answer("yes", "image", "remove", taken.snapshotId);
    expect(removed.code).toBe(0);
    expect(removed.io.lines).toEqual([projectImageRemovedLine(taken.snapshotId, false)]);
    expect(backend.snapshots.map(s => s.id)).not.toContain(taken.snapshotId);
    expect(await rt.golden.projects()).toEqual([]);

    const missing = await run("image", "remove", taken.snapshotId, "--yes");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual([`wsp image remove: ${noProjectImageLine(taken.snapshotId)}`]);
    // A project's name is no id: a remove never picks one of several images by the newest.
    const named = await run("image", "remove", cloud.name, "--yes");
    expect(named.code).toBe(EXIT_CODES.usage);
    expect(named.io.errors).toEqual([`wsp image remove: ${noProjectImageLine(cloud.name)}`]);
    expect((await run("image", "remove")).code).toBe(EXIT_CODES.usage);
  });

  /** A folder on this computer with one source file and one secret-shaped file, not a repository. */
  function projectFolder(): string {
    const proj = join(dir, "proj");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "index.ts"), "export const a = 1;\n");
    writeFileSync(join(proj, ".env"), "API_TOKEN=sk-ant-x\n");
    return proj;
  }
  const landings = (): string[] => backend.machines[0]!.runLog.filter(s => s.includes("mv "));

  it("folders lists one level of this computer's folders with the repository marked and the hidden ones counted, and refuses a path outside the roots", async () => {
    const home = join(dir, "user");
    mkdirSync(join(home, "code", "spoo", ".git"), { recursive: true });
    mkdirSync(join(home, "code", "notes"), { recursive: true });
    mkdirSync(join(home, "code", ".cache"), { recursive: true });
    const { code, io } = await run("folders", join(home, "code"));
    expect(code).toBe(0);
    const lines = io.lines[0]!.split("\n");
    const cells = (line: string): string[] => line.split(/ {2,}/);
    expect(cells(lines[0]!)).toEqual(["FOLDER", "GIT"]);
    expect(lines.slice(1, 3).map(cells)).toEqual([[join(home, "code", "notes")], [join(home, "code", "spoo"), "git"]]);
    expect(lines.at(-1)).toBe(`2 folders in ${join(home, "code")}, 1 hidden. Browsable: ${home}.`);
    // The dot-named folder is a row only when it is asked for, and --json is the listing the app's picker reads.
    const shown = await run("folders", join(home, "code"), "--hidden", "--json");
    expect(json(shown.io)).toEqual([{ dir: join(home, "code"), roots: [home], folders: [{ path: join(home, "code", ".cache"), repo: false }, { path: join(home, "code", "notes"), repo: false }, { path: join(home, "code", "spoo"), repo: true }], hidden: 1 }]);
    const outside = await run("folders", "/etc");
    expect(outside.code).toBe(1);
    expect(outside.io.errors.join("\n")).toBe(`wsp folders: /etc is outside the folders wsp browses on this computer: ${home}`);
    const many = await run("folders", join(home, "code"), join(home, "Applications"));
    // A line refused before anything was dialled is a usage refusal, which is the code an agent branches on.
    expect(many.code).toBe(3);
    expect(many.io.errors.join("\n")).toContain("takes one folder on this computer at most");
  });

  it("folders --on reads the computer it names, this computer by its own name, and refuses a name nobody holds with the computers there are", async () => {
    const home = join(dir, "user");
    mkdirSync(join(home, "code"), { recursive: true });
    const client = await dialHost(statePath);
    let places: PlaceView[];
    try {
      places = (await client.request<{ places: PlaceView[] }>("places.list")).places;
    } finally {
      client.close();
    }
    const here = places.find(p => p.id === HERE_PLACE_ID)!;
    const mine = await run("folders", "--on", here.name, "--json");
    expect(mine.code).toBe(0);
    expect(json(mine.io)[0]).toMatchObject({ dir: home, roots: [home] });
    const nobody = await run("folders", "--on", "nowhere");
    expect(nobody.code).toBe(EXIT_CODES.usage);
    expect(nobody.io.errors.join("\n")).toContain(noSuchPlaceRefusal("nowhere", places.map(p => p.name)));
  });

  it("terminal config reads this computer's Ghostty config with its theme, prints it as Ghostty lines or one object, resolves the scheme asked for, and refuses a word outside light and dark", async () => {
    const home = join(dir, "user");
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    mkdirSync(join(home, ".config", "ghostty", "themes"), { recursive: true });
    writeFileSync(join(home, ".config", "ghostty", "config"), "theme = light:Day,dark:Night\nfont-family = Berkeley Mono\nfont-size = 13\nbackground-opacity = 0.9\n");
    writeFileSync(join(home, ".config", "ghostty", "themes", "Night"), "background = #1e1e2e\nforeground = #cdd6f4\npalette = 1=#f38ba8\n");
    writeFileSync(join(home, ".config", "ghostty", "themes", "Day"), "background = #fafafa\n");
    const { code, io } = await run("terminal", "config");
    expect(code).toBe(0);
    expect(io.lines[0]!.split("\n")).toEqual([
      `Read ${join(home, ".config", "ghostty", "config")}, ${join(home, ".config", "ghostty", "themes", "Night")}`,
      "font-family = Berkeley Mono",
      "font-size = 13",
      "theme = Night",
      "background = #1e1e2e",
      "foreground = #cdd6f4",
      "palette = 1 of 16 colors",
      "background-opacity = 0.9",
    ]);
    const light = await run("terminal", "config", "--scheme", "light", "--json");
    expect(light.code).toBe(0);
    expect(json(light.io)).toEqual([
      expect.objectContaining({ files: [join(home, ".config", "ghostty", "config"), join(home, ".config", "ghostty", "themes", "Day")], theme: "Day", background: { r: 250, g: 250, b: 250 }, fontFamily: ["Berkeley Mono"], fontSize: 13, backgroundOpacity: 0.9 }),
    ]);
    // The same answer the app gets over the host's socket, so the line and the pane never disagree.
    const client = await dialHost(statePath);
    try {
      expect(await client.request("host.terminalConfig", { scheme: "light" })).toMatchObject({ config: json(light.io)[0] });
    } finally {
      client.close();
    }
    const sepia = await run("terminal", "config", "--scheme", "sepia");
    expect(sepia.code).toBe(3);
    expect(sepia.io.errors).toEqual(['wsp terminal config: --scheme takes one of light, dark, and got "sepia". Name one of those.']);
    const extra = await run("terminal", "config", "now");
    expect(extra.code).toBe(3);
    // No config at all is not a failure: the empty object says the pane keeps its defaults.
    rmSync(join(home, ".config", "ghostty"), { recursive: true });
    const none = await run("terminal", "config", "--json");
    expect(none.code).toBe(0);
    expect(json(none.io)).toEqual([{ files: [], fontFamily: [], palette: Array<null>(16).fill(null) }]);
  });

  it("a folder inside the roots this Mac will not let the host read comes back as one stderr line at the provider's code, not a usage refusal", async () => {
    const home = join(dir, "user");
    const shut = join(home, "Documents");
    mkdirSync(shut, { recursive: true });
    const words = `EACCES: permission denied, scandir '${shut}'`;
    const refused = await withRefused(shut, () => run("folders", shut));
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp folders: ${words}`]);
    // The machine said no, so the class is the provider's on the JSON door too, where stdout stays empty.
    const asJson = await withRefused(shut, () => run("folders", shut, "--json"));
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors).toHaveLength(1);
    expect(JSON.parse(asJson.io.errors[0]!)).toEqual({ error: words, class: "provider", exit: 1 });
  });







  it("export brings the folder home to the path given, streams the stages, prints the done line, and keys the sessions to the folder in the homes here", async () => {
    const guest = exportGuest(backend);
    await run("new", "alpha");
    const dest = join(dir, "out", "proj");
    const { code, io } = await run("export", "alpha", dest, "--from", EXPORT_SOURCE);
    expect(io.errors).toEqual([]);
    expect(code).toBe(0);
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("TOKEN=x\n");
    const real = realpathSync(dest);
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    expect(readFileSync(join(dir, "user", ".claude", "projects", key, "S1.jsonl"), "utf8")).toBe(EXPORT_SESSION(real));
    expect(io.lines).toEqual([`2 files, 28 B, landed at ${dest}; 1 cache left behind; sessions: Claude Code (1 session) moved.`]);
    expect(io.streamed.split("\n").filter(l => l !== "")).toEqual(expect.arrayContaining([`Packing ${EXPORT_SOURCE} on the machine.`, "Packing the agents' state for it on the machine.", `Landing at ${dest}.`]));
    expect(io.streamed).not.toContain("landed at");
    expect(guest.sources).toEqual([EXPORT_SOURCE]);
  });

  it("export refuses an existing folder in two lines, the second naming --replace, and replaces it when asked; --from defaults to the folder's own path; --agents narrows; --json prints the result", async () => {
    const guest = exportGuest(backend);
    await run("new", "alpha");
    const dest = join(dir, "out", "proj");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "old.txt"), "old");
    const refused = await run("export", "alpha", dest);
    expect(refused.code).toBe(1);
    expect(refused.io.lines).toEqual([]);
    expect(refused.io.errors).toEqual([`wsp export: ${dest} already exists on this computer with 1 file; export with replace to overwrite it\nRun again with --replace to overwrite it.`]);
    expect(guest.sources).toEqual([]);
    const replaced = await run("export", "alpha", dest, "--replace", "--agents", "codex,pi", "--json");
    expect(replaced.code).toBe(0);
    expect(replaced.io.errors).toEqual([]);
    expect(json(replaced.io)).toEqual([{ dest, files: 2, bytes: 28, excluded: ["node_modules"], agents: [] }]);
    expect(replaced.io.streamed).toBe("");
    expect(existsSync(join(dest, "old.txt"))).toBe(false);
    expect(guest.sources).toEqual([dest]);
    expect(existsSync(join(dir, "user", ".claude"))).toBe(false);
  });

  it("export refuses an --agents id the catalog does not know before anything reaches the machine, naming it and the ids it knows", async () => {
    const guest = exportGuest(backend);
    await run("new", "alpha");
    const typo = await run("export", "alpha", join(dir, "out", "proj"), "--agents", "claude,codx");
    expect(typo.code).toBe(3);
    expect(typo.io.lines).toEqual([]);
    expect(typo.io.errors).toEqual([`wsp export: ${unknownAgentLine("codx", CATALOG_AGENTS.map(a => a.id))}. Name one of those, or drop the flag.`]);
    expect(guest.sources).toEqual([]);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("every verb takes --json and --help; a bad flag prints the usage", async () => {
    for (const verb of [["new"], ["fork"], ["snapshot"], ["pause"], ["wake"], ["forget"], ["delete"], ["threads"], ["threads", "wait"], ["run"], ["send"], ["stop"], ["exec"], ["projects"], ["export"]]) {
      const help = await run(...verb, "--help");
      expect(help.code).toBe(0);
      expect(help.io.lines[0]).toMatch(new RegExp(`^usage: wsp ${verb.join(" ")}`));
      expect(help.io.lines[0]).toContain("--json");
    }
    const bad = await run("threads", "--nope");
    expect(bad.code).toBe(3);
    expect(bad.io.errors[0]).toContain("Unknown option '--nope'");
    expect(bad.io.errors[0]).toContain("usage: wsp threads");
    // A flag another verb reads is refused naming that verb, so the caller is told where it lives: run's --agent on send, threads' --tree on stop.
    const foreign = await run("send", "row_1", "--agent", "claude", "hello");
    expect(foreign.code).toBe(3);
    expect(foreign.io.errors).toEqual(['--agent belongs to wsp skills add, wsp servers signin, wsp servers tools, wsp servers add, wsp servers remove, wsp servers disable, wsp servers enable, wsp fork and wsp run; wsp send does not read it. usage: wsp send <thread> [--model, --effort <value>] [--image <path>] [--detach] "<message>"']);
    const within = await run("stop", "row_1", "--tree");
    expect(within.io.errors[0]).toContain("--tree belongs to wsp threads; wsp stop does not read it");
    // A flag wsp used to read is nobody's now: the parser's own line, with the verb's usage under it.
    const old = await run("threads", "--in", "alpha");
    expect(old.code).toBe(3);
    expect(old.io.errors[0]).toContain("Unknown option '--in'");
    expect(old.io.errors[0]).toContain("usage: wsp threads");
    // A flag spelled like a prototype member is nobody's: the tables are read as own keys, so it gets the parser's line.
    const proto = await run("threads", "--constructor");
    expect(proto.code).toBe(3);
    expect(proto.io.errors[0]).toContain("Unknown option '--constructor'");
    expect(proto.io.errors[0]).not.toContain("belongs to");
    const half = await run("thread");
    expect(half.code).toBe(3);
    expect(half.io.errors).toEqual([
      'wsp thread opens a line rather than being one. usage: wsp thread read <thread> [--last]\nusage: wsp thread rename <thread> "<title>"\nusage: wsp thread forget <thread>\nusage: wsp thread allow <thread>\nusage: wsp thread deny <thread>',
    ]);
  });

  it("without a host serving the state file, and with nothing to start one, every verb refuses in one line before dialling anything", async () => {
    await handle!.close();
    handle = undefined;
    const io = captured();
    expect(await cli(["threads", "--state", statePath], io, undefined, env, false)).toBe(1);
    expect(io.errors).toEqual([`wsp threads: ${noHostServingLine(statePath)}`]);
  });

  it("a wrong token is refused by the host, under the auth class", async () => {
    writeFileSync(join(dir, "state", "host-token"), "not-the-token\n");
    const { code, io } = await run("threads");
    expect(code).toBe(2);
    expect(io.errors).toEqual(["wsp threads: unauthorized"]);
  });

  describe("what the agents on a workspace may do", () => {
    it("the switch is off until a person turns it on, and the listing and the card read it off the record", async () => {
      await run("new", "alpha");
      const off = await run("workspaces");
      expect(off.io.lines[0]!.split("\n")[1]).not.toContain("machines");
      const on = await run("workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "2");
      expect(on.code).toBe(0);
      expect(on.io.lines).toEqual(["alpha: agents may spawn: up to 2 workspaces"]);
      expect((await rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 2, maxDepth: 1 });
      expect((await run("workspaces")).io.lines[0]!).toContain("2 machines");
      const back = await run("workspaces", "agents", "alpha", "--spawn", "off");
      expect(back.io.lines).toEqual(["alpha: agents may not spawn"]);
      // Off keeps the numbers it was given rather than throwing them away, so turning it on again is one word.
      expect((await rt.workspaces.list())[0]!.agents).toEqual({ spawn: false, maxMachines: 2, maxDepth: 1 });
    });

    it("a cap with no --spawn beside it is refused, and so is a word that is neither on nor off", async () => {
      await run("new", "alpha");
      const bare = await run("workspaces", "agents", "alpha", "--max-machines", "2");
      expect(bare.code).toBe(EXIT_CODES.usage);
      expect(bare.io.errors[0]).toContain("need --spawn on beside them");
      const wrong = await run("workspaces", "agents", "alpha", "--spawn", "yes");
      expect(wrong.code).toBe(EXIT_CODES.usage);
      expect(wrong.io.errors[0]).toContain("--spawn takes on or off");
      const none = await run("workspaces", "agents", "alpha");
      expect(none.code).toBe(EXIT_CODES.usage);
      expect((await rt.workspaces.list())[0]!.agents).toBeUndefined();
    });

    it("--max-depth 0 is a usage sentence, not a shape the wire refuses", async () => {
      await run("new", "alpha");
      const zero = await run("workspaces", "agents", "alpha", "--spawn", "on", "--max-depth", "0");
      expect(zero.code).toBe(EXIT_CODES.usage);
      expect(zero.io.errors[0]).toBe('wsp workspaces agents: --max-depth takes a whole number of one or more, and got "0". Write it as --max-depth <n>.');
      // Zero machines is a switch that is on and forks nothing, which is a thing a person may mean.
      const none = await run("workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "0");
      expect(none.code).toBe(0);
      expect((await rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 0, maxDepth: 1 });
    });

    it("a workspace on this computer takes the switch at both doors, since its agents reach the host as themselves", async () => {
      const folder = realpathSync(mkdtempSync(join(dir, "repo-mine-")));
      execFileSync("git", ["init", "-q", folder]);
      const project = await projectOn(rt, HERE_PLACE_ID, folder);
      const made = await run("new", project.name, "mine", "--spawn", "on");
      expect(made.io.errors).toEqual([]);
      expect(made.code).toBe(0);
      expect((await rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 3, maxDepth: 1 });
      await run("new", project.name, "other");
      const set = await run("workspaces", "agents", "other", "--spawn", "on");
      expect(set.code).toBe(0);
      expect((await rt.workspaces.list()).find(w => w.name === "other")!.agents?.spawn).toBe(true);
      expect((await run("workspaces", "agents", "other", "--spawn", "off")).code).toBe(0);
    });

    it("wsp new --spawn on turns the switch on at the create", async () => {
      const made = await run("new", "alpha", "--spawn", "on", "--max-machines", "1");
      expect(made.code).toBe(0);
      expect((await rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 1, maxDepth: 1 });
    });

    it("--tree draws a thread an agent spawned under the thread that spawned it, and stop ends the tree as one", async () => {
      const held = heldAgent(false);
      await restartHost({ claude: held.adapter });
      await run("new", "alpha", "--spawn", "on");
      const alpha = (await rt.workspaces.list())[0]!;
      const lead = await rt.sessions.start(alpha.id, { prompt: "lead" });
      const leadThread = lead.view().threadId!;
      const child = await rt.sessions.start(alpha.id, { prompt: "builder" }, { origin: "relayed", by: { kind: "thread", threadId: leadThread, workspaceId: alpha.id, rootThreadId: leadThread } });
      const childThread = child.view().threadId!;
      // The thread's own cell is the third: a tree indents that cell and leaves the project and the workspace alone.
      const rows = (io: Captured): string[] => io.lines[0]!.split("\n").slice(1);
      expect(rows((await run("threads")).io).some(r => r.split(/ {2,}/)[2]!.startsWith(" "))).toBe(false);
      const drawn = rows((await run("threads", "--tree")).io);
      const at = drawn.findIndex(r => r.includes(leadThread));
      expect(drawn[at + 1]).toContain(`  ${childThread}`);
      // Two rows naming each other are under no top row; the listing prints every row it was given all the same.
      expect(threadTree([
        { id: "a", parentThreadId: "b" },
        { id: "b", parentThreadId: "a" },
      ] as unknown as Parameters<typeof threadTree>[0]).map(t => t.row.id).sort()).toEqual(["a", "b"]);
      const stopped = await run("stop", leadThread);
      expect(stopped.io.lines[0]).toBe(`thread ${leadThread} stopped, and with it 1 thread its agents spawned: ${childThread.slice(0, 8)}`);
      expect((await rt.sessions.list(alpha.id)).every(v => v.status !== "running")).toBe(true);
    });
  });

  describe("an image on a message from the command line", () => {
    /** A real PNG head, so the type is read off the bytes as the verbs read it; the rest is filler of a known weight. */
    const pngFile = (dirPath: string, name: string, bytes: number): string => {
      const path = join(dirPath, name);
      writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8, 7)]));
      return path;
    };

    it("wsp send --image reads the file here and sends its bytes, so the machine never reaches back for this computer's files", async () => {
      await run("new", "alpha");
      await run("run", "alpha", "hello");
      const [row] = await rt.sessions.list();
      const path = pngFile(dir, "shot.png", 2048);
      const sent = await run("send", row!.threadId!, "--image", path, "what does this show?");
      expect(sent.code).toBe(0);
      const start = claude.starts.at(-1)!;
      expect(start.images).toEqual([{ mediaType: "image/png", bytes: readFileSync(path).toString("base64") }]);
      // The path itself never travels: the agent is handed the bytes, not somewhere on this computer to look.
      expect(JSON.stringify(start)).not.toContain(path);
    });

    it("the flag repeats, and the images reach the agent in the order they were named", async () => {
      await run("new", "alpha");
      await run("run", "alpha", "hello");
      const [row] = await rt.sessions.list();
      const one = pngFile(dir, "one.png", 512);
      const two = pngFile(dir, "two.png", 1024);
      const sent = await run("send", row!.threadId!, "--image", one, "--image", two, "these two");
      expect(sent.code).toBe(0);
      expect(claude.starts.at(-1)!.images?.map(i => i.bytes)).toEqual([readFileSync(one).toString("base64"), readFileSync(two).toString("base64")]);
    });

    it("run --image opens the thread with the image on its first turn", async () => {
      await run("new", "alpha");
      const path = pngFile(dir, "opening.png", 256);
      const opened = await run("run", "alpha", "--image", path, "what is this?");
      expect(opened.code).toBe(0);
      expect(claude.starts.at(-1)!.images).toEqual([{ mediaType: "image/png", bytes: readFileSync(path).toString("base64") }]);
    });

    it("the person's turn prints one bracket per image on stderr, since a terminal draws no pixels", async () => {
      await run("new", "alpha");
      const path = pngFile(dir, "big.png", 1_258_291);
      const opened = await run("run", "alpha", "--image", path, "what is this?");
      expect(opened.io.streamed).toContain("[image 1 MB png]");
    });

    it("a path this computer has no file at answers in a sentence, not in the reader's own error", async () => {
      await run("new", "alpha");
      const missing = join(dir, "not-here.png");
      const refused = await run("send", "--image", missing, "x", "y");
      expect(refused.io.errors[0]).not.toContain("ENOENT");
      const opening = await run("run", "alpha", "--image", missing, "look");
      expect(opening.code).toBe(EXIT_CODES.usage);
      expect(opening.io.errors).toEqual([`wsp run: there is no file at ${missing} on this computer. Name a file that is already here.`]);
      expect(claude.starts).toHaveLength(0);
    });

    it("a folder named where an image should be is refused the same way, rather than failing on the read", async () => {
      await run("new", "alpha");
      const refused = await run("run", "alpha", "--image", dir, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual([`wsp run: there is no file at ${dir} on this computer. Name a file that is already here.`]);
    });

    it("a file that is not one of the four types is refused by name, before anything travels", async () => {
      await run("new", "alpha");
      const path = join(dir, "notes.pdf");
      writeFileSync(path, "%PDF-1.7 not an image at all");
      const refused = await run("run", "alpha", "--image", path, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual([`wsp run: ${path} is not PNG, JPEG, GIF or WebP; a message carries those four. Name one of those instead.`]);
      expect(claude.starts).toHaveLength(0);
    });

    it("a 12 MB image is refused with the cap in the sentence, and the file is never read whole", async () => {
      await run("new", "alpha");
      const path = pngFile(dir, "huge.png", 12 * 1024 * 1024);
      const refused = await run("run", "alpha", "--image", path, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp run: huge.png is 12 MB, over the 10 MB an image may be. Drop that one and send the rest."]);
      expect(claude.starts).toHaveLength(0);
    });

    it("six images are refused with both counts", async () => {
      await run("new", "alpha");
      const paths = Array.from({ length: 6 }, (_, i) => pngFile(dir, `n${i}.png`, 64));
      const refused = await run("run", "alpha", ...paths.flatMap(p => ["--image", p]), "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp run: only 5 images fit one message; this one carries 6. Drop that one and send the rest."]);
    });
  });
});

describe("messageTo", () => {
  const row: ThreadView = { id: "row_1", workspaceId: "ws_1", harness: "claude", startedBy: "person", status: "failed", title: "hello", sessionId: "row_1", turns: 1, ran: false };
  it("names the thread when the row has one, resumes by session when it has only that, and refuses a row with neither instead of minting a thread in silence", () => {
    expect(messageTo({ ...row, threadId: "thr_1", claudeSessionId: "sess_1" }, "again")).toEqual({ workspaceId: "ws_1", prompt: "again", harness: "claude", thread: "thr_1" });
    expect(messageTo({ ...row, threadId: "thr_1" }, "again")).toEqual({ workspaceId: "ws_1", prompt: "again", harness: "claude", thread: "thr_1" });
    expect(messageTo({ ...row, claudeSessionId: "sess_1" }, "again")).toEqual({ workspaceId: "ws_1", prompt: "again", harness: "claude", resume: "sess_1" });
    expect(() => messageTo(row, "again")).toThrow("thread row_1 has no session to resume yet");
  });
});

describe("the verbs never talk to the provider", () => {
  it("import the protocol, the catalog, the collector for the recipe verbs and the host's lock file only: no runtime, engine, backend or key loading", () => {
    const source = readFileSync(new URL("../src/verbs.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/ from "([^"]+)";$/gm)].map(m => m[1]!);
    // The catalog is rows and ids alone (the agents a thread can take), so the agent argument's list reaches no
    // provider; the keys package is node crypto and nothing else, which is what a dial holds a host to its key with.
    expect(imports.filter(i => i.startsWith("@wsp/"))).toEqual(["@wsp/catalog", "@wsp/collect", "@wsp/keys", "@wsp/protocol"]);
    expect(imports).not.toContain("@wsp/runtime");
    expect(imports).not.toContain("@wsp/engine");
    expect(source).not.toMatch(/SOLARI|ANTHROPIC|loadKeys|SolariBackend|getsolari/);
  });
});

describe("what the projects remove tool says", () => {
  it("reads the same memory clause the sentence a remove answers with reads, rather than the opposite of it", () => {
    const remove = VERBS.filter(hasTool).find(v => v.name === "projects remove");
    const description = remove?.tool.description ?? "";
    expect(description).toContain(MEMORY_KEPT_CLAUSE);
    expect(description).not.toContain("the memory its threads kept");
    // The words the remove itself answers with carry that same clause, so the two cannot drift apart.
    expect(projectRemovedOnComputerLine("spoo-landing", "spoo", "/wsp/projects/pr_1", true)).toContain(MEMORY_KEPT_CLAUSE);
  });
});
