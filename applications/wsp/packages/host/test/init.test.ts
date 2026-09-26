// SPDX-License-Identifier: AGPL-3.0-only
// wsp init end to end against the stub backend: keys in, the three screens,
// the summary and confirm, prepare with its stage stream, the sign-ins and
// secrets, the seal, the first workspace and the app's address. The runtime
// and host are the real ones over fakes; only the terminal is faked.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { S_RADIO_ACTIVE, S_RADIO_INACTIVE } from "@clack/prompts";
import { RUNGS, parseManifest, type Manifest, type ManifestEntry } from "@wsp/collect";
import { BUILDER_DISK_GB, LocalBackend, SNAPSHOT_STORAGE, type BackendPricing, type ExecResult } from "@wsp/engine";
import { HERE_PLACE_ID, ALREADY_APPLIED, BUILD_NEEDS_FILE_FIX, DAEMON_TOKEN_PATH, buildNeedsFileLine, folderName, MACHINE_GONE_LINE, Recipe, SEAL_FAILED_LINE, SIGN_IN_DEFERRED_WORD, SIGN_IN_LATER, type GoldenManifest, type ProjectImportResult, type ProjectPlan } from "@wsp/protocol";
import { copyKey, DAEMON_TOKEN_SET, LOOPBACK, createRuntime, goldenHead, localExecStream, memoryStore, type GoldenRecipe, type LocalWiring, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogEntry, parseJsonc } from "@wsp/catalog";
import { applyRecipe, recipePath, withCatalogAgents } from "../src/init-recipe.js";
import { hostPlatform } from "../src/verbs.js";
import { signInItems } from "../src/init-pick.js";
import { CARD_FRAME, card, widthOf } from "../src/init-layout.js";
import { PROJECT_QUESTION, noFolderNote } from "../src/init-pick.js";
import { reduceStages, runInit, sealFailedMachineLeftLine, stageLine, summaryNote, SWEEP, type HostHooks, type InitIO, type InitOptions } from "../src/init.js";
import { ALSO_LOCAL_QUESTION, FIRST_QUESTION, folderQuestion } from "../src/init-first.js";
import type { HostHandle, WorkspaceRoads } from "../src/server.js";
import { startCallbackRelay } from "../src/relay.js";
import type { ConnectOptions, DaemonSocket } from "../src/doctor.js";
import { appendCommand, readCommand } from "../src/init-secrets.js";
import { importResultPath } from "../src/init-import.js";
import { noteOutcomes } from "../src/init-signin.js";
import type { FakePtyLink } from "./fake-pty-link.js";
import { DEVICE_URL, GEMINI_URL, scriptedLink } from "./init-link.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";
import { runRecipe } from "../src/recipe-command.js";
import { saveSmallRecipe } from "../src/recipe-file.js";
import { fakeHost } from "./recipe-fixture.js";
import type { ScanRow } from "../src/scan.js";
import { guestAnswer, type StubBackend, stubBackend, type StubMachine } from "./stub-backend.js";
import { loginOf } from "./signin-questions.js";
import { copyingFake, createOn, projectOn } from "./verbs-fixture.js";

/** The screens read this computer for whose login a copy would carry; a home with nothing in it names none. */
const HOME_HERE = "/home/nobody";

const SOLARI = "slr_live_fake_solari_key";
const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", space: " ", enter: "\r", esc: "\x1b", ctrlC: "\x03" };
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\//;
/** The code the fake host mints for the browser init opens; every address the run opens or prints carries it. */
const HERE_CODE = "7K3MQP2X";
/** What the browser is handed on a terminal the person is at: a page in the host's run folder, never the address. */
const OPENING_PAGE = /\/runs\/open-[0-9a-f]+\.html$/;
/** The address that page sends the browser to, read off the page the trail's last open named. */
const openedAddress = (trail: readonly string[]): string | undefined => {
  const last = trail.at(-1);
  if (last === undefined || !last.startsWith("open ") || !OPENING_PAGE.test(last)) return undefined;
  return /content="0; url=([^"]*)"/.exec(readFileSync(last.slice("open ".length), "utf8"))?.[1];
};
const SEAL_Q = (v: number) => `Seal this machine as image v${v}?`;
const BOOT = /Boot a \d+ vCPU/;
const PRICING: BackendPricing = { rateUsdPerHour: s => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: SNAPSHOT_STORAGE, builderDiskGb: BUILDER_DISK_GB };

/** A folder as the host would plan it: one secret-shaped file that must be cut, one the plan offers a rewrite for,
 * one agent with sessions and one without. What the wizard consents to out of this is the app's own default. */
const PLAN: Omit<ProjectPlan, "source"> = {
  repo: true,
  files: 12,
  bytes: 3072,
  secrets: [
    { path: ".env", bytes: 120, signals: ["keys"] },
    { path: ".git/config", bytes: 300, signals: ["url"], rewrite: { urls: ["https://github.com/o/r"], drop: [] } },
  ],
  excluded: ["node_modules"],
  skipped: [],
  agents: [
    { agent: "claude", name: "Claude Code", sessions: 46, bytes: 9_400_000, carry: "moves" },
    { agent: "gemini", name: "Gemini CLI", sessions: 0, bytes: 0, carry: "moves" },
  ],
};

interface Fake {
  io: InitIO;
  opts: InitOptions;
  text(): string;
  raw(): string;
  clear(): void;
  press(...keys: string[]): Promise<void>;
  until(needle: string | RegExp, ms?: number): Promise<void>;
  opened: string[];
  backends: StubBackend[];
  recipes: GoldenRecipe[];
  runtimes: Runtime[];
  hooks: HostHooks[];
  /** The scripted daemon link the sign-in stage talks to. */
  link: FakePtyLink;
  /** How many relays to the builder the run opened, and how many it closed. */
  relays: number;
  relaysClosed: number;
  /** How many hosts the run started once the golden was sealed, and how many it closed. */
  hosts: number;
  hostsClosed: number;
  /** The pair each host was started on, which is the pair the run settled on rather than the pair asked for. */
  served: { port: number; wsPort: number }[];
  /** Keychain services the fake reader was asked for. */
  reads: string[];
  /** The one store every runtime of this fake reads and writes. */
  store: Store;
  /** Where a test delivers Ctrl-C; the real one is process. */
  signals: EventEmitter;
  /** Exit codes the run asked for, in order; the real one ends the process. */
  exits: number[];
  /** What the end of the run did, in order: the fork, the import and the address the app opened on. */
  trail: string[];
  /** Every import the run asked for, as it asked for it. */
  imports: { workspaceId: string; source: string; dest: string; carry?: readonly string[]; rewrite?: readonly string[]; agents?: readonly string[] }[];
  /** The objects --json printed, in order. */
  records: Record<string, unknown>[];
}

/** The saved manifest as the next run reads it. */
const loadManifest = (path: string): Manifest => parseManifest(JSON.parse(readFileSync(path, "utf8")));
/** The small recipe with these catalog ids ticked on top of RECIPE's own, a row added for one RECIPE has none for. */
const ticking = (...ids: string[]): Recipe => ({
  ...RECIPE,
  rows: [
    ...RECIPE.rows.map(r => (ids.includes(r.id) ? { ...r, on: true } : r)),
    ...ids.filter(id => !RECIPE.rows.some(r => r.id === id)).map((id): Recipe["rows"][number] => ({ id, kind: catalogEntry(id)!.kind, on: true, source: { kind: "popular", sessions: 0, images: 0 } })),
  ],
});
/** The small recipe with these catalog ids off. */
const without = (recipe: Recipe, ...ids: string[]): Recipe => ({ ...recipe, rows: recipe.rows.map(r => (ids.includes(r.id) ? { ...r, on: false } : r)) });
/** The small recipe with a login answered copy: under --yes a saved answer is kept, where the default would leave the
 * sign-in to first use. */
const answeredCopy = (id: string, recipe: Recipe = RECIPE): Recipe => ({ ...recipe, rows: recipe.rows.map(r => (r.id === id ? { ...r, signIn: "copy" } : r)) });
/** The small recipe with a login opted in to signing in while the build runs, which is not what a row starts on. */
const answeredInBuild = (id: string, recipe: Recipe = RECIPE): Recipe => ({ ...recipe, rows: recipe.rows.map(r => (r.id === id ? { ...r, signIn: "machine" } : r)) });

function fake(over: Partial<InitOptions> & { tty?: boolean; env?: Record<string, string>; columns?: number; signedIn?: boolean; hold?: boolean; missing?: boolean; json?: boolean } = {}): Fake {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = Object.assign(new PassThrough(), { isTTY: over.tty ?? true });
  if (over.columns !== undefined) Object.assign(output, { columns: over.columns });
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  stderr.on("data", (c: Buffer) => chunks.push(c.toString()));
  const text = () => stripVTControlCharacters(chunks.join(""));
  const raw = () => chunks.join("");
  const clear = () => void chunks.splice(0);
  const opened: string[] = [];
  const trail: string[] = [];
  const imports: Fake["imports"] = [];
  const backends: StubBackend[] = [];
  const recipes: GoldenRecipe[] = [];
  const runtimes: Runtime[] = [];
  const hooks: HostHooks[] = [];
  const link = scriptedLink({ signedIn: over.signedIn ?? true, hold: over.hold ?? false, missing: over.missing ?? false });
  const counters = { hosts: 0, closed: 0, relays: 0, relaysClosed: 0 };
  const served: { port: number; wsPort: number }[] = [];
  const signals = new EventEmitter();
  const exits: number[] = [];
  const records: Record<string, unknown>[] = [];
  const io: InitIO = {
    input,
    output,
    stderr,
    isTTY: over.tty ?? true,
    env: over.env ?? {},
    open: async url => {
      opened.push(url);
      trail.push(`open ${url}`);
      return true;
    },
    signals,
    exit: code => {
      exits.push(code);
    },
    ...(over.json === true ? { json: (record: Record<string, unknown>) => records.push(record) } : {}),
  };
  const dir = mkdtempSync(join(tmpdir(), "wsp-init-"));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), "wsp-init-home-"));
  dirs.push(home);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Me\n");
  writeFileSync(join(home, ".zshrc"), "export A=1\n");
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  writeFileSync(join(home, ".ssh", "config"), "Host work\n", { mode: 0o600 });
  const reads: string[] = [];
  const store = memoryStore();
  const { tty: _tty, env: _env, columns: _columns, signedIn: _signedIn, hold: _hold, missing: _missing, json: _json, ...rest } = over;
  const opts: InitOptions = {
    yes: false,
    // The folder was named on the command line, so the first screen's question is not asked; the run that answers it deletes this.
    project: NAMED_PROJECT,
    collect: async () => FIXTURE,
    recipe: async () => RECIPE,
    scanProject: async folder => ({ dir: folder, rows: [], candidates: [] }),
    vault: () => ({}),
    saveKeys: () => {},
    pricing: PRICING,
    statePath: join(dir, "state.json"),
    home,
    platform: "darwin",
    secrets: {
      read: async (service, account) => {
        reads.push(account === undefined ? service : `${service} (${account})`);
        return "gho_fake";
      },
      run: async command => {
        reads.push(command);
        return "sk-ant-x-helper\n";
      },
    },
    // One account and one state file per fake, as the cli has: a runtime rebuilt after a Keychain refusal sees the same machines.
    runtime: recipe => {
      recipes.push(recipe);
      const backend = backends[0] ?? stubBackend();
      if (backends.length === 0) backends.push(backend);
      const rt = createRuntime({ backend, store, adapters: {}, local: localWiring(dir), goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
      runtimes.push(rt);
      return rt;
    },
    ports: { port: 0, wsPort: 0, named: true },
    upCommand: "wsp up",
    forkCommand: "wsp new first",
    relay: async (rt: Runtime, builder, h) => {
      counters.relays += 1;
      expect(builder.id).toBe(backends.at(-1)?.machines.find(m => !m.killed && m.spec.labels?.["wsp-builder"] === "1")?.id);
      hooks.push(h);
      return { close: async () => void (counters.relaysClosed += 1) };
    },
    roads: rt => roadsOf(rt, trail, imports),
    host: async (rt: Runtime, ports: { port: number; wsPort: number }) => {
      counters.hosts += 1;
      served.push(ports);
      // The host starts only once the golden is on the account and in the store: a host that fails cannot lose it.
      expect(goldenHead(await rt.golden.get())).toBeDefined();
      const handle: HostHandle = { port: 4400, wsPort: 4410, authToken: "tok", revokeDevice: async () => false, hereCode: async () => HERE_CODE, door: { open: async () => ({ port: 4420, addresses: ["http://192.168.1.20:4420"] }), port: () => 4420, close: async () => {} }, ...roadsOf(rt, trail, imports), close: async () => void (counters.closed += 1) };
      return handle;
    },
    daemon: async () => ({ link: link.dial(), close: () => {} }),
    retry: { waitMs: 1, attempts: 3 },
    ...rest,
  };
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      input.write(k);
      await new Promise(r => setTimeout(r, k === KEY.esc ? 70 : 5));
    }
  };
  const until = async (needle: string | RegExp, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const t = text();
      if (typeof needle === "string" ? t.includes(needle) : needle.test(t)) return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`never saw ${String(needle)} in:\n${text()}`);
  };
  return {
    io,
    opts,
    text,
    raw,
    clear,
    press,
    until,
    opened,
    backends,
    recipes,
    runtimes,
    hooks,
    link,
    get relays() {
      return counters.relays;
    },
    get relaysClosed() {
      return counters.relaysClosed;
    },
    get hosts() {
      return counters.hosts;
    },
    get hostsClosed() {
      return counters.closed;
    },
    served,
    reads,
    store,
    signals,
    exits,
    trail,
    imports,
    records,
  };
}

/** The handle's project roads as a fake: the plan is PLAN at the folder asked for, and the import records what the
 * wizard consented to before answering with what landed. Nothing is read from disk and nothing is packed. */
function fakeProjects(trail: string[], imports: Fake["imports"]): Pick<HostHandle, "planProject" | "importProject"> {
  return {
    planProject: async source => ({ ...PLAN, source }),
    importProject: async o => {
      trail.push(`import ${o.source} -> ${o.dest}`);
      imports.push({ workspaceId: o.workspaceId, source: o.source, dest: o.dest, ...(o.carry !== undefined ? { carry: o.carry } : {}), ...(o.rewrite !== undefined ? { rewrite: o.rewrite } : {}), ...(o.agents !== undefined ? { agents: o.agents } : {}) });
      const result: ProjectImportResult = { dest: o.dest, files: 12, bytes: 3072, parts: 1, cut: [".env"], rewritten: [".git/config"], agents: [{ agent: "claude", files: 40, bytes: 9_400_000, outcome: "moved", sessions: 46, rows: 46 }], project: { name: folderName(o.dest), dest: o.dest, importedAt: "2026-09-12T10:00:00.000Z", size: 3072 } };
      return result;
    },
  };
}

/** The workspace roads as the fake host and the hostless run both take them: the fork and the tick are both recorded
 * on the trail, and both go through the runtime the run built. */
function roadsOf(rt: Runtime, trail: string[], imports: Fake["imports"]): WorkspaceRoads {
  return {
    createWorkspace: (name, _caller, project) => { trail.push(project === undefined ? `fork ${name}` : "local"); return project === undefined ? forkHead(rt, name) : rt.workspaces.create({ project, name: LOCAL_NAME }); },
    addProject: (source: string) => projectOn(rt, HERE_PLACE_ID, source),
    ...fakeProjects(trail, imports),
  };
}

/** The name this computer takes in these runs, so no assertion depends on the box the tests run on. */
const LOCAL_NAME = "this-mac";

/** This computer as the fake runtime holds it: a real local backend over the run's own folder, so the workspace step's
 * tick makes a record the way it does on a person's machine. No turn is ever started here. */
function localWiring(root: string): LocalWiring {
  return {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({}),
    platform: hostPlatform(),
    copier: copyingFake(),
  };
}

/** What the host's own create does: a fork of the golden's head under the given name. */
async function forkHead(rt: Runtime, name: string) {
  const head = goldenHead(await rt.golden.get());
  if (!head) throw new Error("no image yet");
  return createOn(rt, { golden: head.snapshotId, name });
}

/** The prompt the vault step raises for a row answered on this computer; these runs have nothing to paste. */
const VAULT_ASK = "Claude Code token";

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Escape at the vault step's prompt, when the run reaches one before `next`: the row is left not signed in and
 * the run goes on. Nothing is ever run for it here, since these runs hand in no mint command. */
async function pastTheVault(f: Fake, next: string): Promise<void> {
  await f.until(new RegExp(`${VAULT_ASK}|${reEscape(next)}`));
  // The screen keeps everything the run has printed, so it is the newer of the two that says where the run is.
  const text = f.text();
  if (text.lastIndexOf(VAULT_ASK) < text.lastIndexOf(next)) return;
  await f.press(KEY.esc);
}

/** Enter at the seal question: the default answer is yes. */
async function sealIt(f: Fake, version = 1): Promise<void> {
  await pastTheVault(f, SEAL_Q(version));
  await f.until(SEAL_Q(version));
  await f.press(KEY.enter);
}

/** The workspace step answered: false forks nothing, a folder imports it, "" forks the workspace with no project.
 * The tick beside the fork is answered too, taken unless the caller says otherwise, as it is on by default. */
async function firstWorkspace(f: Fake, folder: string | false, tick = true): Promise<void> {
  await f.until(FIRST_QUESTION);
  await f.press(folder === false ? "n" : KEY.enter);
  await f.until(ALSO_LOCAL_QUESTION);
  await f.press(tick ? KEY.enter : "n");
  if (folder === false) return;
  await f.until(folderQuestion("darwin"));
  await f.press(...(folder === "" ? [] : [folder]), KEY.enter);
}

/** A run that ends the way a crash after the boot does: the relay to the builder never comes up, so the builder
 * stays unsealed and first-life for the next run to find. */
async function bootedOnly(f: Fake): Promise<void> {
  const relay = f.opts.relay;
  f.opts.relay = async (rt, builder, hooks) => {
    await relay(rt, builder, hooks);
    throw new Error("relay down in this fixture");
  };
  await expect(runInit(f.opts, f.io)).rejects.toThrow("relay down in this fixture");
}

/** Workspace roads whose fork is refused, for runs that test what comes before the first workspace. */
const quietRoads: WorkspaceRoads = { createWorkspace: async () => { throw new Error("no workspace in this fixture"); }, addProject: async () => { throw new Error("no project in this fixture"); }, ...fakeProjects([], []) };
/** A host whose first-workspace fork is refused, for the same runs on a terminal. */
const quietHost = () => async (): Promise<HostHandle> => ({ port: 4400, wsPort: 4410, authToken: "tok", revokeDevice: async () => false, hereCode: async () => HERE_CODE, door: { open: async () => ({ port: 4420, addresses: ["http://192.168.1.20:4420"] }), port: () => 4420, close: async () => {} }, ...quietRoads, close: async () => {} });

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) await new Promise<void>(resolve => s.close(() => resolve()));
});

/** A loopback port this test holds until it ends, the way another host on this computer would. */
async function heldPort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no address");
  return addr.port;
}

/** The project folder a run names on the command line. */
const NAMED_PROJECT = "/Users/dev/proj";

/** The gh login answered copy in the recipe the run starts from. */
function withGhCopy(f: Fake): void {
  f.opts.recipe = async () => answeredCopy("gh");
}

/** The screens a run asks before the build, in order, on a computer whose managers have nothing to offer. */
const SCREENS = ["Agents", "Tools", "Sign-ins", "wsp for your agents on this Mac"];

/** Enter through every screen, taking the defaults each one opens on. */
async function throughScreens(f: Fake, screens: readonly string[] = SCREENS): Promise<void> {
  for (const screen of screens) {
    await f.until(screen);
    await f.press(KEY.enter);
  }
}

