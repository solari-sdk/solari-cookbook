// SPDX-License-Identifier: AGPL-3.0-only
// makeApi against a scripted socket: every wrapper sends the op serveRuntime
// dispatches and unwraps the field its reply carries. The same socket plays a
// runtime that dies and comes back for the reconnect tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLACE_ADD_WORDS, RuntimeRequest } from "@wsp/protocol";
import { DisconnectedError, makeApi, ProtocolClient, type ConnStatus, type ProtocolClientOptions } from "../src/protocol/client.js";
import { ScriptedSocket, type Frame } from "./scripted-socket.js";
import { caps } from "./caps.js";

/** Polls cond every 5 ms until it holds; the redial timer is a real setTimeout, so these tests wait on the wall clock. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 5));
  }
}

const push = (sock: ScriptedSocket, e: Record<string, unknown>) => sock.onmessage?.({ data: JSON.stringify(e) });
/** Lets the scripted socket deliver a reply, which a real socket puts on the wire before any event. */
const replied = () => new Promise(r => setTimeout(r, 0));

/** The Linux box the ssh road's installer hands back once it has dialled this host. */
const box = {
  id: "p_2",
  kind: "computer",
  name: "hetzner",
  default: false,
  present: true,
  takesForks: true,
  engine: "docker",
  os: "Ubuntu 24.04",
  shape: { cpu: 2, memMb: 4096 },
  diskFreeBytes: 40_802_189_312,
};

async function connect() {
  ScriptedSocket.instances.length = 0;
  const client = new ProtocolClient({
    url: "ws://test",
    token: "tok",
    WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket,
  });
  await client.connect();
  const sock = ScriptedSocket.instances[0]!;
  return { api: makeApi(client), sock, lastSent: () => sock.sent[sock.sent.length - 1]! };
}

