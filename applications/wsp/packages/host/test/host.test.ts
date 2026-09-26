// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePath, type AdapterEvent, type TurnResult } from "@wsp/protocol";
import { CATALOG, GUEST_HOME } from "@wsp/catalog";
import { allRows, type RecipeAnswer } from "../src/recipe-answer.js";
import { HERE } from "./recipe-fixture.js";
import { BUILDER_IDLE_MS, type GoldenImport } from "@wsp/engine";
import { copyKey, createRuntime, memoryStore, type HarnessAdapterFactory, type ReapResult, type Runtime, type Store } from "@wsp/runtime";
import { execFileSync } from "node:child_process";
import { DAEMON_PORT } from "@wsp/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { cli, hostDoctorReaders, serve, type CliIO } from "../src/cli.js";
import { placeWiring } from "../src/places.js";
import { claudeEnvs } from "../src/doctor.js";
import { REAP_INTERVAL_MS, startHost, type HostDoctorReaders, type HostHandle } from "../src/server.js";
import { VERSION } from "../src/version.js";
import { SEALED_GOLDEN as GOLDEN } from "./sealed-golden.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { closeStandInGuests, fakeGuestAt } from "../src/fake-guest.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { createOn, projectOn } from "./verbs-fixture.js";

runsFromItsOwnFolder();

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  bin: Record<string, string>;
};