describe("wsp init, interactive", () => {
  it("offers what this Mac's package managers have as its own screen, every row off, and a tick writes that row into the recipe", async () => {
    const f = fake();
    const saved = join(dirname(f.opts.statePath), "recipe.json");
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, JSON.stringify({ version: 1, at: "2026-09-06T03:00:00.000Z", histories: [], rows: [], custom: [{ kind: "custom", id: "cuda", name: "cuda", install: ["apt-get install -y cuda"], check: "command -v cuda", why: "added by the agent" }] }));
    // The scan is asked with what the recipe already installs, so it can leave those tools off the screen.
    let asked: readonly { id: string }[] = [];
    f.opts.scan = async recipe => {
      asked = recipe;
      return [
        { id: "brew/llvm", name: "llvm", manager: "brew", group: "Homebrew formulae", install: "brew install llvm", check: "command -v llvm", size: 2 * 1024 * 1024 * 1024 },
        { id: "npm/turbo", name: "turbo", manager: "npm", group: "npm globals", install: "npm install -g turbo", check: "command -v turbo" },
      ];
    };
    const run = runInit(f.opts, f.io);
    await throughScreens(f, ["Agents", "Tools"]);
    await f.until("Also on this Mac");
    const screen = f.text().slice(f.text().lastIndexOf("◆  Also on this Mac"));
    // The Also on this Mac screen, its own sentence over it, and every row starts off with its manager's count and weight.
    expect(screen).toMatch(/Also on this Mac\s+3\/6/);
    expect(screen).toContain("What else this Mac brings");
    expect(screen).toMatch(/▾ Homebrew formulae\s+0 of 1\s+0 B\n┃\s+○ llvm\s+2 GB\n/);
    expect(screen).toMatch(/▾ npm globals\s+0 of 1\s+0 B\n┃\s+○ turbo\s+size unknown\n/);
    // The screen that spends disk shows the Disk line, as Tools does, and it follows the ticks.
    const disk = (text: string): string => text.slice(text.lastIndexOf("Disk: ")).split("\n")[0]!;
    const before = disk(screen);
    expect(before).toContain("on the 20 GB builder");
    // Down to llvm, tick it, on to the sign-ins.
    await f.press(KEY.down);
    await f.press(" ");
    await f.until(/● llvm/);
    expect(disk(f.text().slice(f.text().lastIndexOf("◆  Also on this Mac")))).not.toBe(before);
    await f.press(KEY.enter);
    await throughScreens(f, ["Sign-ins", "wsp for your agents on this Mac"]);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
    expect(asked.map(r => r.id)).toEqual(["cuda"]);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")).custom).toEqual([
      { kind: "custom", id: "cuda", name: "cuda", install: ["apt-get install -y cuda"], check: "command -v cuda", why: "added by the agent" },
      { kind: "custom", id: "brew/llvm", name: "llvm", install: ["brew install llvm"], check: "command -v llvm", manager: "brew", size: 2 * 1024 * 1024 * 1024, why: "installed on this Mac by brew" },
    ]);
  });

  it("a scanned tap formula this Mac's collector listed is its own row: ticked on the Also on this Mac screen it installs from its GitHub release, its pin is recorded under the row's id and no custom row is written; a --yes re-run reads as no change", async () => {
    const sha = "a".repeat(64);
    const tap: ManifestEntry = { rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" };
    const table = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], bytes: 4 * 1024 * 1024, macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const scanned = { id: "brew/zingzy/tap/diskbloom", name: "zingzy/tap/diskbloom", manager: "brew" as const, group: "Homebrew formulae", install: "brew install zingzy/tap/diskbloom", check: "brew list --versions zingzy/tap/diskbloom", size: 4 * 1024 * 1024, version: "0.1.0" };
    const collect = async () => ({ entries: [...FIXTURE.entries, tap] });
    const brew = async () => table;
    const store = memoryStore();
    const shared = stubBackend();
    shared.execImpl = (_m, cmd) => {
      const tag = /repos\/Zingzy\/diskbloom\/releases\/(?:tags\/(\S+?)'|latest)/.exec(cmd);
      return tag === null ? guestAnswer(cmd) : { exitCode: 0, stdout: `WSP_ROAD release diskbloom_linux_amd64.tar.gz ${sha} ${tag[1] ?? "v0.1.0"}\n`, stderr: "" };
    };
    const onShared = (f: Fake): void => {
      f.opts.runtime = recipe => {
        f.backends.push(shared);
        const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
        f.runtimes.push(rt);
        return rt;
      };
    };
    const f = fake({ collect, brew, scan: async () => [scanned] });
    onShared(f);
    const run = runInit(f.opts, f.io);
    await throughScreens(f, ["Agents", "Tools"]);
    await f.until("Also on this Mac");
    // The Tools screen is the catalog's: the formula is not there. Down onto it here, and the detail says the road the build takes.
    expect(f.text().slice(f.text().lastIndexOf("◆  Tools"), f.text().lastIndexOf("◆  Also on this Mac"))).not.toContain("diskbloom");
    await f.press(KEY.down);
    await f.until("installs from its release: the v0.1.0 release of github.com/Zingzy/diskbloom");
    expect(f.text()).toContain("installed on this Mac, 0.1.0");
    await f.press(" ");
    await f.until(/● zingzy\/tap\/diskbloom/);
    await f.press(KEY.enter);
    await throughScreens(f, ["Sign-ins", "wsp for your agents on this Mac"]);
    await f.until(BOOT);
    expect(f.text().replace(/\n│\s+/g, " ")).toMatch(/3 tools plus Homebrew's toolchain, 1 from its GitHub release \(tag and checksum recorded at the seal, checked on every copy\)/);
    await f.press("y");
    await sealIt(f);
    await firstWorkspace(f, false);
    expect((await run).code).toBe(0);
    const roadRuns = () => shared.machines.flatMap(m => m.execLog.filter(c => c.includes("repos/Zingzy/diskbloom/releases/")));
    expect(roadRuns()).toHaveLength(1);
    expect(roadRuns()[0]).toContain("releases/tags/v0.1.0");
    expect(shared.machines.some(m => m.execLog.some(c => c.includes("brew install zingzy/tap/diskbloom")))).toBe(false);
    const pin = { tag: "v0.1.0", sha256: sha };
    const small = () => Recipe.parse(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")));
    expect(small().rows.find(r => r.id === tap.id)).toEqual({ id: tap.id, kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true }, pin });
    expect(small().custom).toEqual([]);
    // The saved manifest carries no pin: the record does, and the recipe file shows it.
    expect(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.find(e => e.id === tap.id)).toEqual({ ...tap, bring: true });
    // The next run, taking the defaults: the tick comes from the recipe beside the state, and nothing is built.
    const again = fake({ yes: true, tty: false, home: f.opts.home, statePath: f.opts.statePath, collect, brew });
    onShared(again);
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    expect(again.text()).toContain("Image v1 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(roadRuns()).toHaveLength(1);
  });

  it("keeps the rows wsp recipe --add wrote into the recipe beside the state, which a plain run rewrites", async () => {
    const f = fake({ yes: true });
    const saved = join(dirname(f.opts.statePath), "recipe.json");
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [],
      custom: [{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" }],
    }));
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.backends[0]!.machines[0]!.execLog.some(c => c.includes("brew install just"))).toBe(true);
    expect(JSON.parse(readFileSync(saved, "utf8")).custom).toEqual([
      { kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" },
    ]);
  });

  it("says so and carries on when the recipe beside the state cannot be read, rather than refusing to run", async () => {
    const f = fake({ yes: true });
    const saved = join(dirname(f.opts.statePath), "recipe.json");
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, "{ not json");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("added rows go with it");
  });

  it("names Also on this Mac beside What they need when the recipe that overfills the disk has a row from it", async () => {
    const f = fake({ yes: true });
    const saved = join(dirname(f.opts.statePath), "recipe.json");
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [],
      custom: [{ kind: "custom", id: "brew/llvm", name: "llvm", install: ["brew install llvm"], check: "command -v llvm", size: 30 * 1024 * 1024 * 1024, why: "installed on this Mac by brew" }],
    }));
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toContain("This recipe needs about");
    expect(out).toContain("under Tools or Also on this Mac");
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
  });

  it("with no manager row to offer, the Also screen is not shown and the count is of the screens seen", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await f.until("Agents  1/5");
    await f.press(KEY.enter);
    await f.until("Tools  2/5");
    await f.press(KEY.enter);
    await f.until("Sign-ins  3/5");
    expect(f.text()).not.toContain("Also on this Mac");
    await f.press(KEY.enter);
    await throughScreens(f, ["wsp for your agents on this Mac  4/5"]);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("once this computer has measured a build, the build screen says how long that one took", async () => {
    const f = fake();
    // What the last seal wrote beside the recipe: 19 minutes of stages.
    writeFileSync(importResultPath(f.opts.statePath), JSON.stringify({ build: { at: "2026-09-05T19:44:00.000Z", stages: { creating: 61_000, "installing-tools": 1_059_000, snapshotting: 40_000 } } }));
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    const ready = f.text().slice(f.text().lastIndexOf("Ready to build")).replace(/\n┃\s+/g, " ");
    expect(ready).toContain("The build takes about 19 minutes, going by the last one; a workspace naps when it is idle and stops billing.");
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("the build screen says what it will build, what it costs and that a workspace naps; the marker opens on Yes and n keeps everything", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    const frame = f.text().slice(f.text().lastIndexOf("Ready to build")).replace(/\n┃\s+/g, " ");
    const ready = frame.slice(0, frame.indexOf("Boot a"));
    // No sign-in runs on this machine: every login here can only be signed in through a browser, and those are left
    // to first use rather than waited on while the build runs.
    expect(ready).toMatch(/^Ready to build\. 1 agent, 2 tools, [\d.]+ GB on the image\. 0 sign-ins on the machine during the build\. The build takes about ten minutes, not measured on this computer yet; a workspace naps when it is idle and stops billing\./);
    // The rate is the boot question's, said once on the screen.
    expect(ready).not.toContain("/hr");
    expect(frame.match(/\$0\.11\/hr/g)).toHaveLength(1);
    const ask = f.text().slice(f.text().lastIndexOf("Boot a"));
    expect(ask).toMatch(/2 vCPU, 4 GB\s+builder/);
    expect(ask).toMatch(/\$0\.11\/hr/);
    expect(ask).toMatch(/No\s+costs\s+nothing/);
    // Enter takes the defaults everywhere, so the marker opens on Yes; the help line is the screen being answered.
    expect(ask).toContain(`\n┃  ${S_RADIO_ACTIVE} Yes / ${S_RADIO_INACTIVE} No\n┗  ← → change • y n answer • enter choose • esc cancel`);
    await f.press("n");
    expect((await run).code).toBe(1);
    // The finished block opens on the summary line, the boot question under it, and ends on the answer.
    const done = f.text().slice(f.text().lastIndexOf("◇  Ready to build"));
    expect(done).toContain("│  No\n└  Nothing was booted. The recipe is kept.");
    expect(done).toMatch(/^◇  Ready to build\./);
    expect(done).toContain("Boot a");
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
    expect(f.hosts).toBe(0);
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.filter(e => e.bring).map(e => e.id)).toContain("shell/zshrc");
  });

  it("a seal whose fork fails its check is reported with the run log, exits 1 with the relay closed and no host, and the builder is gone", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      // The smoke command fails on the fork alone; the builder's own stages answer as a bare guest does.
      backend.execImpl = (m, cmd) => (m.spec.fromSnapshot !== undefined ? { exitCode: 3, stdout: "", stderr: "claude: not found" } : guestAnswer(cmd));
      f.backends.push(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
      f.runtimes.push(rt);
      return rt;
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(result.handle).toBeUndefined();
    expect(f.relays).toBe(1);
    expect(f.relaysClosed).toBe(1);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toContain("Sealing image v1. Taken as yes (--yes).");
    expect(out).toContain("The fork failed its check");
    expect(out).toContain("Seal failed and the builder is gone. Run wsp init again; the recipe is kept.");
    expect(out).toContain(`The run log is ${join(dirname(f.opts.statePath), "init.log")}`);
    expect(out).not.toMatch(URL_RE);
    expect(f.backends[0]!.machines.every(m => m.killed)).toBe(true);
  });

  /** The provider refusing the snapshot as it did on 2026-09-07: a 502 with its message and a request id per reply. */
  const refusedSnapshot = (nth: number): Error => Object.assign(new Error("Failed to snapshot sandbox"), { kind: "snapshotUnavailable", status: 502, requestId: `req_${nth}` });
  const refusing = (f: Fake, refuse: (m: StubMachine, nth: number) => void): void => {
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.beforeSnapshot = refuse;
      f.backends.push(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, snapshotRetryMs: 1 , hostId: "box:h1" });
      f.runtimes.push(rt);
      return rt;
    };
  };

  it("a snapshot the provider refuses is asked for three times while the builder runs, each attempt on the stage line with the provider's answer; the builder is left up, the outro says how to attach and what it costs, and the run log holds the status and request id", async () => {
    // The widest terminal the wizard draws for, so the cut stage lines keep the provider's answer in view.
    const f = fake({ yes: true, columns: 100 });
    refusing(f, (_m, nth) => { throw refusedSnapshot(nth); });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(result.handle).toBeUndefined();
    expect(f.hosts).toBe(0);
    expect(f.relaysClosed).toBe(1);
    const out = f.text();
    // The terminal cuts each stage line at its edge; the run log below holds them whole.
    expect(out).toContain("attempt 1 of 3 answered 502 Failed to snapshot sandbox (request req_1); the builder reads");
    expect(out).toContain("attempt 2 of 3 answered 502 Failed to snapshot sandbox (request req_2); the builder reads");
    expect(out).toContain("Snapshot failed");
    expect(out).toContain("the snapshot failed 3 times: the provider answered 502 Failed to snapshot sandbox (request req_");
    const recipe = join(dirname(f.opts.statePath), "recipe.json");
    expect(out).toContain(`Seal failed; the builder is as you left it. Builder m1 stays up at about $0.11/hr; wsp init --recipe '${recipe}' attaches to it again, and the sweep stops it once it is six hours old.`);
    expect(out).not.toContain("the builder is gone");
    expect(f.backends[0]!.machines.map(m => m.killed)).toEqual([false]);
    expect(await f.runtimes[0]!.golden.builders()).toEqual([expect.objectContaining({ id: "m1", sealable: true })]);
    const log = readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8");
    expect(log).toContain("stage snapshotting: attempt 1 of 3 answered 502 Failed to snapshot sandbox (request req_1); the builder reads running, next attempt in 1ms");
    expect(log).toContain("stage failed: the snapshot failed 3 times: the provider answered 502 Failed to snapshot sandbox (request req_3) while the builder read running");
  });

  it("a refused snapshot on a builder the provider answers 404 for ends at once: the outro names the provider as the cause and the record is gone", async () => {
    const f = fake({ yes: true, columns: 100 });
    refusing(f, m => { m.killed = true; throw refusedSnapshot(1); });
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toContain("the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_");
    expect(readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8")).toContain("stage failed: the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_1) and no longer has the builder (404)");
    expect(out).toContain("Seal failed and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again; the recipe is kept.");
    expect(out).not.toContain("attaches to it again");
    expect(await f.runtimes[0]!.golden.builders()).toEqual([]);
  });

  it("a refused snapshot whose read of the builder fails with anything but 404 leaves the builder untouched: the outro says the provider could not be read and how to attach", async () => {
    const f = fake({ yes: true, columns: 100 });
    // The read is the machine's own state call, the second GET on Solari; it fails while the snapshot call did.
    refusing(f, m => { m.state = async () => { throw Object.assign(new Error("upstream sad"), { kind: "transient", status: 503 }); }; throw refusedSnapshot(1); });
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toContain("the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_");
    const recipe = join(dirname(f.opts.statePath), "recipe.json");
    expect(out).toContain(`Seal failed; the provider could not be read about the builder, so nothing on it was touched. Builder m1 stays up at about $0.11/hr; wsp init --recipe '${recipe}' attaches to it again, and the sweep stops it once it is six hours old.`);
    expect(f.backends[0]!.machines.map(m => m.killed)).toEqual([false]);
    expect(await f.runtimes[0]!.golden.builders()).toEqual([expect.objectContaining({ id: "m1", sealable: true })]);
    expect(readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8")).toContain("stage failed: the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_1) and could not be read about the builder (upstream sad)");
  });

  it("under --json a failed seal ends with one object carrying the same facts: the provider's answer, the builder's state, and the attach command and cost while it is up", async () => {
    const f = fake({ nonInteractive: true, json: true });
    refusing(f, (_m, nth) => { throw refusedSnapshot(nth); });
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const recipe = join(dirname(f.opts.statePath), "recipe.json");
    expect(f.records.at(-1)).toEqual({
      event: "seal-failed",
      builder: "m1",
      message: "the snapshot failed 3 times: the provider answered 502 Failed to snapshot sandbox (request req_3) while the builder read running",
      recipe,
      builderState: "running",
      attempts: 3,
      provider: { status: 502, message: "Failed to snapshot sandbox", requestId: "req_3", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) as string },
      attachCommand: `wsp init --recipe '${recipe}'`,
      rateUsdPerHour: expect.closeTo(0.11, 5) as number,
    });
    expect(f.backends[0]!.machines.map(m => m.killed)).toEqual([false]);
  });

  it("no at the seal question leaves the builder running for a later attach, closes the relay, starts no host and exits 1", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await pastTheVault(f, SEAL_Q(1));
    await f.until(SEAL_Q(1));
    expect(f.text()).toContain("Enter seals: a snapshot, then a fork to prove it. No leaves the machine up.");
    await f.press("n");
    const result = await run;
    expect(result.code).toBe(1);
    expect(result.handle).toBeUndefined();
    expect(f.relaysClosed).toBe(1);
    expect(f.hosts).toBe(0);
    // The runtime is closed on the way out, so the builder left up carries no dead pid's hold for the next run to age out.
    expect(await f.store.get("builders", "m1")).not.toHaveProperty("heldBy");
    expect(f.text()).toContain(`Nothing was sealed. Builder m1 stays up at about $0.11/hr; wsp init --recipe '${join(dirname(f.opts.statePath), "recipe.json")}' attaches to it again, and the sweep stops it once it is six hours old.`);
    expect(f.backends[0]!.machines.map(m => m.killed)).toEqual([false]);
    expect(await f.runtimes.at(-1)!.golden.get()).toBeUndefined();
    expect(f.opened).toEqual([]);
  });

  it("the detect spinner counts each rung as the collector finishes it, before the found note", async () => {
    const f = fake({
      collect: async onRung => {
        for (const rung of RUNGS) onRung(rung, FIXTURE.entries.filter(e => e.rung === rung).length);
        return FIXTURE;
      },
      recipe: async onHistory => {
        for (const h of RECIPE.histories) onHistory(h);
        return RECIPE;
      },
    });
    const run = runInit(f.opts, f.io);
    await f.until("1/5");
    const t = f.text();
    expect(t).toContain("Reading this computer  Identity 3");
    expect(t).toContain("Reading this computer  Identity 3, Shell 2, Toolchains 1, Tools 4, Agents 2, Sign-ins 3");
    expect(t.indexOf("Sign-ins 3")).toBeLessThan(t.indexOf("Found on this computer"));
    // Then the recipe is read, its own spinner naming each agent's history as it lands.
    expect(t.indexOf("Reading what your agents used")).toBeGreaterThan(t.indexOf("Sign-ins 3"));
    expect(t).toContain("Reading what your agents used  Claude Code: no history here");
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("the history spinner counts each session file off as it lands and says how long the whole read took, once", async () => {
    const read = { agent: "claude", state: "read" as const, sessions: 3, calls: 12 };
    const f = fake({
      recipe: async (onHistory, _onProject, onProgress) => {
        for (const n of [1, 2, 3]) onProgress({ agent: "claude", read: n, files: 3 });
        onHistory(read);
        return { ...RECIPE, histories: [read] };
      },
    });
    const run = runInit(f.opts, f.io);
    await f.until("1/5");
    const t = f.text();
    // The count is on the spinner's own line while it reads, and the counts each store came to land after it.
    expect(t).toContain("Reading what your agents used  Claude Code: reading session 2 of 3");
    expect(t).toContain("Reading what your agents used  Claude Code: 3 sessions, 12 tool calls");
    // How long it took, said once, after the spinner is gone and before the card.
    expect(t).toMatch(/Read 3 sessions in \d+m?s/);
    expect(t.match(/Read 3 sessions in/g)).toHaveLength(1);
    expect(t.indexOf("Read 3 sessions in")).toBeLessThan(t.indexOf("Found on this computer"));
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("counts the session files it opened, not the sessions a project filter kept, so the duration line still lands", async () => {
    // What wsp init --project sees: every session file is opened and none of them ran under the folder that was named.
    const none = { agent: "claude", state: "empty" as const, sessions: 0, calls: 0 };
    const f = fake({
      recipe: async (onHistory, _onProject, onProgress) => {
        for (const n of [1, 2]) onProgress({ agent: "claude", read: n, files: 2 });
        onHistory(none);
        return { ...RECIPE, histories: [none] };
      },
    });
    const run = runInit(f.opts, f.io);
    await f.until("1/5");
    expect(f.text()).toMatch(/Read 2 sessions in \d+m?s/);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("on a narrow terminal the tally is cut to the width so the spinner line never wraps onto itself", async () => {
    const f = fake({
      columns: 48,
      collect: async onRung => {
        for (const rung of RUNGS) onRung(rung, FIXTURE.entries.filter(e => e.rung === rung).length);
        return FIXTURE;
      },
    });
    const run = runInit(f.opts, f.io);
    await f.until("1/5");
    const spins = f.text().split("\r").filter(l => l.includes("Reading this computer"));
    expect(spins.length).toBeGreaterThan(1);
    expect(spins.map(l => l.length).filter(n => n > 48)).toEqual([]);
    expect(spins.filter(l => /Identity 3$/.test(l)).length).toBeGreaterThan(0);
    expect(spins.at(-1)).toMatch(/Identity 3, Shell 2.*…$/);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("nothing found on this machine still offers the six agents, unticked, and reaches the confirm", async () => {
    // A Mac with none of the agents: the recipe found nothing installed either, so no row offers the wsp tools.
    const none = { kind: "popular", sessions: 0, images: 0 } as const;
    const f = fake({ collect: async () => ({ entries: [] }), recipe: async () => ({ ...RECIPE, rows: RECIPE.rows.map(r => ({ ...r, on: r.kind === "tool" && r.source.kind === "popular", ...(r.source.kind === "installed" ? { source: none } : {}) })) }) });
    const run = runInit(f.opts, f.io);
    await f.until("Agents");
    expect(f.text()).toContain("Nothing found to bring");
    // The catalog's six, none ticked: a fresh Mac still gets to try them on a machine.
    expect(f.text()).toContain("On: 0 agents, 0 B");
    for (const name of ["Claude Code", "Codex", "Gemini CLI", "OpenCode", "Pi", "Hermes Agent"]) expect(f.text()).toMatch(new RegExp(`○ ${name}\\s+catalog\\s+not installed here\\s+[\\d.]+ MB`));
    await f.press(KEY.enter);
    await f.until("Tools  2/3");
    // Nothing here and nothing ticked: the base rows still come, and every other row is on the screen at its size.
    // The base rows fold behind the visible ones, and the why column is cut to the screen's width.
    expect(f.text()).toMatch(/• zip and unzip\s+base\s+always on th[^\n]*?\s+996 KB\n/);
    expect(f.text()).toContain("On: 13 tools, 785 MB");
    // No formula, no sign-in and no agent here that takes the wsp tools: none of those three screens is shown.
    await f.press(KEY.enter);
    await f.until(BOOT);
    for (const title of ["Also on this Mac", "Sign-ins", "wsp for your agents on this Mac"]) expect(f.text()).not.toContain(`◆  ${title}`);
    await f.press("n");
    expect((await run).code).toBe(1);
  });
});

describe("wsp init, the project the run is for", () => {
  it("with no folder named the first screen asks for one, and what it answers is read, carded and grouped on the tools screen", async () => {
    const f = fake();
    delete f.opts.project;
    const asked: string[] = [];
    f.opts.scanProject = async folder => {
      asked.push(folder);
      return { dir: folder, rows: [{ id: "go", name: "Go", why: "go.mod needs Go" }, { id: "docker", name: "Docker engine and compose", why: "compose.yaml needs Docker" }], candidates: [{ id: "ruby", name: "Ruby", why: "Gemfile needs Ruby" }] };
    };
    const run = runInit(f.opts, f.io);
    await f.until(PROJECT_QUESTION);
    expect(f.text()).toContain("optional; a folder on this Mac, read for what its own files say it needs");
    await f.press(..."~/proj".split(""), KEY.enter);
    await f.until("Your project needs");
    expect(asked).toEqual(["~/proj"]);
    const card = f.text().slice(f.text().lastIndexOf("Your project needs"));
    expect(card).toContain("go.mod needs Go");
    expect(card).toContain("Not in the catalog: Ruby (Gemfile needs Ruby)");
    await f.until("Agents");
    await f.press(KEY.enter);
    await f.until("Tools  2/5");
    // Go and Docker are both off in the catalog and neither was used here; the folder's own go.mod and compose.yaml
    // put each on the machine, in their own group.
    expect(f.text()).toMatch(/▾ Your project needs\s+2 of 2\s+756 MB/);
    expect(f.text()).toMatch(/● +Go +project +go\.mod needs[^\n]*? +239 MB/);
    expect(f.text()).toMatch(/● +Docker engine and compose +project +compose\.yaml nee[^\n]*? +517 MB/);
    await f.press(KEY.enter);
    await throughScreens(f, ["Sign-ins", "wsp for your agents"]);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("an empty answer asks nothing more: the folder is optional and the ticks stand as this computer left them", async () => {
    const f = fake();
    delete f.opts.project;
    const asked: string[] = [];
    f.opts.scanProject = async folder => {
      asked.push(folder);
      return { dir: folder, rows: [], candidates: [] };
    };
    const run = runInit(f.opts, f.io);
    await f.until(PROJECT_QUESTION);
    await f.press(KEY.enter);
    await f.until("Agents");
    expect(asked).toEqual([]);
    expect(f.text()).not.toContain("Your project needs");
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("an answer that names no folder is said so, not read as a project that needs nothing", async () => {
    const f = fake();
    delete f.opts.project;
    f.opts.scanProject = async () => undefined;
    const run = runInit(f.opts, f.io);
    await f.until(PROJECT_QUESTION);
    await f.press(..."~/prj".split(""), KEY.enter);
    await f.until(noFolderNote("~/prj"));
    expect(f.text()).not.toContain("named a tool the catalog carries");
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("a folder named on the command line is not asked for again, and cards what it asked for the way the question does", async () => {
    const f = fake();
    f.opts.recipe = async (_onHistory, onProject) => {
      onProject({ dir: NAMED_PROJECT, rows: [{ id: "go", name: "Go", why: "go.mod needs Go" }], candidates: [] });
      return RECIPE;
    };
    const run = runInit(f.opts, f.io);
    await f.until("Your project needs");
    expect(f.text().slice(f.text().lastIndexOf("Your project needs"))).toContain("go.mod needs Go");
    await f.until("Agents");
    expect(f.text()).not.toContain(PROJECT_QUESTION);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
  });
});

describe("wsp init, the summary-first screens", () => {
  const hermesKeys: ManifestEntry = { rung: "logins", id: "logins/hermes-keys", label: "Hermes Agent API keys", group: "Agent logins", paths: ["~/.hermes/.env"], bytes: 25_000, default: "bring", detail: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" };
  const hermesLogin: ManifestEntry = { rung: "logins", id: "logins/hermes", label: "Hermes Agent login", group: "Agent logins", paths: ["~/.hermes/auth.json"], bytes: 400, default: "skip" };
  const hermes: ManifestEntry = { rung: "agents", id: "agents/hermes", label: "Hermes Agent", paths: ["~/.hermes/config.yaml"], bytes: 600, default: "bring" };
  const kube: ManifestEntry = { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "bring" };
  const github: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/github", label: "github", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", consent: true, detail: "stdio: npx @modelcontextprotocol/server-github; runs via npx; carries a secret: env GITHUB_TOKEN (40 B)" };
  const notes: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/notes", label: "notes", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", detail: "stdio: npx notes-mcp; runs via npx; carries no secret" };
  /** This Mac with Hermes beside Claude Code and two of Claude Code's MCP servers, one with a token; a recipe that ticks Codex too, a tool the agents used that is not here, and one they looked at once. */
  const LAPTOP: Manifest = { entries: [...FIXTURE.entries, hermes, hermesLogin, hermesKeys, kube, github, notes] };
  /** Every browser sign-in opted in to running while the build runs, which is not what a row starts on; the defaults
   * are what the run below this one takes. */
  const IN_BUILD = ["claude", "codex", "gh"];
  const MEASURED: Recipe = {
    ...RECIPE,
    rows: [
      ...RECIPE.rows.map(r => ({ ...r, ...(r.id === "codex" ? { on: true } : {}), ...(IN_BUILD.includes(r.id) ? { signIn: "machine" as const } : {}) })),
      { id: "hermes", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.hermes/config.yaml"], bin: true } },
      { id: "wrangler", kind: "tool", on: true, source: { kind: "used", sessions: 3, calls: 40 } },
      { id: "go", kind: "tool", on: false, source: { kind: "used", sessions: 1, calls: 2 } },
    ],
  };

  it("four screens: the agents with what this computer did with each, the tools table, a choice per sign-in and the wsp tools; then the build installs the agent ticked here and signs it in on the machine", async () => {
    const f = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED, columns: 100 });
    // A tall terminal, so the whole tools list is on screen at once.
    Object.assign(f.io.output, { rows: 50 });
    for (const [rel, text] of [[".hermes/.env", "OPENAI_API_KEY=sk-x\n"], [".hermes/auth.json", "{}"], [".hermes/config.yaml", "model: x\n"], [".kube/config", "current-context: minikube\n"]] as const) {
      mkdirSync(dirname(join(f.opts.home, rel)), { recursive: true });
      writeFileSync(join(f.opts.home, rel), text);
    }
    // The stand-in guest's Claude config carries the two servers the recipe names, so the edit has them to keep.
    const claudeMcp = JSON.stringify({ mcpServers: { github: { url: "https://github.example/mcp", headers: { Authorization: "Bearer sk-ant-x-mcp" } }, notes: { url: "https://notes.example/mcp" } } }, null, 2);
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => guestAnswer(cmd, file => (file.endsWith(".claude.json") ? claudeMcp : undefined));
    f.backends.push(backend);
    const run = runInit(f.opts, f.io);

    await f.until("Agents");
    const one = f.text();
    // Before any question: what was found; the tool the agents used that this Mac has no row for gets a bare row, not a warning.
    expect(one).toContain("21 found on this computer. Nothing has left this computer.");
    expect(one).not.toContain("not in this build");
    // The catalog's six in its order, a size beside each, the three on this Mac ticked.
    expect(one).toMatch(/◆  Agents  1\/5\n┃ {2}Which agents go on the image\n┃ {2}You can change this later\.\n┃ {2}search/);
    expect(one).toContain("On: 3 agents, 1.1 GB");
    expect(one).toMatch(/● Hermes Agent\s+installed\s+installed here, never used\s+484 MB\n┃\s+● Claude Code\s+installed\s+installed here, never used\s+208 MB\n┃\s+● Codex\s+catalog\s+not installed here\s+455 MB\n/);
    // Down onto Gemini CLI: the detail says wsp cannot drive it yet and what installs; space ticks it for the machine.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down);
    await f.until("about 189 MB installed on the machine (measured 2026-09-05)");
    expect(f.text()).toContain("installs, but wsp cannot run its threads yet");
    expect(f.text()).toContain("not on this Mac; try it on the machine, nothing here changes");
    await f.press(KEY.space);
    await f.until(/● Gemini CLI/);
    await f.press(KEY.enter);

    await f.until("Tools  2/5");
    const two = f.text().slice(f.text().lastIndexOf("◆  Tools"));
    // Screen two is the list itself: the base as bullets under the title, then a group per why, every row with its
    // count and its size, the totals and the Disk line under them. Nothing is hidden behind a key.
    expect(two).toMatch(/^◆  Tools  2\/5\n┃ {2}Tools from your usage\n┃ {2}You can change this later\.\n┃ {2}search/);
    expect(two).toMatch(/▾ Always on the image\s+13\s+785 MB\n┃\s+• C toolchain with cmake and ninja\s+base\s+always on the image\s+469 MB\n/);
    expect(two).toMatch(/▾ You use these\s+1 of 2\s+239 MB\n┃\s+○ Go\s+used\s+below the floor, 2 commands in 1[^\n]*?239 MB\n┃\s+● Cloudflare Wrangler\s+used\s+40 commands in 3 sessions\s+239 MB\n/);
    // This Mac's npm global the catalog does not carry is no row here: the catalog is the Tools screen, the Also screen is its.
    expect(two).toMatch(/▾ Installed here, never used\s+2 of 2\s+54 MB\n┃\s+● GitHub CLI\s+installed\s+installed here, never used\s+40 MB\n┃\s+● yq\s+installed\s+installed here, never used\s+14 MB\n/);
    expect(two).not.toContain("tsx");
    expect(two).toMatch(/On: 16 tools, 1\.1 GB\n┃ {2}on when used in 2 sessions and 5 commands; heavy rows 3 and 20\n┃ {2}Disk: [\d.]+ GB of 15\.2 GB on the 20 GB builder\n┗ {2}space on or off • ← → fold • enter next • esc back/);
    expect(two).not.toContain("adjust");
    expect(two).not.toContain("every row on this screen that can be ticked");
    // Typing narrows the rows to a match; space unticks yq and the totals follow it.
    await f.press("y", "q");
    await f.until(/search {2}yq/);
    await f.press(KEY.space);
    await f.until(/○ yq/);
    expect(f.text().slice(f.text().lastIndexOf("◆  Tools"))).toContain("On: 16 tools");
    await f.press(KEY.enter);

    await f.until("Sign-ins  3/5");
    const four = f.text().slice(f.text().lastIndexOf("◆  Sign-ins"));
    // Every row carries the word it will act on, the agents first, then the CLIs, then the servers with auth.
    expect(four).toMatch(/▾ Agents\s+2 copy\s+0 during the build\s+2 when you need it\s+0 API key\s+0 skip\s+1 token\n/);
    // Claude Code's token is minted on this computer, and Codex signs in once on the computer that runs the
    // workspaces, so neither of them is a sign-in during the build.
    expect(four).toMatch(/Claude Code login\s+[^\n]*token from this computer\n/);
    expect(four).toMatch(/Codex login\s+[^\n]*sign in when you first need it\n/);
    // Hermes signs in through a menu only the person can work through, so its row opens on the copy instead.
    expect(four).toMatch(/Hermes Agent login\s+[^\n]*copy from this Mac\n/);
    expect(four).toMatch(/Hermes Agent API keys\s+[^\n]*copy from this Mac\n/);
    expect(four).toMatch(/▾ Developer CLIs\s+0 copy\s+1 during the build\s+0 when you need it\s+1 skip\n┃\s+GitHub CLI login\s+[^\n]*sign in during the build\n┃\s+kubectl config\s+kubectl is not coming\s+skip\n/);
    expect(four).toMatch(/▾ MCP servers from your agents' configs\s+0 copy\s+1 skip\n┃\s+github\s+in Claude Code's config\s+skip\n/);
    expect(four).not.toContain("notes");
    expect(four).not.toContain("wsp tools");
    // Right on the Hermes keys row walks it to the next word it takes.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down);
    await f.until("the keys in ~/.hermes/.env travel only by copy; no sign-in produces them");
    // The keys travel only by copy: no sign-in produces them, so the row walks between copy and skip alone.
    await f.press(KEY.right);
    await f.until(/Hermes Agent API keys\s+[^\n]*skip/);
    await f.press(KEY.left);
    await f.until(/Hermes Agent API keys\s+[^\n]*copy from this Mac/);
    // Down past the CLIs, headers included, onto the server with a token: copy keeps it in the machine's config with its secret.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
    await f.until("its token is in the agent's own config");
    await f.press(KEY.left);
    await f.until(/▾ MCP servers from your agents' configs\s+1 copy\s+0 skip\n┃ ❯\s+github\s+in Claude Code's config\s+copy from this Mac\n/);
    await f.press(KEY.enter);

    await f.until("wsp for your agents on this Mac  4/5");
    await f.press(KEY.enter);

    await f.until(BOOT);
    const summary = f.text().slice(f.text().lastIndexOf("Summary"), f.text().lastIndexOf("Recipe saved"));
    // The four agents and both MCP servers, the one with a token by the copy it was given on the screen.
    // Gemini's row is the catalog's, added after what the collector found, so it installs last.
    expect(summary).toMatch(/Agents\s+6 of 12/);
    expect(summary).toMatch(/Sign-ins\s+2 copy, 1 during the build, 2 when you need it, 1 token\s+25 KB\n/);
    expect(summary).toMatch(/Hermes Agent login\s+copy\n/);
    expect(summary).toMatch(/Hermes Agent API keys\s+copy\n/);
    expect(summary).toMatch(/kubectl config\s+skip\n/);
    expect(summary).toMatch(/github\s+copy\n/);
    expect(summary.replace(/\n\s*│?\s+/g, " ")).toMatch(/Installs\s+Claude Code, Codex, Hermes Agent, Gemini CLI, 2 tools plus Homebrew's toolchain, 2 MCP servers/);
    expect(f.text()).toMatch(/Recipe saved to .*golden-recipe\.json and .*recipe\.json/);
    await f.press("y");
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    const out = f.text();
    expect(out).not.toMatch(/—|\p{Emoji_Presentation}/u);
    // The four agents installed, Gemini from the catalog's road though nothing of it is on this Mac. The three
    // sign-ins opted in to the build ran here; Hermes, whose menu is the person's, copied instead; and Gemini's row,
    // left on the default, ran nothing at all and says where it is signed in instead.
    expect(out).toMatch(/Agents\n│\s+4 installed: Claude Code, Codex, Hermes Agent, Gemini CLI\n/);
    // Only the GitHub CLI signs in on the machine: Claude Code's token is this computer's and Codex's login is the
    // computer's that runs the workspaces, so neither opens a pty there.
    expect(f.link.ptys.map(p => p.ran)).toEqual([loginOf("gh")]);
    expect(out).toContain(`Gemini CLI login: ${SIGN_IN_DEFERRED_WORD}`);
    expect(f.reads).toEqual([]);
    const log = f.backends[0]!.machines[0]!.execLog;
    expect(log.some(c => c.includes("@google/gemini-cli@"))).toBe(true);
    expect(log.some(c => c.includes("brew install yq"))).toBe(false);
    expect(log.some(c => c.includes("brew install gh"))).toBe(true);
    // Both recipe files: the collector's rows with the ticks, and the small one with the catalog ids, ticks and answers as the screens left them.
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/gemini")).toMatchObject({ bring: true, paths: [] });
    expect(saved.get("agents/pi")).toMatchObject({ bring: false });
    expect(saved.get("tools/brew/yq")).toMatchObject({ bring: false });
    expect(saved.get("tools/brew/gh")).toMatchObject({ bring: true });
    expect(saved.get("tools/npm/tsx")).toMatchObject({ bring: false });
    // The keys row was left on copy, so it travels; the login beside it copies too, since its menu is the person's.
    expect(saved.get("logins/hermes-keys")).toMatchObject({ bring: true, choice: "copy" });
    expect(saved.get("logins/hermes")).toMatchObject({ bring: true, choice: "copy" });
    expect(saved.get("logins/gemini")).toMatchObject({ bring: false, choice: "later" });
    expect(saved.get("logins/kube")).toMatchObject({ bring: false, choice: "skip" });
    expect(saved.get("agents/mcp/claude/github")).toMatchObject({ bring: true, choice: "copy" });
    expect(saved.get("agents/mcp/claude/notes")).toMatchObject({ bring: true });
    // The server with the token was answered copy on the screen, so the edit kept it in the config beside the one
    // without a secret, and the build says both are there. The machine was asked to read its config out, once, and
    // took the edited bytes back as bytes: no definition of the person's rode a command line.
    expect(log.filter(c => c.includes("wsp_mcp_read "))).toHaveLength(1);
    expect(log.some(c => c.includes("mcpServers"))).toBe(false);
    // The read's answer is every config whole. The run log is kept beside the state for five runs and a person may
    // paste it into a bug report, so the read says its output is not a log's: the command is recorded, not what it
    // printed, and neither the server's own bearer nor the base64 the read prints is anywhere in the file.
    const runLog = readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8");
    expect(runLog).toContain("$ wsp_mcp_read 0 ");
    expect(runLog).not.toContain("sk-ant-x-mcp");
    expect(runLog).not.toContain(Buffer.from(claudeMcp, "utf8").toString("base64"));
    expect(out).not.toContain("sk-ant-x-mcp");
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).mcp).toEqual(expect.arrayContaining([expect.objectContaining({ name: "github", outcome: "installed" }), expect.objectContaining({ name: "notes", outcome: "installed" })]));
    const small = Recipe.parse(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")));
    const rows = new Map(small.rows.map(r => [r.id, r]));
    // A recipe is the whole answer, so the row left to first use records that word and not an absence.
    expect(rows.get("gemini")).toMatchObject({ on: true, signIn: "later" });
    // The saved recipe asked for a sign-in during the build for both agents; neither row takes that word any more,
    // so each opened on its own first one and the file records what was answered.
    expect(rows.get("codex")).toMatchObject({ on: true, signIn: "later" });
    expect(rows.get("claude")).toMatchObject({ on: true, signIn: "token" });
    expect(rows.get("hermes")).toMatchObject({ on: true, signIn: "copy" });
    expect(rows.get("yq")).toMatchObject({ on: false });
    expect(rows.get("gh")).toMatchObject({ on: true, signIn: "machine" });
    expect(rows.get("wrangler")).toMatchObject({ on: true });
    // Node is off the floor: this fixture's own use of it is under the floor, and the npm rows bring it at build time.
    expect(rows.get("node")).toMatchObject({ on: false });
    expect(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")).not.toMatch(/sk-x|minikube/);
  });

  it("esc steps back a screen and the ticks stand; the first screen stays put", async () => {
    const f = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED });
    const run = runInit(f.opts, f.io);
    await f.until("Agents");
    await f.press(KEY.esc);
    await new Promise(r => setTimeout(r, 100));
    expect(f.text()).not.toContain("Tools  2/5");
    // Down onto Gemini CLI and space: the tick stands when the screen is left and come back to.
    await f.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.space, KEY.enter);
    await f.until("Tools  2/5");
    await f.press(KEY.esc);
    await f.until(/Agents  1\/5[\s\S]*Agents  1\/5/);
    expect(f.text().slice(f.text().lastIndexOf("◆  Agents"))).toMatch(/● Gemini CLI/);
    await f.press(KEY.enter);
    await f.until(/Tools  2\/5[\s\S]*Tools  2\/5/);
    await f.press(KEY.enter);
    // Esc from the sign-ins lands on the tools: the Also screen between them has no row and is not shown.
    await f.until("Sign-ins  3/5");
    await f.press(KEY.esc);
    await f.until(/Tools  2\/5[\s\S]*Tools  2\/5[\s\S]*Tools  2\/5/);
    await f.press(KEY.enter);
    await f.until(/Sign-ins  3\/5[\s\S]*Sign-ins  3\/5/);
    await f.press(KEY.enter);
    await f.until("wsp for your agents on this Mac  4/5");
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/gemini")).toMatchObject({ bring: true });
    expect(saved.get("tools/catalog/wrangler")).toMatchObject({ label: "Cloudflare Wrangler", bring: true });
  });

  it("the wsp tools screen offers them to each agent on this Mac whose config the catalog knows; ticked, the server is in that config here when the screens end", async () => {
    const f = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED });
    const run = runInit(f.opts, f.io);
    await throughScreens(f, ["Agents", "Tools", "Sign-ins"]);
    await f.until("wsp for your agents on this Mac  4/5");
    const five = f.text().slice(f.text().lastIndexOf("◆  wsp for your agents on this Mac"));
    // Claude Code is the one agent here whose config the catalog can place a server in: Hermes is here without one, Codex is not here.
    expect(five).toContain("Add wsp's MCP server and skill to the agents installed here, so they can");
    expect(five).toMatch(/○ Claude Code\n/);
    expect(five).not.toMatch(/(Codex|Hermes Agent|Pi|Gemini CLI|OpenCode)\n/);
    // This computer has run no session with it, so the row starts off; the file it would write reads under it.
    expect(five).toContain("writes ~/.claude.json");
    await f.press(KEY.space);
    await f.until(/● Claude Code/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    // The helper's own line, after the recipe is saved and before anything boots.
    const out = f.text();
    expect(out).toContain("Claude Code now has the wsp tools: ~/.claude.json");
    expect(out.indexOf("Recipe saved to")).toBeLessThan(out.indexOf("Claude Code now has the wsp tools"));
    const written = JSON.parse(readFileSync(join(f.opts.home, ".claude.json"), "utf8")) as { mcpServers: { wsp: { command: string; args: string[] } } };
    expect(written.mcpServers.wsp.command).toBe(process.execPath);
    expect(written.mcpServers.wsp.args.slice(-3)).toEqual(["mcp", "--state", f.opts.statePath]);
    // The command the config now runs, named once after the agents' lines.
    expect(out).toContain(`The server command is ${process.execPath}`);
    expect(out).toContain(`mcp --state ${f.opts.statePath}`);
    await f.press("n");
    expect((await run).code).toBe(1);
  });

  it("unticked, the offer writes nothing on this Mac; a config that is not its format is refused in one line, left as it was, and the run goes on", async () => {
    const f = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    expect(f.text()).not.toContain("now has the wsp tools");
    expect(existsSync(join(f.opts.home, ".claude.json"))).toBe(false);
    await f.press("n");
    expect((await run).code).toBe(1);

    const broken = fake({ collect: async () => LAPTOP, recipe: async () => MEASURED });
    writeFileSync(join(broken.opts.home, ".claude.json"), "[]\n");
    const second = runInit(broken.opts, broken.io);
    await throughScreens(broken, ["Agents", "Tools", "Sign-ins"]);
    await broken.until("wsp for your agents on this Mac  4/5");
    await broken.press(KEY.space);
    await broken.until(/● Claude Code/);
    await broken.press(KEY.enter);
    await broken.until(BOOT);
    expect(broken.text()).toMatch(/Claude Code did not get the wsp tools: ~\/\.claude\.json: [^\n]+\. Fix the file and run wsp mcp install --agent claude\./);
    expect(readFileSync(join(broken.opts.home, ".claude.json"), "utf8")).toBe("[]\n");
    await broken.press("n");
    expect((await second).code).toBe(1);
  });

  it("--yes never writes an agent's config on this computer, however this Mac's own sessions would have ticked it, and says how to do it by hand", async () => {
    // Claude Code has run here, so the wsp tools screen would have opened with its row on; nobody answered it.
    const used: Recipe = { ...MEASURED, histories: [{ agent: "claude", state: "read", sessions: 151, calls: 4102 }] };
    const f = fake({ yes: true, collect: async () => LAPTOP, recipe: async () => used });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(existsSync(join(f.opts.home, ".claude.json"))).toBe(false);
    expect(f.text()).toContain("The wsp tools were not added to Claude Code here: a run taken as yes (--yes) writes nothing on this computer. Run wsp mcp install --agent claude to add them.");
  });

  it("under --yes the recipe decides the ticks, the keys copy, the logins wait for the machine, and both recipe files are written; no agent's config here is touched", async () => {
    const f = fake({ yes: true, collect: async () => LAPTOP, recipe: async () => MEASURED });
    for (const rel of [".hermes/.env", ".hermes/auth.json", ".hermes/config.yaml", ".kube/config"]) {
      mkdirSync(dirname(join(f.opts.home, rel)), { recursive: true });
      writeFileSync(join(f.opts.home, rel), "x\n");
    }
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).not.toMatch(/◆  Agents|◆  Tools|◆  Sign-ins/);
    expect(existsSync(join(f.opts.home, ".claude.json"))).toBe(false);
    expect(out).not.toContain("not in this build");
    expect(out.replace(/\n\s*│?\s+/g, " ")).toMatch(/Installs\s+Claude Code, Codex, Hermes Agent, 3 tools plus Homebrew's toolchain, 1 MCP server/);
    expect(out).toMatch(/Hermes Agent API keys\s+copy\n/);
    // The server with a token is consent: nobody is here to give it, so it stays off the machine.
    expect(out).not.toMatch(/github\s+copy/);
    // The copied keys are on the machine; their status is the catalog's to check from the app, not this terminal's.
    expect(out).toContain("Hermes Agent API keys: copied");
    expect(out).toContain("Sign-ins on the machine skipped: GitHub CLI login. --yes asks nothing; sign in from the app's terminal.");
    // Claude Code's token and Codex's login never run on a machine, so neither is among them; the token is asked
    // for on this computer, and a run that asks nothing leaves it where it stands.
    expect(out).toContain("Nothing asked for on this computer: Claude Code login. --yes asks nothing; paste it from the app.");
    expect(f.reads).toEqual([]);
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/codex")).toMatchObject({ bring: true });
    expect(saved.get("agents/gemini")).toMatchObject({ bring: false });
    expect(saved.get("tools/npm/tsx")).toMatchObject({ bring: false });
    expect(saved.get("tools/catalog/wrangler")).toMatchObject({ label: "Cloudflare Wrangler", bring: true });
    expect(saved.get("logins/hermes-keys")).toMatchObject({ bring: true, choice: "copy" });
    expect(saved.get("logins/kube")).toMatchObject({ bring: false, choice: "skip" });
    expect(saved.get("agents/mcp/claude/github")).toMatchObject({ bring: false, choice: "skip" });
    expect(saved.get("agents/mcp/claude/notes")).toMatchObject({ bring: true });
    const small = Recipe.parse(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")));
    expect(small.rows.filter(r => r.on).map(r => r.id)).toEqual(["claude", "codex", "curl", "uv", "python", "git", "jq", "ripgrep", "build-essential", "fd", "sqlite3", "wget", "zip", "xz", "rsync", "gh", "yq", "hermes", "wrangler"]);
    expect(small.rows.find(r => r.id === "gh")).toMatchObject({ signIn: "machine" });
    expect(small.rows.find(r => r.id === "go")).not.toHaveProperty("signIn");
    // --yes answers every row with the word its screen would have opened on: the same map signInItems hands the screen.
    const screens = signInItems(applyRecipe(withCatalogAgents(LAPTOP), MEASURED), new Map(), "darwin", HOME_HERE);
    for (const [id, choice] of screens.initial) {
      // The one exception is a Keychain login, which nobody is here to consent to; the run says so on the screen above.
      if (choice === "copy" && saved.get(id)?.paths.some(p => p.startsWith("Keychain:")) === true) continue;
      expect([id, saved.get(id)?.choice]).toEqual([id, choice]);
    }
  });

  it("a Keychain-held Claude login is never copied: the row is the token's, nothing is read of the Keychain and nothing runs on the machine", async () => {
    // The Keychain item is here and the recipe answers nothing, so the screen opens the row on the one word it
    // takes. A sign-in never sits in an image, so there is nothing to consent to and nothing to read.
    const held: Manifest = { entries: [FIXTURE.entries[0]!, { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: ["Keychain: Claude Code-credentials"], bytes: 0, default: "bring" }] };
    const f = fake({ yes: true, collect: async () => held, recipe: async () => ticking("claude") });
    expect(signInItems(applyRecipe(withCatalogAgents(held), ticking("claude")), new Map(), "darwin", HOME_HERE).initial.get("logins/claude")).toBe("token");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.reads).toEqual([]);
    expect(f.link.ptys.map(p => p.writes[0]).filter(w => w?.includes("exec bash -c claude"))).toEqual([]);
    expect(loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/claude")?.choice).toBe("token");
    expect(f.text()).toContain("Nothing asked for on this computer: Claude Code login. --yes asks nothing; paste it from the app.");
  });
});

describe("wsp init, the secrets step", () => {
  it("a cut secret is skipped under --non-interactive naming that flag, and under --yes off a terminal naming the terminal, while the sign-ins are left to first use", async () => {
    const tty = fake({ nonInteractive: true });
    writeFileSync(join(tty.opts.home, ".zshrc"), "export A_KEY=fake\n");
    expect((await runInit(tty.opts, tty.io)).code).toBe(0);
    expect(tty.text()).toContain("Secrets skipped: A_KEY (cut from ~/.zshrc). --non-interactive asks nothing; set them from the app's terminal.");

    const pipe = fake({ yes: true, tty: false });
    writeFileSync(join(pipe.opts.home, ".zshrc"), "export A_KEY=fake\n");
    expect((await runInit(pipe.opts, pipe.io)).code).toBe(0);
    expect(pipe.text()).toContain("Secrets skipped: A_KEY (cut from ~/.zshrc). No terminal to paste into; set them from the app's terminal.");
    // Nothing here is sent to the app's terminal: both logins take the default, so nothing was waited on and each
    // row says where its sign-in happens instead.
    expect(pipe.text()).not.toContain("Sign-ins on the machine skipped");
    expect(pipe.text()).toContain(`GitHub CLI login: ${SIGN_IN_DEFERRED_WORD}`);
    // Claude Code's token is this computer's to paste, and off a terminal there is nobody to paste it.
    expect(pipe.text()).toContain("Nothing asked for on this computer: Claude Code login. No terminal to paste into; paste it from the app.");
  });

  it("an rc file with a cut secret export is named in the secrets step, skipped under --yes with the reason and recorded", async () => {
    // The recipe row carries no secrets field: the names come from the pack, which strips the file as it stands at build time.
    const f = fake({ yes: true });
    writeFileSync(join(f.opts.home, ".zshrc"), "export A=1\nexport A_KEY=fake\n");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("Secrets skipped: A_KEY (cut from ~/.zshrc). --yes asks nothing; set them from the app's terminal.");
    expect(out).toMatch(/Secrets\n│\s+A_KEY\s+skipped \(--yes asks nothing; set them from the app's terminal\)\n/);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      secrets: [{ name: "A_KEY", from: "cut from ~/.zshrc", state: "skipped", note: "--yes asks nothing; set them from the app's terminal" }],
    });
    // The value never went anywhere: no pty was opened for it.
    expect(f.link.ptys.filter(p => p.created["env"] !== undefined && "WSP_SECRET_LINE" in (p.created["env"] as object))).toEqual([]);
  });

  it("on a terminal each cut secret is asked for hidden and set before any sign-in runs; the pasted value rides the pty's environment into the machine's secrets file, out of the screen and the run log", async () => {
    const f = fake({ recipe: async () => answeredInBuild("gh") });
    writeFileSync(join(f.opts.home, ".zshrc"), "export A=1\nexport ANTHROPIC_API_KEY=fake\n");
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Paste each value to set it on the machine, or leave it empty to skip.");
    expect(f.text()).not.toContain("Signing in on the machine");
    await f.until("cut from ~/.zshrc; the value is set on the machine and never shown here");
    await f.press(..."s3cret-value".split(""), KEY.enter);
    await f.until("ANTHROPIC_API_KEY: set in /etc/profile.d/wsp-secrets.sh on the machine");
    // Claude Code's token is asked for on this computer, between the secrets and the machine's own sign-ins.
    await pastTheVault(f, "Signing in on the machine");
    await f.until(`GitHub CLI login: signed in (${loginOf("gh")} exited 0)`);
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.secrets).toEqual([{ name: "ANTHROPIC_API_KEY", from: "cut from ~/.zshrc", state: "set" }]);
    const out = f.text();
    expect(out.indexOf("Paste each value")).toBeGreaterThan(out.indexOf("Ready"));
    expect(out.indexOf("Paste each value")).toBeLessThan(out.indexOf("Signing in on the machine"));
    expect(out.indexOf("Signing in on the machine")).toBeLessThan(out.indexOf("Ready to seal image v1"));
    expect(out).toMatch(/Secrets\n│\s+ANTHROPIC_API_KEY\s+set on the machine\n/);
    expect(out).not.toContain("s3cret");
    // The machine's secrets file is read first (nothing there on a fresh builder, no fish), then the one write, and
    // only then the sign-ins.
    const read = f.link.ptys.find(p => p.ran!.startsWith(readCommand()))!;
    expect(read.created["env"]).toEqual({ PS1: "" });
    const pty = f.link.ptys.find(p => p.created["env"] !== undefined && "WSP_SECRET_LINE" in (p.created["env"] as object))!;
    expect(pty.created).toEqual({ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "", WSP_SECRET_LINE: "export ANTHROPIC_API_KEY='s3cret-value'" } });
    expect(pty.ran).toBe(appendCommand(false));
    expect(pty.killed).toBe(true);
    const lines = f.link.ptys.map(p => p.writes[0]!);
    expect(lines.indexOf(pty.writes[0]!)).toBeLessThan(lines.findIndex(l => l.includes("; exec bash -c ")));
    // The read, the write and the GitHub CLI's sign-in; Claude Code's token is asked for here, so nothing is
    // dialled for it.
    expect(f.link.dials).toBe(3);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({
      logins: [{ id: "logins/claude", state: "not-signed-in" }, { id: "logins/gh", state: "signed-in", note: `${loginOf("gh")} exited 0` }],
      secrets: [{ name: "ANTHROPIC_API_KEY", from: "cut from ~/.zshrc", state: "set" }],
    });
    expect(readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8")).not.toContain("s3cret");
  });

});

describe("wsp init, the sign-in stage", () => {
  /** The Supabase CLI alone is on, so its login is the one listed; the kubeconfig's command is not coming, so that row is locked at skip. */
  // The Supabase CLI stands in for every login that still signs in on the machine: a browser flow, a no-browser
  // variant to retry with, and a status command of its own. The agents' own rows sign in nowhere near a machine.
  const CODEX = answeredInBuild("supabase", without(ticking("supabase"), "claude"));
  const CODEX_MANIFEST: Manifest = {
    entries: [
      FIXTURE.entries[0]!,
      { rung: "tools", id: "tools/brew/kubernetes-cli", label: "kubernetes-cli", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "logins", id: "logins/supabase", label: "Supabase login", group: "CLI logins", paths: ["~/.supabase"], bytes: 300, default: "skip" },
      { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "skip" },
    ],
  };

  it("a login the status check does not confirm is offered a retry, then the table's fallback, then a skip; o opens the page here and arms auto-open for that command only; the skip lands in the notes", async () => {
    const f = fake({ signedIn: false, hold: true, collect: async () => CODEX_MANIFEST, recipe: async () => CODEX });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    expect(f.text()).toMatch(/Supabase login\s+[^\n]*sign in during the build/);
    await f.until(BOOT);
    await f.press("y");

    // The default flow first: the shim would open the page; here the printed URL is offered with o.
    await f.until(/Supabase login\s+supabase login\n/);
    await f.until("Press Enter to open https://github.com/login/device");
    // The terminal's stage answers Ctrl-C itself: the run puts no stop handler on the signals here, as it does on the hand-off road.
    expect(f.signals.listenerCount("SIGINT") + f.signals.listenerCount("SIGTERM")).toBe(0);
    const builderId = f.backends[0]!.machines[0]!.id;
    expect(f.hooks[0]!.autoOpen(builderId, DEVICE_URL)).toBe(false);
    // While the pty is on screen the shim's line says what to press here; outside it the relay keeps its own words.
    expect(f.hooks[0]!.openLine("default (builder)", "github.com", DEVICE_URL)).toBe("default (builder): press o on the link above to open it here");
    expect(f.hooks[0]!.openLine("task-1", "github.com", DEVICE_URL)).toBe("task-1: a sign-in page for github.com is ready; open it from the app");
    await f.press("o");
    await f.until("opened on this computer");
    expect(f.opened).toEqual([DEVICE_URL]);
    // gh's Enter re-sends the page o just opened: the pty says so instead of asking for o again.
    expect(f.hooks[0]!.openLine("default (builder)", "github.com", DEVICE_URL)).toBe("default (builder): that page is already open here");
    expect(f.hooks[0]!.openLine("default (builder)", "other.test", "https://other.test/a")).toBe("default (builder): press o on the link above to open it here");
    // One o arms exactly one auto-open, and never for the page o already opened here (gh's Enter re-sends that one).
    expect(f.hooks[0]!.autoOpen("some-other-workspace", "https://other.test/a")).toBe(false);
    expect(f.hooks[0]!.autoOpen(builderId, DEVICE_URL)).toBe(false);
    expect(f.hooks[0]!.autoOpen(builderId, "https://other.test/a")).toBe(true);
    expect(f.hooks[0]!.autoOpen(builderId, "https://other.test/a")).toBe(false);
    await f.press("o");
    await f.until(/opened on this computer[\s\S]*opened on this computer/);
    expect(f.hooks[0]!.autoOpen(builderId, "https://other.test/b")).toBe(true);
    // A host line during the pty lands inside it, dim, instead of breaking the raw terminal.
    expect(f.hooks[0]!.onLine("default (builder): forwarding localhost:1455 on this computer")).toBe(true);
    expect(f.text()).toContain("default (builder): forwarding localhost:1455 on this computer");
    await f.press("\x03");
    await f.until("Supabase login: not signed in (supabase login exited 130)");
    expect(f.hooks[0]!.autoOpen(builderId, "https://other.test/c")).toBe(false);
    expect(f.hooks[0]!.onLine("later")).toBe(false);
    expect(f.hooks[0]!.openLine("default (builder)", "github.com", DEVICE_URL)).toBe("default (builder): a sign-in page for github.com is ready; open it from the app");

    await f.until("r retry   f retry with supabase login --no-browser   s skip");
    await f.press("r");
    await f.until(/supabase login\n[\s\S]*Press Enter to open[\s\S]*Press Enter to open/);
    await f.press("\x03");
    await f.until(/not signed in[\s\S]*not signed in[\s\S]*r retry/);
    await f.press("f");
    await f.until(/Supabase login\s+supabase login --no-browser/);
    await f.press("\x03");
    await f.until(/not signed in[\s\S]*not signed in[\s\S]*not signed in[\s\S]*r retry/);
    await f.press("s");

    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    const out = f.text();
    expect(out).toMatch(/Supabase login\s+skipped\s+skipped by you/);
    // Three login ptys (default, retry, fallback), no status run after any of them and no check script since nothing was copied; o never reached the machine.
    expect(f.link.ptys.map(p => p.ran)).toEqual(["supabase login", "supabase login", "supabase login --no-browser"]);
    expect(f.link.ptys.flatMap(p => p.writes.slice(1))).toEqual(["\x03", "\x03", "\x03"]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({
      logins: [{ id: "logins/supabase", label: "Supabase login", state: "skipped", command: "supabase login --no-browser", note: "skipped by you" }],
    });
    expect(result.logins?.map(l => l.state)).toEqual(["skipped"]);
    expect(out).not.toMatch(/—/);
    // o opened the page twice; the device URL, the second o, then the app after the seal.
    expect(f.opened).toEqual([DEVICE_URL, DEVICE_URL, expect.stringMatching(OPENING_PAGE)]);
    // The seal stamps their states on the version.
    expect((await f.runtimes.at(-1)!.golden.get())?.versions[0]?.logins).toEqual([{ name: "Supabase login", state: "skipped" }]);
  });

  it("a tool that is not on the machine (exit 127) is skipped with that reason, its status command never runs, and nothing is asked", async () => {
    const f = fake({ missing: true, collect: async () => CODEX_MANIFEST, recipe: async () => CODEX });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Supabase login: skipped (supabase is not on the machine)");
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    expect(f.link.ptys.map(p => p.ran)).toEqual(["supabase login"]);
    expect(f.text()).not.toContain("r retry");
    expect(result.logins?.[0]).toEqual({ id: "logins/supabase", label: "Supabase login", state: "skipped", command: "supabase login", exit: 127, note: "supabase is not on the machine" });
  });

  it("a browser-only row takes the default, so the build runs nothing for it, says where it is signed in instead and goes on to the seal", async () => {
    // The Supabase CLI's login can only happen in a browser: nothing of it is on this Mac to copy. Nobody answers
    // the screens, so the row keeps the answer it opened on, which is the one that waits on nobody.
    const f = fake({ signedIn: false, hold: true, collect: async () => CODEX_MANIFEST, recipe: async () => without(ticking("supabase"), "claude") });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    expect(f.text()).toMatch(/Supabase login\s+[^\n]*sign in when you first need it/);
    await f.until(BOOT);
    await f.press("y");
    await f.until(`Supabase login: ${SIGN_IN_DEFERRED_WORD}`);
    // The seal comes on its own: nothing was waited on, so no retry is offered and no key is read for one.
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    // Not one pty ran the sign-in: the only commands on the machine are the build's own.
    expect(f.link.ptys.map(p => p.writes[0]).filter(w => w?.includes("supabase login"))).toEqual([]);
    expect(f.text()).not.toContain("r retry");
    expect(f.text()).not.toContain("r sign in on the machine");
    expect(result.logins).toEqual([{ id: "logins/supabase", label: "Supabase login", state: "deferred" }]);
    // The version carries the row, so the image says which of its sign-ins is still to be made.
    expect((await f.runtimes.at(-1)!.golden.get())?.versions[0]?.logins).toEqual([{ name: "Supabase login", state: "deferred" }]);
    // The recipe records the answer, and a second run reads it back rather than deciding again.
    const small = Recipe.parse(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")));
    expect(small.rows.find(r => r.id === "supabase")).toMatchObject({ on: true, signIn: "later" });
    expect(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.find(e => e.id === "logins/supabase")?.choice).toBe("later");
    expect(signInItems(applyRecipe(withCatalogAgents(CODEX_MANIFEST), small), new Map(), "darwin", HOME_HERE).initial.get("logins/supabase")).toBe("later");
  });

  it("a machine sign-in that ended with a non-zero exit is not signed in and offered a retry or a skip; a clean exit signs it in", async () => {
    // A login whose command is not coming starts at skip and is never staged, so the tools row that brings cloudflared is here.
    const CLOUDFLARED_MANIFEST: Manifest = {
      entries: [
        FIXTURE.entries[0]!,
        { rung: "tools", id: "tools/brew/cloudflared", label: "cloudflared", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
        { rung: "logins", id: "logins/cloudflared", label: "cloudflared login", group: "CLI logins", paths: ["~/.cloudflared/cert.pem"], bytes: 300, default: "skip" },
      ],
    };
    const f = fake({ signedIn: false, hold: true, collect: async () => CLOUDFLARED_MANIFEST, recipe: async () => answeredInBuild("cloudflared", without(ticking("cloudflared"), "claude")) });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until(/cloudflared login\s+cloudflared tunnel login\n/);
    await f.until("Press Enter to open");
    await f.press("\x03");
    await f.until("cloudflared login: not signed in (cloudflared tunnel login exited 130)");
    await f.until("cloudflared login  r retry   s skip");
    await f.press("r");
    await f.until(/Press Enter to open[\s\S]*Press Enter to open/);
    // A clean exit is the sign-in landing: nothing to check and nothing to retry.
    f.link.exit(f.link.ptys.at(-1)!, 0);
    await f.until(/signed in \(cloudflared tunnel login exited 0\)\n/);
    await f.until(SEAL_Q(1));
    await f.press(KEY.enter);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.logins?.map(l => [l.state, l.exit])).toEqual([["signed-in", 0]]);
    expect(f.text()).toMatch(/Sign-ins\n│\s+cloudflared login\s+signed in\n/);
  });

  it("an unreadable golden-import.json is said so when the logins and secrets are written into a fresh one", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-notes-"));
    dirs.push(dir);
    const path = join(dir, "golden-import.json");
    writeFileSync(path, "{ not json");
    expect(noteOutcomes(path, { logins: [{ id: "logins/gh", label: "GitHub CLI login", state: "skipped" }], secrets: [] })).toEqual({ replaced: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ logins: [{ id: "logins/gh", label: "GitHub CLI login", state: "skipped" }], secrets: [] });
    expect(noteOutcomes(path, { logins: [] })).toEqual({ replaced: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ logins: [], secrets: [] });
  });

  it("a daemon link that drops under a login ends that command as not signed in, and the retry dials a fresh link", async () => {
    const f = fake({ signedIn: false, hold: true, collect: async () => CODEX_MANIFEST, recipe: async () => CODEX });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Press Enter to open https://github.com/login/device");
    expect(f.link.dials).toBe(1);
    f.link.drop();
    await f.until("Supabase login: not signed in (the machine's terminal link dropped)");
    await f.until("r retry   f retry with supabase login --no-browser   s skip");
    await f.press("r");
    await f.until(/Press Enter to open[\s\S]*Press Enter to open/);
    expect(f.link.dials).toBe(2);
    await f.press("\x03");
    await f.until(/not signed in \(supabase login exited 130\)/);
    await f.until(/exited 130[\s\S]*r retry   f retry/);
    await f.press("s");
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.logins?.map(l => [l.state, l.note])).toEqual([["skipped", "skipped by you"]]);
  });

  it("outside a pty the openLine hook says exactly what the relay says by itself, hostname and all", async () => {
    // The relay's default line, read off a real relay over a fake link and a workspace named task-1.
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes(DAEMON_TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const create = backend.create.bind(backend);
    backend.create = async spec => Object.assign(await create(spec), { previewUrl: async () => ({ url: "http://guest.test", token: "pt", expiresAt: Date.now() + 3_600_000 }) });
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] });
    // Nothing answers on guest.test, so the create's daemon ping is kept short.
    backend.lifecycle.budgets.daemonAnswersMs = 100;
    const rt = createRuntime({ backend, store, adapters: {}, hostId: "box:h1" });
    await createOn(rt, { golden: "snap_g", name: "task-1" });
    const lines: string[] = [];
    let emit: ((e: Record<string, unknown>) => void) | undefined;
    const connect = async (c: ConnectOptions): Promise<DaemonSocket> => {
      emit = c.onEvent ?? (() => {});
      let settle: (code: number) => void = () => {};
      const closed = new Promise<number>(r => (settle = r));
      return { op: async op => (op === "ports.watch" ? { ok: true, ports: [] } : { ok: true }), close: () => settle(1000), closed, beats: 0, open: true };
    };
    const relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: l => lines.push(l), connect });
    for (let i = 0; i < 200 && emit === undefined; i++) await new Promise(r => setTimeout(r, 5));
    emit!({ type: "browser.open", url: "https://github.com/login/device" });
    for (let i = 0; i < 200 && lines.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    await relay.close();
    expect(lines).toHaveLength(1);

    // init's hook, for a target that is not the builder, produces the same line.
    const f = fake({ yes: true, collect: async () => CODEX_MANIFEST, recipe: async () => CODEX });
    await runInit(f.opts, f.io);
    expect(f.hooks[0]!.openLine("task-1", "github.com", "https://github.com/login/device")).toBe(lines[0]);
  });

  it("when the machine's terminal cannot be reached the login is not signed in with the reason, can be skipped, and the seal still comes", async () => {
    const f = fake({ collect: async () => CODEX_MANIFEST, recipe: async () => CODEX, daemon: async () => { throw new Error("no daemon token"); } });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await f.until("Supabase login: not signed in (no daemon token)");
    await f.until("r retry   f retry with supabase login --no-browser   s skip");
    await f.press("s");
    await sealIt(f);
    await firstWorkspace(f, "");
    const result = await run;
    expect(result.code).toBe(0);
    expect(result.logins).toEqual([{ id: "logins/supabase", label: "Supabase login", state: "skipped", command: "supabase login", note: "skipped by you" }]);
    // The typed key never echoes into the next line.
    expect(f.text()).not.toMatch(/\ns[│◇]/);
  });
});

describe("wsp init, logins copied to the machine", () => {
  it("a Claude login with an apiKeyHelper here has nothing read and nothing copied, and the settings.json that travels loses its helper line", async () => {
    const withHelper: Manifest = {
      entries: [
        FIXTURE.entries[0]!,
        { rung: "agents", id: "agents/claude", label: "Claude Code", paths: ["~/.claude/settings.json"], bytes: 60, default: "bring" },
        { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: ["Helper: ~/.claude/settings.json"], bytes: 0, default: "bring", detail: "Claude Code uses the apiKeyHelper in ~/.claude/settings.json" },
      ],
    };
    const f = fake({ tty: false });
    mkdirSync(join(f.opts.home, ".claude"), { recursive: true });
    writeFileSync(join(f.opts.home, ".claude", "settings.json"), '{"apiKeyHelper": "security find-generic-password -s anthropic-api-key -w"}');
    f.opts.collect = async () => withHelper;
    // Even a saved recipe answering copy brings nothing: the row takes no such answer any more.
    f.opts.recipe = async () => answeredCopy("claude");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    // The helper is never run and macOS is never asked: a key it printed would outrank the vault's token inside
    // the CLI on every turn, so nothing of it travels.
    expect(f.reads).toEqual([]);
    const out = f.text();
    expect(out).not.toContain("Running the ~/.claude/settings.json helper");
    expect(out).not.toContain("Claude Code login: copied");
    expect(loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/claude")?.choice).toBe("token");
    // The settings.json that does travel comes out with no helper in it.
    const landed = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")) as { files: { skipped: unknown[] } };
    expect(landed.files.skipped).toEqual([{ id: "agents/claude", path: "~/.claude/settings.json", note: "apiKeyHelper left out of the copy: the command runs on this computer only" }]);
  });

  it("a gh login whose account in use here has no Keychain item is refused with that account named and is left to first use", async () => {
    const f = fake({ yes: true });
    withGhCopy(f);
    f.opts.secrets = {
      read: async (service, account) => {
        f.reads.push(`${service} (${account})`);
        throw new Error(`Command failed: security find-generic-password -s ${service} -a ${account} -w\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n`);
      },
      run: async () => {
        throw new Error("no helper in this fixture");
      },
    };
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    git_protocol: ssh\n    users:\n        other:\n        Zingzy:\n    user: Zingzy\n");
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    // hosts.yml names Zingzy the user in use, so that is the one item the run asks macOS for; other is never read.
    expect(f.reads).toEqual(["gh:github.com (Zingzy)"]);
    expect(f.text()).toContain(
      `GitHub CLI login: Keychain read failed (Zingzy: security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.); changed to ${SIGN_IN_LATER}.`,
    );
    expect(f.text()).not.toContain("left behind");
    expect(loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("later");
    expect(f.recipes).toHaveLength(2);
  });
});

describe("wsp init, flags and no terminal", () => {
  it("without a terminal it behaves as --yes: defaults taken, nothing asked, the golden sealed, no workspace forked, no host, and the wsp up named beside this computer", async () => {
    const f = fake({ tty: false, recipe: async () => answeredInBuild("gh") });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(result.handle).toBeUndefined();
    const out = f.text();
    expect(out).toContain("Taken as yes (no terminal)");
    expect(out).toContain("Sealing image v1. Taken as yes (no terminal).");
    expect(out).toContain("Image v1 sealed.");
    // Nobody is here to use the app or to pay for a machine nobody asked for: no host and no fork. A workspace is
    // one project's copy and this run named no folder here, so the tick makes none and the line says the road.
    expect(out).not.toContain("forked from image v1");
    expect(out).toContain("a workspace is one project's, and this run named no folder here");
    expect(out).not.toMatch(URL_RE);
    expect(await f.runtimes.at(-1)!.workspaces.list()).toEqual([]);
    expect(f.trail).toEqual([]);
    expect(f.relays).toBe(1);
    expect(f.hosts).toBe(0);
    // No process stays to end a kept builder's window, so the builder goes with the seal; the smoke fork too; nothing else booted.
    expect(f.backends[0]!.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1-default-v1", true]]);
    expect(out).not.toContain("The builder stays up ten minutes");
    expect(await f.store.list("builders")).toEqual([]);
    expect(f.opened).toEqual([]);
    // The gh login is opted in to the build by the saved recipe: nobody is here to click macOS's consent dialog, so
    // the Keychain is never asked, and the sign-in runs on the machine with its page handed over.
    expect(f.reads).toEqual([]);
    expect(out).toMatch(/GitHub CLI login\s+during the build/);
    expect(out).toContain(`GitHub CLI login: open ${DEVICE_URL} on this computer`);
    expect(out).toContain(`open '${DEVICE_URL}'`);
    expect(result.logins?.find(l => l.id === "logins/gh")).toMatchObject({ state: "signed-in", note: `${loginOf("gh")} exited 0` });
    expect(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("machine");
    expect(out).not.toContain("from your Keychain");
    // Nothing is printed as an object without --json.
    expect(f.records).toEqual([]);
  });

  it("off a terminal a saved copy answer still reads the Keychain, and says what is read before macOS can ask", async () => {
    const f = fake({ tty: false });
    f.opts.recipe = async () => answeredInBuild("gemini", answeredCopy("gh", ticking("gemini")));
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    const out = f.text();
    const said = out.indexOf("Reading gh:github.com from your Keychain, as the saved recipe answered copy; macOS may ask you to allow it.");
    expect(said).toBeGreaterThan(-1);
    expect(said).toBeLessThan(out.search(BOOT));
    // The copied gh login is recorded as copied with nobody here and nothing runs for it; the one sign-in chosen
    // for the machine is run there and its page handed over.
    expect(f.text()).toContain("GitHub CLI login: copied");
    expect(f.text()).toContain(`Gemini CLI login: open ${GEMINI_URL} on this computer`);
    expect(f.link.ptys.map(p => p.ran)).toEqual(["gemini --skip-trust"]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({
      logins: [
        // Claude Code's row is the vault's, and off a terminal there is nobody to paste its token.
        { id: "logins/claude", state: "not-signed-in", note: "no terminal to paste into; paste it from the app" },
        { id: "logins/gh", state: "copied" },
        { id: "logins/gemini", state: "signed-in", note: "gemini --skip-trust exited 0" },
      ],
    });
  });

  it("under --non-interactive --json on a terminal with the app's ports taken: no screens, each sign-in's page and outcome as one object, no host, the golden recorded, and one last object naming it and the wsp up to run", async () => {
    // Another host holds the app's port, as the coordinator's did: a run nobody is at never binds it, so it never notices.
    const port = await heldPort();
    const f = fake({ nonInteractive: true, json: true, ports: { port, wsPort: port, named: true }, upCommand: "wsp up --state /tmp/wsp-test/state.json", forkCommand: "wsp new first --state /tmp/wsp-test/state.json", recipe: async () => answeredInBuild("gh", answeredInBuild("gemini", ticking("gemini"))) });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(result.handle).toBeUndefined();
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).not.toMatch(/◆  Agents|◆  Sign-ins/);
    expect(out).not.toContain("is in use on this computer");
    expect(out).toContain("Taken as yes (--non-interactive)");
    expect(out).toContain("Sealing image v1. Taken as yes (--non-interactive).");
    expect(out).toContain("a workspace is one project's, and this run named no folder here");
    const rt = f.runtimes.at(-1)!;
    expect(goldenHead(await rt.golden.get())?.snapshotId).toBe("snap_wsp-h1-default-v1");
    // An agent pays for no machine it did not ask for: nothing is forked. A workspace is one project's copy and
    // this run named no folder here, so the tick makes none either.
    expect(await rt.workspaces.list()).toEqual([]);
    // Every stage frame is one object too, so whoever drives the run can clock a step; the sign-ins and the end follow in order.
    const stages = f.records.filter(r => r["event"] === "stage");
    expect(stages[0]).toEqual({ event: "stage", stage: "creating", detail: expect.any(String) });
    expect(stages.map(r => r["stage"])).toEqual(expect.arrayContaining(["creating", "installing-tools", "ready", "snapshotting", "sealed"]));
    expect(stages.some(r => r["stage"] === "installing-tools" && typeof (r["step"] as { command?: unknown } | undefined)?.command === "string")).toBe(true);
    expect(f.records.filter(r => r["event"] !== "stage")).toEqual([
      // Claude Code's token is this computer's and nobody is at this terminal to paste it, so its row is one object
      // and no machine is asked for anything.
      { event: "sign-in-result", tool: "claude", label: "Claude Code login", state: "not-signed-in", note: "--non-interactive asks nothing; paste it from the app" },
      // Each sign-in on the machine is an object as its command starts, then again with its page and the road that
      // page names, then its outcome.
      { event: "sign-in", tool: "gh", label: "GitHub CLI login" },
      { event: "sign-in", tool: "gh", label: "GitHub CLI login", browserUrl: DEVICE_URL, finish: "none", nextCommand: `open '${DEVICE_URL}'`, waitSeconds: 120 },
      { event: "sign-in-result", tool: "gh", label: "GitHub CLI login", state: "signed-in", note: `${loginOf("gh")} exited 0` },
      { event: "sign-in", tool: "gemini", label: "Gemini CLI login" },
      // Gemini's row is declared callback, and the page it printed here returns to a hosted page rather than to a
      // port on the machine, so the row takes a code.
      // Every row is given the same two minutes, whatever the tool itself would have waited for.
      { event: "sign-in", tool: "gemini", label: "Gemini CLI login", browserUrl: GEMINI_URL, finish: "code", nextCommand: `open '${GEMINI_URL}'`, waitSeconds: 120 },
      { event: "sign-in-result", tool: "gemini", label: "Gemini CLI login", state: "signed-in", note: "gemini --skip-trust exited 0" },
      // Nothing was made, so the last object names the command that opens the app and no workspace.
      { event: "done", golden: "default", version: 1, snapshotId: "snap_wsp-h1-default-v1", recipe: join(dirname(f.opts.statePath), "recipe.json"), nextCommand: "wsp up --state /tmp/wsp-test/state.json", forkCommand: "wsp new first --state /tmp/wsp-test/state.json" },
    ]);
    // Claude Code's token is the vault's and nobody is at this terminal to paste it; the two machine sign-ins ran.
    expect(result.logins?.map(l => l.state)).toEqual(["not-signed-in", "signed-in", "signed-in"]);
    // No process stays to end a kept builder's window, so the builder goes with the seal; the smoke fork too; nothing else boots.
    expect(f.backends[0]!.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1-default-v1", true]]);
    expect(await f.store.list("builders")).toEqual([]);
  });

  it("under --json with --first-workspace the last object names the workspace forked, in place of the fork command", async () => {
    const f = fake({ nonInteractive: true, json: true, firstWorkspace: "proj" });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const workspace = (await f.runtimes.at(-1)!.workspaces.list())[0]!;
    expect(workspace.name).toBe("proj");
    expect(f.records.at(-1)).toEqual({ event: "done", golden: "default", version: 1, snapshotId: "snap_wsp-h1-default-v1", recipe: join(dirname(f.opts.statePath), "recipe.json"), nextCommand: "wsp up", workspace: { id: workspace.id, name: "proj" } });
    expect(f.text()).toContain("Done. Image v1 is sealed; wsp up opens the app.");
    expect(f.hosts).toBe(0);
  });

  it("a port a person named and something holds refuses with the holder, the state file and --port, before anything is read or booted", async () => {
    // The one port this test speaks about is one it holds for the whole run, so the real probe finds it taken
    // whatever else the machine is doing; a named pair never steps, so no other port's state can decide the run.
    const port = await heldPort();
    const f = fake({ ports: { port: 0, wsPort: port, named: true, listener: async () => ({ command: "node", pid: 62569 }) } });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    expect(out).toContain(`Port ${port} is in use on this computer by node (pid 62569).`);
    // Which state file the run was about to set up, and the flag that starts a fresh one, so a second init is not a surprise upgrade.
    expect(out).toContain(`Setting up ${f.opts.statePath}; --state <path> starts a fresh setup instead.`);
    expect(out).toContain("Nothing was booted. Stop that process, or name a free app port with --port; the WebSocket port follows 10 above it unless --ws-port names another.");
    expect(out).not.toContain("Found on this computer");
    expect(f.backends).toEqual([]);
    expect(f.relays).toBe(0);
    expect(f.hosts).toBe(0);
  });

  it("a pair nobody named that is taken is stepped over: the run says which pair it serves on and who holds the one it left, and serves there", async () => {
    // Every port this run treats as taken is one this test holds for its duration, and the probe answers off that
    // list alone: a port another process takes while the run works cannot move the pair the assertions name.
    const taken = await heldPort();
    const held = new Set([taken]);
    // The state file of the host holding it: a path this test names, not one it reads off this computer.
    const other = "/Users/z/.wsp/state.json";
    const f = fake({
      yes: true,
      ports: {
        port: taken,
        wsPort: taken + 10,
        named: false,
        probe: async p => held.has(p),
        states: [other],
        serving: () => ({ pid: 62569, port: taken, wsPort: taken + 10, startedAt: "2026-09-07T23:08:00.000Z" }),
      },
    });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain(`Serving on ${taken + 1} and ${taken + 11}; ${taken} is held by the host serving ${other}.`);
    expect(out).not.toContain("Nothing was booted");
    // The host is started on the pair the run settled on, not the one it was asked for.
    expect(f.served).toEqual([{ port: taken + 1, wsPort: taken + 11 }]);
    expect(f.hosts).toBe(1);
  });

  it("a host that fails after the seal loses nothing: the golden is recorded, the builder is kept as saved with its hold freed, and the line names the wsp up to run", async () => {
    const f = fake();
    f.opts.host = async () => {
      throw Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:4410"), { code: "EADDRINUSE" });
    };
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    const result = await run;
    expect(result.code).toBe(1);
    expect(result.handle).toBeUndefined();
    const out = f.text();
    expect(out).toContain("Image v1 sealed.");
    expect(out).toContain("listen EADDRINUSE: address already in use 127.0.0.1:4410");
    expect(out).toContain("Image v1 is sealed and recorded. The app did not start; fix that and run wsp up, with --port when a port is taken.");
    expect(out).not.toContain(FIRST_QUESTION);
    expect(goldenHead(await f.runtimes.at(-1)!.golden.get())?.snapshotId).toBe("snap_wsp-h1-default-v1");
    // The builder is kept ten minutes for one more change and recorded as saved; the smoke fork is gone; no workspace was forked.
    expect(f.backends[0]!.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1-default-v1", true]]);
    // The runtime is closed on the way out, so the kept builder carries no dead pid's hold.
    expect(await f.store.get("builders", "m1")).toMatchObject({ sealed: { version: 1 } });
    expect(await f.store.get("builders", "m1")).not.toHaveProperty("heldBy");
    expect(f.opened).toEqual([]);
  });

  it("under --non-interactive a recipe answering copy for a Keychain login asks nothing and still copies it", async () => {
    const f = fake({ nonInteractive: true });
    f.opts.recipe = async () => answeredInBuild("gemini", answeredCopy("gh", ticking("gemini")));
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    expect(f.text()).toContain("GitHub CLI login: copied");
    // The screens never ran, so nothing was typed at: the only pty is the one sign-in chosen for the machine.
    expect(f.text()).not.toMatch(/◆  Agents|◆  Sign-ins/);
    expect(f.link.ptys.map(p => p.ran)).toEqual(["gemini --skip-trust"]);
  });

  it("on a terminal without the flag the screens still run", async () => {
    const f = fake();
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    for (const screen of SCREENS) expect(f.text()).toContain(screen);
    await f.press("n");
    expect((await run).code).toBe(1);
    expect(f.records).toEqual([]);
  });

  it("a Keychain login the reader refuses is read before anything boots, is left to first use, and says so before the confirm", async () => {
    const f = fake({ yes: true });
    withGhCopy(f);
    f.opts.secrets = {
      read: async service => {
        f.reads.push(service);
        throw new Error(`Command failed: security find-generic-password -s ${service} -w\nsecurity: SecKeychainSearchCopyNext: User canceled the operation.\n`);
      },
      run: async () => {
        throw new Error("no helper in this fixture");
      },
    };
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    expect(f.reads).toEqual(["gh:github.com"]);
    const note = out.indexOf(`GitHub CLI login: Keychain read failed (security: SecKeychainSearchCopyNext: User canceled the operation.); changed to ${SIGN_IN_LATER}.`);
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(out.search(BOOT));
    // The refusal happened with no machine on the account; the pack later asks the Keychain for nothing and notes the row.
    const saved = loadManifest(join(dirs[0]!, "golden-recipe.json"));
    expect(saved.entries.find(e => e.id === "logins/gh")?.choice).toBe("later");
    const log = f.backends[0]!.machines[0]!.execLog;
    expect(log.some(c => c.includes("tar xzf"))).toBe(true);
    // The refused row travels with none of its files: the recipe is replanned with gh left to first use, so the builder
    // carries two items fewer than first planned (hosts.yml and the Keychain item stay home) and the same hash a
    // reload of the saved recipe gives.
    expect(f.recipes).toHaveLength(2);
    expect(f.recipes[1]!.import!.files!.count).toBe(f.recipes[0]!.import!.files!.count - 2);
    const skipped = JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).files.skipped as { id: string }[];
    expect(skipped.filter(s => s.id === "logins/gh")).toEqual([]);
  });

  it("a gh row that carries hosts.yml alone copies the file and never asks the Keychain", async () => {
    const rows = FIXTURE.entries.filter(e => e.rung === "identity" || e.id === "logins/gh").map(e => (e.id === "logins/gh" ? { ...e, paths: ["~/.config/gh/hosts.yml"] } : e));
    const f = fake({ yes: true, collect: async () => ({ entries: rows }), recipe: async () => without(answeredCopy("gh"), "claude") });
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    oauth_token: gho_in_file\n");
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.reads).toEqual([]);
    expect(f.text()).not.toContain("Keychain read failed");
    expect(loadManifest(join(dirname(f.opts.statePath), "golden-recipe.json")).entries.find(e => e.id === "logins/gh")?.choice).toBe("copy");
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")).files.skipped).toEqual([]);
  });

  it("a create the provider refuses ends with nothing booted, not a machine gone", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.create = async () => {
        throw Object.assign(new Error("Insufficient credit"), { kind: "quota", status: 402 });
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.text()).toContain("Insufficient credit");
    expect(f.text()).toContain("Nothing was booted. Run wsp init again");
    expect(f.backends[0]!.machines).toHaveLength(0);
  });

  it("a daemon binary this computer has not got refuses before the confirm: nothing boots, nothing bills, and the line names the file and the fix", async () => {
    const missing = "wsp-daemon binary missing: /Users/z/wsp/packages/wspx/daemon/aarch64-unknown-linux-musl/wsp-daemon";
    const f = fake({ yes: true, json: true });
    f.opts.bundleFile = () => missing;
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    // The file names the fault, the cancel carries the fix, and the reason is said once; the price was never
    // named and no machine was made.
    expect(out).toContain(missing);
    expect(out).toContain(BUILD_NEEDS_FILE_FIX);
    expect(out.split(missing)).toHaveLength(2);
    expect(out).not.toContain("Boot a ");
    expect(f.backends).toHaveLength(0);
    // A client watching the run has one line for the stage that refused, so that one carries both halves.
    expect(f.records).toContainEqual({ event: "stage", stage: "failed", detail: buildNeedsFileLine(missing) });
  });

  it("a stage that fails after the boot ends on the machine sentence a stop gives, and exits non-zero", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude-code-releases/") ? { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" } : guestAnswer(cmd));
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    // The builder went with the failure, and the run says so in the words a stop the person asked for uses.
    expect(f.backends[0]!.machines[0]!.killed).toBe(true);
    expect(f.text()).toContain(`${MACHINE_GONE_LINE} Run wsp init again to start over; the recipe is kept.`);
  });

  it("a stage failure whose rollback the provider refused names the machine still billing, as the stop on a signal does", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude-code-releases/") ? { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" } : guestAnswer(cmd));
      const made = backend.create.bind(backend);
      backend.create = async spec => {
        const machine = await made(spec);
        machine.kill = async () => Promise.reject(new Error("provider said no"));
        return machine;
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: f.store, adapters: {}, goldenRecipe: recipe, hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    // The id is what somebody can act on, so the failure road prints it where the signal road already did.
    expect(f.text()).toContain(`The machine did not stop (${f.backends[0]!.machines[0]!.id}); ${SWEEP}`);
    expect(f.text()).not.toContain("nothing is billing");
    // The machine outlived the run, so the record that names it does too: the next init attaches to it and the
    // doctor sweeps it. A record dropped here leaves it billing with nothing on this computer pointing at it.
    expect(await f.store.list("builders")).toEqual([expect.objectContaining({ id: f.backends[0]!.machines[0]!.id })]);
  });

  it("a seal whose rollback could not reach the provider keeps the builder in the record, machine id and all", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => guestAnswer(cmd);
      // The link goes while the image is being taken, the way this computer's network went mid-seal: the snapshot
      // lands, the smoke fork never boots, and afterwards neither a kill nor a read reaches the provider. The read
      // failing is the half that decides the record: a 404 would be the machine gone, and this is not one.
      let down = false;
      const made = backend.create.bind(backend);
      const read = backend.get.bind(backend);
      backend.create = async spec => {
        if (down) throw new Error("fetch failed");
        const machine = await made(spec);
        machine.kill = async () => Promise.reject(new Error("fetch failed"));
        return machine;
      };
      backend.get = async id => (down ? Promise.reject(new Error("fetch failed")) : read(id));
      backend.beforeSnapshot = () => {
        down = true;
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: f.store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const builder = f.backends[0]!.machines[0]!;
    expect(builder.killed).toBe(false);
    // The record outlives the run, so the next init attaches to the machine and the doctor sweeps it; the outro
    // names it rather than telling the person the builder is gone while it bills.
    expect(await f.store.list("builders")).toEqual([expect.objectContaining({ id: builder.id })]);
    expect(f.text()).toContain(sealFailedMachineLeftLine(builder.id));
    expect(f.text()).not.toContain(SEAL_FAILED_LINE);
  });

  it("over ssh the address is printed with the forward line instead of opening a browser", async () => {
    const f = fake({ yes: true, env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.9 22" } });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.hosts).toBe(1);
    expect(f.opened).toEqual([]);
    expect(f.text()).toContain("ssh -L 4400:127.0.0.1:4400");
  });

  it("over ssh a run told to bind beyond this computer prints that address and no forward, so the whole road holds the address and not only the line that prints it", async () => {
    const f = fake({ yes: true, address: "100.64.0.3", env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.9 22" } });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.opened).toEqual([]);
    const out = f.text();
    expect(out).toMatch(/^◇\s+Open http:\/\/100\.64\.0\.3:4400\/#w\/ws_[0-9a-f]+\/c\/7K3MQP2X$/m);
    expect(out).not.toContain("ssh -L");
  });

  it("--yes on a terminal is a person taking the defaults: the app is served after the seal and its address printed, not opened", async () => {
    const f = fake({ yes: true });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(result.handle).toBeDefined();
    expect(f.hosts).toBe(1);
    expect(f.opened).toEqual([]);
    const out = f.text();
    expect(out).toMatch(/^◇\s+Open http:\/\/127\.0\.0\.1:4400\/#w\/ws_[0-9a-f]+\/c\/7K3MQP2X$/m);
    expect(out).toContain("wsp keeps serving the app from this terminal; Ctrl-C stops it.");
    expect(out).not.toContain("Done. Image v1 is sealed");
    expect(out.indexOf("Image v1 sealed.")).toBeLessThan(out.indexOf("Open http://"));
  });

  it("a refused create for the account cap waits and retries, killing nothing", async () => {
    const f = fake({ yes: true });
    let refusals = 0;
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      const create = backend.create.bind(backend);
      backend.create = async spec => {
        if (refusals < 2) {
          refusals += 1;
          throw Object.assign(new Error("Sandbox limit reached"), { kind: "concurrency", status: 429 });
        }
        return create(spec);
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(refusals).toBe(2);
    expect(f.text()).toContain("at its machine cap");
    // The builder, then the seal's smoke fork and the first workspace.
    expect(f.backends[0]!.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1-default-v1", true], ["snap_wsp-h1-default-v1", false]]);
  });

  it("a failed upload reports the stage and the detail and exits 1 with no host", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("tar xzf") ? { exitCode: 2, stdout: "", stderr: "gzip: stdin: not in gzip format" } : guestAnswer(cmd));
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.hosts).toBe(0);
    expect(f.text()).toMatch(/Copying your files failed/);
    expect(f.text()).toContain("not in gzip format");
  });

  it("a tool that fails is a warning in the stream, named on its own line, not the end of the build", async () => {
    const f = fake({ yes: true, recipe: async () => ticking("codex") });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("brew install yq") ? { exitCode: 1, stdout: "", stderr: "curl: no route" } : guestAnswer(cmd));
      f.backends.push(backend);
      f.recipes.push(recipe);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    // The tools and their shared deps; the failed formula is named alone.
    expect(out).toMatch(/Tools installed\s+5 installed, 1 failed/);
    expect(out).toMatch(/Agents installed\s+Claude Code, Codex installed/);
    expect(out).toContain("Ready");
    // The stage line is cut to the width; the names come back in full under the tally.
    const tally = out.slice(out.indexOf("Tools, agents and machine context:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools, agents and machine context: 7 installed, 1 failed, 0 skipped; the list is in .*golden-import\.json$/),
      "yq failed: curl: no route",
    ]);
    expect(f.recipes[0]!.import?.node).toMatchObject({ floor: 16, agents: ["Codex"] });
  });

  it("a machine context that did not land is counted and named in the tally, not the end of the build", async () => {
    const f = fake({ yes: true, recipe: async () => ticking("codex") });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      // The person's files untar under /root; the context archive is the one untarred at the root. Only the builder refuses it.
      backend.execImpl = (m, cmd) => (m.spec.fromSnapshot === undefined && cmd.includes("tar xzf - -C '/' ") ? { exitCode: 2, stdout: "", stderr: "tar: etc/wsp: Cannot mkdir: Read-only file system\n" } : guestAnswer(cmd));
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const out = f.text();
    const tally = out.slice(out.indexOf("Tools, agents and machine context:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools, agents and machine context: 8 installed, 1 failed, 0 skipped; the list is in .*golden-import\.json$/),
      "machine context failed: write failed: vault import untar failed (exit 2): tar: etc/wsp: Cannot mkdir: Read-only file system",
    ]);
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({ context: [], contextFailure: expect.stringMatching(/^write failed: vault import untar failed/) });
  });

  /** A build whose context write the builder refused once, so the results file carries contextFailure; the next init over the same store attaches and the retried write lands. */
  async function builtWithRefusedContextWrite() {
    const store = memoryStore();
    const shared = stubBackend();
    let refusals = 0;
    // The builder refuses the root untar once: the build's context write fails, the attach's lands.
    shared.execImpl = (m, cmd) => (m.spec.fromSnapshot === undefined && cmd.includes("tar xzf - -C '/' ") && refusals++ === 0 ? { exitCode: 2, stdout: "", stderr: "tar: etc/wsp: Cannot mkdir: Read-only file system\n" } : guestAnswer(cmd));
    const runtimeOver = (f: Fake) => (recipe: GoldenRecipe) => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    const first = fake({ yes: true });
    first.opts.runtime = runtimeOver(first);
    await bootedOnly(first);
    const resultsPath = join(dirname(first.opts.statePath), "golden-import.json");
    const built = JSON.parse(readFileSync(resultsPath, "utf8")) as { tools: unknown[]; agents: unknown[]; context: unknown[]; contextFailure?: string };
    expect(built).toMatchObject({ context: [], contextFailure: expect.stringMatching(/^write failed: vault import untar failed/) });
    expect(built.tools.length).toBeGreaterThan(0);
    expect(built.agents.length).toBeGreaterThan(0);
    const attach = async (): Promise<Fake> => {
      const f = fake({ yes: true, tty: false, home: first.opts.home, statePath: first.opts.statePath });
      f.opts.runtime = runtimeOver(f);
      await bootedOnly(f);
      expect(f.text()).toMatch(/Attaching to your earlier builder/);
      expect(shared.machines).toHaveLength(1);
      return f;
    };
    return { resultsPath, built, attach };
  }

  it("an attach whose retried context write lands takes the failure out of the saved result and keeps the build's tools and agents", async () => {
    const { resultsPath, built, attach } = await builtWithRefusedContextWrite();
    const f = await attach();
    expect(f.text()).not.toContain("could not be read");
    const after = JSON.parse(readFileSync(resultsPath, "utf8")) as typeof built;
    expect(after.contextFailure).toBeUndefined();
    expect(after.context).toEqual([]);
    expect(after.tools).toEqual(built.tools);
    expect(after.agents).toEqual(built.agents);
  });

  it("an attach whose retried write lands over a results file that no longer parses says the file was rewritten with the context alone", async () => {
    const { resultsPath, attach } = await builtWithRefusedContextWrite();
    writeFileSync(resultsPath, "{ not json");
    const f = await attach();
    expect(f.text()).toContain(`${resultsPath} could not be read; it was rewritten with the machine context alone.`);
    expect(JSON.parse(readFileSync(resultsPath, "utf8"))).toEqual({ context: [] });
  });

  it("a line on stderr while the stages animate is drawn by the stream, and a build that fails hands the streams back", async () => {
    const f = fake({ yes: true });
    const write = { out: f.io.output.write, err: f.io.stderr.write };
    let duringPrepare: { out: typeof f.io.output.write; err: typeof f.io.stderr.write } | undefined;
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => {
        if (!cmd.includes("claude-code-releases/")) return guestAnswer(cmd);
        duringPrepare = { out: f.io.output.write, err: f.io.stderr.write };
        f.io.stderr.write("heartbeat for builder m1 not written: ETIMEDOUT\n");
        return { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" };
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(duringPrepare?.out).not.toBe(write.out);
    expect(duringPrepare?.err).not.toBe(write.err);
    expect(f.io.output.write).toBe(write.out);
    expect(f.io.stderr.write).toBe(write.err);
    const out = f.text();
    expect(out).toContain("│  heartbeat for builder m1 not written: ETIMEDOUT");
    expect(out.indexOf("heartbeat for builder m1")).toBeLessThan(out.indexOf("Installing agents failed"));
    // The line the terminal showed for a moment is kept in the run log as a note.
    const runLog = readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8").split("\n");
    expect(runLog.some(l => / note heartbeat for builder m1 not written: ETIMEDOUT$/.test(l))).toBe(true);
    expect(runLog.findIndex(l => l.includes("note heartbeat"))).toBeLessThan(runLog.findIndex(l => l.includes("stage failed")));
  });

  it("an agent failing ends the build: one line per agent with its reason, the builder killed, and an offer to start over", async () => {
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude-code-releases/") ? { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" } : guestAnswer(cmd));
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toContain("Installing agents failed");
    expect(out.split("\n").map(l => l.replace(/^│\s+/, ""))).toEqual(expect.arrayContaining(["an agent did not install, so nothing is sealed:", "Claude Code: curl: (6) Could not resolve host"]));
    expect(out).toContain("Run wsp init again to start over; the recipe is kept.");
    expect(f.backends[0]!.machines[0]!.killed).toBe(true);
    expect(JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8"))).toMatchObject({ agents: [{ id: "agents/claude", outcome: "failed" }] });
    // The terminal shows one line per agent; the log has the install's whole stderr under its exec, and the failure.
    const logPath = join(dirs[0]!, "init.log");
    expect(out).toContain(`The run log is ${logPath}`);
    const runLog = readFileSync(logPath, "utf8");
    expect(runLog).toContain("  ! curl: (6) Could not resolve host");
    expect(runLog).toMatch(/ note failed: an agent did not install, so nothing is sealed:\n/);
    expect(runLog).toMatch(/ stage failed: an agent did not install/);
  });

  it("a run log that cannot be written stops nothing: the address line says so instead of naming it", async () => {
    const f = fake({ yes: true, tty: false });
    mkdirSync(join(dirname(f.opts.statePath), "init.log"));
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.relays).toBe(1);
    expect(f.text()).toMatch(/The run log .*init\.log could not be written \(EISDIR/);
    expect(f.text()).not.toContain("The run log is");
  });

  it("a Keychain value never reaches the run log, whatever the machine prints it in", async () => {
    const f = fake({ yes: true, tty: false });
    withGhCopy(f);
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      // The recipe's setup line is "true"; the harness stage runs it under its guard like every installer.
      backend.execImpl = (_m, cmd) => (cmd.includes("\ntrue' &") ? { exitCode: 0, stdout: "export GH_TOKEN=gho_fake\ntoken gho_fake seen\n", stderr: "" } : guestAnswer(cmd));
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    const runLog = readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8");
    expect(runLog).toContain("  > export GH_TOKEN=<redacted>");
    expect(runLog).toContain("  > token <redacted> seen");
    expect(runLog).not.toContain("gho_fake");
  });

  it("a builder from an earlier run built from a different recipe is listed with its age, cost and reason; under --yes it is stopped by its recorded id and a fresh one boots", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const earlier = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", cpu: 2, memMb: 4096 } , hostId: "box:h1" });
    await earlier.golden.prepare();
    const f = fake({ yes: true });
    withGhCopy(f);
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(f);
    expect(f.relays).toBe(1);
    const out = f.text();
    expect(out).toContain("A builder from an earlier wsp init is still running on the account:");
    // A record with no digest behind its hash can say no more than this.
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe$/m);
    expect(out).toMatch(/Stop it, then boot a 2 vCPU, 4 GB builder and build this\? About \$0\.11\/hr while it runs\. Taken as yes \(--yes\)\./);
    expect(out).toContain("Stopped default (m1).");
    expect(out).not.toContain("Solari console");
    expect(out).not.toContain("save it");
    // The stop comes after the consent dialog and right before the boot, so a refused dialog costs no machine.
    expect(f.reads).toEqual(["gh:github.com"]);
    expect(out.indexOf("Reading your Keychain")).toBeLessThan(out.indexOf("Stopped default (m1)."));
    expect(out.indexOf("Stopped default (m1).")).toBeLessThan(out.indexOf("Ready"));
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
    expect(await store.list("builders")).toHaveLength(1);
  });

  it("a changed byte in a planned file is named in the refusal; the earlier builder is stopped on the yes and a fresh one boots", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=2\n");

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe: ~\/\.zshrc changed$/m);
    expect(out).toContain("Stopped default (m1).");
    expect(out).not.toContain("Attaching");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("a planned file rewritten with the same bytes and a moved mtime still attaches: the hash reads bytes, not stat times", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    const zshrc = join(first.opts.home, ".zshrc");
    writeFileSync(zshrc, readFileSync(zshrc));
    const later = new Date(Date.now() + 90_000);
    utimesSync(zshrc, later, later);

    const f = fake({ yes: true, tty: false, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toContain("Attaching to your earlier builder: default (m1)");
    expect(out).not.toContain("still running on the account");
    expect(out).not.toMatch(BOOT);
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("a recipe saved before the volatile list existed still attaches once ~/.claude.json moved: the catalog supplies the list, the file is re-imported and never reads as gone", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    const home = first.opts.home;
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { one: {} } }));
    const saved: Manifest = { entries: [
      { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 20, default: "bring", required: true },
      { rung: "agents", id: "agents/claude", label: "Claude Code", paths: ["~/.claude/settings.json", "~/.claude.json"], bytes: 30, default: "bring" },
    ] };
    first.opts.collect = async () => saved;
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    const [recorded] = (await store.list("builders")) as { import: { recipe: { files: { path: string; volatile?: boolean }[] } } }[];
    expect(recorded!.import.recipe.files.map(f => [f.path, f.volatile])).toEqual([["~/.claude.json", true], ["~/.claude/settings.json", undefined], ["~/.gitconfig", undefined]]);

    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { one: {}, two: {} } }));
    const f = fake({ yes: true, tty: false, home, collect: async () => saved });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toContain("Attaching to your earlier builder: default (m1)");
    expect(out).toMatch(/Files copied\s+~\/\.claude\.json re-imported/);
    expect(out).not.toContain("gone");
    expect(out).not.toContain("still running on the account");
    expect(shared.machines).toHaveLength(1);
  });

  it("a re-login on this computer attaches: the Keychain value is out of the hash, the login file re-renders with the new token on attach, and the record carries the new value's digest", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    const keychainOf = async () => ((await store.list("builders")) as { import: { recipe: { files: { path: string; digest: string; volatile?: boolean }[] } } }[])[0]!.import.recipe.files.find(f => f.path === "Keychain: gh:github.com");
    expect(await keychainOf()).toMatchObject({ digest: sha("gho_fake"), volatile: true });
    // The person's files untar under /root; the machine context archive untars at the root and is not counted here.
    const uploads = () => shared.machines[0]!.execLog.filter(c => c.includes("tar xzf - -C '/root'")).length;
    expect(uploads()).toBe(1);

    const f = fake({ yes: true, tty: false, home: first.opts.home });
    withGhCopy(f);
    f.opts.secrets = { read: async () => "gho_new", run: async () => { throw new Error("no helper in this fixture"); } };
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toContain("Attaching to your earlier builder: default (m1)");
    // The fake home has no hosts.yml, so the login file is rendered from the Keychain value alone.
    // Off a terminal the detail is cut at 80 columns; the path and the start of the word survive.
    expect(out).toMatch(/Files copied\s+Keychain: gh:github\.com re-imp/);
    expect(uploads()).toBe(2);
    expect(await keychainOf()).toMatchObject({ digest: sha("gho_new"), volatile: true });
    expect(shared.machines).toHaveLength(1);
  });

  it("when the second of two stops fails, the message names the builder still running", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    for (const n of [1, 2]) {
      const earlier = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", cpu: 2, memMb: 4096, labels: { n: String(n) } } , hostId: "box:h1" });
      await earlier.golden.prepare();
    }
    expect(shared.machines.map(m => m.id)).toEqual(["m1", "m2"]);
    shared.machines[1]!.kill = async () => { throw new Error("provider said no"); };
    const f = fake({ yes: true });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toMatch(/Stop them, then boot a 2 vCPU/);
    expect(out).toContain("Stopped default (m1).");
    expect(out).toContain("Stopping default (m2) failed: provider said no");
    expect(out).toContain("Nothing was booted. default (m2) is still running; run wsp init again to retry.");
    expect(out).not.toContain("It is still running");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("a changed tick is named in the refusal: the saved recipe with Codex ticked reads as Codex ticked", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);

    const f = fake({ yes: true, tty: false, home: first.opts.home, recipe: async () => ticking("codex") });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe: Codex ticked$/m);
    expect(out).toContain("Stopped default (m1).");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("No at the stop question leaves the earlier builder running, boots nothing, and keeps the recipe", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=2\n");

    const f = fake({ home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until("Stop it, then boot");
    const ask = f.text().slice(f.text().lastIndexOf("A builder from an earlier"));
    expect(ask).toMatch(/built from a different recipe: GitHub CLI login unticked, ~\/\.zshrc changed/);
    expect(ask).toMatch(/No\s+costs\s+nothing;\s+nothing\s+is\s+stopped\s+and\s+the\s+recipe\s+is\s+kept/);
    expect(ask).toContain(`${S_RADIO_ACTIVE} No`);
    await f.press(KEY.enter);
    expect((await run).code).toBe(1);
    expect(f.hosts).toBe(0);
    expect(f.text()).toContain("Nothing was booted or stopped. The recipe is kept.");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", false]]);
  });

  it("a builder from an earlier run that was paused is listed as unsealable and stopped on the yes; a fresh one boots", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    shared.machines[0]!.paused = true;

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    await bootedOnly(f);
    expect(f.relays).toBe(1);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; cannot be sealed after a restart$/m);
    expect(out).toContain("Stopped default (m1).");
    expect(out).not.toContain("Solari console");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("the same builder at a place whose copy is the disk as it stands is attached to, not listed as unsealable: the sentence follows the provider", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    shared.capabilities.snapshotsAnyLife = true;
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    // The machine napped and woke: the record keeps that, and only the place decides what it means for a seal.
    const record = (await store.get("builders", "m1")) as { firstLife: boolean };
    await store.put("builders", "m1", { ...record, firstLife: false });

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe, hostId: "box:h1" });
    };
    await bootedOnly(f);
    const out = f.text();
    expect(out).not.toContain("cannot be sealed after a restart");
    expect(out).toContain("Attaching to your earlier builder");
    // Nothing new boots and nothing is stopped: the builder that woke is the one this run seals.
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", false]]);
  });

  it("an earlier builder wearing another setup's owner label is refused with those words, and nothing boots beside it", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    shared.machines[0]!.spec.labels!["wsp-owner"] = "h_other";

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; not this setup's builder/);
    expect(out).not.toContain("cannot be sealed");
    expect(out).toContain("Nothing was booted. It belongs to another wsp setup: stop it from there, or from the Solari console if it is yours and forgotten; then run wsp init again.");
    expect(out).not.toContain("Stop it");
    expect(f.reads).toEqual([]);
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("when the only blocker is a builder another wsp process is using, the guard says to wait for or stop that process, never to kill the machine", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    const record = (await store.get("builders", "m1")) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: process.ppid } });

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toMatch(new RegExp(`default \\(m1\\), \\d+ s old, about \\$\\d+\\.\\d\\d so far; in use by another wsp process \\(pid ${process.ppid}\\)`));
    expect(out).toContain(`Nothing was booted. Another wsp process (pid ${process.ppid}) is using it; wait for it or stop that process, then run wsp init again.`);
    expect(out).not.toContain("Stop it");
    expect(f.reads).toEqual([]);
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("a placeholder left mid-setup by a dead process is listed as unfinished, never attached to even on the same recipe, and stopped on the yes before a fresh one boots", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const gate = new Promise<void>(() => {});
    const dying = fake({ yes: true });
    dying.opts.runtime = recipe => {
      dying.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: () => gate } , hostId: "box:h1" });
    };
    void runInit(dying.opts, dying.io);
    await vi.waitFor(() => expect(shared.machines).toHaveLength(1));
    const record = (await store.get("builders", "m1")) as { building?: true; heldBy: { host: string; pid: number; heartbeat: string } };
    expect(record.building).toBe(true);
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: 999_999_999 } });

    const f = fake({ yes: true, home: dying.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    await bootedOnly(f);
    expect(f.relays).toBe(1);
    const out = f.text();
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; its setup never finished$/m);
    expect(out).toContain("Stopped default (m1).");
    expect(out).not.toContain("Solari console");
    expect(out).not.toContain("Attaching");
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", true], ["m2", false]]);
  });

  it("when another builder blocks, the one this run can reuse is named; the yes stops the blocker and attaches to it", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    const other = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", cpu: 2, memMb: 4096 } , hostId: "box:h1" });
    await other.golden.prepare();

    const f = fake({ yes: true, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    await bootedOnly(f);
    expect(f.relays).toBe(1);
    const out = f.text();
    expect(out).toMatch(/default \(m2\), \d+ s old, about \$\d+\.\d\d so far; built from a different recipe$/m);
    expect(out).toMatch(/default \(m1\), \d+ s old, about \$\d+\.\d\d so far; reusable by this run once the others are stopped/);
    expect(out).toMatch(/Stop it, then attach to your earlier builder default \(m1\), \d+ s old, about \$\d+\.\d\d so far\? Taken as yes \(--yes\)\./);
    expect(out).toContain("Stopped default (m2).");
    expect(out).toContain("Attaching to your earlier builder: default (m1)");
    expect(out).not.toMatch(BOOT);
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", false], ["m2", true]]);
  });

  it("a Keychain refusal rehashes the recipe the builder carries, so the next wsp init with the same answers attaches after a crash", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.secrets = {
      read: async service => {
        if (service.includes("gh")) throw new Error("User canceled");
        return "tok";
      },
      run: async () => {
        throw new Error("no helper in this fixture");
      },
    };
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
      first.runtimes.push(rt);
      return rt;
    };
    await bootedOnly(first);
    expect(first.text()).toContain(`changed to ${SIGN_IN_LATER}`);
    const saved = JSON.parse(readFileSync(recipePath(first.opts.statePath), "utf8")) as { entries: { id: string; choice?: string }[] };
    expect(saved.entries.find(e => e.id === "logins/gh")).toMatchObject({ choice: "later" });
    // The runtime that prepared the builder is the one built after the refusal, around the rehashed recipe.
    expect(first.runtimes).toHaveLength(2);
    const [recorded] = (await store.list("builders")) as { import: { recipeHash: string } }[];
    expect(recorded!.import.recipeHash).toBe((await first.runtimes[1]!.golden.builders())[0]!.recipeHash);

    const f = fake({ yes: true, tty: false, home: first.opts.home });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(f);
    expect(f.reads).toEqual([]);
    expect(f.text()).toContain("Attaching to your earlier builder: default (m1)");
    expect(shared.machines).toHaveLength(1);
  });

  it("a first-life builder from an earlier run with the same recipe is attached to: no boot question, every stage already applied, one machine", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    expect(shared.machines).toHaveLength(1);

    // The same home, so the file rows hash the same; a second process is a second runtime over the same
    // store. Off a terminal each stage prints once, so the lines can be counted.
    const f = fake({ yes: true, tty: false, home: first.opts.home });
    withGhCopy(f);
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(f);
    expect(f.relays).toBe(1);
    const out = f.text();
    expect(out).toMatch(/Attaching to your earlier builder: default \(m1\), \d+ s old, about \$\d+\.\d\d so far\. Nothing new boots; stages already applied are skipped\./);
    expect(out).not.toMatch(BOOT);
    expect(out).not.toContain("Creating the machine");
    // The GitHub login is copied from the Keychain, so its rendered file goes up again on every attach; the rest is skipped.
    expect(out.match(/(Setup applied|Tools installed|Agents installed)\s+already applied/g)).toHaveLength(3);
    expect(out).toMatch(/Files copied\s+Keychain: gh:github\.com re-imp/);
    // The two stages an attach never runs say so as well, and no skipped stage carries a duration: the reach
    // check that follows the last one is nobody's stage.
    expect(out).toMatch(/Machine created\s+already applied$/m);
    expect(out).toMatch(/Base installed\s+already applied$/m);
    expect(out).not.toMatch(/already applied\s+\d/);
    expect(out).toContain("Ready");
    expect(shared.machines).toHaveLength(1);
    expect(shared.machines[0]!.killed).toBe(false);
    expect((await store.list("builders")).map(b => (b as { id: string; firstLife: boolean }).firstLife)).toEqual([true]);
  });

  it("the seal report names the version sealed: a second golden on the same store is v2", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const runtimeOver = (f: Fake) => (recipe: GoldenRecipe) => {
      f.backends.push(shared);
      const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
      f.runtimes.push(rt);
      return rt;
    };
    // A person at a terminal (--yes) keeps the builder for one more change; a run with nobody at one would not.
    const first = fake({ yes: true });
    first.opts.runtime = runtimeOver(first);
    expect((await runInit(first.opts, first.io)).code).toBe(0);
    expect(first.text()).toContain("Image v1 sealed.");
    await first.runtimes.at(-1)!.close();

    // The seal kept that builder for its window; a changed recipe updates the golden on it and seals v2 there.
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const second = fake({ yes: true, tty: false, home: first.opts.home });
    second.opts.runtime = runtimeOver(second);
    expect((await runInit(second.opts, second.io)).code).toBe(0);
    await second.until("Sealed");
    expect(second.text()).toMatch(/Image v2 sealed in \d+s on the builder kept since the save/);
    expect(second.text()).not.toContain("Image v1 sealed");
    // The kept builder and the first run's workspace; the update road forks none.
    expect(shared.machines.filter(m => !m.killed).map(m => m.spec.fromSnapshot)).toEqual([undefined, "snap_wsp-h1-default-v1"]);
  });
});

