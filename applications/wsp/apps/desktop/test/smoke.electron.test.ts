// SPDX-License-Identifier: AGPL-3.0-only
// Drives the packaged app (pnpm --filter @wsp/desktop build first). Gated on
// WSP_DESKTOP_SMOKE=1 so the unit suite stays free of a 200 MB binary.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { LAUNCHD_PATH, placeWiring, serve, shimPath, startHost, workspaceAsset, type CliIO, type HostHandle, type InstallReport } from "@wsp/host";
import { GET_THE_APP_WORD, HOST_WORDS, hereWord } from "@wsp/protocol";
import { createRuntime, memoryStore, tokenDigest, type Runtime } from "@wsp/runtime";
import { _electron as electron, type ElectronApplication, type Frame, type Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { WORKSPACE_WORDS } from "../../web/src/actions/format.js";
import { ADD_COMPUTER_WORDS, SETTINGS_WORDS } from "../../web/src/settings/format.js";
import { workspaceRowId } from "../../web/src/sidebar/rowGrammar.js";
import { FIRST_RUN_WORDS } from "../../web/src/sidebar/words.js";
import { VERSION } from "../../../packages/host/src/version.js";
import { builtExecutableHere } from "./packaged.js";
import { menuShapeOf, workspaceMenuShape } from "./workspace-menu.js";
import { notForThisPage } from "../src/origin.js";

const SMOKE = process.env["WSP_DESKTOP_SMOKE"] === "1";
const FAKE_SOLARI = "slr_live_fake_desktop_smoke";
/** What the loopback page carries of the host's token: its sha256, hex. The token itself is in no page. */
const DIGEST = /^[0-9a-f]{64}$/;

function builtApp(): string {
  const fromEnv = process.env["WSP_DESKTOP_APP"];
  if (fromEnv !== undefined) return fromEnv;
  const built = builtExecutableHere();
  if (built === undefined) throw new Error(`no packaged tree for ${process.platform}-${process.arch}`);
  return built;
}

const GOLDEN = {
  head: 1,
  versions: [
    { version: 1, snapshotId: "snap_gold", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } },
  ],
};

/** What wsp init leaves behind once a golden is sealed, in the store's on-disk shape. */
function seedGolden(home: string): void {
  writeFileSync(join(home, "state.json"), JSON.stringify({ goldens: { default: GOLDEN } }));
}

/** One local workspace record as wsp add and wsp new --local leave it, in the store's on-disk shape: a project of
 * this computer and the workspace working it in place, which is the whole of what a computer that never held a
 * provider key has. */
const LOCAL_WORKSPACE = {
  id: "ws_1",
  name: "seeded-mac",
  kind: "local",
  machineId: "local",
  phase: "running",
  golden: "",
  createdAt: "2026-09-01T00:00:00.000Z",
  project: "pr_1",
  spec: {},
  size: { cpu: 8, memMb: 16384 },
  firstLife: false,
  idleWindowMs: null,
};

function seedLocalWorkspace(home: string): void {
  const folder = join(home, "work", LOCAL_WORKSPACE.name);
  mkdirSync(folder, { recursive: true });
  const project = {
    id: LOCAL_WORKSPACE.project,
    name: LOCAL_WORKSPACE.name,
    computer: "here",
    source: { kind: "folder", path: folder },
    path: folder,
    defaultBranch: "main",
    createdAt: LOCAL_WORKSPACE.createdAt,
  };
  const workspace = { ...LOCAL_WORKSPACE, copy: { road: "clonefile", path: `${folder}-first`, source: folder, base: "", branch: "main", carried: "deps-and-config" }, portBase: 3100 };
  writeFileSync(join(home, "state.json"), JSON.stringify({ projects: { [project.id]: project }, workspaces: { [LOCAL_WORKSPACE.id]: workspace } }));
}

/** The project a fixture host's workspaces are copies of: a repo on the provider computer that host serves, which
 * is what wsp add records. A workspace is one project's copy, so a host holding none refuses to make one. */
async function seedProject(host: HostHandle): Promise<void> {
  await host.addProject("https://github.com/dev/first.git", "default");
}

/** A record of a host on the account under the launch's own wsp home, as wsp hosts leaves one: the list the shell
 * reads has a host in it the window is not on, which is what a page on a host somewhere else may not learn. */
function seedAccountHost(home: string, alias: string, url: string, token: string): void {
  mkdirSync(join(home, "hosts"), { recursive: true });
  writeFileSync(join(home, "hosts", `${alias}.json`), JSON.stringify({ url, deviceId: "d_seed", deviceToken: token, pairedAt: "2026-09-01T00:00:00.000Z", via: { kind: "account", hostId: `h${alias}` } }));
}

/** The lock and the token file a host serving this home left beside its state, which is what the window reads to
 * attach to it: a page on a port is no reason to, whoever is serving there. */
function seedServingLock(home: string, at: { port: number; token: string }): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: at.port, wsPort: 0, startedAt: new Date().toISOString() }));
  writeFileSync(join(home, "host-token"), `${at.token}\n`);
}

interface Launched {
  app: ElectronApplication;
  home: string;
}

const APP_URL = /^http:\/\/127\.0\.0\.1:\d+\/$/;
const ONBOARDING_URL = /onboarding\.html/;
/** Where the photographed states go, beside the render tests' own. */
const SHOTS = join(tmpdir(), "wsp-render");
const DEVTOOLS_URL = /^devtools:\/\//;
/** The words every notice about the app and its host being two releases shares. */
const VERSION_LINE = /this app is/;

/** The windows the app opened: a devtools window is Chromium's own, enumerated alongside them and able to come first. */
function appWindows(app: ElectronApplication): Page[] {
  return app.windows().filter(w => !DEVTOOLS_URL.test(w.url()));
}

/** The window showing a page, picked by its URL and never by the order the windows were made in. */
function windowAt(app: ElectronApplication, url: RegExp): Promise<Page> {
  return vi.waitFor(
    () => {
      const page = appWindows(app).find(w => url.test(w.url()));
      if (page === undefined) throw new Error(`no window at ${url}, saw ${JSON.stringify(app.windows().map(w => w.url()))}`);
      return page;
    },
    { timeout: 30_000, interval: 50 },
  );
}