// Stands in for apps/web/dist: the dev boot line the host replaces, one
// module script with a src, one asset.
const DEV_BOOT = `<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>`;
const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
${DEV_BOOT}
</body></html>
`;

function fakeWebDir(page: string | null = PAGE): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')\n");
  if (page !== null) writeFileSync(join(dir, "index.html"), page);
  return dir;
}

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
function quietIO(lines: string[] = []): CliIO {
  return { log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt };
}

function testRuntime(seedGolden = true): { rt: Runtime; backend: StubBackend; store: Store } {
  const backend = stubBackend();
  const store = memoryStore();
  if (seedGolden) void store.put("goldens", copyKey("default", "default"), GOLDEN);
  const rt = createRuntime({ backend, store, adapters: {} });
  return { rt, backend, store };
}

/** One socket to a host started here, speaking the protocol by hand: auth, then request and reply by id, with
 * every frame the host pushed kept in order. */
async function wsClient(port: number, token: string): Promise<{ request(op: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>; frames: Record<string, unknown>[]; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let next = 1;
  const pending = new Map<number, (f: Record<string, unknown>) => void>();
  const frames: Record<string, unknown>[] = [];
  ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const waiting = typeof frame["id"] === "number" ? pending.get(frame["id"] as number) : undefined;
    if (waiting !== undefined) {
      pending.delete(frame["id"] as number);
      waiting(frame);
      return;
    }
    frames.push(frame);
  });
  const request = (op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = next++;
    return new Promise(resolve => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, op, ...params }));
    });
  };
  await request("auth", { token });
  return { request, frames, close: () => ws.close() };
}

/** A JSON route read with the host's own token, as every tool on this computer reads it off the file beside the state. */
async function getJson(url: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
}

function refused(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => sock.destroy(new Error("connected")));
    sock.once("error", e => resolve((e as NodeJS.ErrnoException).code === "ECONNREFUSED"));
  });
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]!);
}

/** A computer for the recipe verb to read, written to a temp dir: one agent's history with node, pnpm and pulumi
 * in two sessions, and java on PATH and never run. The verb reads a computer through nodeHost(), whose whole answer
 * comes from HOME and PATH, so pinning those two is what keeps these rows off whichever box the suite runs on. */
function fixtureMachine(): { dir: string; home: string; state: string; project: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-cli-recipe-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const project = join(home, "proj");
  const line = (sessionId: string, commands: readonly string[]): string =>
    JSON.stringify({ type: "assistant", cwd: project, sessionId, message: { role: "assistant", content: commands.map(command => ({ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } })) } });
  mkdirSync(join(home, ".claude", "projects", "s"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(home, ".claude", "projects", "s", "s1.jsonl"), `${[line("s1", ["node build.js", "node build.js", "node build.js", "pnpm install", "pnpm install", "pnpm install"]), line("s1", ["pulumi -q"])].join("\n")}\n`);
  writeFileSync(join(home, ".claude", "projects", "s", "s2.jsonl"), `${[line("s2", ["pnpm test", "pnpm test", "node build.js", "node build.js", "node build.js", "pulumi"])].join("\n")}\n`);
  writeFileSync(join(bin, "java"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // nodeHost() takes its home from HOME and answers `which` off PATH, so these two words are the whole computer
  // the verb sees: no transcript, config tree or binary of the box the suite runs on is read.
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", bin);
  return {
    dir,
    home,
    state: join(dir, "state.json"),
    project,
    close: () => {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("wsp cli", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("--version prints the package version", async () => {
    const lines: string[] = [];
    const code = await cli(["--version"], quietIO(lines));
    expect(code).toBe(0);
    expect(lines).toEqual([`wsp ${pkg.version}`]);
  });

  it("is wired as the wsp bin", () => {
    expect(pkg.bin["wsp"]).toBe("./dist/bin.js");
  });

  it("recipe writes the file, prints the table on stdout and the reading on stderr, and refuses a --tick word it does not know", async () => {
    const box = fixtureMachine();
    const out = join(box.dir, "recipe.json");
    const logs: string[] = [];
    const errs: string[] = [];
    const io: CliIO = { log: l => logs.push(l), error: l => errs.push(l), ask: noPrompt, askSecret: noPrompt };
    const row = (id: string) => JSON.parse(readFileSync(out, "utf8")).rows.find((r: { id: string }) => r.id === id);

    expect(await cli(["recipe", "--out", out, "--state", box.state, "--tick", "default", "--json"], io)).toBe(0);
    const table = JSON.parse(logs.at(-1)!) as RecipeAnswer;
    expect(table).toMatchObject({ tick: "default", out });
    expect(logs).toHaveLength(1);
    expect(errs[0]).toContain("Nothing leaves this computer");
    // The catalog's own default, so the rows are the catalog's and nothing of this computer moves them.
    // The table puts heavy rows first inside a group, so the two sides compare as sets.
    expect(allRows(table).filter(r => r.on).map(r => r.id).sort()).toEqual(CATALOG.flatMap(e => (e.kind === "tool" && e.defaultOn ? [e.id] : [])).sort());
    expect(readFileSync(out, "utf8")).toContain('"tick": "default"');

    logs.length = 0;
    errs.length = 0;
    expect(await cli(["recipe", "--out", out, "--state", box.state, "--tick", "used", "--set", "java=on"], io)).toBe(0);
    // The wizard's own two tables, drawn by the one renderer both it and this verb call.
    expect(logs[0]).toBe("Agents");
    expect(logs).toContain("Tools");
    expect(logs.filter(l => l.startsWith("On: "))).toHaveLength(2);
    expect(logs.at(-1)).toContain(`wsp init --recipe ${out}`);
    // What the fixture's own history and PATH say, the same on any box: two tools run in two sessions above the floor, one
    // installed and never run, and one flipped on by hand.
    expect(row("node")).toMatchObject({ on: true, source: { kind: "used", sessions: 2, calls: 6 } });
    expect(row("pnpm")).toMatchObject({ on: true, source: { kind: "used", sessions: 2, calls: 5 } });
    expect(row("java")).toMatchObject({ on: true, source: { kind: "installed", bin: true } });
    expect(row("gradle")).toMatchObject({ on: false, source: { kind: "popular" } });
    expect(logs.find(l => l.includes("Java 21"))).toMatch(/^● {2}Java 21\s+installed\s+installed here, never used\s+585 MB$/);
    expect(logs.find(l => l.includes("Node 22"))).toMatch(/^● {2}Node 22 with npm\s+used\s+6 commands in 2 sessions\s+199 MB$/);
    expect(logs).toContain("  pulumi       2         2");

    errs.length = 0;
    expect(await cli(["recipe", "--out", out, "--state", box.state, "--tick", "everything"], io)).toBe(3);
    expect(errs.at(-1)).toBe('wsp recipe: --tick takes one of used, installed, default, and got "everything". Name one of those.');
    box.close();
  });

  it("recipe scan prints every section and writes nothing; an unknown subverb is one usage line", async () => {
    const box = fixtureMachine();
    // scan takes no --out, so its state file is what says where a recipe would have gone.
    const state = box.state;
    const out = join(box.dir, "recipe.json");
    const logs: string[] = [];
    const errs: string[] = [];
    const io: CliIO = { log: l => logs.push(l), error: l => errs.push(l), ask: noPrompt, askSecret: noPrompt };
    expect(await cli(["recipe", "scan", "--state", state], io)).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(logs[0]).toBe("Agents");
    expect(logs).toContain("Tools");
    expect(logs).toContain(`Also on ${HERE}`);
    // The scanner runs on the command line, and the fixture PATH has no package manager on it.
    expect(logs).toContain("  none");
    expect(logs.at(-1)).toContain("Nothing was written.");
    expect(errs[0]).toContain("Nothing leaves this computer");
    // The fixture's own rows, the same on any box.
    expect(logs.find(l => l.includes("Node 22"))).toMatch(/^● {2}Node 22 with npm\s+used\s+6 commands in 2 sessions\s+199 MB {2}on$/);
    expect(logs.find(l => l.includes("Java 21"))).toMatch(/^○ {2}Java 21\s+installed\s+installed here, never used\s+585 MB {2}off$/);
    expect(logs).toContain("  pulumi       2         2");

    logs.length = 0;
    expect(await cli(["recipe", "scan", "--state", state, "--json"], io)).toBe(0);
    expect(logs).toHaveLength(1);
    const scan = JSON.parse(logs[0]!) as {
      tick: string;
      agents: { id: string; on: boolean }[];
      tools: { id: string; on: boolean; recommended: { value: string; why: string } }[];
      commands: { name: string; calls: number; sessions: number }[];
      signIns: { id: string; recommended: { value: string } }[];
    };
    expect(scan.tick).toBe("used");
    for (const row of scan.tools) expect(row.recommended.why.length, row.id).toBeGreaterThan(0);
    expect(scan.tools.filter(r => r.on).map(r => r.id).sort()).toEqual(["build-essential", "curl", "fd", "git", "jq", "node", "pnpm", "python", "ripgrep", "rsync", "sqlite3", "uv", "wget", "xz", "zip"]);
    expect(scan.agents.filter(r => r.on).map(r => r.id)).toEqual(["claude"]);
    expect(scan.commands).toEqual([{ name: "pulumi", calls: 2, sessions: 2 }]);
    expect(scan.signIns.map(r => [r.id, r.recommended.value])).toEqual([["claude", "token"]]);
    expect(existsSync(out)).toBe(false);

    errs.length = 0;
    expect(await cli(["recipe", "sniff"], io)).toBe(3);
    expect(errs.at(-1)).toMatch(/^wsp recipe takes no positional arguments; wsp recipe scan is its one subcommand\. usage: wsp recipe /);

    // scan reads none of the write verb's flags, so one on its line is refused naming the verb it belongs to, with scan's own usage.
    logs.length = 0;
    errs.length = 0;
    expect(await cli(["recipe", "scan", "--state", state, "--tick", "installed", "--set", "go=on", "--out", out], io)).toBe(3);
    expect(errs[0]).toBe("--tick belongs to wsp recipe; wsp recipe scan does not read it. usage: wsp recipe scan [--project <folder>]");
    expect(logs).toEqual([]);
    errs.length = 0;
    expect(await cli(["recipe", "scan", "--add", "jj"], io)).toBe(3);
    expect(errs[0]).toContain("--add belongs to wsp recipe; wsp recipe scan does not read it");
    errs.length = 0;
    expect(await cli(["recipe", "scan", "--signin", "gh=copy"], io)).toBe(3);
    expect(errs[0]).toContain("--signin belongs to wsp recipe; wsp recipe scan does not read it");
    // A flag no verb reads keeps the parser's own refusal.
    errs.length = 0;
    expect(await cli(["recipe", "scan", "--nope"], io)).toBe(3);
    expect(errs[0]).toContain("Unknown option '--nope'");
    // What scan does take stays taken.
    expect(await cli(["recipe", "scan", "--project", box.project, "--json"], io)).toBe(0);
    box.close();
  });
});

describe("host serves the app", () => {
  let handle: HostHandle | undefined;
  let probeTarget: Server | undefined;
  const dirs: string[] = [];
  const webDir = (page?: string | null): string => {
    const d = fakeWebDir(page);
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    vi.useRealTimers();
    await handle?.close();
    handle = undefined;
    await new Promise<void>(r => (probeTarget ? probeTarget.close(() => r()) : r()));
    probeTarget = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("the page's one inline script is the boot object: runtime port, the token's digest and the release this host is, nothing else", async () => {
    const { rt } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir() });
    expect(handle.wsPort).toBeGreaterThan(0);

    const page = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<script type="module" crossorigin src="/assets/app.js">');
    expect(inlineScripts(html)).toEqual([
      `window.__WSP__ = {"wsPort":${handle.wsPort},"tokenHash":"${createHash("sha256").update(handle.authToken).digest("hex")}","wsPath":"/ws","paired":true,"version":"${VERSION}"};`,
    ]);
    expect(html).not.toContain("window.__WSP__ ||");
  });

  it("the boot object names the state file the host serves, so the page keeps what it remembers per state file", async () => {
    const { rt } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), statePath: "/Users/dev/.wsp/state.json" });
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/`)).text();
    expect(inlineScripts(html)).toEqual([`window.__WSP__ = {"wsPort":${handle.wsPort},"tokenHash":"${createHash("sha256").update(handle.authToken).digest("hex")}","wsPath":"/ws","paired":true,"version":"${VERSION}","statePath":"/Users/dev/.wsp/state.json"};`]);
  });

  it("the handle's createWorkspace forks the golden's head the way the app's own create does, and refuses without a golden", async () => {
    const { rt, backend } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), workspaceEnvs: g => claudeEnvs(g) });
    await handle.addProject("https://github.com/dev/first.git", "default");
    const first = await handle.createWorkspace("first");
    expect(first.name).toBe("first");
    expect(first.golden).toBe("snap_gold");
    const machine = backend.machines.find(m => m.id === first.machineId)!;
    expect(machine.spec.envs?.["CLAUDE_CONFIG_DIR"]).toBe("/root/.claude-cfg");
    expect(machine.spec.labels).toMatchObject({ wsp: "1", "wsp-host": "1" });
    const list = (await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`, handle.authToken)).body as { workspaces: { id: string }[] };
    expect(list.workspaces.map(w => w.id)).toEqual([first.id]);
    await handle.close();
    const bare = testRuntime(false);
    handle = await startHost({ runtime: bare.rt, port: 0, wsPort: 0, webDir: webDir() });
    await handle.addProject("https://github.com/dev/first.git", "default");
    await expect(handle.createWorkspace("first")).rejects.toThrow("no image yet; run wsp init first");
  });

  it("carries the terminal font the saved recipe ticks, read on every page load; an unticked or absent row carries none", async () => {
    const { rt } = testRuntime(false);
    const dir = mkdtempSync(join(tmpdir(), "wsp-host-recipe-"));
    dirs.push(dir);
    const recipePath = join(dir, "golden-recipe.json");
    const font = (bring: boolean) => ({ rung: "shell", id: "shell/terminal-font", label: "terminal font: Hack (Ghostty)", paths: [], bytes: 0, default: "bring", bring, font: "Hack" });
    writeFileSync(recipePath, JSON.stringify({ entries: [{ rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 10, default: "bring", bring: true }, font(true)] }));
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), recipePath });
    const boot = async () => inlineScripts(await (await fetch(`http://127.0.0.1:${handle!.port}/`)).text())[0];
    expect(await boot()).toBe(`window.__WSP__ = {"wsPort":${handle.wsPort},"tokenHash":"${createHash("sha256").update(handle.authToken).digest("hex")}","wsPath":"/ws","paired":true,"version":"${VERSION}","terminalFont":"Hack"};`);
    writeFileSync(recipePath, JSON.stringify({ entries: [font(false)] }));
    expect(await boot()).not.toContain("terminalFont");
    writeFileSync(recipePath, "not json");
    expect(await boot()).not.toContain("terminalFont");
    rmSync(recipePath);
    expect(await boot()).not.toContain("terminalFont");
  });

  it("a font family from a config file cannot end the page's inline script", async () => {
    const { rt } = testRuntime(false);
    const dir = mkdtempSync(join(tmpdir(), "wsp-host-recipe-"));
    dirs.push(dir);
    const recipePath = join(dir, "golden-recipe.json");
    const family = "Hack</script><script>alert(1)</script>&\u2028";
    writeFileSync(recipePath, JSON.stringify({ entries: [{ rung: "shell", id: "shell/terminal-font", label: "terminal font", paths: [], bytes: 0, default: "bring", bring: true, font: family }] }));
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), recipePath });
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/`)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("\u2028");
    const scripts = inlineScripts(html);
    expect(scripts).toHaveLength(1);
    const boot = JSON.parse(scripts[0]!.replace(/^window\.__WSP__ = /, "").replace(/;$/, "")) as { terminalFont?: string };
    expect(boot.terminalFont).toBe(family);
  });

  it("through the cli, the page never carries a key value", async () => {
    const SOLARI = "slr_live_fake_solari_key";
    const ANTHROPIC = "sk-ant-x-fake-anthropic-key";
    const home = mkdtempSync(join(tmpdir(), "wsp-home-"));
    dirs.push(home);
    vi.stubEnv("SOLARI_API_KEY", SOLARI);
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC);
    vi.stubEnv("HOME", home);
    vi.stubEnv("WSP_HOME", home);

    const { rt } = testRuntime();
    handle = await serve(quietIO(), { port: 0, wsPort: 0, statePath: join(home, "state.json"), webDir: webDir(), runtime: rt });
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/`)).text();
    expect(html).not.toContain("anthropic");
    expect(html).not.toContain(ANTHROPIC);
    expect(html).not.toContain(SOLARI);
    expect(html).not.toMatch(/sk-ant|slr_live/);
    const assets = await (await fetch(`http://127.0.0.1:${handle.port}/assets/app.js`)).text();
    expect(assets).not.toMatch(/sk-ant|slr_live/);
  });

  it("serves the bundle's assets and refuses paths outside the web dir", async () => {
    const { rt } = testRuntime();
    const dir = webDir();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: dir });
    const base = `http://127.0.0.1:${handle.port}`;

    const js = await fetch(`${base}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect(await js.text()).toBe("console.log('app')\n");

    writeFileSync(join(dir, "..", "wsp-outside-marker.txt"), "outside");
    dirs.push(join(dir, "..", "wsp-outside-marker.txt"));
    expect((await fetch(`${base}/..%2fwsp-outside-marker.txt`)).status).toBe(404);
    expect((await fetch(`${base}/assets/..%2f..%2fwsp-outside-marker.txt`)).status).toBe(404);
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/assets/`)).status).toBe(404);
  });

  it("answers a path it has no route for with the app, which reads the address it opened on", async () => {
    const { rt } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir() });
    const base = `http://127.0.0.1:${handle.port}`;

    const typed = await fetch(`${base}/new`);
    expect(typed.status).toBe(200);
    expect(typed.headers.get("content-type")).toContain("text/html");
    expect(inlineScripts(await typed.text())[0]).toContain('"wsPath":"/ws"');
    expect((await fetch(`${base}/w/ws_a1b2/t/thr_9`)).status).toBe(200);

    // A file of the bundle that is not there is still a miss: a script answering as a page breaks silently.
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    // A route that is not there is named to nobody who carries no token, and a miss to the host's own.
    expect((await fetch(`${base}/api/nothing`)).status).toBe(401);
    const api = await fetch(`${base}/api/nothing`, { headers: { authorization: `Bearer ${handle!.authToken}` } });
    expect(api.status).toBe(404);
    expect(((await api.json()) as { error: string }).error).toBe("no route: GET /api/nothing");
    expect((await fetch(`${base}/new`, { method: "POST" })).status).toBe(404);
  });

  it("refuses to start without a built page or without the boot line to replace", async () => {
    const { rt } = testRuntime();
    await expect(startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(null) })).rejects.toThrow(
      /web app not built/,
    );
    await expect(
      startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir("<!doctype html><html><body></body></html>") }),
    ).rejects.toThrow(/__WSP__/);
  });

  it("releases the runtime port when the app port is already held", async () => {
    const { rt } = testRuntime();
    probeTarget = createServer();
    await new Promise<void>(r => probeTarget!.listen(0, "127.0.0.1", r));
    const held = (probeTarget.address() as { port: number }).port;
    const wsPort = await freePort();

    await expect(startHost({ runtime: rt, port: held, wsPort, webDir: webDir() })).rejects.toThrow(/EADDRINUSE/);
    await new Promise<void>(r => probeTarget!.close(() => r()));
    probeTarget = undefined;

    expect(await refused(held)).toBe(true);
    expect(await refused(wsPort)).toBe(true);
  });

  it("lists workspaces as JSON", async () => {
    const { rt } = testRuntime();
    await createOn(rt, { golden: "snap_gold", name: "alpha" });
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir() });
    const { status, body } = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`, handle.authToken);
    expect(status).toBe(200);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({
      name: "alpha",
      phase: "running",
      machineState: "running",
      reach: { state: "unsupported" }, // stub backend cannot mint preview URLs
    });
  });

  it("creates a workspace from the golden head via POST", async () => {
    const { rt, backend } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir() });
    await handle.addProject("https://github.com/dev/beta.git", "default");
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${handle.authToken}` },
      body: JSON.stringify({ name: "beta" }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { workspace: { name: string; machineId: string } };
    expect(created.workspace.name).toBe("beta");
    expect(backend.machines[0]?.spec.fromSnapshot).toBe("snap_gold");
    expect(backend.machines[0]?.spec.labels).toMatchObject({ wsp: "1", "wsp-host": "1", "wsp-owner": expect.stringMatching(/^h_[0-9a-f]{8}$/) });

    const list = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`, handle.authToken);
    expect(list.body.workspaces).toHaveLength(1);
  });

  it("bakes BROWSER into a fork only when its golden head was sealed with the shim", async () => {
    for (const browserShim of [true, false]) {
      const backend = stubBackend();
      const store = memoryStore();
      const head = { ...GOLDEN.versions[0]!, ...(browserShim ? { browserShim } : {}) };
      void store.put("goldens", copyKey("default", "default"), { head: 1, versions: [head] });
      const rt = createRuntime({ backend, store, adapters: {} });
      const h = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), workspaceEnvs: g => claudeEnvs(g) });
      try {
        await h.addProject("https://github.com/dev/beta.git", "default");
        const res = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${h.authToken}` }, body: JSON.stringify({ name: "beta" }) });
        expect(res.status).toBe(200);
        const envs = backend.machines[0]?.spec.envs ?? {};
        expect(envs["CLAUDE_CONFIG_DIR"]).toBe("/root/.claude-cfg");
        expect(envs["BROWSER"]).toBe(browserShim ? "/usr/local/bin/wsp-open" : undefined);
      } finally {
        await h.close();
      }
    }
  });

  it("refuses workspace creation without an image", async () => {
    const { rt } = testRuntime(false);
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir() });
    await handle.addProject("https://github.com/dev/beta.git", "default");
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${handle.authToken}` },
      body: JSON.stringify({ name: "beta" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/image/i);
  });

  it("reports daemon reach by probing the minted preview URL", async () => {
    const { rt, backend } = testRuntime();
    await createOn(rt, { golden: "snap_gold", name: "alpha" });

    // Stands in for the Solari edge + guest daemon: plain HTTP against the
    // daemon's ws port answers 426 Upgrade Required (measured through the
    // real proxy in the ticket-6 spike).
    probeTarget = createServer((_req, res) => {
      res.writeHead(426).end();
    });
    await new Promise<void>(r => probeTarget!.listen(0, "127.0.0.1", r));
    const addr = probeTarget.address();
    const probePort = typeof addr === "object" && addr !== null ? addr.port : 0;
    const machine = backend.machines[0]!;
    let minted = 0;
    machine.previewUrl = async port => {
      minted++;
      return {
        url: `http://127.0.0.1:${probePort}/?pt_token=stub&port=${port}`,
        token: "stub",
        expiresAt: Date.now() + 60 * 60_000,
      };
    };

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir() });
    const first = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`, handle.authToken);
    expect(first.body.workspaces[0].reach).toMatchObject({ state: "reachable" });
    expect(first.body.workspaces[0].reach.url).toContain("pt_token=");

    // Fresh reach is reused across polls, not reminted per request.
    await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`, handle.authToken);
    expect(minted).toBe(1);

    // Napping workspaces are not probed; their reach state says so.
    const ws = (await rt.workspaces.list())[0]!;
    await rt.workspaces.nap(ws.id);
    const napped = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`, handle.authToken);
    expect(napped.body.workspaces[0].reach.state).toBe("napping");
    expect(napped.body.workspaces[0].machineState).toBe("paused");
  });
});

describe("host close flushes transcripts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An adapter the test drives by hand, so a turn boundary can land with no session.end behind it. */
  function manualAdapter(): { adapter: HarnessAdapterFactory; start: () => void; done: (text: string) => void } {
    const sessionId = "44444444-4444-4444-8444-444444444444";
    let onEvent: ((e: AdapterEvent) => void) | undefined;
    const finished = new Promise<TurnResult>(() => {});
    const adapter: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        onEvent = o.onEvent;
        return { localId: sessionId, claudeSessionId: sessionId, finished, interrupt: async () => {} };
      },
    });
    return {
      adapter,
      start: () => onEvent!({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }),
      done: text => onEvent!({ type: "turn.done", sessionId, result: { status: "completed", text } }),
    };
  }

  it("a turn boundary right before close() is in the store once close() resolves", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), GOLDEN);
    const m = manualAdapter();
    const rt = createRuntime({ backend, store, adapters: { claude: m.adapter } });
    const dir = fakeWebDir();
    dirs.push(dir);
    const handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: dir });

    const ws = await createOn(rt, { golden: "snap_gold", name: "alpha" });
    await rt.sessions.start(ws.id, { prompt: "go" });
    m.start();
    m.done("t0");
    await handle.close();

    const stored = (await store.get("transcripts", ws.id)) as { events: { type: string }[] } | undefined;
    expect(stored?.events.map(e => e.type)).toEqual(["session.start", "session.done"]);
  });
});

describe("host sweeps orphaned machines", () => {
  let handle: HostHandle | undefined;
  const dirs: string[] = [];
  const webDir = (): string => {
    const d = fakeWebDir();
    dirs.push(d);
    return d;
  };
  const TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;
  afterEach(async () => {
    vi.useRealTimers();
    await handle?.close();
    handle = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const BUILDER = { wsp: "1", "wsp-builder": "1" };
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

  it("at start reaps what its own state owns or nobody claims past the backstop, lists the rest once in plain words, and touches no poc machine", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const owned = await crashed.golden.prepare();
    backend.machines[0]!.paused = true; // paused from the console, so no longer first-life
    const orphanAt = ago(BUILDER_IDLE_MS + 60_000);
    const strayAt = ago(12 * 60_000);
    const foreign = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(53_000) } });
    const orphan = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: orphanAt } });
    const young = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: ago(2 * 60_000) } });
    const ageless = await backend.create({ kind: "sandbox", labels: BUILDER });
    const experiment = await backend.create({ kind: "sandbox", labels: { ...BUILDER, poc: "ttl-test" } });
    const foreignWs = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": "h_other", createdAt: ago(20 * 60_000) } });
    const strayWs = await backend.create({ kind: "sandbox", labels: { wsp: "1", createdAt: strayAt } });
    const garbage = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: "yesterday" } });
    const foreignSmoke = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-smoke": "1", "wsp-owner": "h_other", createdAt: ago(20 * 60_000) } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });

    const killed = (m: { id: string }): boolean => backend.machines.find(x => x.id === m.id)!.killed;
    expect([owned, foreign, orphan, young, ageless, experiment, foreignWs, strayWs, garbage, foreignSmoke].map(killed)).toEqual([true, false, true, false, false, false, false, true, false, false]);
    expect(lines).toEqual([
      `reap: stopping ${owned.id}: your earlier builder from this setup; a builder cannot be sealed after a restart`,
      `reap: stopping ${orphan.id} (wsp=1 wsp-builder=1 createdAt=${orphanAt}): builder with no owner, 6.0 h old`,
      `reap: stopping ${strayWs.id} (wsp=1 createdAt=${strayAt}): workspace with no owner, 12 min old`,
      `reap: left alone ${foreign.id}: builder from another wsp setup (owner h_other), 53 s old, $0.11/h (about $0.00 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${young.id}: builder with no owner, 2 min old, $0.11/h (about $0.00 so far); reaped once it is 6.0 h old`,
      `reap: left alone ${ageless.id}: builder with no owner, age unknown, $0.11/h; never reaped by this host`,
      `reap: left alone ${foreignWs.id}: workspace from another wsp setup (owner h_other), 20 min old, $0.11/h (about $0.04 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${garbage.id}: builder with no owner, age unknown, $0.11/h; never reaped by this host`,
      `reap: left alone ${foreignSmoke.id}: smoke fork from another wsp setup (owner h_other), 20 min old, $0.11/h (about $0.04 so far); kill it from the Solari console if it is yours and forgotten`,
    ]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("a workspace machine from this setup that no record claims is recorded at start under the name its fork stamped, named in the log, listed by the app and deletable", async () => {
    const { rt, backend, store } = testRuntime();
    const earlier = createRuntime({ backend, store, adapters: {} });
    const lost = await createOn(earlier, { golden: "snap_gold", name: "first" });
    await earlier.close();
    await store.delete("workspaces", lost.id);
    backend.machines[0]!.spec.labels!["createdAt"] = ago(2 * 60_000);
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });

    expect(backend.machines[0]!.killed).toBe(false);
    expect(lines).toEqual([`reap: recorded ${lost.machineId} as workspace first (${lost.id}): a machine from this setup that no record claimed; it bills until wsp delete first`]);
    const list = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`, handle.authToken);
    expect(list.body.workspaces).toMatchObject([{ id: lost.id, name: "first", machineId: lost.machineId, phase: "running" }]);
    await rt.workspaces.delete(lost.id);
    expect(backend.machines[0]!.killed).toBe(true);
  });

  it("a failed listing reaps nothing beyond the recorded builder, and logs both", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const owned = await crashed.golden.prepare();
    backend.machines[0]!.paused = true;
    await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: ago(BUILDER_IDLE_MS + 60_000) } });
    backend.list = async () => { throw new Error("list 502"); };
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });

    expect(backend.machines.map(m => m.killed)).toEqual([true, false]);
    expect(lines).toEqual([
      `reap: stopping ${owned.id}: your earlier builder from this setup; a builder cannot be sealed after a restart`,
      "reap: sweep failed: list 502",
    ]);
  });

  it("a listed machine that will not die is reported by id while everything before and after it is still handled", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const strayAt = ago(12 * 60_000);
    const stray = await backend.create({ kind: "sandbox", labels: { wsp: "1", createdAt: strayAt } });
    const lost = await crashed.golden.prepare();
    await store.delete("builders", lost.id);
    backend.machines[1]!.spec.labels!["createdAt"] = ago(5 * 60_000);
    backend.machines[1]!.kill = async () => { throw new Error("Bad Gateway"); };
    const orphanAt = ago(BUILDER_IDLE_MS + 60_000);
    const orphan = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: orphanAt } });
    const foreign = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(53_000) } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });

    expect(backend.machines.map(m => m.killed)).toEqual([true, false, true, false]);
    expect(lines).toEqual([
      `reap: stopping ${stray.id} (wsp=1 createdAt=${strayAt}): workspace with no owner, 12 min old`,
      `reap: stopping ${orphan.id} (wsp=1 wsp-builder=1 createdAt=${orphanAt}): builder with no owner, 6.0 h old`,
      `reap: left alone ${foreign.id}: builder from another wsp setup (owner h_other), 53 s old, $0.11/h (about $0.00 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: ${lost.id}: could not stop: Bad Gateway`,
    ]);
  });

  it("ages never read negative, never round up, and hours have one format", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    await crashed.golden.builders();
    const { id: owner } = (await store.get("owner", "id")) as { id: string };
    const ahead = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(-45_000) } });
    const almostMinute = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(59_600) } });
    const ownWs = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": owner, createdAt: ago(45_000) } });
    const hours = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(6 * 3_600_000) } });
    const freshOwn = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": owner, createdAt: ago(30_000) } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });

    expect(backend.machines.some(m => m.killed)).toBe(false);
    expect(lines).toEqual([
      `reap: left alone ${ahead.id}: builder from another wsp setup (owner h_other), 0 s old, $0.11/h (about $0.00 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${almostMinute.id}: builder from another wsp setup (owner h_other), 59 s old, $0.11/h (about $0.00 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${ownWs.id}: workspace from this setup that no record claims, 45 s old, $0.11/h (about $0.00 so far); recorded once it is 1 min old unless a record claims it first`,
      `reap: left alone ${hours.id}: builder from another wsp setup (owner h_other), 6.0 h old, $0.11/h (about $0.66 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${freshOwn.id}: builder from this setup that no record claims, 30 s old, $0.11/h (about $0.00 so far); reaped once it is 1 min old unless a record claims it first`,
    ]);
  });

  it("a recorded builder that will not die is reported and the sweep goes on", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const stuck = await crashed.golden.prepare();
    backend.machines[0]!.paused = true;
    const orphanAt = ago(BUILDER_IDLE_MS + 60_000);
    const orphan = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: orphanAt } });
    backend.machines[0]!.kill = async () => { throw new Error("502 exec failed"); };
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });

    expect(backend.machines.map(m => m.killed)).toEqual([false, true]);
    expect(lines).toEqual([
      `reap: stopping ${orphan.id} (wsp=1 wsp-builder=1 createdAt=${orphanAt}): builder with no owner, 6.0 h old`,
      `reap: ${stuck.id}: could not stop: 502 exec failed; stays recorded, retried next sweep`,
    ]);
  });

  it("a first-life builder from an earlier run is kept, claimed against the sweep, and named at start", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const kept = await crashed.golden.prepare();
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(backend.machines[0]!.killed).toBe(false);
    expect(lines).toEqual([
      `reap: left alone ${kept.id}: your earlier builder from this setup, still sealable, 0 s old, $0.11/h (about $0.00 so far); reuse it with wsp init, or it is stopped at six hours`,
    ]);
    expect(await store.get("builders", kept.id)).toMatchObject({ firstLife: true });
  });

  it("a builder kept after its save is named at start with its version and window; one past the window is stopped with reason grace", async () => {
    const { rt, backend, store } = testRuntime(false);
    const imp: GoldenImport = { recipeHash: "h1", recipe: { ticks: [], files: [] }, tools: [], agents: [] };
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", import: imp } });
    const b = await crashed.golden.prepare();
    await crashed.golden.seal(b.id);
    await crashed.close();
    expect(backend.machines.map(m => m.killed)).toEqual([false, true]);
    const lines: string[] = [];
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });
    expect(backend.machines[0]!.killed).toBe(false);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^reap: left alone ${b.id}: your builder saved as image v1, kept \\d+ s since the save and holding one of the account's machine slots, \\$0\\.11/h \\(about \\$0\\.00 so far\\); wsp init updates your image on it, or it is stopped ten minutes after the save$`));
    // The seal's snapshot is on the account now, so the storage line follows the sweep.
    expect(lines[1]).toBe("storage: 1 snapshot, 8.0 GB; inside the free 10 GB, nothing to pay from 2026-10-01");
    await handle.close();
    handle = undefined;

    const record = (await store.get("builders", b.id)) as { sealed: { at: string; version: number } };
    await store.put("builders", b.id, { ...record, sealed: { ...record.sealed, at: ago(11 * 60_000) } });
    const later: string[] = [];
    handle = await startHost({ runtime: createRuntime({ backend, store, adapters: {} }), port: 0, wsPort: 0, webDir: webDir(), log: l => later.push(l) });
    expect(later).toEqual([`reap: stopping ${b.id}: the builder kept after the save for one more change; its ten-minute window is over`, "storage: 1 snapshot, 8.0 GB; inside the free 10 GB, nothing to pay from 2026-10-01"]);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
  });

  it("a recorded builder wearing another setup's owner label is named as such at start and never touched", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const foreign = await crashed.golden.prepare();
    backend.machines[0]!.spec.labels!["wsp-owner"] = "h_other";
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(backend.machines[0]!.killed).toBe(false);
    expect(lines).toEqual([`reap: left alone ${foreign.id}: recorded builder wearing another setup's owner label (h_other); never touched by this host`]);
  });

  it("a recorded builder another live wsp process holds is named as in use at start and never touched", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const held = await crashed.golden.prepare();
    const record = (await store.get("builders", held.id)) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", held.id, { ...record, heldBy: { ...record.heldBy, pid: process.ppid } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(backend.machines[0]!.killed).toBe(false);
    expect(lines).toEqual([`reap: left alone ${held.id}: your earlier builder from this setup, in use by another wsp process (pid ${process.ppid}); never touched by this host`]);
  });

  it("a placeholder left mid-setup by a dead process is stopped at start with the line saying its setup never finished", async () => {
    const { rt, backend, store } = testRuntime();
    const gate = new Promise<void>(() => {});
    const dying = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", deployDaemon: () => gate } });
    void dying.golden.prepare();
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    const record = (await store.get("builders", "m1")) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: 999_999_999 } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(backend.machines[0]!.killed).toBe(true);
    expect(lines).toEqual(["reap: stopping m1: your earlier builder from this setup; its setup never finished"]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("an unfinished placeholder that will not die is reported and named as unfinished at start, never as reusable", async () => {
    const { rt, backend, store } = testRuntime();
    const gate = new Promise<void>(() => {});
    const dying = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", deployDaemon: () => gate } });
    void dying.golden.prepare();
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    const record = (await store.get("builders", "m1")) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: 999_999_999 } });
    backend.machines[0]!.kill = async () => { throw new Error("Bad Gateway"); };
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(lines).toEqual([
      "reap: m1: could not stop: Bad Gateway; stays recorded, retried next sweep",
      "reap: left alone m1: your earlier builder from this setup; its setup never finished; the next sweep stops it",
    ]);
    expect(lines.join("\n")).not.toContain("reuse it");
  });

  it("a kept builder whose age cannot be read is stopped at start, with the line saying the age is unknown", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const ageless = await crashed.golden.prepare();
    backend.machines[0]!.spec.labels!["createdAt"] = "yesterday";
    await store.put("builders", ageless.id, { ...((await store.get("builders", ageless.id)) as object), createdAt: "yesterday" });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });

    expect(backend.machines[0]!.killed).toBe(true);
    expect(lines).toEqual([`reap: stopping ${ageless.id}: your earlier builder from this setup, age unknown; a kept builder with no readable age is stopped at once`]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("a kept first-life builder past six hours by our createdAt label is stopped and forgotten at start, with the line saying so", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const old = await crashed.golden.prepare();
    backend.machines[0]!.spec.labels!["createdAt"] = ago(BUILDER_IDLE_MS + 60_000);
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });

    expect(backend.machines[0]!.killed).toBe(true);
    expect(lines).toEqual([`reap: stopping ${old.id}: your earlier builder from this setup, 6.0 h old; a kept builder is stopped at six hours`]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("a builder still there after the sweep's stop is said on the host's log under the sweep's own prefix", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const old = await crashed.golden.prepare();
    backend.machines[0]!.spec.labels!["createdAt"] = ago(BUILDER_IDLE_MS + 60_000);
    backend.machines[0]!.kill = async () => {};
    const rt = createRuntime({ backend, store, adapters: {}, killConfirm: { graceMs: 20, pollMs: 1 } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });

    await vi.waitFor(() => expect(lines.at(-1)).toMatch(new RegExp(`^reap: machine ${old.id} is still running after .*; asking again in 60 s$`)));
  });

  it("lists once per sweep", async () => {
    const { rt, backend } = testRuntime();
    const list = vi.spyOn(backend, "list");
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: () => {} });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("sweeps again every ten minutes until the host closes", async () => {
    vi.useFakeTimers({ toFake: [...TIMERS] });
    const { rt, backend } = testRuntime();
    const lines: string[] = [];
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });
    const reap = vi.spyOn(rt, "reap");

    await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: ago(BUILDER_IDLE_MS + 60_000) } });
    await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(60_000) } });
    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS - 1);
    expect(reap).not.toHaveBeenCalled();
    expect(backend.machines[0]?.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(reap).toHaveBeenCalledTimes(1);
    expect(backend.machines.map(m => m.killed)).toEqual([true, false]);
    // The foreign builder is listed at start only; later sweeps stay quiet about it.
    expect(lines).toEqual([expect.stringContaining("stopping m1")]);

    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS);
    expect(reap).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(1);

    await handle.close();
    handle = undefined;
    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS * 3);
    expect(reap).toHaveBeenCalledTimes(2);
  });

  it("starts no sweep while one is still in flight", async () => {
    vi.useFakeTimers({ toFake: [...TIMERS] });
    const { rt } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: () => {} });
    let finish!: (result: ReapResult) => void;
    const reap = vi.spyOn(rt, "reap").mockImplementationOnce(() => new Promise<ReapResult>(r => (finish = r)));

    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS * 3);
    expect(reap).toHaveBeenCalledTimes(1);

    finish({ reaped: [], spared: [] });
    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS);
    expect(reap).toHaveBeenCalledTimes(2);
  });
});