describe("wsp init, a signal during prepare", () => {
  const gone = () => Object.assign(new Error("gone"), { kind: "missing", status: 404 });

  /** The tools stage hangs on its first install until the machine is deleted, as the provider fails a call on a machine that is gone;
   * the signal lands while that call is in flight. `onKill` sees the machine's kill before it runs. */
  function toolsStageHeld(f: Fake, store: ReturnType<typeof memoryStore>, onKill?: (m: StubMachine, kill: () => Promise<void>) => Promise<void>, signal: "SIGINT" | "SIGTERM" = "SIGINT"): void {
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (m, cmd) => {
        if (!cmd.includes("brew install yq")) return guestAnswer(cmd);
        return new Promise((_, reject) => {
          const kill = m.kill.bind(m);
          m.kill = async () => {
            if (onKill !== undefined) await onKill(m, kill);
            else await kill();
            reject(gone());
          };
          f.signals.emit(signal);
        });
      };
      f.backends.push(backend);
      return createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
  }

  it.each([
    ["--yes", { yes: true }, "SIGINT", 130],
    ["no terminal", { yes: false, tty: false }, "SIGTERM", 143],
  ] as const)("a signal during the tools stage (%s) kills the builder by its recorded id, drops the record, says so on one line and exits", async (_label, over, signal, code) => {
    const f = fake(over);
    const store = memoryStore();
    toolsStageHeld(f, store, undefined, signal);
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(code);
    expect(f.exits).toEqual([code]);
    expect(f.hosts).toBe(0);
    expect(f.backends[0]!.machines.map(m => [m.id, m.killed])).toEqual([["m1", true]]);
    expect(await store.list("builders")).toEqual([]);
    const out = f.text();
    expect(out).toContain("Stopped while installing tools. The machine is gone; nothing is billing.");
    expect(out).not.toContain("Installing tools failed");
    expect(out).not.toContain("Run wsp init again");
    expect(f.signals.listenerCount("SIGINT") + f.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("a signal during the stages hands the streams back with the stream it stops", async () => {
    const f = fake({ yes: true });
    const write = { out: f.io.output.write, err: f.io.stderr.write };
    let duringPrepare: typeof f.io.stderr.write | undefined;
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (m, cmd) => {
        if (!cmd.includes("brew install yq")) return guestAnswer(cmd);
        // The stream is animating here; the signal that follows stops it and must hand the streams back.
        duringPrepare = f.io.stderr.write;
        return new Promise((_, reject) => {
          const kill = m.kill.bind(m);
          m.kill = async () => {
            await kill();
            reject(gone());
          };
          f.signals.emit("SIGINT");
        });
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(duringPrepare).toBeDefined();
    expect(duringPrepare).not.toBe(write.err);
    expect(f.io.output.write).toBe(write.out);
    expect(f.io.stderr.write).toBe(write.err);
  });

  it("a second signal while the kill is still running exits at once with the builder id and the sweep line; the record stays for the sweep", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    let killing!: () => void;
    const killStarted = new Promise<void>(r => {
      killing = r;
    });
    toolsStageHeld(f, store, async (_m, kill) => {
      killing();
      await held;
      await kill();
    });
    const run = runInit(f.opts, f.io);
    await killStarted;
    f.signals.emit("SIGINT");
    await vi.waitFor(() => expect(f.exits).toEqual([130]));
    expect(f.text()).toContain(`Stopping was cut short. Builder m1 may still be running; ${SWEEP}`);
    expect(await store.get("builders", "m1")).toMatchObject({ building: true, heldBy: { pid: process.pid } });
    expect(f.backends[0]!.machines[0]!.killed).toBe(false);
    release();
    expect((await run).code).toBe(130);
    expect(f.backends[0]!.machines[0]!.killed).toBe(true);
  });

  it("a signal while the create is still in flight waits for the machine, then kills it: nothing leaks", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      const create = backend.create.bind(backend);
      backend.create = spec => {
        f.signals.emit("SIGINT");
        return create(spec);
      };
      f.backends.push(backend);
      return createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(f.backends[0]!.machines.map(m => [m.id, m.killed])).toEqual([["m1", true]]);
    expect(await store.list("builders")).toEqual([]);
    expect(f.text()).toContain("Stopped while creating the machine. The machine is gone; nothing is billing.");
    expect(f.exits).toEqual([130]);
  });

  it("a signal during the wait for a machine slot cuts the wait: nothing was booted", async () => {
    const f = fake({ yes: true, retry: { waitMs: 60_000, attempts: 3 } });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.create = async () => {
        throw Object.assign(new Error("Sandbox limit reached"), { kind: "concurrency", status: 429 });
      };
      f.backends.push(backend);
      return createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
    };
    const run = runInit(f.opts, f.io);
    await f.until("at its machine cap");
    f.signals.emit("SIGINT");
    const result = await run;
    expect(result.code).toBe(130);
    expect(f.backends[0]!.machines).toHaveLength(0);
    expect(f.text()).toContain("Stopped while waiting for a machine slot. Nothing was booted; nothing is billing.");
    expect(f.exits).toEqual([130]);
  });

  it("a builder that outlives its kill is named with the sweep line, and its record stays for the sweep", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    toolsStageHeld(f, store, async () => {
      throw new Error("provider said no");
    });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(f.text()).toContain(`Stopped while installing tools. The machine did not stop (provider said no); ${SWEEP}`);
    expect(f.text()).not.toContain("nothing is billing");
    expect(await store.get("builders", "m1")).toMatchObject({ building: true });
    expect(f.exits).toEqual([130]);
  });

  it("a second signal while the stop's line, close and exit run still answers, with the line the stop settled on", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    toolsStageHeld(f, store);
    const exit = f.io.exit;
    f.io.exit = code => {
      exit(code);
      if (f.exits.length === 1) f.signals.emit("SIGINT");
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(f.exits).toEqual([130, 130]);
    expect(f.text().match(/Stopped while installing tools\. The machine is gone; nothing is billing\./g)).toHaveLength(2);
    expect(f.text()).not.toContain("cut short");
  });

  it("a last exec that outruns the kill never writes a finished record: the placeholder stays building until the stop drops it", async () => {
    const f = fake({ yes: true });
    const store = memoryStore();
    const puts: { id: string; building?: true }[] = [];
    const put = store.put.bind(store);
    store.put = async (collection, id, value) => {
      if (collection === "builders") puts.push({ id, ...(value as { building?: true }) });
      return put(collection, id, value);
    };
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    let ready!: () => void;
    const prepared = new Promise<void>(r => {
      ready = r;
    });
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (m, cmd) => {
        // The signal lands inside the agents install, which then finishes on its own; the kill waits until told.
        if (cmd.includes("claude-code-releases/")) {
          const kill = m.kill.bind(m);
          m.kill = async () => {
            await held;
            await kill();
          };
          f.signals.emit("SIGINT");
        }
        return guestAnswer(cmd);
      };
      f.backends.push(backend);
      const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe , hostId: "box:h1" });
      rt.events.on("golden.stage", e => {
        if (e.type === "golden.stage" && e.stage === "ready") ready();
      });
      return rt;
    };
    const run = runInit(f.opts, f.io);
    await prepared;
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every(p => p.building === true)).toBe(true);
    release();
    expect((await run).code).toBe(130);
    expect(puts.every(p => p.building === true)).toBe(true);
    expect(await store.list("builders")).toEqual([]);
    expect(f.backends[0]!.machines[0]!.killed).toBe(true);
    expect(f.text()).toContain("The machine is gone; nothing is billing.");
    expect(f.text()).not.toMatch(/Builder m1 is gone/);
  });

  it("a signal while attaching to an earlier builder that can still be sealed leaves it running: the hold is released, the record stays reusable, and the line says what bills", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const first = fake({ yes: true });
    withGhCopy(first);
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    await bootedOnly(first);
    expect(shared.machines).toHaveLength(1);

    const f = fake({ yes: true, home: first.opts.home });
    withGhCopy(f);
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      // The attach's liveness check never answers; the signal lands while it is in flight.
      shared.execImpl = (_m, cmd) => {
        if (cmd !== "true") return guestAnswer(cmd);
        f.signals.emit("SIGINT");
        return new Promise<never>(() => {});
      };
      return createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(130);
    expect(f.exits).toEqual([130]);
    expect(f.hosts).toBe(0);
    expect(shared.machines.map(m => [m.id, m.killed])).toEqual([["m1", false]]);
    const record = (await store.get("builders", "m1")) as { firstLife: boolean; building?: true; heldBy?: unknown };
    expect(record).toMatchObject({ firstLife: true });
    expect(record.building).toBeUndefined();
    expect(record.heldBy).toBeUndefined();
    const out = f.text();
    expect(out).toMatch(/Stopped between stages\. Your earlier builder default was not stopped: it still has a seal in it\. Builder m1 stays up at about \$\d+\.\d\d\/hr; wsp init --recipe '.*recipe\.json' attaches to it again, and the sweep stops it once it is six hours old\./);
    expect(out).not.toContain("nothing is billing");
  });

  it("once init returns no handler of init's is left: a signal then is the host's to handle", async () => {
    const f = fake({ yes: true });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.hosts).toBe(1);
    expect(f.signals.listenerCount("SIGINT") + f.signals.listenerCount("SIGTERM")).toBe(0);
    f.signals.emit("SIGINT");
    expect(f.exits).toEqual([]);
    expect(f.backends[0]!.machines[0]!.killed).toBe(false);
  });
});