describe("makeApi wrappers", () => {
  it("startSession sends sessions.start with the scope and unwraps the session view", async () => {
    const { api, lastSent } = await connect();
    const session = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "running" };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, session });
    const got = await api.startSession({ workspaceId: "ws_1", prompt: "fix it", resume: "claude-sid" });
    expect(lastSent()).toMatchObject({ op: "sessions.start", workspaceId: "ws_1", prompt: "fix it", resume: "claude-sid" });
    expect(got).toEqual(session);
  });

  it("interruptSession sends sessions.interrupt with the runtime's session id and unwraps the outcome", async () => {
    const { api, lastSent } = await connect();
    const interrupt = api.interruptSession!;
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, outcome: "not-running" });
    expect(await interrupt("s1")).toBe("not-running");
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "sessions.interrupt", sessionId: "s1" });
    // An outcome outside the enum must not read as accepted.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, outcome: "maybe" });
    await expect(interrupt("s1")).rejects.toThrow();
  });

  it("hostTerminalConfig sends host.terminalConfig with the scheme and unwraps the config the wire type vouches for", async () => {
    const { api, lastSent } = await connect();
    const read = api.hostTerminalConfig!;
    const config = { files: ["/Users/dev/.config/ghostty/config"], fontFamily: ["Berkeley Mono"], fontSize: 13, palette: Array<null>(16).fill(null), backgroundOpacity: 0.85 };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, config });
    expect(await read("light")).toEqual(config);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "host.terminalConfig", scheme: "light" });
    // A config the wire type does not vouch for is not applied: the pane would paint with a value it never checked.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, config: { ...config, backgroundOpacity: 2 } });
    await expect(read("dark")).rejects.toThrow();
  });

  it("initGet and initBuild carry the place the card asks about, and the job names the place its build went to", async () => {
    const { api, lastSent } = await connect();
    const setup = { keys: { solari: true }, home: "/Users/dev", agents: [], pricing: null, place: { id: "box", name: "box" }, job: null };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, setup });
    expect((await api.initGet!({ on: "box" })).place).toEqual({ id: "box", name: "box" });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "init.get", on: "box" });
    await api.initGet!();
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "init.get" });
    const job = { id: "j1", road: "manual", phase: "building", keys: { solari: true }, step: 5, stoppable: true, screens: [], rows: [], progress: { done: 0, total: 0 }, log: [], place: { id: "box", name: "box" } };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, job });
    expect((await api.initBuild!({ on: "box" })).place).toEqual({ id: "box", name: "box" });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "init.build", on: "box" });
  });

  it("serversIcon asks the host for a host's icon and takes only an inline image of a kind the host keeps", async () => {
    const { api, lastSent } = await connect();
    const png = "data:image/png;base64,iVBORw0KGgo=";
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, icon: png });
    expect(await api.serversIcon!("mcp.notion.com")).toBe(png);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "servers.icon", host: "mcp.notion.com" });
    await api.serversIcon!("mcp.notion.com", true);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "servers.icon", host: "mcp.notion.com", refresh: true });
    for (const icon of [null, "https://mcp.notion.com/favicon.ico", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGI+", `${png}"onerror="x`, 7]) {
      ScriptedSocket.reply = f => ({ id: f["id"], ok: true, icon });
      expect(await api.serversIcon!("mcp.notion.com"), String(icon)).toBeNull();
    }
  });

  it("preferences and setPreferences send the two preferences ops and unwrap the record the wire type vouches for", async () => {
    const { api, lastSent } = await connect();
    const record = { theme: "light", sidebarMode: "spaces", sidebarWidth: 312, terminalSize: "app", terminalZoom: { ws_a: 2 }, access: { ws_a: "bypassPermissions" }, target: { workspace: "ws_a" }, projectLook: { pr_1: { icon: "rocket", hue: "teal" } }, labs: false };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, preferences: record });
    // A record from a host that kept no computer icons or theme picks reads as none and the side defaults rather than
    // failing the whole record.
    expect(await api.preferences!()).toEqual({ ...record, computerLook: {}, serverIcons: true, agentVersions: true, lightTheme: "paper", darkTheme: "graphite" });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "preferences.get" });
    expect(await api.setPreferences!({ theme: "light", sidebarWidth: null })).toEqual({ ...record, computerLook: {}, serverIcons: true, agentVersions: true, lightTheme: "paper", darkTheme: "graphite" });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "preferences.set", patch: { theme: "light", sidebarWidth: null } });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, preferences: record, notice: "Server icons are off, but ~/.wsp/icons could not be deleted: permission denied. Delete it by hand." });
    expect(await api.setPreferences!({ serverIcons: false })).toEqual({ ...record, computerLook: {}, serverIcons: true, agentVersions: true, lightTheme: "paper", darkTheme: "graphite", notice: "Server icons are off, but ~/.wsp/icons could not be deleted: permission denied. Delete it by hand." });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, preferences: { ...record, computerLook: { pl_1: { icon: "server" } } } });
    expect((await api.preferences!()).computerLook).toEqual({ pl_1: { icon: "server" } });
    // A record the wire type does not vouch for is not applied: the page would paint a theme it never checked.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, preferences: { ...record, theme: "sepia" } });
    await expect(api.preferences!()).rejects.toThrow();
  });

  it("setSessionAccess sends sessions.access with the runtime's session id and unwraps the outcome", async () => {
    const { api, lastSent } = await connect();
    const move = api.setSessionAccess!;
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, outcome: "unsupported" });
    expect(await move("s1", "bypassPermissions")).toBe("unsupported");
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "sessions.access", sessionId: "s1", permissionMode: "bypassPermissions" });
    // An outcome outside the enum must not read as set: the composer would say nothing and the turn would keep asking.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, outcome: "moved" });
    await expect(move("s1", "plan")).rejects.toThrow();
  });

  it("hostFolders sends host.folders with only the fields it was given and unwraps the level the wire type vouches for", async () => {
    const { api, lastSent } = await connect();
    const browse = api.hostFolders!;
    const listing = { dir: "/Users/dev/code", roots: ["/Users/dev"], folders: [{ path: "/Users/dev/code/spoo", repo: true }], hidden: 2 };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, listing });
    expect(await browse()).toEqual(listing);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "host.folders" });
    expect(await browse("/Users/dev/code", true)).toEqual(listing);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "host.folders", dir: "/Users/dev/code", hidden: true });
    // A level the wire type does not vouch for is not walked: the picker would render a path it never checked.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, listing: { ...listing, folders: [{ path: "/Users/dev/code/spoo" }] } });
    await expect(browse()).rejects.toThrow();
  });

  it("createWorkspace sends the project and the name, a picked size as cpu and memMb and a picked image, and the runtime parses every one of them", async () => {
    const { api, lastSent } = await connect();
    const workspace = { id: "ws_1", name: "beta", machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_1", createdAt: "t" };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, workspace });
    // A workspace is one project's copy: the project is the whole of where it goes, and the image and the size ride
    // only where the person picked one. Each frame is parsed by the runtime's own schema here, so the app and the
    // wire cannot drift apart again without this test going red.
    await api.createWorkspace("pr_1", "beta");
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.create", project: "pr_1", name: "beta" });
    expect(RuntimeRequest.parse(lastSent())).toMatchObject({ op: "workspaces.create", project: "pr_1", name: "beta" });
    await api.createWorkspace("pr_1", "beta", { size: { cpu: 2, memMb: 8192 } });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.create", project: "pr_1", name: "beta", cpu: 2, memMb: 8192 });
    expect(RuntimeRequest.safeParse(lastSent()).success).toBe(true);
    await api.createWorkspace("pr_1", "beta", { golden: "snap_1", size: { cpu: 2, memMb: 8192 } });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.create", project: "pr_1", name: "beta", golden: "snap_1", cpu: 2, memMb: 8192 });
    expect(RuntimeRequest.safeParse(lastSent()).success).toBe(true);
  });

  it("sends no frame the runtime would refuse: every op this client has is one the runtime serves", async () => {
    const { api, lastSent } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, workspaces: [], projects: [], places: [], statuses: [], sessions: [] });
    // The create road that left the wire with the projects recut leaves the client with it: nothing here asks for a
    // local workspace of this computer, which is now a project of its own recorded with wsp add.
    expect("createLocalWorkspace" in api).toBe(false);
    await api.listWorkspaces();
    expect(RuntimeRequest.safeParse(lastSent()).success).toBe(true);
    await api.projectsList!();
    expect(lastSent()).toMatchObject({ op: "projects.list" });
    expect(RuntimeRequest.safeParse(lastSent()).success).toBe(true);
  });

  it("capabilities sends capabilities.get and unwraps the flags", async () => {
    const { api, lastSent } = await connect();
    const capabilities = caps({ sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }] });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, capabilities });
    expect(await api.capabilities()).toEqual(capabilities);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "capabilities.get" });
  });

  it("listSessions without a workspace asks for every session", async () => {
    const { api, lastSent } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, sessions: [] });
    await api.listSessions();
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "sessions.list" });
    await api.listSessions("ws_1");
    expect(lastSent()).toMatchObject({ op: "sessions.list", workspaceId: "ws_1" });
  });

  it("the daemon api opens, sends and closes a channel, and never puts a route or a token on the wire", async () => {
    const { api, sock, lastSent } = await connect();
    ScriptedSocket.reply = f => (f["op"] === "daemon.open" ? { id: f["id"], ok: true, channel: "ch_1" } : { id: f["id"], ok: true, reply: { id: 3, ok: true, ptyId: "p1" } });
    expect(await api.daemon.open({ workspaceId: "ws_1" })).toEqual({ channel: "ch_1" });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "daemon.open", workspaceId: "ws_1" });

    expect(await api.daemon.send("ch_1", { op: "pty.write", ptyId: "p1", data: "ls\r" })).toEqual({ id: 3, ok: true, ptyId: "p1" });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "daemon.send", channel: "ch_1", frame: { op: "pty.write", ptyId: "p1", data: "ls\r" } });

    ScriptedSocket.reply = f => ({ id: f["id"], ok: true });
    await api.daemon.close("ch_1");
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "daemon.close", channel: "ch_1" });
    // The machine's route and its daemon token stay on the host: nothing this page sent could carry one.
    expect(sock.sent.some(f => "reach" in f || "daemonToken" in f)).toBe(false);
  });

  it("a pushed daemon frame reaches its own channel's listener and no other, and never the event listeners", async () => {
    const { api, sock } = await connect();
    const events: unknown[] = [];
    const mine: unknown[] = [];
    const other: unknown[] = [];
    api.subscribe(e => events.push(e));
    const stop = api.daemon.onFrame("ch_1", e => mine.push(e));
    api.daemon.onFrame("ch_2", e => other.push(e));

    const data = { type: "daemon.event", channel: "ch_1", event: { type: "pty.data", ptyId: "p1", data: "hi" } };
    sock.onmessage!({ data: JSON.stringify(data) });
    sock.onmessage!({ data: JSON.stringify({ type: "daemon.closed", channel: "ch_1", code: 1006, reason: "" }) });
    expect(mine).toEqual([data, { type: "daemon.closed", channel: "ch_1", code: 1006, reason: "" }]);
    expect(other).toEqual([]);
    // A pty chunk is not history: the store that folds the runtime's events never sees one.
    expect(events).toEqual([]);

    // A runtime event still reaches the subscribers, so the channel routing took only the frames meant for it.
    const workspace = { type: "workspace.napped", workspaceId: "ws_1" };
    sock.onmessage!({ data: JSON.stringify(workspace) });
    expect(events).toEqual([workspace]);

    stop();
    sock.onmessage!({ data: JSON.stringify(data) });
    expect(mine).toHaveLength(2);
  });

  it("a frame that lands before its channel has a listener is held and handed over, and a redial drops what is held", async () => {
    const { api, sock } = await connect();
    // The host writes the open reply and the daemon's hello back to back; two frames in one read reach the client
    // before the microtask that resolves the open, so the hello must wait for the listener rather than be dropped.
    const hello = { type: "daemon.event", channel: "ch_1", event: { type: "daemon.hello", root: "/root" } };
    sock.onmessage!({ data: JSON.stringify(hello) });
    const held: unknown[] = [];
    api.daemon.onFrame("ch_1", e => held.push(e));
    expect(held).toEqual([hello]);

    // A channel dies with the socket that opened it, so nothing held for one outlives a redial.
    sock.onmessage!({ data: JSON.stringify({ type: "daemon.event", channel: "ch_2", event: { type: "daemon.hello", root: "/root" } }) });
    sock.drop(1006);
    await until(() => ScriptedSocket.instances.length > 1);
    const late: unknown[] = [];
    api.daemon.onFrame("ch_2", e => late.push(e));
    expect(late).toEqual([]);
  });

  it("portReach sends workspaces.portReach with the port and unwraps the reach view", async () => {
    const { api, lastSent } = await connect();
    const reach = { url: "https://m1-3000.preview.example/?pt_token=e", expiresAt: 1 };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, reach });
    expect(await api.portReach("ws_1", 3000)).toEqual(reach);
    expect(lastSent()).toMatchObject({ op: "workspaces.portReach", workspaceId: "ws_1", port: 3000 });
  });

  it("listSnapshots and rollbackSnapshot send the snapshots ops and unwrap their replies", async () => {
    const { api, lastSent } = await connect();
    const lineage = { name: "default", head: 2, versions: [] };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, lineage });
    expect(await api.listSnapshots()).toEqual(lineage);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "snapshots.list" });
    await api.listSnapshots("other");
    expect(lastSent()).toMatchObject({ op: "snapshots.list", name: "other" });

    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, lineage: { ...lineage, head: 1 }, existingWorkspaces: "untouched" });
    expect(await api.rollbackSnapshot(1)).toEqual({ lineage: { ...lineage, head: 1 }, existingWorkspaces: "untouched" });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "snapshots.rollback", version: 1 });
  });

  it("snapshotWorkspace and listProjectGoldens send their ops and parse the replies; a reply without the list is refused", async () => {
    const { api, lastSent } = await connect();
    const golden = { snapshotId: "snap_p", projects: [{ name: "proj", dest: "/root/work/proj", importedAt: "2026-09-06T10:01:00.000Z" }], golden: "snap_g", version: 1, workspaceId: "ws_1", workspaceName: "task", createdAt: "2026-09-06T10:06:00.000Z" };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, projectGolden: golden });
    expect(await api.snapshotWorkspace!("ws_1")).toEqual(golden);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.snapshot", workspaceId: "ws_1" });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, projectGoldens: [golden] });
    expect(await api.listProjectGoldens!()).toEqual([golden]);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "projectGoldens.list" });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true });
    await expect(api.listProjectGoldens!()).rejects.toThrow();
  });

  it("a rejected op surfaces the runtime's error message", async () => {
    const { api } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: false, error: "workspace is napping" });
    await expect(api.startSession({ workspaceId: "ws_1", prompt: "x" })).rejects.toThrow("workspace is napping");
  });

  it("a rejected op keeps the fix and the kind the runtime sent apart from its sentence, and a bare frame says the host gave no reason", async () => {
    const { api } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: false, error: "spoo names no user. Type user@spoo.", kind: "invalid", fix: "Type user@spoo." });
    await expect(api.startSession({ workspaceId: "ws_1", prompt: "x" })).rejects.toMatchObject({ name: "RequestError", message: "spoo names no user. Type user@spoo.", kind: "invalid", fix: "Type user@spoo." });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: false, error: "workspace is napping" });
    await expect(api.startSession({ workspaceId: "ws_1", prompt: "x" })).rejects.toMatchObject({ fix: undefined, kind: undefined });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: false });
    await expect(api.startSession({ workspaceId: "ws_1", prompt: "x" })).rejects.toThrow("The host answered with no reason. Try again.");
  });

  it("addComputerOverSsh sends places.add under the stream its caller minted, with a port other than 22, and answers the computer", async () => {
    const { api, sock, lastSent } = await connect();
    ScriptedSocket.reply = f => (f["op"] === "places.add" ? { id: f["id"], ok: true, addId: f["addId"], place: box } : { id: f["id"], ok: true });
    const road = api.addComputerOverSsh!({ address: "root@65.21.4.12", port: 2222 }, "a_mine");
    await until(() => sock.frames("places.add").length === 1);
    expect(lastSent()).toMatchObject({ op: "places.add", address: "root@65.21.4.12", sshPort: 2222, addId: "a_mine" });
    expect(await road).toEqual(box);
  });

  it("addComputerOverSsh leaves the port out when nothing was typed, and refuses a place the wire type does not vouch for", async () => {
    const { api, lastSent } = await connect();
    ScriptedSocket.reply = f => (f["op"] === "places.add" ? { id: f["id"], ok: true, place: box } : { id: f["id"], ok: true });
    await api.addComputerOverSsh!({ address: "root@65.21.4.12" }, "a_mine");
    expect(lastSent()["sshPort"]).toBeUndefined();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, place: { ...box, kind: "toaster" } });
    await expect(api.addComputerOverSsh!({ address: "root@65.21.4.12" }, "a_mine")).rejects.toThrow();
  });

  it("placesList reads the computers and the adds off one places.list, no adds from a host that sends none, and refuses a step the wire type does not vouch for", async () => {
    const { api } = await connect();
    const job = { addId: "a_1", address: "root@spoo", startedAt: "2026-09-25T09:00:00.000Z", state: "failed", steps: [{ step: "wsp", state: "failed", note: "no curl" }], said: "spoo has no curl.", fix: "Install it." };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, places: [box], adds: [job] });
    expect(await api.placesList!()).toEqual({ places: [box], adds: [job] });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, places: [box] });
    expect(await api.placesList!()).toEqual({ places: [box], adds: [] });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, places: [box], adds: [{ ...job, steps: [{ step: "node", state: "running" }] }] });
    await expect(api.placesList!()).rejects.toThrow();
  });
});