describe("a host that stops takes what it spawned with it", () => {
  let handle: HostHandle | undefined;
  const dirs: string[] = [];
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await closeStandInGuests();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("ends the daemons a stand-in provider's machines were given, which are children and outlive the process that spawned them", async () => {
    const web = fakeWebDir();
    const root = mkdtempSync(join(tmpdir(), "wsp-stand-in-host-"));
    dirs.push(web, root);
    const { rt } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: web });
    const guest = fakeGuestAt(root);
    await guest.reach("fk_c0ffee", DAEMON_PORT);
    const running = (): boolean => execFileSync("ps", ["-ax", "-o", "args="], { encoding: "utf8" }).includes(guest.tokenPath("fk_c0ffee"));
    expect(running()).toBe(true);
    // A lab stopped by its own verb kills the host it recorded the pid of; the daemon it spawned for each machine
    // a tester had opened stayed behind on the person's computer.
    await handle.close();
    handle = undefined;
    expect(running()).toBe(false);
  }, 20_000);
});

describe("host names snapshot storage at start", () => {
  let handle: HostHandle | undefined;
  const dirs: string[] = [];
  const webDir = (): string => {
    const d = fakeWebDir();
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("prints the count, the size the listing reports and the monthly cost above the free GB, sized from the listing and not from any machine, and says whose the rest are", async () => {
    const { rt, backend } = testRuntime();
    backend.snapshots.push({ id: "snap_gold", sizeBytes: 8_500_000_000 }, { id: "snap_old-golden", sizeBytes: 20_000_000_000 }, { id: "snap_other", sizeBytes: 7_700_000_000 });
    const lines: string[] = [];
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });
    expect(lines).toEqual(["storage: 3 snapshots, 36.2 GB; about $1.31/month above the free 10 GB from 2026-10-01. 1 kept here, 8.5 GB; 2 not this host's, 27.7 GB"]);
  });

  it("a snapshot this host made that nothing records is counted apart, which is the answer to why the account holds so many", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), GOLDEN);
    // Pinned: the mark on a name is read back against this host's own, so the identity has to be the test's.
    const rt = createRuntime({ backend, store, adapters: {}, hostId: "box:h1" });
    // Long past OWN_GRACE_MS whenever the suite runs: a marked row inside that window is still being recorded.
    backend.snapshots.push({ id: "snap_gold", sizeBytes: 8_500_000_000 }, { id: "snap_left", name: "wsp-h1-default-v9", sizeBytes: 20_000_000_000, createdAt: "2026-09-01T00:00:00.000Z" });
    const lines: string[] = [];
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });
    expect(lines).toEqual(["storage: 2 snapshots, 28.5 GB; about $0.93/month above the free 10 GB from 2026-10-01. 1 kept here, 8.5 GB; 1 this host's with nothing recording them, 20.0 GB"]);
  });

  it("says nothing with no snapshots on the account, and names a listing the provider refused", async () => {
    const quiet = testRuntime();
    const lines: string[] = [];
    handle = await startHost({ runtime: quiet.rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });
    expect(lines).toEqual([]);
    await handle.close();
    const { rt, backend } = testRuntime();
    backend.listSnapshots = async () => {
      throw new Error("502 Bad Gateway");
    };
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), log: l => lines.push(l) });
    expect(lines).toEqual(["storage: snapshot listing failed (502 Bad Gateway)"]);
  });
});