const PAGE = `<!doctype html><html><head><title>wsp</title></head><body><script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script></body></html>`;

function fakeWebDir(): string {
  const webDir = mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-web-"));
  writeFileSync(join(webDir, "index.html"), PAGE);
  return webDir;
}

/** The environment a fixture host's runtime is given, said here rather than inherited from the shell that started
 * the run. The settings page is one of the surfaces behind labs, so a case that opens it turns labs on. */
const LABS_ON = { WSP_LABS: "1" };

function testRuntime(seedGolden = false, env: Record<string, string> = {}): Runtime {
  const store = memoryStore();
  if (seedGolden) void store.put("goldens", "default", GOLDEN);
  // The place wiring every host a person starts has: the key it proves is what a pairing code names and what the
  // computer taking that code holds it to, so a fixture host without one hands out a code nothing can spend.
  const statePath = join(mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-state-")), "state.json");
  return createRuntime({ backend: stubBackend(), store, adapters: {}, env, placeLinks: placeWiring(statePath) });
}

function fixtureHost(): Promise<HostHandle> {
  return startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
}

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

/** This launch's login shell: a script printing the fixture's own bin folder in front of the four folders launchd
 * gives an app, which is what a person's shell prints on their Mac. A launch handed launchd's set reads it, so this
 * is what decides which agents the app finds; a launch handed a fuller PATH never runs it. Without one the app
 * would read the shell of the Mac running the suite and find its agents instead of the fixture's. */
function loginShellIn(home: string): string {
  const bin = join(home, "bin");
  mkdirSync(bin);
  const shell = join(home, "login-shell");
  writeFileSync(shell, `#!/bin/sh\nprintf %s ${JSON.stringify(`${bin}:${LAUNCHD_PATH.join(":")}`)}\n`);
  chmodSync(shell, 0o755);
  return shell;
}

/** HOME is the temp dir too, so the app's ~/.wsp (and the pointer a host it
 * starts would write there) never touch this machine's. A value of undefined
 * removes that variable, the way a Finder launch has no WSP_HOME. */
async function launch(env: Record<string, string | undefined>, prepare: (home: string) => void = () => {}): Promise<Launched> {
  const home = mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-"));
  const cwd = join(home, "cwd");
  mkdirSync(cwd);
  prepare(home);
  const inherited = { ...process.env };
  delete inherited["SOLARI_API_KEY"];
  delete inherited["ANTHROPIC_API_KEY"];
  // The app reads WSP_DESKTOP_SMOKE to know it is driven: the bundle runs out of dist, and the move to Applications
  // it would otherwise offer has nobody to press a button.
  const merged = { ...inherited, HOME: home, WSP_HOME: home, WSP_PORT: "0", WSP_WS_PORT: "0", WSP_DESKTOP_SMOKE: "1", SHELL: loginShellIn(home), ...env };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
  // Playwright emulates a light prefers-color-scheme in the renderer unless told not to; the page's system theme has to
  // read the Mac's own appearance, the one the window's glass is drawn from, or the two sides split in the shot.
  const app = await electron.launch({ executablePath: builtApp(), cwd, env: clean, colorScheme: null });
  return { app, home };
}

/** A host of another release, as an app attached to one it did not start meets it. The real host serves the page and
 * runs the runtime; this stands in front of it on its own port and rewrites the one version in the boot object, so
 * the window is a real window on a real host that happens to have been built apart from it. Faking the app's half
 * instead would need a lever in the shipped shell, since a packaged bundle's own version cannot be moved. */
async function hostOfVersion(upstream: HostHandle, version: string): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(await collect(req));
      const from = await fetch(`http://127.0.0.1:${upstream.port}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        ...(body !== undefined ? { body } : {}),
      });
      const type = from.headers.get("content-type") ?? "application/octet-stream";
      const bytes = type.startsWith("text/html")
        ? Buffer.from((await from.text()).replace(`"version":"${VERSION}"`, `"version":"${version}"`))
        : Buffer.from(await from.arrayBuffer());
      res.writeHead(from.status, { "content-type": type, "content-length": bytes.length });
      res.end(bytes);
    })().catch(() => res.writeHead(502).end());
  });
  // The page dials the runtime on its own origin's /ws, so the stand-in carries the upgrade through to the real host
  // byte for byte; without it the window is a page with a toast and no runtime behind it.
  server.on("upgrade", (req, socket, head) => {
    const through = connect(upstream.port, "127.0.0.1", () => {
      const line = [`${req.method} ${req.url} HTTP/${req.httpVersion}`, ...req.rawHeaders.map((h, i) => (i % 2 === 0 ? `${h}: ${req.rawHeaders[i + 1]}` : undefined)).filter(h => h !== undefined), "", ""].join("\r\n");
      through.write(line);
      if (head.length > 0) through.write(head);
      socket.pipe(through).pipe(socket);
    });
    through.on("error", () => socket.destroy());
    socket.on("error", () => through.destroy());
  });
  return { port: await listenOn(server), server };
}

function collect(req: NodeJS.ReadableStream): Promise<Buffer[]> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(chunks));
  });
}

function listenOn(server: Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

/** A page served on a loopback port the way a process inside a workspace serves one: it asks for a service worker on
 * its own origin when the test says so, and answers on either spelling of loopback, so the frame on one holds a
 * frame on the other. */
function workerPage(): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end("self.addEventListener('fetch', () => {});");
      return;
    }
    const port = Number((req.headers.host ?? "").split(":")[1] ?? 0);
    const nested = path === "/nested" ? "" : `<iframe src="http://127.0.0.1:${port}/nested"></iframe>`;
    const asks = '<script>window.registerWorker = () => navigator.serviceWorker.register("/sw.js").then(() => "registered", e => "refused: " + e.name);</script>';
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${nested}${asks}</body></html>`);
  });
  return listenOn(server).then(port => ({ port, server }));
}

/** A frame the window holds, by the url it is on. */
function frameAt(win: Page, url: string): Promise<Frame> {
  return vi.waitFor(
    () => {
      const frame = win.frames().find(f => f.url() === url);
      if (frame === undefined) throw new Error(`no frame at ${url}, saw ${JSON.stringify(win.frames().map(f => f.url()))}`);
      return frame;
    },
    { timeout: 30_000, interval: 50 },
  );
}