describe("summaryNote", () => {
  it("the Machine disk line adds files, Homebrew's toolchain, the formulae's closures and the agents against the room, and names what has no size", () => {
    const ticks = new Set(["tools/brew/gh", "tools/brew/yq", "tools/npm/tsx", "agents/claude", "agents/codex"]);
    const brew = new Map([
      ["gh", { name: "gh", fullName: "gh", deps: [], bytes: 50 * 1024 * 1024, macosOnly: false }],
      ["yq", { name: "yq", fullName: "yq", deps: ["oniguruma"], bytes: 2 * 1024 * 1024, macosOnly: false }],
      ["oniguruma", { name: "oniguruma", fullName: "oniguruma", deps: [], bytes: 1024 * 1024, macosOnly: false }],
    ]);
    const lines = summaryNote(FIXTURE, ticks, new Map(), 200, 300 * 1024 * 1024, brew, [], BUILDER_DISK_GB);
    // 300 MB files + 1024 toolchain + 252 tools (53 plus the node the tsx row's npm road brings) + 663 agents
    // + 50 assumed for tsx = 2289 MiB.
    expect(lines).toContain("Disk      2.2 GB of 15.2 GB on the 20 GB builder (files 300 MB, Homebrew's toolchain 1 GB, tools 252 MB, agents 663 MB; 1 unmeasured, ~50 MB)");
    const huge = new Map([["gh", { name: "gh", fullName: "gh", deps: [], bytes: 30 * 1024 * 1024 * 1024, macosOnly: false }]]);
    const over = summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 200, 0, huge, [], BUILDER_DISK_GB).find(l => l.startsWith("Disk"));
    expect(over).toBe("Disk      31 GB, 15.8 GB over the 15.2 GB the 20 GB builder leaves (Homebrew's toolchain 1 GB, tools 30 GB)");
    // A provider that gives a builder no disk figure has no cap to be over: the line says the total and nothing else.
    expect(summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 200, 0, huge).find(l => l.startsWith("Disk"))).toBe("Disk      31 GB on the machine (Homebrew's toolchain 1 GB, tools 30 GB)");
    // With colour on, the Disk line takes its tier's colour, every wrapped line of it; a total under 50 percent stays plain.
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "3";
    try {
      const wrapped = summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 90, 0, huge, [], BUILDER_DISK_GB).filter(l => stripVTControlCharacters(l).startsWith("Disk") || stripVTControlCharacters(l).startsWith("          "));
      expect(wrapped.length).toBeGreaterThan(1);
      for (const l of wrapped) expect(l).toMatch(/^\x1b\[31m.*\x1b\[39m$/);
      expect(summaryNote(FIXTURE, ticks, new Map(), 200, 300 * 1024 * 1024, brew, [], BUILDER_DISK_GB).find(l => l.startsWith("Disk"))).not.toContain("\x1b[");
      // No cap, no colour: nothing is over a room that does not exist.
      expect(summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 90, 0, huge).find(l => stripVTControlCharacters(l).startsWith("Disk"))).not.toContain("\x1b[");
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
  });

  it("names every row outside the catalog with the command it runs, since the card is the last thing read before the boot", () => {
    const custom = [
      { kind: "custom" as const, id: "brew/just", name: "just", install: ["brew install just"], check: "command -v just", size: 4 * 1024 * 1024, why: "installed on this Mac by brew" },
      { kind: "custom" as const, id: "ruff", name: "ruff", install: ["uv tool install ruff"], check: "ruff --version", why: "used in wsp" },
    ];
    const lines = summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 200, 0, new Map(), custom);
    expect(lines).toContain("Added     just runs brew install just");
    expect(lines).toContain("          ruff runs uv tool install ruff");
    // They are the person's tools too: the Installs line counts them, the Disk line carries the measured one's
    // 4 MB and counts the other beside the gh formula the Mac's Homebrew never sized.
    expect(lines.find(l => l.startsWith("Installs"))).toContain("3 tools");
    expect(lines.find(l => l.startsWith("Disk"))).toContain("tools 4 MB; 2 unmeasured");
    expect(summaryNote(FIXTURE, new Set(["tools/brew/gh"]), new Map(), 200, 0).some(l => l.startsWith("Added"))).toBe(false);
  });

  it("a tap formula that takes the road counts as a tool in the Installs line, with the checksum note the ruling asks for", () => {
    const tap = { rung: "tools" as const, id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "bring" as const, linux: "unknown" as const };
    const brew = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], bytes: 4 * 1024 * 1024, macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const manifest = { entries: [...FIXTURE.entries, tap] };
    const ticks = new Set(["tools/brew/gh", "tools/brew/zingzy/tap/diskbloom", "agents/claude"]);
    const line = "Installs  Claude Code, 2 tools plus Homebrew's toolchain, 1 from its GitHub release (tag and checksum recorded at the seal, checked on every copy)";
    expect(summaryNote(manifest, ticks, new Map(), 200, 0, brew)).toContain(line);
    // Without the table the tap is a skip, as init-import would plan it without the table too.
    expect(summaryNote(manifest, ticks, new Map(), 200, 0)).toContain("Installs  Claude Code, 1 tool plus Homebrew's toolchain");
    // A pin on the row changes nothing here: the image's own seal reads the release anew whatever an earlier one recorded.
    expect(summaryNote({ entries: [...FIXTURE.entries, { ...tap, pin: { tag: "v0.0.9", sha256: "f".repeat(64) } }] }, ticks, new Map(), 200, 0, brew)).toContain(line);
  });

  it("wraps a long Installs line under its own column instead of letting the frame break it with a stray indent", () => {
    const ticks = new Set(["tools/brew/gh", "tools/brew/yq", "tools/npm/tsx", "agents/claude"]);
    const narrow = summaryNote(FIXTURE, ticks, new Map(), 48);
    const at = narrow.indexOf("Installs  Claude Code, 3 tools plus");
    expect(at).toBeGreaterThan(-1);
    expect(narrow[at + 1]).toBe("          Homebrew's toolchain");
    // The card's bar takes three columns; every line fits inside what is left.
    expect(narrow.every(l => l.length <= 48 - CARD_FRAME)).toBe(true);
    expect(summaryNote(FIXTURE, ticks, new Map(), 80)).toContain("Installs  Claude Code, 3 tools plus Homebrew's toolchain");
  });

  it("the card prints the pre-wrapped lines one for one, none past the columns, so nothing is wrapped twice", () => {
    const ticks = new Set(["tools/brew/gh", "tools/brew/yq", "tools/npm/tsx", "agents/claude"]);
    for (const columns of [50, 80]) {
      const output = Object.assign(new PassThrough(), { columns });
      const chunks: string[] = [];
      output.on("data", (c: Buffer) => chunks.push(c.toString()));
      const lines = summaryNote(FIXTURE, ticks, new Map(), widthOf(output));
      card("Summary", lines, output);
      const printed = stripVTControlCharacters(chunks.join("")).split("\n");
      expect(printed.filter(l => l.length > columns)).toEqual([]);
      // Past the bar and the title line, each printed line is one of ours, with the bar's three columns before it.
      expect(printed.slice(2, -1).map(l => l.replace(/^│( {2})?/, ""))).toEqual(lines);
      // At 50 the Installs line had to wrap, so the one-to-one check above saw a continuation line go through.
      if (columns === 50) expect(lines.some(l => l.startsWith(" ".repeat(10)) && l.trim() !== "")).toBe(true);
    }
  });
});