describe("the doctor's computer road on the host that holds the link", () => {
  let handle: HostHandle | undefined;
  const dirs: string[] = [];
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A host holding one computer that joined and has not dialled back, which is every computer this process holds
   * no link to: the road's first step reads that off the host's own places door. */
  async function serving(readers?: HostDoctorReaders): Promise<HostHandle> {
    const store = memoryStore();
    await store.put("places", "p_1", {
      id: "p_1",
      name: "spoo",
      publicKey: "k",
      joinedAt: "2026-09-18T09:00:00.000Z",
      lastSeenAt: "2026-09-18T09:00:00.000Z",
      report: { name: "spoo", platform: "linux", arch: "x64", os: "Ubuntu 24.04", shape: { cpu: 4, memMb: 4096 }, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" }, runsWorkspaces: true, engine: "none", daemonVersion: 54, agents: [], wsp: ["/usr/local/bin/wsp"] },
    });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: placeWiring(join(tmpdir(), `wsp-doctor-host-${Date.now()}`, "state.json")) });
    const dir = fakeWebDir();
    dirs.push(dir);
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: dir, ...(readers === undefined ? {} : { doctor: readers }) });
    return handle;
  }

  it("runs the road here and says each of its lines as an event, out for what it printed and err for what it failed with", async () => {
    const asked: string[] = [];
    const up = await serving({ vault: () => ({}), plan: async () => (asked.push("plan"), { recipeAt: "2026-09-18T09:00:00.000Z", path: probePath(GUEST_HOME), skipped: [], steps: [] }) });
    const c = await wsClient(up.wsPort, up.authToken);
    await c.request("events.subscribe");
    const reply = await c.request("places.doctor", { placeId: "p_1", doctorId: "d_1" });
    // The road ran here and failed where it had to: this process holds no link to that computer, and present is
    // the map of links the process that computer dialled is holding.
    expect(reply).toMatchObject({ ok: true, code: 1 });
    const lines = c.frames.filter(f => f["type"] === "doctor.line");
    expect(lines.every(f => f["doctorId"] === "d_1")).toBe(true);
    // What the road printed rode the out stream and what it failed with rode err, each as the road said it.
    expect(lines[0]).toMatchObject({ stream: "out", line: expect.stringContaining("proving spoo, a computer you added") });
    expect(lines.filter(f => f["stream"] === "err").map(f => String(f["line"]))).toEqual([expect.stringContaining("spoo is not answering")]);
    expect(lines.at(-1)).toMatchObject({ stream: "err" });
    c.close();
  });

  it("reads the recipe through the planner the places wiring already holds, and no second one", async () => {
    const plan = { recipeAt: "2026-09-18T09:00:00.000Z", path: probePath(GUEST_HOME), skipped: [], steps: [] };
    let asked = 0;
    const links = placeWiring(join(tmpdir(), `wsp-doctor-planner-${Date.now()}`, "state.json"));
    links.provision = { plan: async () => (asked++, plan), run: async () => [] };
    const readers = hostDoctorReaders(links, join(tmpdir(), "wsp-doctor-planner", "state.json"));
    expect(await readers.plan!()).toBe(plan);
    expect(asked).toBe(1);
    // A wiring that plans no recipe hands the road no reader at all, and the tools step says so in its own words.
    const bare = placeWiring(join(tmpdir(), `wsp-doctor-bare-${Date.now()}`, "state.json"));
    delete bare.provision;
    expect(hostDoctorReaders(bare, join(tmpdir(), "wsp-doctor-bare", "state.json")).plan).toBeUndefined();
  });
});