describe("makeApi golden wrappers", () => {
  it("getGolden asks golden.get by name and unwraps the manifest, undefined on a fresh install", async () => {
    const { api, lastSent } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true });
    expect(await api.getGolden()).toBeUndefined();
    expect(lastSent()).toMatchObject({ op: "golden.get", name: "default" });
    const manifest = { head: 1, versions: [{ version: 1, snapshotId: "snap_1", baseTemplate: "default", kind: "desktop", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, manifest });
    expect(await api.getGolden()).toEqual(manifest);
  });


});

describe("ProtocolClient reconnect", () => {
  function newClient(extra: Partial<ProtocolClientOptions> = {}) {
    ScriptedSocket.instances.length = 0;
    const statuses: ConnStatus[] = [];
    const client = new ProtocolClient({
      url: "ws://test",
      token: "tok",
      WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket,
      onStatus: s => statuses.push(s),
      ...extra,
    });
    return { client, statuses, socket: (n: number) => ScriptedSocket.instances[n]! };
  }
  beforeEach(() => {
    ScriptedSocket.authOk = true;
    ScriptedSocket.serverUp = true;
    ScriptedSocket.reply = () => undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a dropped socket comes back: redial, same token, events.subscribe re-armed, events flow again", async () => {
    const { client, statuses, socket } = newClient({ backoffMs: () => 0 });
    await client.connect();
    const seen: unknown[] = [];
    client.subscribe(e => seen.push(e));
    expect(socket(0).frames("events.subscribe")).toHaveLength(1);

    socket(0).drop(1006);
    expect(client.status).toBe("reconnecting");
    await until(() => client.status === "live");

    expect(ScriptedSocket.instances).toHaveLength(2);
    expect(socket(1).sent[0]).toEqual({ id: 0, op: "auth", token: "tok" });
    expect(socket(1).frames("events.subscribe")).toHaveLength(1);
    expect(statuses).toEqual(["live", "reconnecting", "live"]);

    socket(1).onmessage?.({ data: JSON.stringify({ type: "workspace.napped", workspaceId: "ws_1" }) });
    expect(seen).toEqual([{ type: "workspace.napped", workspaceId: "ws_1" }]);
    client.close();
  });

  it("requests in flight at the drop reject with DisconnectedError; so do requests made while reconnecting", async () => {
    const { client, socket } = newClient({ backoffMs: () => 10_000 });
    await client.connect();
    const inFlight = client.request("workspaces.list");
    socket(0).drop(1006);
    await expect(inFlight).rejects.toBeInstanceOf(DisconnectedError);
    await expect(inFlight).rejects.toMatchObject({ reason: "lost" });
    const whileDown = client.request("workspaces.list");
    await expect(whileDown).rejects.toBeInstanceOf(DisconnectedError);
    await expect(whileDown).rejects.toMatchObject({ reason: "lost" });
    client.close();
  });

  it("redials on the default schedule, 250 ms doubling to a 5 s cap, and starts over after a live", async () => {
    vi.useFakeTimers();
    const { client } = newClient();
    await client.connect();
    ScriptedSocket.serverUp = false;
    client.subscribe(() => {});
    ScriptedSocket.instances[0]!.drop(1006);

    let dials = 1;
    for (const wait of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(ScriptedSocket.instances).toHaveLength(dials);
      await vi.advanceTimersByTimeAsync(1);
      expect(ScriptedSocket.instances).toHaveLength(dials + 1);
      dials++;
    }
    expect(client.status).toBe("reconnecting");

    ScriptedSocket.serverUp = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.status).toBe("live");

    ScriptedSocket.instances[ScriptedSocket.instances.length - 1]!.drop(1006);
    const before = ScriptedSocket.instances.length;
    await vi.advanceTimersByTimeAsync(249);
    expect(ScriptedSocket.instances).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(ScriptedSocket.instances).toHaveLength(before + 1);
    client.close();
  });

  it("a rejected token is terminal: closed, no redial, requests say unauthorized", async () => {
    vi.useFakeTimers();
    ScriptedSocket.authOk = false;
    const { client, statuses } = newClient();
    await expect(client.connect()).rejects.toMatchObject({ reason: "unauthorized" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ScriptedSocket.instances).toHaveLength(1);
    expect(client.status).toBe("closed");
    expect(statuses).toEqual(["closed"]);
    await expect(client.request("workspaces.list")).rejects.toMatchObject({ reason: "unauthorized" });
  });

  it("close() ends the redial loop and settles as closed", async () => {
    vi.useFakeTimers();
    const { client, statuses } = newClient();
    await client.connect();
    ScriptedSocket.instances[0]!.drop(1006);
    client.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ScriptedSocket.instances).toHaveLength(1);
    expect(statuses).toEqual(["live", "reconnecting", "closed"]);
    await expect(client.request("workspaces.list")).rejects.toMatchObject({ reason: "closed" });
  });

  it("before the first live it keeps dialling as connecting, never reconnecting", async () => {
    vi.useFakeTimers();
    ScriptedSocket.serverUp = false;
    const { client, statuses } = newClient();
    const opened = client.connect();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ScriptedSocket.instances.length).toBeGreaterThan(2);
    expect(client.status).toBe("connecting");
    expect(statuses).toEqual([]);
    ScriptedSocket.serverUp = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await opened;
    expect(statuses).toEqual(["live"]);
    client.close();
  });
});