describe("stage stream", () => {
  const ev = (stage: string, detail?: string) => ({ type: "golden.stage" as const, name: "default", stage, ...(detail !== undefined ? { detail } : {}) });

  it("renders one step per stage named, in the frames' order, with start and end labels and a tail of details", () => {
    const view = reduceStages([ev("creating", "sandbox from default"), ev("deploying-daemon", "node v22"), ev("installing-harness")]);
    expect(view.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["deploying-daemon", "done"],
      ["installing-harness", "current"],
    ]);
    expect(view.steps.map(s => [s.start, s.end])).toEqual([
      ["Creating the machine", "Machine created"],
      ["Installing the base tools", "Base installed"],
      ["Installing agents", "Agents installed"],
    ]);
    expect(view.steps[0]).toMatchObject({ tail: ["sandbox from default"] });
    expect(view.steps[1]!.tail).toEqual(["node v22"]);
    expect(view.failure).toBeUndefined();
  });

  it("a stage never named never shows; ready finishes; failed carries the detail", () => {
    const done = reduceStages([ev("creating"), ev("installing-harness"), ev("ready")]);
    expect(done.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["installing-harness", "done"],
      ["ready", "done"],
    ]);
    const failed = reduceStages([ev("creating"), ev("failed", "golden setup failed (exit 1): curl: no route")]);
    expect(failed.steps.map(s => [s.stage, s.state])).toEqual([["creating", "failed"]]);
    expect(failed.failure).toBe("golden setup failed (exit 1): curl: no route");
  });

  it("a step closes only when another stage's frame arrives, whatever order the engine runs them in", () => {
    const view = reduceStages([ev("creating"), ev("uploading-files"), ev("installing-harness"), ev("installing-harness", "claude (1/3)"), ev("installing-tools", "gh (1/2)")]);
    expect(view.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["uploading-files", "done"],
      ["installing-harness", "done"],
      ["installing-tools", "current"],
    ]);
    expect(view.steps.filter(s => s.state === "current")).toHaveLength(1);
  });

  it("a frame's arrival time gives the stage it ends its duration; the last stage has none", () => {
    const view = reduceStages([
      { ...ev("creating"), at: 1_000 },
      { ...ev("deploying-daemon"), at: 4_200 },
      { ...ev("deploying-daemon", "node v22"), at: 4_900 },
      { ...ev("installing-tools"), at: 5_000 },
      { ...ev("ready"), at: 65_500 },
    ]);
    // The second deploying-daemon frame carries the detail; it does not restart that stage's clock.
    expect(view.steps.map(s => s.ms)).toEqual([3_200, 800, 60_500, undefined]);
  });

  it("a stage already applied is done the moment its frame arrives and is charged no time, whatever follows it", () => {
    const skipped = ["creating", "deploying-daemon", "applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"].map((stage, i) => ({ ...ev(stage, ALREADY_APPLIED), at: 1_000 + i }));
    const view = reduceStages([...skipped, { ...ev("ready"), at: 2_200 }]);
    expect(view.steps.map(s => s.state)).toEqual(Array<string>(8).fill("done"));
    expect(view.steps.map(s => s.ms)).toEqual(Array<undefined>(8).fill(undefined));
    expect(view.steps.slice(0, 7).map(s => s.tail)).toEqual(Array<string[]>(7).fill(["already applied"]));
  });

  it("a failure with nothing running lands on the stage about to run, not on the last stage the builder already held", () => {
    const skipped = ["creating", "deploying-daemon", "applying-setup", "uploading-files", "installing-tools", "installing-harness", "installing-mcp"].map(stage => ev(stage, ALREADY_APPLIED));
    const view = reduceStages([...skipped, ev("failed", "the builder answered exit 1 to a no-op; it is not serving")]);
    expect(view.steps.map(s => s.state)).toEqual([...Array<string>(7).fill("done"), "failed"]);
    expect(view.steps[7]!.fail).toBe("The machine never answered");
    expect(view.failure).toBe("the builder answered exit 1 to a no-op; it is not serving");
    // A failure while a stage runs still lands on that stage.
    const running = reduceStages([ev("creating"), ev("uploading-files", "4 MB"), ev("failed", "HTTP 413")]);
    expect(running.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["uploading-files", "failed"],
    ]);
  });

  it("a stage line pads the label, keeps the detail, and puts the duration flush right at the width", () => {
    const line = stripVTControlCharacters(stageLine("o", "Base installed", "node v22.12.0", 3_200, 60, 20));
    expect(line).toBe("o  Base installed        node v22.12.0                  3.2s");
    expect(line.length).toBe(60);
    const long = stripVTControlCharacters(stageLine("o", "Base installed", "x".repeat(80), 61_000, 60, 20));
    expect(long.length).toBe(60);
    expect(long).toMatch(/x…  1m 1s$/);
    expect(stripVTControlCharacters(stageLine("o", "Ready", undefined, undefined, 60, 20))).toBe("o  Ready");
    // Off a terminal there is no width: nothing is cut and the duration follows two spaces after the detail.
    expect(stripVTControlCharacters(stageLine("o", "Base installed", "x".repeat(80), 61_000, undefined, 20))).toBe(`o  Base installed        ${"x".repeat(80)}  1m 1s`);
  });

  it("frames for another golden are ignored", () => {
    const view = reduceStages([{ type: "golden.stage" as const, name: "nightly", stage: "ready" }]);
    expect(view.steps).toEqual([]);
  });
});