/** What the page inside a frame made of the worker it asked for. A frame has its url from the moment its navigation
 * commits, before the script at the end of its body has run, so the ask waits for the page to have defined it. */
async function registerWorker(frame: Frame): Promise<string> {
  await frame.waitForFunction(() => "registerWorker" in window);
  return frame.evaluate(() => (window as unknown as { registerWorker(): Promise<string> }).registerWorker());
}

async function bootOf(page: Page): Promise<{ wsPort: number; tokenHash: string; token?: string }> {
  await page.waitForLoadState("domcontentloaded");
  return page.evaluate(() => (window as unknown as { __WSP__: { wsPort: number; tokenHash: string; token?: string } }).__WSP__);
}

interface DesktopWindow {
  wsp: { capturePreview(workspaceId: string): Promise<void>; workspacePreview(workspaceId: string): Promise<string | undefined>; setTheme(theme: string): void };
}

function readPreview(page: Page, workspaceId: string): Promise<string | undefined> {
  return page.evaluate(id => (window as unknown as DesktopWindow).wsp.workspacePreview(id), workspaceId);
}

/** A page in both themes: the shell's theme source is flipped, since the onboarding page follows the system's. */
async function photograph(app: ElectronApplication, page: Page, name: string): Promise<string[]> {
  mkdirSync(SHOTS, { recursive: true });
  const files: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    await app.evaluate(({ nativeTheme }, t) => {
      nativeTheme.themeSource = t;
    }, theme);
    await page.waitForFunction(t => window.matchMedia("(prefers-color-scheme: dark)").matches === (t === "dark") && document.documentElement.classList.contains("dark") === (t === "dark"), theme);
    // The page holds transitions off for one frame across the flip, as the app does; the shot waits past that frame and
    // any hover fade, and shows the screen at rest, without the focus ring of the button Enter would press.
    await page.waitForTimeout(400);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const file = join(SHOTS, `${name}-${theme}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = "system";
  });
  return files;
}

/** The app window's page as a file. The sidebar is the window's glass, which a page capture paints clear. */
async function photographPage(win: Page, file: string): Promise<string> {
  mkdirSync(SHOTS, { recursive: true });
  await win.screenshot({ path: file });
  return file;
}

/** The onboarding page's two-agent fixture: Claude Code and Codex by their config alone and a PATH with none, so what
 * the screen finds is what was put here. */
function twoAgents(home: string): void {
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), "");
}

async function refused(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
}

/** The window's frame as the shell set it and the header row as the page drew it, read on a launched app. */
async function macHeader(app: ElectronApplication, win: Page) {
  const frame = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    return { id: w.id, buttons: w.getWindowButtonPosition(), bounds: w.getBounds(), content: w.getContentBounds(), title: w.getTitle() };
  });
  const page = await win.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const region = (selector: string) => (style(selector) as unknown as { webkitAppRegion: string }).webkitAppRegion;
    const buttons = (selector: string) => Array.from(document.querySelector(selector)!.querySelectorAll("button")).map(b => (getComputedStyle(b) as unknown as { webkitAppRegion: string }).webkitAppRegion);
    return {
      pageToggles: document.querySelectorAll("header [data-slot=sidebar-trigger]").length,
      htmlClass: document.documentElement.className,
      container: style("[data-slot=sidebar-container]").backgroundColor,
      headerHeight: document.querySelector("[data-slot=sidebar-header]")!.getBoundingClientRect().height,
      sidebarHeader: region("[data-slot=sidebar-header]"),
      pageHeader: region("header [data-header-row]"),
      sidebarButtons: buttons("[data-slot=sidebar-header]"),
      pageButtons: buttons("header"),
      sidebarWidth: document.querySelector("[data-slot=sidebar-container]")!.getBoundingClientRect().width,
    };
  });
  return { frame, page };
}

/** A point of the window, in css pixels across and a fraction of the height down. */
type WindowPoint = { x: number; y: number };

/** For each theme, at each point: the alpha the window's capture holds there and the alpha the page's own
 * backgrounds stack to at the element under it, both out of 255. */
async function readPainted<K extends string>(app: ElectronApplication, win: Page, id: number, points: Record<K, WindowPoint>): Promise<Record<"light" | "dark", Record<K, { captured: number; declared: number }>>> {
  const out = {} as Record<"light" | "dark", Record<K, { captured: number; declared: number }>>;
  for (const theme of ["light", "dark"] as const) {
    // The app's page sets the shell's theme source back to system, so the side is picked where the page reads it.
    await win.emulateMedia({ colorScheme: theme });
    // The page holds transitions off for one frame across the flip; once it lets them back every colour is at rest,
    // and a frame after that the window has painted it.
    await win.waitForFunction(t => document.documentElement.classList.contains("dark") === (t === "dark") && !document.documentElement.classList.contains("no-transitions"), theme);
    await win.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const declared = await win.evaluate(pts => {
      const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")!;
      const alphaOf = (color: string): number => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[3]! / 255;
      };
      const stacked = (p: { x: number; y: number }): number => {
        let clear = 1;
        for (let el: Element | null = document.elementFromPoint(p.x, p.y * window.innerHeight); el !== null; el = el.parentElement) clear *= 1 - alphaOf(getComputedStyle(el).backgroundColor);
        return Math.round((1 - clear) * 255);
      };
      return Object.fromEntries(Object.entries(pts).map(([k, p]) => [k, stacked(p as { x: number; y: number })]));
    }, points as Record<string, WindowPoint>);
    const captured = await app.evaluate(async ({ BrowserWindow }, args) => {
      const image = await BrowserWindow.fromId(args.id)!.webContents.capturePage();
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      const scale = width / args.cssWidth;
      return Object.fromEntries(Object.entries(args.points).map(([k, p]) => [k, bitmap[(Math.round(p.y * height) * width + Math.round(p.x * scale)) * 4 + 3]!]));
    }, { id, cssWidth: await win.evaluate(() => window.innerWidth), points: points as Record<string, WindowPoint> });
    out[theme] = Object.fromEntries(Object.keys(points).map(k => [k, { captured: captured[k]!, declared: declared[k]! }])) as Record<K, { captured: number; declared: number }>;
  }
  await win.emulateMedia({ colorScheme: null });
  return out;
}

interface MenuRow {
  label: string;
  checked: boolean;
  enabled: boolean;
}

/** The rows of the menu bar's Hosts menu as the shell built them. */
function hostsMenuRows(app: ElectronApplication): Promise<MenuRow[]> {
  return app.evaluate(({ Menu }, word) => {
    const hosts = Menu.getApplicationMenu()?.items.find(item => item.label === word)?.submenu;
    if (hosts === undefined) throw new Error(`no ${word} menu`);
    return hosts.items.filter(item => item.type !== "separator").map(item => ({ label: item.label, checked: item.checked, enabled: item.enabled }));
  }, HOST_WORDS.hosts);
}

/** Clicks one row of the Hosts menu, as a person would from the menu bar. */
function hostsMenu(app: ElectronApplication, label: string): Promise<void> {
  return app.evaluate(({ Menu }, [word, row]) => {
    const hosts = Menu.getApplicationMenu()?.items.find(item => item.label === word)?.submenu;
    const item = hosts?.items.find(i => i.label === row);
    if (item === undefined) throw new Error(`no row ${row} in the ${word} menu`);
    item.click();
  }, [HOST_WORDS.hosts, label] as const);
}

// Each launch boots Electron and a host; the default 5s test timeout is too tight.
describe.runIf(SMOKE)("desktop app (built)", { timeout: 60_000 }, () => {
  let launched: Launched | undefined;
  let existing: HostHandle | undefined;
  let standIn: Server | undefined;
  afterEach(async () => {
    await launched?.app.close().catch(() => {});
    if (launched) rmSync(launched.home, { recursive: true, force: true });
    launched = undefined;
    await existing?.close();
    existing = undefined;
    if (standIn !== undefined) await new Promise<void>(resolve => standIn!.close(() => resolve()));
    standIn = undefined;
    vi.unstubAllEnvs();
  });

  it("is built", () => {
    expect(existsSync(builtApp())).toBe(true);
  });

  it("opens one window on the host it started, titled wsp, with the token's digest in the boot object and never the token, and stops the host on quit", async () => {
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
    const win = await windowAt(launched.app, APP_URL);
    const boot = await bootOf(win);
    const url = win.url();
    expect(url).toMatch(APP_URL);
    expect(await win.title()).toBe("wsp");
    expect(boot.tokenHash).toMatch(DIGEST);
    expect(boot.token).toBeUndefined();
    expect(boot.wsPort).toBeGreaterThan(0);
    expect(appWindows(launched.app)).toHaveLength(1);
    await launched.app.close();
    expect(await refused(url)).toBe(true);
  });

  it("the window's theme source follows the page, which draws the side this computer is set to", async () => {
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
    const win = await windowAt(launched.app, APP_URL);
    await bootOf(win);
    const source = () => launched!.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    // The one value the page ever says, whatever a pin before it was: no screen picks a side, so the frame and the
    // page cannot draw two.
    await vi.waitFor(async () => expect(await source()).toBe("system"));
    await launched.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await win.reload();
    await vi.waitFor(async () => expect(await source()).toBe("system"));
  });

  it("photographs its own page for a workspace and hands the picture back to the page", async () => {
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
    const win = await windowAt(launched.app, APP_URL);
    await bootOf(win);
    expect(await readPreview(win, "ws_a")).toBeUndefined();
    await win.evaluate(id => (window as unknown as DesktopWindow).wsp.capturePreview(id), "ws_a");
    expect(await readPreview(win, "ws_a")).toMatch(/^data:image\/png;base64,\w/);
    expect(await readPreview(win, "ws_b")).toBeUndefined();
  });

  it("puts the picture of the workspace the person left on that workspace's switcher card", async () => {
    // A host over the stub backend with two workspaces, serving the built web app, so the switcher has cards to
    // draw. The app attaches to it rather than starting its own, so nothing here needs a provider key or a golden
    // on disk, and the workspaces are made through the runtime's own road instead of written into the store.
    existing = await startHost({ runtime: testRuntime(true), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    await seedProject(existing);
    const api = await existing.createWorkspace("api");
    const web = await existing.createWorkspace("web");
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: existing!.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    await win.waitForSelector(`[data-row-id='ws:${api.id}']`);
    await win.waitForSelector(`[data-row-id='ws:${web.id}']`);

    // A tap: the chord's step and its release, which is what asks for a picture of the workspace being left.
    await win.keyboard.down("Control");
    await win.keyboard.press("Tab");
    await win.keyboard.up("Control");
    await win.waitForSelector("[data-workspace-switcher]", { state: "detached" });
    // The capture is an ipc round trip the tap only started, and the overlay reads the pictures once, when it
    // opens. Which workspace the tap left is the sidebar's order to decide, so the picture names it.
    const left = await vi.waitFor(
      async () => {
        for (const id of [api.id, web.id]) if ((await readPreview(win, id)) !== undefined) return id;
        throw new Error("no picture yet");
      },
      { timeout: 30_000, interval: 100 },
    );

    await win.keyboard.down("Control");
    await win.keyboard.press("Tab");
    await win.waitForSelector("[data-workspace-switcher]");
    const shot = win.locator(`[data-workspace-card='${left}'] [data-card-preview] img`);
    await shot.waitFor();
    expect(await shot.getAttribute("src")).toMatch(/^data:image\/png;base64,\w/);
    // The picture decodes off the main thread; its size is a fact only once it has.
    expect(await shot.evaluate((img: HTMLImageElement) => img.decode().then(() => img.naturalWidth))).toBeGreaterThan(0);
    await win.keyboard.up("Control");
  });

  it("first launch with no key: the welcome, then the agents found here ticked, Open wsp gives them the tools and opens the app on the first run, whose Add a project holds the door to another computer, and the shim runs", async () => {
    // Labs on, since the settings page the door to another computer opens is a labs surface. The PATH is launchd's
    // own, what a Finder or Dock launch is handed, so this run is the one a tester's Mac makes.
    launched = await launch({ PATH: LAUNCHD_PATH.join(":"), WSP_LABS: "1" }, twoAgents);
    const { app, home } = launched;
    const shim = shimPath(home);
    // The command is installed before any window, so an agent configured on the next screen has something to run.
    expect(existsSync(shim)).toBe(true);
    const page = await windowAt(app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    expect(await page.title()).toBe("wsp");
    // Nothing scrolls, on any screen.
    const fits = (): Promise<boolean> => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.body.scrollHeight <= window.innerHeight);
    // The page draws with the app's stylesheet: its tokens resolve here, and the dark class is the app's own switch.
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return { background: style.getPropertyValue("--background").trim(), mono: style.getPropertyValue("--font-mono").trim(), primary: style.getPropertyValue("--primary").trim() };
    });
    expect(tokens.background).not.toBe("");
    expect(tokens.primary).not.toBe("");
    expect(tokens.mono).toContain("ui-monospace");
    // The app's stylesheet clears html and body under the desktop class for the glass; this page paints its own ground.
    expect(await page.$eval(".ground", el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    // The welcome is the mark and one button, and nothing behind it: a Mac is never a place, so no join screen.
    expect(await page.$$eval("#welcome h1, #welcome p", els => els.length)).toBe(0);
    expect(await page.$$eval("#welcome button", els => els.map(el => el.id))).toEqual(["start"]);
    expect(await page.textContent("#start")).toContain("Get started");
    expect(await page.$("#computer")).toBeNull();
    expect(await page.$$eval(".setup", els => els.map(el => `${el.id}:${(el as HTMLElement).hidden}`))).toEqual(["welcome:false", "agents:true"]);
    expect(await fits()).toBe(true);
    await page.waitForFunction(() => document.getAnimations().length === 0);
    expect(await page.$$eval(":focus-visible", els => els.length)).toBe(0);
    console.info(`welcome: ${(await photograph(app, page, "onboarding-welcome")).join(" ")}`);
    // The scan is the recipe scan's own: one row per catalog agent, the two on this fixture's PATH ticked and the
    // rest held, and the line under the card says where agents installed later get the tools.
    const here = CATALOG_AGENTS.filter(a => a.id === "claude" || a.id === "codex");
    await page.waitForFunction(() => (document.querySelector("#line")?.textContent ?? "") !== "", undefined, { timeout: 30_000 });
    await page.click("#start");
    expect(await page.$$eval(".setup", els => els.map(el => `${el.id}:${(el as HTMLElement).hidden}`))).toEqual(["welcome:true", "agents:false"]);
    expect(await page.$$eval("#rows .row", els => els.length)).toBe(CATALOG_AGENTS.length);
    expect(await page.$$eval("#rows input:checked", els => els.map(el => (el as HTMLInputElement).value))).toEqual(here.map(a => a.id));
    expect(await page.$$eval("#rows input:disabled", els => els.length)).toBe(CATALOG_AGENTS.length - here.length);
    expect(await page.textContent("#line")).toBe("Agents you install later get the tools from Settings.");
    expect(await page.textContent("#open")).toContain("Open wsp");
    // The column is the sheet screen's, and nothing scrolls.
    expect(await page.$eval("#agents", el => el.getBoundingClientRect().width)).toBe(560);
    expect(await fits()).toBe(true);
    await page.waitForFunction(() => document.getAnimations().length === 0);
    expect(await page.$$eval(":focus-visible", els => els.length)).toBe(0);
    console.info(`agents: ${(await photograph(app, page, "onboarding-agents")).join(" ")}`);

    // Enter is the keycap: the tools into both agents found here, then the app. An event asked for after it has
    // fired never arrives, and the finish closes this window while the key is in flight.
    const closed = page.waitForEvent("close");
    await page.keyboard.press("Enter");
    const win = await windowAt(app, APP_URL);
    const boot = await bootOf(win);
    expect(boot.tokenHash).toMatch(DIGEST);
    await closed;
    await vi.waitFor(() => expect(appWindows(app)).toHaveLength(1), { timeout: 10_000, interval: 50 });
    // A workspace is one project's copy, so this press records neither: the app opens on the first run, whose one
    // button opens Add a project. The screen standing is what says the host read the state back, so the file holds
    // everything the launch wrote by then.
    await win.waitForSelector("[data-k=first-run]");
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as { workspaces?: Record<string, unknown>; projects?: Record<string, unknown> };
    expect(Object.keys(state.workspaces ?? {})).toEqual([]);
    expect(Object.keys(state.projects ?? {})).toEqual([]);
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(await win.locator("[data-workspace-name]").count()).toBe(0);
    // The tick was live, so both agents found here carry the wsp server and its skill, with the shim as the command.
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({ mcpServers: { wsp: { command: shim, args: ["mcp", "--state", join(home, "state.json")] } } });
    expect(existsSync(join(home, ".claude", "skills", "wsp", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.wsp]");

    // The first run's one button opens Add a project, whose computers column holds the door for the person who came
    // for a box.
    const add = win.locator("[data-k=first-run] [data-k=add-project]");
    await add.waitFor();
    expect(await add.textContent()).toBe(FIRST_RUN_WORDS.add);
    const shots: string[] = [];
    // The shots show the shell at rest: no focus ring from the click that just happened, and the theme painted. One
    // side only: the page says system and nothing else, so the app draws the side this computer is set to and a shot
    // of the other one is this Mac's appearance to change, not this run's.
    const rest = async (): Promise<void> => {
      await win.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        return new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      });
    };
    await rest();
    shots.push(await photographPage(win, join(SHOTS, "app-first-run.png")));
    await add.click();
    const door = win.locator("[role=dialog] [data-k=add-computer]");
    await door.click();
    // The door closes the dialog and opens Settings on Computers, whose Add a computer stands on its first road.
    await win.getByRole("dialog").waitFor({ state: "detached" });
    const adding = win.locator("[data-settings-page] [data-k=add-computer]");
    await adding.waitFor();
    await adding.locator("[data-k=road-ssh]").waitFor();
    expect(await win.locator("[data-settings-page]").textContent()).toContain(ADD_COMPUTER_WORDS.title);
    expect(await adding.textContent()).not.toMatch(/wsp init|terminal/i);
    await rest();
    shots.push(await photographPage(win, join(SHOTS, "app-add-computer.png")));
    await win.keyboard.press("Escape");
    await win.locator("[data-settings-page]").waitFor({ state: "detached" });
    await win.locator("[data-k=first-run]").waitFor();
    console.info(`the app on first launch: ${shots.join(" ")}`);

    // The shim is the wsp command: it runs the bundled host as node, and an install through it writes the shim too.
    const env = { ...process.env, HOME: home, WSP_HOME: home };
    const version = spawnSync(shim, ["--version"], { encoding: "utf8", env });
    expect(version.stderr).toBe("");
    expect(version.stdout).toBe(`wsp ${VERSION}\n`);
    const installed = spawnSync(shim, ["mcp", "install", "--agent", "codex", "--json", "--state", join(home, "state.json")], { encoding: "utf8", env, cwd: join(home, "cwd") });
    expect(installed.status).toBe(0);
    const report = JSON.parse(installed.stdout) as InstallReport;
    expect(report.server).toEqual({ command: shim, args: ["mcp", "--state", join(home, "state.json")] });
    expect(report.installed.map(p => p.id)).toEqual(["codex"]);
  });

  it("with every tick taken off Open wsp is held, says why, and leaves every agent's config alone", async () => {
    launched = await launch({ PATH: "/usr/bin:/bin" }, twoAgents);
    const { app, home } = launched;
    const page = await windowAt(app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => (document.querySelector("#line")?.textContent ?? "") !== "", undefined, { timeout: 30_000 });
    await page.click("#start");
    for (const id of ["claude", "codex"]) await page.click(`#rows input[value=${id}]`);
    expect(await page.$$eval("#rows input:checked", els => els.length)).toBe(0);
    expect(await page.isDisabled("#open")).toBe(true);
    expect(await page.textContent("#line")).toBe("Tick at least one agent. wsp works through the agents you give it.");
    expect(appWindows(app).filter(w => APP_URL.test(w.url()))).toHaveLength(0);
    // The fixture's own files are what the scan found the two agents by; neither gained the wsp server.
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe("");
    expect(existsSync(join(home, ".claude", "skills", "wsp"))).toBe(false);
    const stateFile = join(home, "state.json");
    const state = (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {}) as { workspaces?: Record<string, unknown> };
    expect(Object.keys(state.workspaces ?? {})).toEqual([]);
  });

  it("with no provider key the welcome opens while nothing is recorded, and a recorded local workspace opens the app on it instead", async () => {
    // The two launches differ by the seed alone, so what decides the window is the record and not the missing key.
    launched = await launch({});
    const welcome = await windowAt(launched.app, ONBOARDING_URL);
    await welcome.waitForLoadState("domcontentloaded");
    expect(await welcome.textContent("#start")).toContain("Get started");
    expect(appWindows(launched.app).filter(w => APP_URL.test(w.url()))).toHaveLength(0);
    await launched.app.close();
    rmSync(launched.home, { recursive: true, force: true });

    launched = await launch({}, seedLocalWorkspace);
    const win = await windowAt(launched.app, APP_URL);
    const boot = await bootOf(win);
    expect(boot.tokenHash).toMatch(DIGEST);
    const row = win.locator(`[data-row-id='${workspaceRowId(LOCAL_WORKSPACE.id)}']`);
    await row.waitFor();
    expect(await row.locator("[data-workspace-name]").textContent()).toBe(LOCAL_WORKSPACE.name);
    // Line two is the branch the seeded copy stands on.
    expect(await row.locator("[data-workspace-meta]").textContent()).toBe("main");
    // The seeded record is the whole list: nothing was recorded on the way in.
    expect(await win.locator("[data-workspace-name]").count()).toBe(1);
    expect(appWindows(launched.app).filter(w => ONBOARDING_URL.test(w.url()))).toHaveLength(0);
    expect(existsSync(join(launched.home, ".env"))).toBe(false);
  });

  it("no frame in the window registers a service worker on a loopback origin, and a host page loads into a session holding none", async () => {
    const served = await workerPage();
    standIn = served.server;
    launched = await launch({}, seedLocalWorkspace);
    const win = await windowAt(launched.app, APP_URL);
    const row = `[data-row-id='${workspaceRowId(LOCAL_WORKSPACE.id)}']`;
    await win.click(row);
    // The preview pane on this computer's own workspace frames this computer's port, which is the pane a person types one into.
    await win.keyboard.press("Meta+k");
    await win.locator("[data-command-palette]").getByText(WORKSPACE_WORDS.openBrowser, { exact: true }).click();
    await win.fill("[data-preview-url-input]", `localhost:${served.port}`);
    await win.press("[data-preview-url-input]", "Enter");
    const framed = await frameAt(win, `http://localhost:${served.port}/`);
    const nested = await frameAt(win, `http://127.0.0.1:${served.port}/nested`);
    // The road the finding names is the 127.0.0.1 frame, which is the nested one; the localhost frame is the same
    // rule read on the other spelling, and neither may plant a worker on a port the kernel hands out again.
    expect(await registerWorker(framed)).toMatch(/^refused/);
    expect(await registerWorker(nested)).toMatch(/^refused/);
    // The rule is the worker's alone: the framed page keeps its own storage, which a sandbox attribute would have taken.
    expect(await framed.evaluate(() => {
      localStorage.setItem("wsp-smoke", "kept");
      return localStorage.getItem("wsp-smoke");
    })).toBe("kept");
    // And the move a person makes through the Hosts menu loads the host page with the session swept first. The window
    // is on that url already, so the reload is its own navigation of the main frame, waited for as one.
    const reloaded = win.waitForEvent("framenavigated", { predicate: frame => frame === win.mainFrame() });
    await hostsMenu(launched.app, hereWord(process.platform === "darwin"));
    await reloaded;
    expect(win.url()).toMatch(APP_URL);
    expect(await launched.app.evaluate(({ session }) => Object.keys(session.defaultSession.serviceWorkers.getAllRunning()).length)).toBe(0);
  });

  it("does not attach to a host on the port that no lock beside the resolved home names: the first launch runs", async () => {
    // Any login on this computer can bind a port and answer with the boot line; the lock beside the state file of
    // the home this launch resolved is what says a host of the owner's is serving, and there is none here.
    existing = await fixtureHost();
    launched = await launch({ WSP_HOME: undefined, WSP_PORT: String(existing.port) });
    const page = await windowAt(launched.app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    expect(await page.textContent("#start")).toContain("Get started");
    expect(appWindows(launched.app).filter(w => APP_URL.test(w.url()))).toHaveLength(0);
    await launched.app.close();
    // The host on that port was never touched: it is still serving, with the page it was serving before.
    expect(await refused(`http://127.0.0.1:${existing.port}/`)).toBe(false);
  });

  it("attached to a host of a later release, says so in a notice with the releases page behind its button", async () => {
    existing = await startHost({ runtime: testRuntime(true, LABS_ON), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    const stand = await hostOfVersion(existing, "9.9.9");
    standIn = stand.server;
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: stand.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    const notice = win.locator("[data-notice]", { hasText: VERSION_LINE });
    await notice.waitFor();
    expect(await notice.textContent()).toContain(`this app is ${VERSION}, the host is 9.9.9: get the new app`);
    expect(await notice.locator("[data-notice-action]").textContent()).toBe(GET_THE_APP_WORD);
    // The settings page names both halves as well, on About, so the notice is never the only place the numbers are.
    // The palette's Settings row is the road through it.
    await win.keyboard.press("Meta+k");
    await win.locator("[data-command-palette]").getByText(SETTINGS_WORDS.title, { exact: true }).click();
    await win.waitForSelector("[data-settings-page]");
    await win.locator("[data-k=settings-about]").click();
    await win.waitForSelector("[data-settings-at=about]");
    expect(await win.locator("[data-k=app-version] [data-settings-word]").textContent()).toBe(VERSION);
    expect(await win.locator("[data-k=host-version] [data-settings-word]").textContent()).toBe("9.9.9");
  });

  it("attached to a host of an earlier release, asks for the app's own host and offers nothing to download", async () => {
    existing = await startHost({ runtime: testRuntime(true), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    const stand = await hostOfVersion(existing, "0.0.1");
    standIn = stand.server;
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: stand.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    const notice = win.locator("[data-notice]", { hasText: VERSION_LINE });
    await notice.waitFor();
    expect(await notice.textContent()).toContain(`this app is ${VERSION}, the host is 0.0.1: run the app's own host`);
    expect(await notice.locator("[data-notice-action]").count()).toBe(0);
  });

  it("attached to a host of its own release, says nothing at all", async () => {
    existing = await startHost({ runtime: testRuntime(true), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: existing!.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    await win.waitForSelector("[data-slot=sidebar-container]");
    // The page asks the shell for its hosts on load and says the versions once that answers; a second ask answers
    // after the first, and a frame later anything it said is drawn.
    await win.evaluate(async () => {
      await (window as unknown as { wsp: { hosts(): Promise<unknown> } }).wsp.hosts();
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    });
    expect(await win.locator("[data-notice]", { hasText: VERSION_LINE }).count()).toBe(0);
  });

  it("attaches to a host serving a custom home when that home is named on its launch, with no port hint", async () => {
    const user = mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-user-"));
    const custom = join(user, "custom-home");
    const quiet: CliIO = { log: () => {}, error: () => {}, ask: () => Promise.reject(new Error("prompt")), askSecret: () => Promise.reject(new Error("prompt")) };
    vi.stubEnv("SOLARI_API_KEY", FAKE_SOLARI);
    vi.stubEnv("HOME", user);
    vi.stubEnv("WSP_HOME", custom);
    existing = await serve(quiet, { port: 0, wsPort: 0, statePath: join(custom, "state.json"), webDir: fakeWebDir(), runtime: testRuntime() });
    vi.unstubAllEnvs();
    // The host wrote every file of its own under the home it serves and nothing under the person's own.
    expect(existsSync(join(custom, "host.lock"))).toBe(true);
    expect(existsSync(join(user, ".wsp"))).toBe(false);

    launched = await launch({ HOME: user, WSP_HOME: custom });
    const win = await windowAt(launched.app, APP_URL);
    const boot = await bootOf(win);
    expect(win.url()).toBe(`http://127.0.0.1:${existing.port}/`);
    expect(boot.tokenHash).toBe(tokenDigest(existing.authToken));
    await launched.app.close();
    expect(await refused(`http://127.0.0.1:${existing.port}/`)).toBe(false);
    rmSync(user, { recursive: true, force: true });
  });

  it("a right-click on a workspace row builds the native menu from the workspace registry through the bridge", async () => {
    // A host over the stub backend with one workspace, serving the built web app, so the sidebar has a row to right-click.
    existing = await startHost({ runtime: testRuntime(true), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    await seedProject(existing);
    const first = await existing.createWorkspace("first");
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: existing!.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    const row = `[data-row-id='ws:${first.id}']`;
    await win.waitForSelector(row);
    // A native menu blocks until it is dismissed, so the main process keeps the template it would have shown and closes on nothing.
    await launched.app.evaluate(({ Menu }) => {
      type Kept = { type?: string; label?: string; enabled?: boolean; toolTip?: string; accelerator?: string | null };
      const kept: Kept[][] = [];
      (globalThis as { __menus?: Kept[][] }).__menus = kept;
      const build = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = template => {
        kept.push(template.map(({ type, label, enabled, toolTip, accelerator }) => ({ type, label, enabled, toolTip, accelerator })));
        const menu = build(template);
        menu.popup = options => options?.callback?.();
        return menu;
      };
    });
    await win.click(row, { button: "right" });
    await win.waitForFunction(() => true);
    const menus = await launched.app.evaluate(() => (globalThis as { __menus?: { type?: string; label?: string; enabled?: boolean; toolTip?: string; accelerator?: string | null }[][] }).__menus ?? []);
    expect(menus).toHaveLength(1);
    const rows = menus[0]!;
    // The rows the registry says, in its order and parted where its groups part, so an action added to the registry
    // never brings this case with it. Labels and separator places are read as one list: a separator that moved is a
    // failure here, not only a wrong count.
    expect(menuShapeOf(rows)).toEqual(workspaceMenuShape(first));
    expect(rows.find(r => r.label === WORKSPACE_WORDS.rename)).toMatchObject({ enabled: true });
    expect(rows.find(r => r.label === WORKSPACE_WORDS.openTerminal)).toMatchObject({ enabled: true, accelerator: "CommandOrControl+J" });
    // The shell's page got the native menu, not the in-app one.
    expect(await win.locator("[data-context-menu]").count()).toBe(0);
  });

  it("moves to a host on the account from the Hosts menu, lists both with the current one marked, and This Mac takes the window back", async () => {
    existing = await fixtureHost();
    const at = `http://127.0.0.1:${existing.port}`;
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, home => {
      seedGolden(home);
      // Two hosts on the account, so the window opens here rather than on either; the one on loopback is dialled
      // with no key pinned, since there is no road between two ports of one computer for anybody to stand on.
      seedAccountHost(home, "box", at, existing!.authToken);
      seedAccountHost(home, "attic", "http://attic.example:4400", "tok-seed");
    });
    const win = await windowAt(launched.app, APP_URL);
    const home = win.url();
    await win.waitForSelector("[data-host-foot]");
    const here = hereWord(process.platform === "darwin");
    expect(await win.locator("[data-host-label]").textContent()).toBe(here);
    await hostsMenu(launched.app, "box");
    await win.waitForURL(`${at}/`);
    // The shell's own menu lists every host on the account, so the owner still moves from one to another while the
    // window stands on a host somewhere else. It is rebuilt once the page is up, which is a beat after the window moved.
    await vi.waitFor(async () => {
      expect(await hostsMenuRows(launched!.app)).toEqual([
        { label: here, checked: false, enabled: true },
        { label: "attic", checked: false, enabled: true },
        { label: "box", checked: true, enabled: true },
      ]);
    }, { timeout: 30_000, interval: 100 });
    // The page that host serves is shown this computer and that host alone, and what it asks of this computer is
    // refused in one sentence naming the channel, before anything on this computer is read or written.
    const asked = await win.evaluate(async () => {
      const wsp = (
        window as unknown as {
          wsp: {
            hosts(): Promise<{ here: string; current: string | null; hosts: { alias: string }[] }>;
            localFonts(family: string): Promise<unknown>;
            switchHost(alias: string | null): Promise<unknown>;
          };
        }
      ).wsp;
      const said = async (call: () => Promise<unknown>): Promise<string> => {
        try {
          await call();
          return "answered";
        } catch (e) {
          return (e as Error).message;
        }
      };
      return {
        hosts: await wsp.hosts(),
        fonts: await said(() => wsp.localFonts("Menlo")),
        elsewhere: await said(() => wsp.switchHost("attic")),
      };
    });
    expect(asked.hosts.hosts.map(h => h.alias)).toEqual(["box"]);
    expect(asked.hosts.here).toBe(here);
    expect(asked.fonts).toContain(notForThisPage("fonts:local"));
    expect(asked.elsewhere).toContain(notForThisPage("hosts:switch"));
    // The move home is the one move that page may ask for, and the record it could not read still stands after it.
    await win.evaluate(() => {
      void (window as unknown as { wsp: { switchHost(alias: string | null): Promise<unknown> } }).wsp.switchHost(null);
    });
    await win.waitForURL(home);
    expect(existsSync(join(launched.home, "hosts", "attic.json"))).toBe(true);
    await hostsMenu(launched.app, "box");
    await win.waitForURL(`${at}/`);
    await hostsMenu(launched.app, here);
    await win.waitForURL(home);
    await vi.waitFor(async () => {
      expect((await hostsMenuRows(launched!.app)).map(r => r.checked)).toEqual([true, false, false]);
    }, { timeout: 30_000, interval: 100 });
    expect(await win.locator("[data-host-label]").textContent()).toBe(here);
    // The app's own host was never stopped by the move.
    await launched.app.close();
    expect(await refused(home)).toBe(true);
  });

  it("a host under some other home is nothing to a launch that names none: the first launch runs on ~/.wsp", async () => {
    launched = await launch({ WSP_HOME: undefined }, home => {
      const custom = join(home, "old-home");
      mkdirSync(custom);
      writeFileSync(join(custom, "host.lock"), JSON.stringify({ pid: deadPid(), port: 1, wsPort: 2, startedAt: "2026-09-01T00:00:00.000Z" }));
    });
    const page = await windowAt(launched.app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    expect(await page.textContent("#start")).toContain("Get started");
    expect(existsSync(shimPath(join(launched.home, ".wsp")))).toBe(true);
    expect(existsSync(join(launched.home, "old-home", "bin"))).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "on macOS the header row is the frame: the lights sit inside it, both header rows drag, and the window paints nothing under the page, whose dark sidebar lets the glass through",
    async () => {
      launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
      const win = await windowAt(launched.app, APP_URL);
      await win.waitForSelector("[data-slot=sidebar-container]");
      const app = launched.app;
      const { frame, page } = await macHeader(app, win);
      expect(frame.buttons).toEqual({ x: 16, y: 19 });
      expect(frame.content.height).toBe(frame.bounds.height);
      expect(frame.title).toBe("wsp");

      expect(page.htmlClass.split(" ")).toContain("desktop-mac");
      expect(page.container).toBe("rgba(0, 0, 0, 0)");
      expect(page.headerHeight).toBe(52);
      expect(page.pageToggles).toBe(0);
      expect(page.sidebarHeader).toBe("drag");
      expect(page.pageHeader).toBe("drag");
      expect(page.pageButtons.length).toBeGreaterThan(1);
      expect([...page.sidebarButtons, ...page.pageButtons].every(r => r === "no-drag")).toBe(true);

      // Each theme lays its own share of ground over the glass, so the window is read in both: at a point in the
      // sidebar and one in the main column, the page's capture holds exactly the alpha the page's own backgrounds
      // stack to there, which is what says the window under them is clear.
      const points = { sidebar: { x: page.sidebarWidth / 2, y: 0.7 }, main: { x: page.sidebarWidth + 200, y: 0.7 } };
      const painted = await readPainted(app, win, frame.id, points);
      console.info(`painted alpha by theme: ${JSON.stringify(painted)}`);
      for (const theme of ["light", "dark"] as const) {
        for (const at of ["sidebar", "main"] as const) expect(Math.abs(painted[theme][at].captured - painted[theme][at].declared)).toBeLessThanOrEqual(2);
      }
      // Dark mode stands the whole window on the glass: the sidebar's share lets it through. Light mode keeps the main
      // column's solid ground.
      expect(painted.dark.sidebar.captured).toBeLessThan(255);
      expect(painted.dark.sidebar.captured).toBeGreaterThan(0);
      expect(painted.light.main.captured).toBe(255);
    },
  );
});