describe("ProtocolClient event cursor", () => {
  function newClient(extra: Partial<ProtocolClientOptions> = {}) {
    ScriptedSocket.instances.length = 0;
    const gaps: number[] = [];
    const client = new ProtocolClient({
      url: "ws://test",
      token: "tok",
      WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket,
      backoffMs: () => 0,
      onGap: () => gaps.push(gaps.length + 1),
      ...extra,
    });
    return { client, gaps, socket: (n: number) => ScriptedSocket.instances[n]! };
  }
  /** The runtime's subscribe reply: head first, the same head after a redial unless a test overrides it. */
  const subscribeReply = (seq: number, gap = false, stream = "stream-a") => (f: Frame) =>
    f["op"] === "events.subscribe" ? { id: f["id"], ok: true, seq, stream, ...(gap ? { gap: true } : {}) } : undefined;
  const redial = async (client: ProtocolClient, sock: ScriptedSocket) => {
    sock.drop(1006);
    await until(() => client.status === "live");
  };
  beforeEach(() => {
    ScriptedSocket.authOk = true;
    ScriptedSocket.serverUp = true;
    ScriptedSocket.reply = () => undefined;
  });

  it("the first subscribe carries no cursor; a re-subscribe carries the seq of the last event seen", async () => {
    ScriptedSocket.reply = subscribeReply(2);
    const { client, socket } = newClient();
    await client.connect();
    const seen: unknown[] = [];
    client.subscribe(e => seen.push(e));
    expect(socket(0).frames("events.subscribe")).toEqual([{ id: expect.any(Number), op: "events.subscribe" }]);
    await replied();

    push(socket(0), { type: "workspace.napped", workspaceId: "ws_1", seq: 3 });
    push(socket(0), { type: "workspace.woken", workspaceId: "ws_1", machineId: "m2", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, resurrected: false, seq: 4 });
    expect(seen).toHaveLength(2);

    await redial(client, socket(0));
    expect(socket(1).frames("events.subscribe")).toEqual([{ id: expect.any(Number), op: "events.subscribe", after: 4, stream: "stream-a" }]);
    // Replayed events move the cursor like live ones.
    push(socket(1), { type: "workspace.napped", workspaceId: "ws_1", seq: 5 });
    await redial(client, socket(1));
    expect(socket(2).frames("events.subscribe")[0]).toMatchObject({ after: 5 });
    client.close();
  });

  it("with no event seen yet the cursor starts at the reply's head, so a quiet tab still gets what a drop hid", async () => {
    ScriptedSocket.reply = subscribeReply(9);
    const { client, socket } = newClient();
    await client.connect();
    client.subscribe(() => {});
    await until(() => socket(0).frames("events.subscribe").length === 1);
    await new Promise(r => setTimeout(r, 0));
    await redial(client, socket(0));
    expect(socket(1).frames("events.subscribe")[0]).toMatchObject({ after: 9 });
    client.close();
  });

  it("a gap reply fires onGap once and moves the cursor to the runtime's head", async () => {
    ScriptedSocket.reply = subscribeReply(2);
    const { client, gaps, socket } = newClient();
    await client.connect();
    client.subscribe(() => {});
    push(socket(0), { type: "workspace.napped", workspaceId: "ws_1", seq: 3 });

    ScriptedSocket.reply = subscribeReply(40, true);
    await redial(client, socket(0));
    await until(() => gaps.length === 1);
    expect(socket(1).frames("events.subscribe")[0]).toMatchObject({ after: 3 });

    ScriptedSocket.reply = subscribeReply(40);
    await redial(client, socket(1));
    expect(socket(2).frames("events.subscribe")[0]).toMatchObject({ after: 40 });
    expect(gaps).toEqual([1]);
    client.close();
  });

  it("a reply from a different stream is a gap even without the marker: onGap fires and the cursor restarts at that head", async () => {
    ScriptedSocket.reply = subscribeReply(2);
    const { client, gaps, socket } = newClient();
    await client.connect();
    client.subscribe(() => {});
    await replied();
    push(socket(0), { type: "workspace.napped", workspaceId: "ws_1", seq: 3 });

    ScriptedSocket.reply = subscribeReply(1, false, "stream-b");
    await redial(client, socket(0));
    expect(socket(1).frames("events.subscribe")[0]).toMatchObject({ after: 3, stream: "stream-a" });
    await until(() => gaps.length === 1);

    ScriptedSocket.reply = subscribeReply(1, false, "stream-b");
    await redial(client, socket(1));
    expect(socket(2).frames("events.subscribe")[0]).toMatchObject({ after: 1, stream: "stream-b" });
    expect(gaps).toEqual([1]);
    client.close();
  });

  it("a reply without a head and events without seq leave the cursor where it was", async () => {
    ScriptedSocket.reply = f => (f["op"] === "events.subscribe" ? { id: f["id"], ok: true } : undefined);
    const { client, gaps, socket } = newClient();
    await client.connect();
    client.subscribe(() => {});
    push(socket(0), { type: "workspace.napped", workspaceId: "ws_1" });
    await redial(client, socket(0));
    expect(socket(1).frames("events.subscribe")).toEqual([{ id: expect.any(Number), op: "events.subscribe" }]);
    expect(gaps).toEqual([]);
    client.close();
  });
});