describe("pack size before the boot", () => {
  it("a recipe whose files would not fit the machine's disk is refused after the summary, before anything boots", async () => {
    // Under the disk estimate's room, over what the upload stage can hold twice (the archive and its files).
    const big = 9 * 1024 * 1024 * 1024;
    const f = fake({ yes: true, collect: async () => ({ entries: FIXTURE.entries.map(e => (e.id === "shell/zshrc" ? { ...e, bytes: big } : e)) }) });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(1);
    const out = f.text();
    expect(out).toMatch(/Upload\s+9 GB, over the 8\.5 GB the machine's disk allows/);
    expect(out).not.toContain("This recipe needs about");
    expect(out).toContain("Recipe saved to");
    expect(out).toContain("Nothing was booted.");
    // No screen lists the files; the saved manifest does, and the fix is on this computer.
    expect(out).toContain(`The rows and their sizes are listed in ${recipePath(f.opts.statePath)}; shrink or remove the largest on this computer and run wsp init again.`);
    expect(out).not.toMatch(BOOT);
    expect(f.backends[0]?.machines ?? []).toHaveLength(0);
    expect(f.hosts).toBe(0);
  });
});

describe("disk estimate before the boot", () => {
  it("the seal records the tag and the asset's checksum a release install read into the recipe file, and the saved manifest carries none", async () => {
    // gh with no formula row here: the recipe's bare row installs it from its GitHub release.
    const f = fake({ yes: true, collect: async () => ({ entries: FIXTURE.entries.filter(e => e.id !== "tools/brew/gh") }) });
    const sha = "b".repeat(64);
    f.opts.runtime = recipe => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("cli/cli/releases/download/") ? { exitCode: 0, stdout: `WSP_ROAD release gh_2.101.0_linux_amd64.tar.gz ${sha} v2.101.0\n`, stderr: "" } : guestAnswer(cmd));
      f.backends.push(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
      f.runtimes.push(rt);
      return rt;
    };
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    // The road checked the catalog's own sum, and recorded nothing of its own before it ran.
    const road = f.backends[0]!.machines[0]!.execLog.find(c => c.includes("cli/cli/releases/download/"))!;
    expect(road).toContain("sha256sum -c -");
    const saved = loadManifest(recipePath(f.opts.statePath));
    expect(saved.entries.filter(e => e.pin !== undefined)).toHaveLength(0);
    // The small recipe carries the record's pin under the catalog id, for wsp recipe to show; the fake guest reads no other version back.
    const small = Recipe.parse(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "recipe.json"), "utf8")));
    expect(small.rows.find(r => r.id === "gh")?.pin).toEqual({ tag: "v2.101.0", sha256: sha });
    expect(small.rows.filter(r => r.pin !== undefined)).toHaveLength(1);
    // The record beside it says the same, by the row's id there.
    const record = (await f.runtimes[0]!.image.get()).image!;
    expect(record.pins).toEqual([{ id: "gh", tag: "v2.101.0", sha256: sha, road: "release" }]);
    // The results file carries the same checksum and tag beside the road.
    const results = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")) as { tools: { id: string; road?: { kind: string; sha256?: string } }[] };
    expect(results.tools.find(t => t.id === "tools/catalog/gh")?.road).toEqual({ kind: "release", from: "gh_2.101.0_linux_amd64.tar.gz", sha256: sha, tag: "v2.101.0" });
  });

  it("the tally after the build names every skipped tool with its reason, under the counts, and the results file carries the same rows", async () => {
    // A catalog formula this Mac has with no Linux bottle known: ticked by the recipe, set aside by the plan.
    const unknown: ManifestEntry = { rung: "tools", id: "tools/brew/maven", label: "maven", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" };
    const f = fake({ yes: true, collect: async () => ({ entries: [...FIXTURE.entries, unknown] }), recipe: async () => ticking("maven"), brew: async () => new Map() });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    const tally = f.text().slice(f.text().indexOf("Tools, agents and machine context:"));
    expect(tally.split("\n").slice(0, 2).map(l => l.replace(/^[│◇]\s+/, ""))).toEqual([
      expect.stringMatching(/^Tools, agents and machine context: 7 installed, 0 failed, 1 skipped; the list is in .*golden-import\.json$/),
      "maven skipped: no Linux bottle known",
    ]);
    const results = JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8")) as { tools: { id: string; label: string; outcome: string; note?: string }[] };
    expect(results.tools.filter(t => t.outcome === "skipped")).toEqual([{ id: "tools/brew/maven", label: "maven", outcome: "skipped", note: "no Linux bottle known" }]);
  });

  it("a Homebrew that cannot be read is a note, not a stop; the summary falls back to the measured table", async () => {
    const f = fake({ yes: true, brew: async () => { throw new Error("brew: command timed out"); } });
    const run = runInit(f.opts, f.io);
    await f.until(BOOT);
    expect(f.text()).toContain("Homebrew could not be read for sizes (brew: command timed out); formula sizes come from the measured table alone.");
    expect(f.text()).toMatch(/Disk\s+1\.4 GB of 15\.2 GB/);
    await run;
  });
});

describe("wsp init with a golden already built from a recipe", () => {
  /** A first init under --yes that prepared and sealed golden v1; the builder stays for its window. Its first
   * workspace is refused by the host fake so the machines here are the builder and the forks the seals boot. */
  async function sealed(over: Partial<InitOptions> = {}, answer?: (cmd: string) => ExecResult) {
    const store = memoryStore();
    const shared = stubBackend();
    if (answer !== undefined) shared.execImpl = (_m, cmd) => answer(cmd);
    const first = fake({ yes: true, ...over });
    first.opts.runtime = recipe => {
      first.backends.push(shared);
      const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
      first.runtimes.push(rt);
      return rt;
    };
    first.opts.host = quietHost();
    expect((await runInit(first.opts, first.io)).code).toBe(0);
    expect(first.text()).toContain("Image v1 sealed.");
    expect(first.text()).toContain("The first workspace could not be forked: no workspace in this fixture. Create one from the app.");
    const builder = shared.machines[0]!;
    await first.runtimes.at(-1)!.close();
    expect(builder.killed).toBe(false);
    expect(await store.get("golden-recipes", copyKey("default", "default@v1"))).toBeDefined();
    const next = (o: Partial<InitOptions> & { tty?: boolean } = {}) => {
      const f = fake({ yes: true, home: first.opts.home, statePath: first.opts.statePath, ...o });
      f.opts.runtime = recipe => {
        f.backends.push(shared);
        const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, snapshotRetryMs: 1 , hostId: "box:h1" });
        f.runtimes.push(rt);
        return rt;
      };
      return f;
    };
    return { store, shared, first, next };
  }

  it("a release pin recorded at v1 rides the small recipe for wsp recipe to show and feeds no build: the same recipe reads as no change, a pin edited in the file changes nothing, and a version cut for another row carries the pin onto its record", async () => {
    const sha = "b".repeat(64);
    // The fake guest serves whatever tag the road asks for, and hashes every asset the same.
    const answer = (cmd: string): ExecResult => {
      const tag = /cli\/cli\/releases\/download\/(\S+?)\//.exec(cmd);
      return tag === null ? guestAnswer(cmd) : { exitCode: 0, stdout: `WSP_ROAD release gh_linux_amd64.tar.gz ${sha} ${tag[1]}\n`, stderr: "" };
    };
    // gh with no formula row here, so the recipe's bare row installs it from its GitHub release.
    const collect = async () => ({ entries: FIXTURE.entries.filter(e => e.id !== "tools/brew/gh") });
    const { store, shared, first, next } = await sealed({ collect }, answer);
    const recipeFile = join(dirname(first.opts.statePath), "recipe.json");
    const small = () => Recipe.parse(JSON.parse(readFileSync(recipeFile, "utf8")));
    const roadRuns = () => shared.machines.flatMap(m => m.execLog.filter(c => c.includes("cli/cli/releases/download/")));
    const record = () => store.get("images", "default") as Promise<{ pins?: unknown }>;
    const pin = { tag: "v2.101.0", sha256: sha };
    // v1 installed the catalog's pinned release and checked its sum; the record keeps what it read, and the small recipe shows it.
    expect(roadRuns()).toHaveLength(1);
    expect(roadRuns()[0]).toContain("releases/download/v2.101.0/");
    expect(roadRuns()[0]).toContain("sha256sum -c -");
    expect((await record()).pins).toEqual([{ id: "gh", ...pin, road: "release" }]);
    expect(small().rows.find(r => r.id === "gh")?.pin).toEqual(pin);
    expect(small().rows.filter(r => r.pin !== undefined).map(r => r.id)).toEqual(["gh"]);
    // The sealed digest says the same, stamped by the build.
    const sealedDigest = (v: number) => (store.get("golden-recipes", copyKey("default", `default@v${v}`)) as Promise<{ ticks: { id: string; road?: string; pin?: unknown }[] }>);
    expect((await sealedDigest(1)).ticks.find(t => t.id === "tools/catalog/gh")).toMatchObject({ road: "release", pin });

    // The same recipe again: nothing is built.
    const same = next({ tty: false, collect });
    expect((await runInit(same.opts, same.io)).code).toBe(0);
    expect(same.text()).toContain("Image v1 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(roadRuns()).toHaveLength(1);

    // A pin edited in the file is a fact about some seal, not an ask: nothing is built, and no release is fetched at the edited tag.
    writeFileSync(recipeFile, JSON.stringify({ ...small(), rows: small().rows.map(r => (r.id === "gh" ? { ...r, pin: { tag: "v2.85.0", sha256: sha } } : r)) }));
    const edited = next({ tty: false, collect });
    expect((await runInit(edited.opts, edited.io)).code).toBe(0);
    expect(edited.text()).toContain("Image v1 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(roadRuns()).toHaveLength(1);

    // Another row ticked, by a file given, cuts v2 on top of v1: gh does not run again, its pin rides onto v2's record, and the file beside the state shows the record's pin again.
    const file = join(dirname(first.opts.statePath), "elsewhere.json");
    writeFileSync(file, JSON.stringify({ ...small(), rows: [...small().rows, { id: "tmux", kind: "tool", on: true, source: { kind: "popular", sessions: 1, images: 1 } }] }));
    const more = next({ tty: false, collect, recipeFile: file });
    expect((await runInit(more.opts, more.io)).code).toBe(0);
    expect(more.text()).toContain("Builds version 2 on top of version 1: 1 tool added");
    expect(roadRuns()).toHaveLength(1);
    expect((await store.get("goldens", copyKey("default", "default")) as GoldenManifest).head).toBe(2);
    expect((await sealedDigest(2)).ticks.find(t => t.id === "tools/catalog/gh")).toMatchObject({ pin });
    expect((await record()).pins).toEqual([{ id: "gh", ...pin, road: "release" }]);
    expect(small().rows.find(r => r.id === "gh")?.pin).toEqual(pin);
    expect(small().rows.find(r => r.id === "tmux")).not.toHaveProperty("pin");

    // Under --recipe <file>, the file's pins are another setup's facts: nothing is planned from them and nothing is built.
    writeFileSync(file, JSON.stringify({ ...small(), rows: small().rows.map(r => (r.id === "gh" ? { ...r, pin: { tag: "v2.84.0", sha256: sha } } : r)) }));
    const given = next({ tty: false, collect, recipeFile: file });
    expect((await runInit(given.opts, given.io)).code).toBe(0);
    expect(given.text()).toContain("Image v2 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(roadRuns()).toHaveLength(1);
  });

  it("a tap formula this Mac has, ticked by the recipe file, installs from its GitHub release and records its pin under the row's own id on the record and the small recipe; the same file, a plain re-run and a file whose recorded sum differs all read as no change", async () => {
    const sha = "a".repeat(64);
    const tap: ManifestEntry = { rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" };
    const table = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], bytes: 4 * 1024 * 1024, macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    // The fake guest serves whatever tag the road asks for and hashes every asset the same.
    const answer = (cmd: string): ExecResult => {
      const tag = /repos\/Zingzy\/diskbloom\/releases\/(?:tags\/(\S+?)'|latest)/.exec(cmd);
      return tag === null ? guestAnswer(cmd) : { exitCode: 0, stdout: `WSP_ROAD release diskbloom_linux_amd64.tar.gz ${sha} ${tag[1] ?? "v0.1.0"}\n`, stderr: "" };
    };
    const collect = async () => ({ entries: [...FIXTURE.entries, tap] });
    const brew = async () => table;
    const given = mkdtempSync(join(tmpdir(), "wsp-init-given-"));
    dirs.push(given);
    const file = join(given, "recipe.json");
    const outside = { id: tap.id, kind: "tool" as const, on: true, source: { kind: "installed" as const, paths: [], bin: true } };
    writeFileSync(file, JSON.stringify({ ...RECIPE, rows: [...RECIPE.rows, outside] }));
    const { store, shared, first, next } = await sealed({ collect, brew, recipeFile: file }, answer);
    const roadRuns = () => shared.machines.flatMap(m => m.execLog.filter(c => c.includes("repos/Zingzy/diskbloom/releases/")));
    // v1 fetched the release this Mac runs, with nothing to check: no pin was recorded before. The card counted the road.
    expect(roadRuns()).toHaveLength(1);
    expect(roadRuns()[0]).toContain("releases/tags/v0.1.0");
    expect(roadRuns()[0]).not.toContain('[ "$sum" =');
    expect(first.text().replace(/\n│\s+/g, " ")).toMatch(/Installs\s+Claude Code, 3 tools plus Homebrew's toolchain, 1 from its GitHub release \(tag and checksum recorded at the seal, checked on every copy\)/);
    expect(first.text()).not.toContain("has no row that installs it");
    // The pin is recorded under the row's own id: on the record and in the small recipe beside the state, and the saved manifest carries none.
    const pin = { tag: "v0.1.0", sha256: sha };
    const small = () => Recipe.parse(JSON.parse(readFileSync(join(dirname(first.opts.statePath), "recipe.json"), "utf8")));
    expect(small().rows.find(r => r.id === tap.id)).toEqual({ ...outside, pin });
    expect(small().rows.filter(r => r.pin !== undefined).map(r => r.id)).toEqual([tap.id]);
    expect(loadManifest(recipePath(first.opts.statePath)).entries.find(e => e.id === tap.id)).toEqual({ ...tap, bring: true });
    expect(((await store.get("images", "default")) as { pins?: unknown }).pins).toEqual([{ id: tap.id, ...pin, road: "release" }]);
    // The sealed digest says the row installed by the release road at this Mac's tag, the pin stamped by the build.
    const sealedDigest = (v: number) => (store.get("golden-recipes", copyKey("default", `default@v${v}`)) as Promise<{ ticks: { id: string; road?: string; version?: string; pin?: unknown }[] }>);
    expect((await sealedDigest(1)).ticks.find(t => t.id === tap.id)).toMatchObject({ road: "release", version: "v0.1.0", pin });
    const tools = JSON.parse(readFileSync(join(dirname(first.opts.statePath), "golden-import.json"), "utf8")).tools as { id: string; outcome: string; road?: unknown; pin?: unknown }[];
    expect(tools.find(t => t.id === tap.id)).toMatchObject({ outcome: "installed", road: { kind: "release", sha256: sha, tag: "v0.1.0" }, pin });

    // The same file again: nothing is built.
    const same = next({ tty: false, collect, brew, recipeFile: file });
    expect((await runInit(same.opts, same.io)).code).toBe(0);
    expect(same.text()).toContain("Image v1 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(roadRuns()).toHaveLength(1);

    // A plain run: the tick comes from the recipe beside the state, so the row stands and nothing is built; the pin stays shown.
    const plain = next({ tty: false, collect, brew });
    expect((await runInit(plain.opts, plain.io)).code).toBe(0);
    expect(plain.text()).toContain("Image v1 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(roadRuns()).toHaveLength(1);
    expect(small().rows.find(r => r.id === tap.id)).toEqual({ ...outside, pin });

    // A file whose recorded sum is another, as one from another setup would carry: a pin asks for nothing, so nothing is built.
    const other = "b".repeat(64);
    writeFileSync(file, JSON.stringify({ ...small(), rows: small().rows.map(r => (r.id === tap.id ? { ...r, pin: { tag: "v0.1.0", sha256: other } } : r)) }));
    const moved = next({ tty: false, collect, brew, recipeFile: file });
    expect((await runInit(moved.opts, moved.io)).code).toBe(0);
    expect(moved.text()).toContain("Image v1 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(roadRuns()).toHaveLength(1);

    // The file with the row unticked: the row is retired on the next version, and the state's recipe says off.
    writeFileSync(file, JSON.stringify({ ...small(), rows: small().rows.map(r => (r.id === tap.id ? { ...r, on: false } : r)) }));
    const off = next({ tty: false, collect, brew, recipeFile: file });
    expect((await runInit(off.opts, off.io)).code).toBe(0);
    expect(off.text()).toContain("Builds version 2 on top of version 1: 1 row retired");
    expect(off.text()).toContain("retire 1 tool: zingzy/tap/diskbloom, left on the image");
    expect(small().rows.find(r => r.id === tap.id)).toMatchObject({ on: false });
    expect(roadRuns()).toHaveLength(1);
  });

  it("a recipe file wsp recipe --set wrote for a tap formula this Mac has installs it from its GitHub release, the road the Also on this Mac screen takes, and the same file read again builds nothing", async () => {
    const sha = "c".repeat(64);
    const tap: ManifestEntry = { rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" };
    const table = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], bytes: 4 * 1024 * 1024, macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const answer = (cmd: string): ExecResult => {
      const tag = /repos\/Zingzy\/diskbloom\/releases\/(?:tags\/(\S+?)'|latest)/.exec(cmd);
      return tag === null ? guestAnswer(cmd) : { exitCode: 0, stdout: `WSP_ROAD release diskbloom_linux_amd64.tar.gz ${sha} ${tag[1] ?? "v0.1.0"}\n`, stderr: "" };
    };
    const collect = async () => ({ entries: [...FIXTURE.entries, tap] });
    const brew = async () => table;
    const given = mkdtempSync(join(tmpdir(), "wsp-init-set-"));
    dirs.push(given);
    const file = join(given, "recipe.json");
    // The agent's own door: the recipe verb ticks the package by the id wsp recipe scan gives it, nothing else.
    const scanned: ScanRow = { id: "brew/zingzy/tap/diskbloom", name: "zingzy/tap/diskbloom", manager: "brew", group: "Homebrew formulae", install: "brew install zingzy/tap/diskbloom", check: "brew list --versions zingzy/tap/diskbloom", size: 4 * 1024 * 1024, version: "0.1.0" };
    saveSmallRecipe(file, RECIPE);
    await runRecipe(fakeHost({ which: ["claude"], files: { "~/.claude/settings.json": "{}" } }), { out: file, set: ["brew/zingzy/tap/diskbloom=on"], alsoHere: async () => [scanned] }, undefined, () => new Date("2026-09-06T03:00:00Z"));
    expect(Recipe.parse(JSON.parse(readFileSync(file, "utf8"))).rows.find(r => r.id === tap.id)).toEqual({ id: tap.id, kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } });

    const { shared, first, next } = await sealed({ collect, brew, recipeFile: file }, answer);
    const roadRuns = () => shared.machines.flatMap(m => m.execLog.filter(c => c.includes("repos/Zingzy/diskbloom/releases/")));
    expect(roadRuns()).toHaveLength(1);
    expect(roadRuns()[0]).toContain("releases/tags/v0.1.0");
    expect(first.text()).not.toContain("has no row that installs it");
    // Nothing runs the manager's own line for it: the row's road is the release, and no second row was written.
    expect(shared.machines.some(m => m.execLog.some(c => c.includes("brew install zingzy/tap/diskbloom")))).toBe(false);
    const small = () => Recipe.parse(JSON.parse(readFileSync(join(dirname(first.opts.statePath), "recipe.json"), "utf8")));
    expect(small().rows.find(r => r.id === tap.id)?.pin).toEqual({ tag: "v0.1.0", sha256: sha });
    expect(small().custom ?? []).toEqual([]);
    // The same file again: the pin folds away, nothing is built and nothing is fetched a second time.
    const same = next({ tty: false, collect, brew, recipeFile: file });
    expect((await runInit(same.opts, same.io)).code).toBe(0);
    expect(same.text()).toContain("Image v1 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(roadRuns()).toHaveLength(1);
  });

  it("--yes with a small change: the changes since v1 are listed, the update runs on the kept builder with the one sentence, v2 is current, and no machine boots", async () => {
    const { store, shared, first, next } = await sealed();
    const before = JSON.parse(readFileSync(join(dirname(first.opts.statePath), "golden-import.json"), "utf8")) as { recipeHash: string; build: unknown };
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ tty: false });
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.hosts).toBe(0);
    const out = f.text();
    expect(out).toContain("Changes since image v1");
    expect(out).toContain("update 1 file: ~/.zshrc");
    expect(out).toContain("Small change: update on the builder kept since the save, under a minute");
    expect(out).toMatch(/about \$0\.11\/hr/);
    expect(out).toContain("Updating your image. Taken as the default (--yes).");
    expect(out.match(/Updating your image to v2: files, tools, agents and logins on it are kept and only the changes above are applied; workspaces on v1 stay there until you upgrade them\./g)).toHaveLength(1);
    expect(out).not.toMatch(BOOT);
    expect(out).not.toContain("A builder from an earlier wsp init is still running");
    for (const step of ["Machine ready", "Changes applied", "Files uploaded", "Tools installed", "Agents installed", "MCP servers installed", "Ready", "Snapshot taken", "Fork booted and checked", "Sealed"]) expect(out).toContain(step);
    expect(out).toContain("your builder from v1, kept since the save");
    expect(out).toMatch(/Image v2 sealed in \d+s on the builder kept since the save; new workspaces fork it\./);
    expect(out).toContain("The builder stays up (about $0.11/h, one of the account's machine slots) until wsp init updates on it again, a wsp sweep stops it ten minutes after the save, or the provider's six-hour idle kill fires.");
    // The builder, v1's smoke fork, v2's smoke fork: nothing else booted.
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1-default-v1", true], ["snap_wsp-h1-default-v2", true]]);
    // The update rewrote the import result; the first build's measured stages stay in it for the next rebuild offer.
    const after = JSON.parse(readFileSync(join(dirname(first.opts.statePath), "golden-import.json"), "utf8")) as { recipeHash: string; build: unknown };
    expect(after.recipeHash).not.toBe(before.recipeHash);
    expect(after.build).toEqual(before.build);
    expect(await store.get("goldens", copyKey("default", "default"))).toMatchObject({ head: 2 });
    // The update kept the golden's disk, so what v1's stages recorded is stamped on v2 as it was: the GitHub CLI
    // left to first use, and Claude Code's token not pasted with nobody at this terminal.
    const deferred = [{ name: "Claude Code login", state: "not-signed-in" }, { name: "GitHub CLI login", state: "deferred" }];
    expect(((await store.get("goldens", copyKey("default", "default"))) as { versions: { logins?: unknown }[] }).versions.map(v => v.logins)).toEqual([deferred, deferred]);
    expect(await store.get("golden-recipes", copyKey("default", "default@v2"))).toBeDefined();
    // The saved recipe is the new one, and a run on the same answers finds nothing to update.
    const again = next({ tty: false });
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    expect(again.text()).toContain("Image v2 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(shared.machines).toHaveLength(3);
  });

  /** The recipe with yq off: the formula this Mac has comes off the golden on the next update. */
  const withoutYq = (): Recipe => ({ ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "yq" ? { ...r, on: false } : r)) });

  it("a binary row unticked after the seal is retired on the update, left on the image, and the tally names it", async () => {
    const { store, shared, next } = await sealed();
    const f = next({ tty: false, recipe: async () => withoutYq() });
    const builder = shared.machines[0]!;
    const before = builder.execLog.length;
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("Builds version 2 on top of version 1: 1 row retired");
    expect(out).toContain("retire 1 tool: yq, left on the image");
    expect(out).toContain("Small change: update on the builder kept since the save");
    const ran = builder.execLog.slice(before);
    expect(ran.filter(c => c.includes("brew uninstall yq"))).toEqual([]);
    expect(ran.some(c => c.includes("brew install"))).toBe(false);
    expect(out).toMatch(/Image v2 sealed in \d+s on the builder kept since the save/);
    expect(out).toMatch(/Tools, agents and machine context: 0 installed, 1 retired, 0 failed, 0 skipped; the list is in .*golden-import\.json/);
    expect(out).toContain("yq retired: out of the recipe, left on the image");
    expect(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "golden-import.json"), "utf8"))).toMatchObject({ tools: [], retired: [{ id: "tools/brew/yq", name: "yq" }] });
    expect(await store.get("goldens", copyKey("default", "default"))).toMatchObject({ head: 2, versions: [{ version: 1 }, { version: 2, retired: [{ id: "tools/brew/yq", name: "yq" }] }] });
  });

  it("when the cap refuses the smoke fork the update falls back and the line about the builder staying up is not printed", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const create = shared.create.bind(shared);
    let refused = false;
    shared.create = async spec => {
      if (spec.fromSnapshot === "snap_wsp-h1-default-v2" && !refused) {
        refused = true;
        throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
      }
      return create(spec);
    };
    const f = next({ tty: false });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toMatch(/Image v2 sealed in \d+s on the builder kept since the save; new workspaces fork it\./);
    expect(out).not.toContain("The builder stays up");
    expect(out).toContain("Run wsp to serve.");
    expect(shared.machines[0]!.killed).toBe(true);
  });

  it("the seal report names the kept builder only when it was kept: a cap fallback prints no such line", async () => {
    const store = memoryStore();
    const shared = stubBackend();
    const create = shared.create.bind(shared);
    // The account has one slot: a fork beside a running machine is refused, so the seal gives the builder up first.
    shared.create = async spec => {
      if (spec.fromSnapshot !== undefined && shared.machines.filter(m => !m.killed).length >= 1) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
      return create(spec);
    };
    const f = fake({ yes: true, tty: false });
    f.opts.runtime = recipe => {
      f.backends.push(shared);
      const rt = createRuntime({ backend: shared, store, adapters: {}, goldenRecipe: { ...recipe, deployDaemon: async () => "node v22.12.0" }, hostId: "box:h1" });
      f.runtimes.push(rt);
      return rt;
    };
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("Image v1 sealed.");
    expect(f.text()).not.toContain("The builder stays up ten minutes");
    expect(shared.machines[0]!.killed).toBe(true);
    // The builder gave up its slot to the smoke fork; nothing else boots, and the fork is the person's to ask for.
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1-default-v1", true]]);
    expect(f.text()).toContain("wsp new first forks a workspace from it, and wsp up opens the app.");
  });

  it("a reusable builder already carrying the new recipe is attached to; the update road does not run beside it", async () => {
    const { shared, next } = await sealed();
    // A rebuild with the new recipe whose seal was answered no: its builder stays, first-life, carrying the new hash.
    const rebuilt = next({ recipe: async () => ticking("codex"), yes: false, tty: true });
    rebuilt.opts.host = quietHost();
    const run = runInit(rebuilt.opts, rebuilt.io);
    await throughScreens(rebuilt);
    await rebuilt.until("How do you want to apply them?");
    await rebuilt.press(KEY.enter);
    await rebuilt.until(BOOT);
    await rebuilt.press("y");
    await pastTheVault(rebuilt, SEAL_Q(2));
    await rebuilt.until(SEAL_Q(2));
    await rebuilt.press("n");
    expect((await run).code).toBe(1);
    expect(rebuilt.text()).toContain("Nothing was sealed. Builder m3 stays up");
    expect(shared.machines.map(m => m.killed)).toEqual([true, true, false]);
    await rebuilt.runtimes.at(-1)!.close();

    const again = next({ recipe: async () => ticking("codex"), tty: false });
    again.opts.roads = () => quietRoads;
    expect((await runInit(again.opts, again.io)).code).toBe(0);
    const out = again.text();
    expect(out).toContain("Attaching to your earlier builder: default (m3)");
    expect(out).not.toContain("Changes since image v1");
    expect(out).not.toMatch(BOOT);
    expect(out).toContain("Image v2 sealed.");
    // The attached builder goes with its seal, since nobody at a terminal stays to end a kept one's window; v2's smoke fork too.
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1-default-v1", true], [undefined, true], ["snap_wsp-h1-default-v2", true]]);
  });

  it("a failed update on the kept builder says that builder is gone and what a retry costs", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    shared.execImpl = (m, cmd) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: "1\n", stderr: "" } : guestAnswer(cmd));
    const f = next({ tty: false });
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toContain("Image v1 is unchanged and the builder kept since the save is gone. Run wsp init again to retry on a fork of your image (about two minutes), or pick the rebuild.");
    expect(shared.machines[0]!.killed).toBe(true);
  });

  it("an update whose snapshot the provider refuses leaves the kept builder up and says so; one the provider dropped is named gone at its hand", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    shared.beforeSnapshot = (_m, nth) => { throw Object.assign(new Error("Failed to snapshot sandbox"), { kind: "snapshotUnavailable", status: 502, requestId: `req_${nth}` }); };
    const f = next({ tty: false });
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    // Off a terminal the stream prints a step's end line only, so the attempts are read from the run log; the v1 seal was ask 1 on this machine.
    expect(readFileSync(join(dirname(f.opts.statePath), "init.log"), "utf8")).toContain("stage snapshotting: attempt 1 of 3 answered 502 Failed to snapshot sandbox (request req_2); the builder reads running, next attempt in 1ms");
    expect(f.text()).toContain("the snapshot failed 3 times: the provider answered 502 Failed to snapshot sandbox (request req_4) while the builder read running");
    expect(f.text()).toContain("Image v1 is unchanged. Builder m1 is as it was, up at about $0.11/hr; run wsp init again to retry, and the sweep stops it once it is six hours old.");
    expect(shared.machines.map(m => m.killed)).toEqual([false, true]);
    // The retry: the next wsp init finds the builder with the new recipe on it, attaches, and seals v2 off it.
    shared.beforeSnapshot = undefined;
    const h = next({ tty: false });
    expect((await runInit(h.opts, h.io)).code).toBe(0);
    expect(h.text()).toContain("Image v2 is sealed");
    expect(goldenHead(await h.runtimes.at(-1)!.golden.get())).toMatchObject({ version: 2, snapshotId: "snap_wsp-h1-default-v2" });
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1-default-v1", true], ["snap_wsp-h1-default-v2", true]]);

    const unread = await sealed();
    writeFileSync(join(unread.first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    unread.shared.beforeSnapshot = m => { m.state = async () => { throw Object.assign(new Error("upstream sad"), { kind: "transient", status: 503 }); }; throw Object.assign(new Error("Failed to snapshot sandbox"), { kind: "snapshotUnavailable", status: 502 }); };
    const u = unread.next({ tty: false });
    expect((await runInit(u.opts, u.io)).code).toBe(1);
    expect(u.text()).toContain("Image v1 is unchanged. The provider could not be read about builder m1, so nothing on it was touched; run wsp init again to retry, and the sweep stops it once it is six hours old.");
    expect(unread.shared.machines.map(m => m.killed)).toEqual([false, true]);

    const dropped = await sealed();
    writeFileSync(join(dropped.first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    dropped.shared.beforeSnapshot = m => { m.killed = true; throw Object.assign(new Error("Failed to snapshot sandbox"), { kind: "snapshotUnavailable", status: 502 }); };
    const g = dropped.next({ tty: false });
    expect((await runInit(g.opts, g.io)).code).toBe(1);
    expect(g.text()).toMatch(/the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox \(no request id from the provider, at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\) and no longer has the builder \(404\)/);
    expect(g.text()).toContain("Image v1 is unchanged and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again to retry.");
    expect(await g.runtimes.at(-1)!.golden.builders()).toEqual([]);
  });

  it("an unchanged recipe says the golden already matches and boots nothing", async () => {
    const { shared, next } = await sealed();
    const f = next();
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("Image v1 already matches this recipe. Nothing to update; run wsp to serve it.");
    expect(f.text()).not.toContain("Changes since");
    expect(f.hosts).toBe(0);
    expect(shared.machines).toHaveLength(2);
  });

  it("--rebuild seals the next version from a fresh machine where the changes would have taken the update road, and the help names the flag", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\n");
    // Without the flag a run that asks nothing takes whichever road the changes call for, and this one is small.
    const asked = next({ tty: false });
    asked.opts.rebuild = true;
    expect((await runInit(asked.opts, asked.io)).code).toBe(0);
    const out = asked.text();
    expect(out).not.toContain("Changes since image v1");
    expect(out).not.toContain("Updating your image");
    expect(out).toContain("Image v2 sealed.");
    // A fresh machine, not a fork of v1: the rebuild boots from the base image and runs every stage again.
    expect(shared.machines.map(m => m.spec.fromSnapshot)).toEqual([undefined, "snap_wsp-h1-default-v1", undefined, "snap_wsp-h1-default-v2"]);
  });

  it("a rebuild's seal offers the oldest version for deletion the way an update's does, before the app opens", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const second = next({ tty: false });
    expect((await runInit(second.opts, second.io)).code).toBe(0);
    expect(second.text()).toMatch(/Image v2 sealed in \d+s/);
    // A big change takes the rebuild road; its seal is v3, so v1 is the one to offer.
    const third = next({ recipe: async () => ticking("codex"), tty: false });
    third.opts.roads = () => quietRoads;
    expect((await runInit(third.opts, third.io)).code).toBe(0);
    const out = third.text();
    expect(out).toContain("Rebuilding from scratch. Taken as the default (--yes).");
    expect(out).toContain("Image v3 sealed.");
    expect(out).toMatch(/Delete image v1, [\d.]+ GB, .*\? v3 and v2 stay\..* Taken as yes \(--yes\)\./);
    expect(out).toContain("Deleted image v1.");
    expect(out.indexOf("Image v3 sealed.")).toBeLessThan(out.indexOf("Delete image v1"));
    expect(out.indexOf("Deleted image v1.")).toBeLessThan(out.indexOf("Done. Image v3 is sealed;"));
    expect(shared.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v2", "snap_wsp-h1-default-v3"]);
  });

  it("once a third version seals, wsp init offers the oldest for deletion in one line and --yes takes it, keeping the head and its parent", async () => {
    const { store, shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const second = next({ tty: false });
    expect((await runInit(second.opts, second.io)).code).toBe(0);
    // Two versions: nothing to offer yet.
    expect(second.text()).not.toContain("Delete golden");
    expect(shared.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v1", "snap_wsp-h1-default-v2"]);
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\nexport C=3\n");
    const third = next({ tty: false });
    expect((await runInit(third.opts, third.io)).code).toBe(0);
    const out = third.text();
    expect(out).toMatch(/Image v3 sealed in \d+s/);
    expect(out).toContain("Delete image v1, 8.0 GB, saving about $0.40/month from 2026-10-01? v3 and v2 stay. Taken as yes (--yes).");
    expect(out).toContain("Deleted image v1.");
    expect(out).toContain("storage: 2 snapshots, 16.0 GB; about $0.30/month above the free 10 GB from 2026-10-01");
    expect(shared.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v2", "snap_wsp-h1-default-v3"]);
    expect(await store.get("goldens", copyKey("default", "default"))).toMatchObject({ head: 3, versions: [{ version: 2 }, { version: 3 }] });
    expect(await store.get("golden-recipes", copyKey("default", "default@v1"))).toBeUndefined();
    expect(await store.get("golden-recipes", copyKey("default", "default@v3"))).toBeDefined();
  });

  it("a recipe with one row added builds the next version on top of the golden's head: one road only, v2 with v1 as its parent, and the wizard says what it builds", async () => {
    const { store, shared, first, next } = await sealed();
    const f = next({ tty: false, recipe: async () => ticking("tmux") });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("Builds version 2 on top of version 1: 1 tool added");
    expect(out).toContain("Updating your image. Taken as the default (--yes).");
    // One road: the delta landed on the builder kept from v1, and nothing was built from scratch beside it.
    expect(out).not.toContain("Rebuilding from scratch");
    expect(out).not.toMatch(BOOT);
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1-default-v1", true], ["snap_wsp-h1-default-v2", true]]);
    const manifest = (await store.get("goldens", copyKey("default", "default"))) as GoldenManifest;
    expect(manifest.head).toBe(2);
    expect(manifest.versions.map(v => v.version)).toEqual([1, 2]);
    expect(manifest.versions[1]).toMatchObject({ version: 2, parentSnapshotId: manifest.versions[0]!.snapshotId });
    expect(manifest.versions[1]).not.toHaveProperty("retired");
    expect(first.text()).toContain("Image v1 sealed.");
  });

  it("a row unticked after the seal is retired on the next version and left on the image: nothing is uninstalled, and the lineage carries it", async () => {
    const { store, shared, next } = await sealed();
    const added = next({ tty: false, recipe: async () => ticking("tmux") });
    expect((await runInit(added.opts, added.io)).code).toBe(0);
    const before = shared.machines.length;

    const dropped = next({ tty: false });
    expect((await runInit(dropped.opts, dropped.io)).code).toBe(0);
    const out = dropped.text();
    expect(out).toContain("Builds version 3 on top of version 2: 1 row retired");
    expect(out).toContain("retire 1 tool: tmux, left on the image");
    expect(out).toContain("tmux retired: out of the recipe, left on the image");
    const ran = shared.machines.slice(before - 1).flatMap(m => m.execLog);
    expect(ran.filter(c => /uninstall|apt-get purge/.test(c))).toEqual([]);
    const manifest = (await store.get("goldens", copyKey("default", "default"))) as GoldenManifest;
    expect(manifest.head).toBe(3);
    expect(manifest.versions.find(v => v.version === 3)!.retired).toEqual([{ id: "tools/catalog/tmux", name: "tmux" }]);
  });

  it("a third version names only the row it retires, while its record carries every row the image still holds", async () => {
    const { store, shared, next } = await sealed();
    // v2 drops yq and picks up tmux.
    const two = next({ tty: false, recipe: async () => without(ticking("tmux"), "yq") });
    expect((await runInit(two.opts, two.io)).code).toBe(0);
    expect(two.text()).toContain("Builds version 2 on top of version 1: 1 tool added, 1 row retired");
    const before = shared.machines.length;

    // v3 drops tmux. yq was retired a version ago and is nothing this run did.
    const three = next({ tty: false, recipe: async () => without(RECIPE, "yq") });
    expect((await runInit(three.opts, three.io)).code).toBe(0);
    const out = three.text();
    expect(out).toContain("Builds version 3 on top of version 2: 1 row retired");
    expect(out).toContain("retire 1 tool: tmux, left on the image");
    expect(out).toMatch(/Tools, agents and machine context: 0 installed, 1 retired, /);
    expect(out).toContain("tmux retired: out of the recipe, left on the image");
    // The run never claims to have retired yq: that happened at v2.
    expect(out).not.toContain("yq retired");
    expect(out).not.toContain("retired: yq");
    expect(shared.machines.slice(before - 1).flatMap(m => m.execLog).filter(c => /uninstall|apt-get purge/.test(c))).toEqual([]);

    // The version's record is the whole truth about its image, so it carries both.
    const manifest = (await store.get("goldens", copyKey("default", "default"))) as GoldenManifest;
    expect(manifest.versions.find(v => v.version === 2)!.retired).toEqual([{ id: "tools/brew/yq", name: "yq" }]);
    expect(manifest.versions.find(v => v.version === 3)!.retired).toEqual([
      { id: "tools/brew/yq", name: "yq" },
      { id: "tools/catalog/tmux", name: "tmux" },
    ]);
  });

  it("--yes with a big change (an agent added) takes the rebuild: the boot question follows, the kept builder is no blocker, a fresh builder boots beside it, and its seal forks nothing beside the existing workspace", async () => {
    const { store, shared, first, next } = await sealed();
    // The person's one workspace, forked from v1 before the rebuild.
    const alphaRt = createRuntime({ backend: shared, store, adapters: {}, hostId: "box:h1" });
    const alpha = await createOn(alphaRt, { golden: "snap_wsp-h1-default-v1", name: "alpha" });
    // A measured build on this computer whose tools stage alone took 17m39s; the stages sum to 22 minutes.
    noteOutcomes(importResultPath(first.opts.statePath), { build: { at: "2026-09-05T19:44:00.000Z", stages: { creating: 62_000, "deploying-daemon": 35_000, "applying-setup": 4_000, "uploading-files": 6_000, "installing-harness": 48_000, "installing-tools": 1_059_000, "installing-mcp": 3_000, snapshotting: 41_000, "smoke-forking": 82_000 } } });
    const f = next({ recipe: async () => ticking("codex") });
    const hosted: string[] = [];
    const relay = f.opts.relay;
    f.opts.relay = (rt, builder, hooks) => {
      hosted.push(builder.id);
      return relay(rt, builder, hooks);
    };
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("add 1 agent: Codex");
    expect(out.replace(/\s*│?\s*\n│\s+/g, " ")).toContain("A big change: a rebuild from scratch is the safer road, about 22 minutes last time.");
    expect(out).toContain("Rebuilding from scratch. Taken as the default (--yes).");
    // The kept builder holds a slot the rebuild needs; it goes after the confirm and before the boot, said once.
    expect(out).toContain("Stopping the builder kept from image v1 (m1) to free its machine slot.");
    expect(out.indexOf("Stopping the builder kept")).toBeGreaterThan(out.indexOf("Boot a "));
    expect(out.indexOf("Stopping the builder kept")).toBeLessThan(out.indexOf("Creating the machine"));
    expect(out).toMatch(BOOT);
    expect(out).not.toContain("A builder from an earlier wsp init is still running");
    expect(out).not.toContain("Nothing was booted");
    expect(hosted).toEqual(["m4"]);
    // The rebuilt builder seals v2 and is kept; its smoke fork is gone. v1 stays for the workspace forked from it,
    // which stays where it is: no second workspace is forked, and the app opens on the one there.
    expect(out).toContain("Image v2 sealed.");
    expect(out).toContain("Your 1 workspace stays on the image version it was forked from; upgrade it from the app. New workspaces fork v2.");
    expect(out).not.toContain("Workspace first");
    expect(out).not.toContain("Forking your first workspace");
    expect(out).toMatch(/^◇\s+Open http:\/\/127\.0\.0\.1:4400\/#c\/7K3MQP2X$/m);
    expect((await f.runtimes.at(-1)!.workspaces.list()).map(w => [w.id, w.golden])).toEqual([[alpha.id, "snap_wsp-h1-default-v1"]]);
    expect(shared.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1-default-v1", true], ["snap_wsp-h1-default-v1", false], [undefined, false], ["snap_wsp-h1-default-v2", true]]);
  });

  it("--first-workspace on a rebuild forks it whatever the list holds, and the workspaces already there stay on the version they came from", async () => {
    const { store, shared, first, next } = await sealed();
    const alpha = await createOn(createRuntime({ backend: shared, store, adapters: {}, hostId: "box:h1" }), { golden: "snap_wsp-h1-default-v1", name: "alpha" });
    const f = next({ recipe: async () => ticking("codex") });
    f.opts.firstWorkspace = "proj";
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("Image v2 sealed.");
    // The step was answered, so the count of workspaces has nothing to say and the stay line stands down.
    expect(out).not.toContain("stays on the image version it was forked from");
    expect(out).toMatch(/Workspace proj \(ws_[0-9a-f]+\) forked from image v2\./);
    expect(f.trail).toContain("fork proj");
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(workspaces.map(w => w.name).sort()).toEqual(["alpha", "proj"]);
    // The one that was already there is untouched: the fork above it is a new machine on the new version.
    expect(workspaces.find(w => w.name === "alpha")!.golden).toBe(alpha.golden);
    expect(workspaces.find(w => w.name === "proj")!.golden).toBe("snap_wsp-h1-default-v2");
    expect(first.text()).not.toContain("Workspace proj");
  });

  it("interactive: the offer is a choice with the update first when the change is small; enter takes it", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ yes: false, tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until("How do you want to apply them?");
    const asked = f.text();
    expect(asked).toContain("Update your image (under a minute, about $0.11/hr while it runs)");
    expect(asked).toContain("Rebuild from scratch (under a minute last time)");
    expect(asked.indexOf("Update the golden")).toBeLessThan(asked.indexOf("Rebuild from scratch"));
    await f.press(KEY.enter);
    expect((await run).code).toBe(0);
    expect(f.text()).toMatch(/Image v2 sealed in \d+s on the builder kept since the save/);
    expect(f.text()).not.toMatch(BOOT);
    expect(shared.machines).toHaveLength(3);
  });

  it("the seal records how long each stage of the build ran in the import result, the closing stages apart", async () => {
    const { first } = await sealed();
    const { build } = JSON.parse(readFileSync(join(dirname(first.opts.statePath), "golden-import.json"), "utf8")) as { build: { at: string; stages: Record<string, number> } };
    expect(Date.parse(build.at)).toBeGreaterThan(Date.now() - 60_000);
    expect(Object.keys(build.stages)).toEqual(["creating", "deploying-daemon", "applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp", "snapshotting", "smoke-forking"]);
    for (const ms of Object.values(build.stages)) expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("with no measured build in the import result the rebuild is offered at the assumed ten minutes and says so", async () => {
    const { shared, first, next } = await sealed();
    rmSync(importResultPath(first.opts.statePath));
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ yes: false, tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until("How do you want to apply them?");
    expect(f.text()).toContain("Rebuild from scratch (about ten minutes, not measured on this computer yet)");
    await f.press(KEY.ctrlC);
    await run;
    expect(shared.machines).toHaveLength(2);
  });

  it("a head sealed before the base tools existed is offered the rebuild only: no update choice, the boot question follows", async () => {
    const { store, first, next } = await sealed();
    const manifest = (await store.get("goldens", copyKey("default", "default"))) as GoldenManifest;
    await store.put("goldens", copyKey("default", "default"), { ...manifest, versions: manifest.versions.map(({ base: _base, ...v }) => v) });
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ yes: false, tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    const asked = f.text();
    expect(asked).toContain("Changes since image v1");
    expect(asked).toContain("update 1 file: ~/.zshrc");
    expect(asked).toContain("Image v1 was sealed before the base tools existed and cannot take an update; the rebuild is the only road, under a minute last time.");
    expect(asked).not.toContain("How do you want to apply them?");
    expect(asked).not.toContain("Update the golden");
    expect(asked).not.toContain("Small change");
    await f.press(KEY.ctrlC);
    expect((await run).code).toBe(1);
    expect(f.text()).toContain("Nothing was booted. The recipe is kept.");
  });

  it("a kept builder another process holds does not count as the update's machine: the offer names the fork road and its two minutes", async () => {
    const { store, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const record = (await store.get("builders", "m1")) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: process.ppid } });
    const f = next({ tty: false });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).toContain("Small change: update on a fork of your image, about two minutes");
    expect(out).toMatch(/Image v2 sealed in \d+s from a fork of your image/);
  });

  it("interactive: down then enter picks the rebuild, and the boot question follows", async () => {
    const { shared, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const f = next({ yes: false, tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until("How do you want to apply them?");
    await f.press(KEY.down, KEY.enter);
    await f.until(BOOT);
    await f.press(KEY.esc);
    expect((await run).code).toBe(1);
    expect(f.text()).toContain("Nothing was booted. The recipe is kept.");
    // No costs nothing: the kept builder is as it was.
    expect(f.text()).not.toContain("Stopping the builder kept");
    expect(shared.machines[0]!.killed).toBe(false);
  });

  it("a kept builder that is no longer first-life is not the update's machine", async () => {
    const { store, first, next } = await sealed();
    writeFileSync(join(first.opts.home, ".zshrc"), "export A=1\nexport B=2\n");
    const record = (await store.get("builders", "m1")) as { firstLife: boolean };
    await store.put("builders", "m1", { ...record, firstLife: false });
    const f = next({ tty: false });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain("Small change: update on a fork of your image, about two minutes");
  });
});

describe("wsp init --recipe", () => {
  const recipeFile = (f: Fake): string => {
    const path = join(dirname(f.opts.statePath), "recipe.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [
        { id: "claude", kind: "agent", on: false, source: { kind: "popular", sessions: 149, images: 1 } },
        { id: "codex", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.codex/config.toml"], bin: true } },
        { id: "gh", kind: "tool", on: true, source: { kind: "used", sessions: 100, calls: 7919 }, signIn: "copy" },
        { id: "yq", kind: "tool", on: false, source: { kind: "popular", sessions: 0, images: 3 } },
        { id: "agent-browser", kind: "tool", on: true, source: { kind: "used", sessions: 45, calls: 2591 } },
      ],
    }));
    return path;
  };

  it("skips the pick screens and lands on the sign-ins, the recipe's ticks and answers in place, then saves them", async () => {
    const f = fake();
    f.opts.recipeFile = recipeFile(f);
    const run = runInit(f.opts, f.io);
    await f.until("Sign-ins");
    const out = f.text();
    // The machine was still read; the card says what ticked it and counts the collector's rows, not the catalog's bare one.
    expect(out).toContain("15 found on this computer, ticked by the recipe.");
    expect(out).not.toContain("not in this build");
    // No Agents or Tools screen: the run opens on the sign-ins, the first of the three steps it shows.
    expect(out).not.toContain("◆  Agents");
    expect(out).toMatch(/Sign-ins\s+1\/3/);
    // Codex is on and Claude Code off, so only Codex's login is listed, left to first use; the saved copy answer for gh is a ticked keys row.
    expect(out).toMatch(/Codex login\s+[^\n]*sign in when you first need it/);
    expect(out).not.toContain("Claude Code login");
    expect(out).toMatch(/GitHub CLI login\s+[^\n]*copy from this Mac/);
    await f.press(KEY.enter);
    await f.until("wsp for your agents on this Mac  2/3");
    await f.press(KEY.enter);
    await f.until(BOOT);
    await f.press("n");
    expect((await run).code).toBe(1);
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/codex")).toMatchObject({ bring: true });
    expect(saved.get("agents/claude")).toMatchObject({ bring: false });
    expect(saved.get("tools/brew/gh")).toMatchObject({ bring: true });
    expect(saved.get("tools/brew/yq")).toMatchObject({ bring: false });
    expect(saved.get("tools/npm/tsx")).toMatchObject({ bring: false });
    // The ticked tool this Mac has no row for is saved as the catalog's bare row, so the build installs it by its road.
    expect(saved.get("tools/catalog/agent-browser")).toMatchObject({ label: "agent-browser", bring: true });
    expect(saved.get("logins/gh")).toMatchObject({ bring: true, choice: "copy" });
    expect(saved.get("logins/codex")).toMatchObject({ bring: false, choice: "later" });
    // The other rungs took their defaults, as the screens would have.
    expect(saved.get("identity/git-user")).toMatchObject({ bring: true });
  });

  it("with --yes the recipe's saved copy answer is honoured like a saved manifest's: the Keychain is read, the golden built", async () => {
    const f = fake({ yes: true });
    f.opts.recipeFile = recipeFile(f);
    mkdirSync(join(f.opts.home, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.opts.home, ".config", "gh", "hosts.yml"), "github.com:\n    user: Zingzy\n");
    const result = await runInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(f.reads).toEqual(["gh:github.com"]);
    const saved = new Map(loadManifest(join(dirs[0]!, "golden-recipe.json")).entries.map(e => [e.id, e]));
    expect(saved.get("agents/codex")).toMatchObject({ bring: true });
    expect(saved.get("agents/claude")).toMatchObject({ bring: false });
    expect(saved.get("tools/brew/yq")).toMatchObject({ bring: false });
    expect(saved.get("logins/gh")).toMatchObject({ bring: true, choice: "copy" });
    expect(f.text()).toContain("GitHub CLI login: copied");
    // agent-browser has no row here: the build installed it by its catalog road, an npm global, and the tally says the road is unmeasured.
    expect(f.backends[0]!.machines[0]!.execLog.some(c => c.includes("npm install -g agent-browser@0.31.1"))).toBe(true);
    const tools = JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).tools as { id: string; outcome: string; note?: string }[];
    expect(tools.find(t => t.id === "tools/catalog/agent-browser")).toMatchObject({ outcome: "installed", note: "by an unmeasured road" });
    expect(f.text()).toMatch(/Installing tools\s+\d+ installed \(agent-browser \(by an u/);
  });

  it("a row the catalog does not carry installs after the catalog's own, is recorded by name, and is offered no sign-in", async () => {
    const f = fake({ yes: true });
    const path = join(dirname(f.opts.statePath), "recipe.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [{ id: "gh", kind: "tool", on: true, source: { kind: "used", sessions: 100, calls: 7919 } }],
      custom: [{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "used in wsp" }],
    }));
    f.opts.recipeFile = path;
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const log = f.backends[0]!.machines[0]!.execLog;
    expect(log.some(c => c.includes("brew install just"))).toBe(true);
    // After every catalog road: the gh formula went first.
    expect(log.findIndex(c => c.includes("brew install just"))).toBeGreaterThan(log.findIndex(c => c.includes("brew install gh")));
    const tools = JSON.parse(readFileSync(join(dirs[0]!, "golden-import.json"), "utf8")).tools as { id: string; label: string; outcome: string }[];
    expect(tools.at(-1)).toMatchObject({ id: "tools/custom/just", label: "just", outcome: "installed" });
    // The row travels in the small recipe, so a second run carries it; no sign-in was ever offered for it.
    expect(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8")).custom).toEqual([{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "used in wsp" }]);
    expect(f.text()).not.toContain("just login");
  });

  it("names the recipe file, not screens it never drew, when the recipe it was given overfills the disk", async () => {
    const f = fake({ yes: true });
    const path = join(dirname(f.opts.statePath), "given.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [],
      custom: [{ kind: "custom", id: "brew/llvm", name: "llvm", install: ["brew install llvm"], check: "brew list llvm", manager: "brew", size: 30 * 1024 * 1024 * 1024, why: "installed on this Mac by brew" }],
    }));
    f.opts.recipeFile = path;
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    const out = f.text();
    expect(out).toContain(`Untick about 14.8 GB of tools or agents in ${path}`);
    expect(out).not.toContain("What they need");
    expect(f.backends.flatMap(b => b.machines)).toHaveLength(0);
  });

  it("a provider that caps no disk boots the same recipe: there is no room to be over", async () => {
    const f = fake({ yes: true });
    const path = join(dirname(f.opts.statePath), "given.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      at: "2026-09-06T03:00:00.000Z",
      histories: [],
      rows: [],
      custom: [{ kind: "custom", id: "brew/llvm", name: "llvm", install: ["brew install llvm"], check: "brew list llvm", manager: "brew", size: 30 * 1024 * 1024 * 1024, why: "installed on this Mac by brew" }],
    }));
    f.opts.recipeFile = path;
    // The same 30 GB recipe the case above refuses, on a provider whose machines take the box's disk: nothing is
    // over a cap that does not exist, so the run goes on and the build boots.
    f.opts.pricing = { ...f.opts.pricing, builderDiskGb: undefined };
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const out = f.text();
    expect(out).not.toContain("This recipe needs about");
    expect(out).not.toContain("Untick about");
    // The Disk line still says the total, with no cap named and no weight on it.
    expect(out).toContain("on the machine");
    expect(f.backends.flatMap(b => b.machines).length).toBeGreaterThan(0);
  });

  it("the wsp tools rows follow the agents on this Mac, not the recipe's recorded source; a ticked row writes here, and a file with comments keeps them", async () => {
    const f = fake();
    // The file says Codex is installed where it was written; this Mac has Claude Code and Gemini CLI.
    f.opts.recipeFile = recipeFile(f);
    f.opts.recipe = async () => ({ ...RECIPE, rows: [...RECIPE.rows, { id: "gemini", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.gemini/settings.json"], bin: true } }] });
    mkdirSync(join(f.opts.home, ".gemini"), { recursive: true });
    writeFileSync(join(f.opts.home, ".gemini", "settings.json"), '{\n  // the theme\n  "theme": "dark"\n}\n');
    const run = runInit(f.opts, f.io);
    // A recipe file decides the agents and the tools, so the run opens on the sign-ins and the wsp tools follow.
    await f.until("Sign-ins  1/3");
    await f.press(KEY.enter);
    await f.until("wsp for your agents on this Mac  2/3");
    const screen = f.text().slice(f.text().lastIndexOf("◆  wsp for your agents on this Mac"));
    expect(screen).toMatch(/○ Claude Code\n┃\s+○ Gemini CLI\n/);
    expect(screen).not.toContain("Codex");
    await f.press(..."gemini");
    await f.until(/search {2}gemini/);
    await f.press(KEY.space);
    await f.until(/● Gemini CLI/);
    await f.press(KEY.enter);
    await f.until(BOOT);
    const out = f.text();
    expect(out).toMatch(/Gemini CLI now has the wsp tools: ~\/\.gemini\/settings\.json\n│\s+The wsp skill went to /);
    expect(out).not.toContain("Claude Code now has the wsp tools");
    expect(existsSync(join(f.opts.home, ".claude.json"))).toBe(false);
    const text = readFileSync(join(f.opts.home, ".gemini", "settings.json"), "utf8");
    expect(text).toContain("// the theme\n");
    const settings = parseJsonc(text) as { theme: string; mcpServers: { wsp: { args: string[] } } };
    expect(settings.theme).toBe("dark");
    expect(settings.mcpServers.wsp.args.slice(-3)).toEqual(["mcp", "--state", f.opts.statePath]);
    await f.press("n");
    expect((await run).code).toBe(1);
    // The saved recipe is this Mac's rows with the file's ticks on them: what is here as each row's source, a row the file lacked off.
    const saved = Recipe.parse(JSON.parse(readFileSync(join(dirname(f.opts.statePath), "recipe.json"), "utf8")));
    expect(saved.rows.find(r => r.id === "codex")).toMatchObject({ on: true, source: { kind: "popular" } });
    expect(saved.rows.find(r => r.id === "claude")).toMatchObject({ on: false, source: { kind: "installed" } });
    expect(saved.rows.find(r => r.id === "gemini")).toMatchObject({ on: false, source: { kind: "installed" } });
  });

  it("a recipe file's tick on a tool outside the catalog that this Mac has no row for is said and left out, never installed by guesswork, and the recipe saved beside the state does not carry it", async () => {
    const f = fake({ yes: true });
    const path = join(dirname(f.opts.statePath), "given.json");
    writeFileSync(path, JSON.stringify({ ...RECIPE, rows: [...RECIPE.rows, { id: "tools/brew/zingzy/tap/diskbloom", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } }] }));
    f.opts.recipeFile = path;
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(f.text().replace(/\n[│▲]\s+/g, " ")).toContain(`zingzy/tap/diskbloom is ticked in ${path}, but this Mac has no row that installs it; it is left out.`);
    expect(f.backends[0]!.machines[0]!.execLog.some(c => c.includes("diskbloom"))).toBe(false);
    expect(Recipe.parse(JSON.parse(readFileSync(join(dirs[0]!, "recipe.json"), "utf8"))).rows.some(r => r.id === "tools/brew/zingzy/tap/diskbloom")).toBe(false);
  });

  it("a recipe that does not parse ends the run before anything is read or booted", async () => {
    const f = fake({ collect: async () => { throw new Error("collect must not run on a bad recipe"); } });
    f.opts.recipeFile = join(dirname(f.opts.statePath), "recipe.json");
    writeFileSync(f.opts.recipeFile, JSON.stringify({ version: 2 }));
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    expect(f.text()).toMatch(/recipe\.json: invalid recipe: version/);
    expect(f.backends).toHaveLength(0);
  });
});

describe("wsp init, the first workspace and its project", () => {
  it("--first-workspace and --import fork, then import, then open the app on that workspace, with the consent the app's import starts from", async () => {
    const f = fake({ tty: false });
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-init-proj-")));
    dirs.push(folder);
    // A workspace on this computer is a folder of the person's own worked in place, so the folder is a repo.
    execFileSync("git", ["init", "-q", folder]);
    f.opts.firstWorkspace = "proj";
    f.opts.importFolder = folder;
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(workspaces.map(w => w.name)).toEqual(["proj", LOCAL_NAME]);
    // The fork, then the import onto it, then the tick's own workspace. Off a terminal nothing is launched, so the
    // address is printed below.
    expect(f.trail).toEqual(["fork proj", `import ${folder} -> ${folder}`, "local"]);
    // The app's own defaults, unchanged: the rewrite travels, the bare secret is cut, the agent with sessions comes.
    expect(f.imports).toEqual([{ workspaceId: workspaces[0]!.id, source: folder, dest: folder, carry: [], rewrite: [".git/config"], agents: ["claude"] }]);
    const out = f.text();
    expect(out).toMatch(/Workspace proj \(ws_[0-9a-f]+\) forked from image v1\./);
    expect(out).toContain("12 files, 3 KB; the repository whole; 46 sessions from Claude Code; 2 secret-shaped files read for what may travel.");
    expect(out).toContain(`${folder} on proj: 12 files, 3 KB; 1 file rewritten without their credentials; 1 secret-shaped file cut.`);
    // Off a terminal no app is served: the run ends naming what serves it.
    expect(out).toContain("Done. Image v1 is sealed; wsp up opens the app.");
    expect(out).not.toMatch(URL_RE);
    expect(f.hosts).toBe(0);
  });

  it("No to both the fork and the tick makes nothing, imports nothing, and leaves the plain address", async () => {
    const f = fake({ tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    await firstWorkspace(f, false, false);
    expect((await run).code).toBe(0);
    expect(f.trail).toEqual([expect.stringMatching(OPENING_PAGE)]);
    expect(openedAddress(f.trail)).toBe(`http://127.0.0.1:4400/#c/${HERE_CODE}`);
    expect(f.imports).toEqual([]);
    expect(await f.runtimes.at(-1)!.workspaces.list()).toEqual([]);
    const out = f.text();
    expect(out).toContain("Done. wsp up starts the app; opening it now.");
    expect(out).not.toContain("Forking your first workspace");
  });

  it("No to the fork with the tick left on and no folder named makes nothing, and says the road that records one", async () => {
    const f = fake({ tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    await firstWorkspace(f, false);
    expect((await run).code).toBe(0);
    // A workspace is one project's copy, so a run that named no folder here makes none and says what records one.
    expect(await f.runtimes.at(-1)!.workspaces.list()).toEqual([]);
    expect(f.trail).toEqual([expect.stringMatching(OPENING_PAGE)]);
    expect(openedAddress(f.trail)).toBe(`http://127.0.0.1:4400/#c/${HERE_CODE}`);
    expect(f.text()).toContain("a workspace is one project's, and this run named no folder here");
  });

  it("Yes with a typed folder forks under the default name and imports what was typed", async () => {
    const f = fake({ tty: true });
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-init-proj-")));
    dirs.push(folder);
    // A workspace on this computer is a folder of the person's own worked in place, so the folder is a repo.
    execFileSync("git", ["init", "-q", folder]);
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    await firstWorkspace(f, folder);
    expect((await run).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(workspaces.map(w => w.name)).toEqual(["first", LOCAL_NAME]);
    expect(f.trail).toEqual(["fork first", `import ${folder} -> ${folder}`, "local", expect.stringMatching(OPENING_PAGE)]);
    expect(openedAddress(f.trail)).toBe(`http://127.0.0.1:4400/#w/${workspaces[0]!.id}/c/${HERE_CODE}`);
  });

  it("Yes with nothing typed forks the workspace and imports no project", async () => {
    const f = fake({ tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    await firstWorkspace(f, "");
    expect((await run).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(f.trail).toEqual(["fork first", expect.stringMatching(OPENING_PAGE)]);
    expect(openedAddress(f.trail)).toBe(`http://127.0.0.1:4400/#w/${workspaces[0]!.id}/c/${HERE_CODE}`);
    expect(f.imports).toEqual([]);
  });

  it("--no-local leaves this computer alone, and the run ends naming the wsp new that forks one", async () => {
    const f = fake({ tty: false });
    f.opts.noLocal = true;
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(await f.runtimes.at(-1)!.workspaces.list()).toEqual([]);
    expect(f.trail).toEqual([]);
    expect(f.text()).toContain("Done. Image v1 is sealed; wsp new first forks a workspace from it, and wsp up opens the app.");
  });

  it("a host that refuses the tick is one line, and the fork beside it still opens the app", async () => {
    const f = fake({ tty: false });
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-init-proj-")));
    dirs.push(folder);
    execFileSync("git", ["init", "-q", folder]);
    f.opts.firstWorkspace = "proj";
    f.opts.importFolder = folder;
    const roads = f.opts.roads;
    f.opts.roads = rt => ({ ...roads(rt), addProject: async () => { throw new Error("that folder is not a git repo"); } });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect((await f.runtimes.at(-1)!.workspaces.list()).map(w => w.name)).toEqual(["proj"]);
    expect(f.text()).toContain("this computer was not made a workspace: that folder is not a git repo");
  });

  it("a --import folder that is not there ends the run before anything is read or booted", async () => {
    const f = fake({ tty: false, collect: async () => { throw new Error("collect must not run on a bad --import"); } });
    f.opts.importFolder = join(tmpdir(), "wsp-init-no-such-folder");
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    expect(f.text()).toContain(`--import ${f.opts.importFolder}: no folder there on this computer`);
    expect(f.backends).toHaveLength(0);
    expect(f.trail).toEqual([]);
  });

  it("a --import path that is a file, not a folder, ends the run the same way", async () => {
    const f = fake({ tty: false, collect: async () => { throw new Error("collect must not run on a bad --import"); } });
    const file = join(f.opts.home, ".zshrc");
    f.opts.importFolder = file;
    expect((await runInit(f.opts, f.io)).code).toBe(1);
    expect(f.text()).toContain(`--import ${file}: not a folder`);
    expect(f.backends).toHaveLength(0);
  });

  it("esc at the folder prompt forks the workspace with no project, the same as enter on nothing", async () => {
    const f = fake({ tty: true });
    const run = runInit(f.opts, f.io);
    await throughScreens(f);
    await f.until(BOOT);
    await f.press("y");
    await sealIt(f);
    await f.until(FIRST_QUESTION);
    await f.press(KEY.enter);
    await f.until(ALSO_LOCAL_QUESTION);
    await f.press(KEY.enter);
    await f.until(folderQuestion("darwin"));
    await f.press(KEY.esc);
    expect((await run).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(workspaces.map(w => w.name)).toEqual(["first"]);
    expect(f.trail).toEqual(["fork first", expect.stringMatching(OPENING_PAGE)]);
    expect(openedAddress(f.trail)).toBe(`http://127.0.0.1:4400/#w/${workspaces[0]!.id}/c/${HERE_CODE}`);
    expect(f.imports).toEqual([]);
    expect(f.text()).not.toContain("Done. wsp up starts the app");
  });

  it("an import that fails keeps the workspace and says where to import it from", async () => {
    const f = fake({ tty: false });
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-init-proj-")));
    dirs.push(folder);
    // A workspace on this computer is a folder of the person's own worked in place, so the folder is a repo.
    execFileSync("git", ["init", "-q", folder]);
    f.opts.importFolder = folder;
    const roads = f.opts.roads;
    f.opts.roads = rt => ({ ...roads(rt), importProject: async () => { throw new Error("the machine refused the upload"); } });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    const workspaces = await f.runtimes.at(-1)!.workspaces.list();
    expect(workspaces.map(w => w.name)).toEqual(["first", LOCAL_NAME]);
    expect(f.text()).toContain(`${folder} was not imported: the machine refused the upload. The workspace is up; import it from the app.`);
    // The workspace survived the failed import, so the run still ends done, with the workspace on the account.
    expect(f.text()).toContain("Done. Image v1 is sealed; wsp up opens the app.");
  });
});

describe("wsp init beside a host already serving the state", () => {
  it("asks its own screens, saves the recipe and hands the build over: nothing is built, served or booted here", async () => {
    const handed: { interactive: boolean }[] = [];
    const f = fake({
      yes: true,
      handOff: async o => {
        handed.push(o);
        return 0;
      },
    });
    expect((await runInit(f.opts, f.io)).code).toBe(0);
    expect(handed).toEqual([{ interactive: false }]);
    const out = f.text();
    // The run's own words up to the hand-off: the same cards, the same recipe, the same question about the money.
    expect(out).toContain("Found on this computer");
    expect(out).toContain("Recipe saved to");
    expect(out).toMatch(BOOT);
    expect(readFileSync(join(dirname(f.opts.statePath), "recipe.json"), "utf8")).toContain('"rows"');
    // No second writer of this state file: no runtime was made here, so nothing booted and nothing billed.
    expect(f.runtimes).toEqual([]);
    expect(f.backends).toEqual([]);
    expect(f.recipes).toEqual([]);
    expect(f.hosts).toBe(0);
  });

  it("asks for the spend where the person is: No hands nothing over and boots nothing, Enter hands it over", async () => {
    const handed: { interactive: boolean }[] = [];
    const handOff = async (o: { interactive: boolean }): Promise<number> => {
      handed.push(o);
      return 0;
    };
    const no = fake({ handOff });
    const refused = runInit(no.opts, no.io);
    await throughScreens(no);
    await no.until(BOOT);
    await no.press("n");
    expect((await refused).code).toBe(1);
    expect(handed).toEqual([]);
    expect(no.text()).toContain("Nothing was booted. The recipe is kept.");

    const yes = fake({ handOff });
    const taken = runInit(yes.opts, yes.io);
    await throughScreens(yes);
    await yes.until(BOOT);
    await yes.press(KEY.enter);
    expect((await taken).code).toBe(0);
    expect(handed).toEqual([{ interactive: true }]);
    expect(yes.backends).toEqual([]);
  });
});
