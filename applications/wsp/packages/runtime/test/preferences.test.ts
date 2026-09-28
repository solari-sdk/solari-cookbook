// SPDX-License-Identifier: AGPL-3.0-only
// The preferences record over the wire: preferences.get answers the defaults
// until a client sets something, preferences.set lands a patch on the record,
// keeps it in the store so a runtime started later on the same state reads
// it, and pushes the whole record to every subscribed socket; a patch outside
// the record's own values is refused and changes nothing.
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFERENCES, HERE_PLACE_ID, LABS_ENV } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, serveRuntime, type AgentsReader, type RuntimeServer, type ServerIcons } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient, wsRequest } from "./ws-client.js";

/** The environment these runtimes read labs off: this file's, not the shell that started the run, so a builder with
 * WSP_LABS exported reads the same record as one without. */
const NO_LABS: Readonly<Record<string, string | undefined>> = {};

describe("preferences over the wire", () => {
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
    vi.unstubAllEnvs();
  });

  it("reads as the defaults, takes a patch, keeps it for the next runtime on the store, and pushes the record to every socket", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {}, env: NO_LABS });
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "preferences.get" })).toMatchObject({ ok: true, preferences: DEFAULT_PREFERENCES });

    const watcher = await WsClient.connect(srv.port, { token: "t" });
    expect((await watcher.request("events.subscribe")).ok).toBe(true);
    const set = await wsRequest(srv.port, "t", { op: "preferences.set", patch: { theme: "light", sidebarWidth: 312, terminalZoom: { ws_a: 2 } } });
    const expected = { ...DEFAULT_PREFERENCES, theme: "light", sidebarWidth: 312, terminalZoom: { ws_a: 2 } };
    expect(set).toMatchObject({ ok: true, preferences: expected });
    await until(() => watcher.events.some(e => e.type === "preferences.changed"));
    expect(watcher.events.find(e => e.type === "preferences.changed")).toMatchObject({ type: "preferences.changed", preferences: expected, seq: expect.any(Number) });
    watcher.close();

    // A second patch lands on the first, a null width clears the width alone, and a zoom entry lands beside the others.
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { sidebarMode: "spaces", sidebarWidth: null, terminalZoom: { ws_b: -1 } } })).toMatchObject({
      ok: true,
      preferences: { theme: "light", sidebarMode: "spaces", terminalSize: "app", terminalZoom: { ws_a: 2, ws_b: -1 } },
    });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { terminalZoom: { ws_b: null } } })).toMatchObject({ ok: true, preferences: { terminalZoom: { ws_a: 2 } } });
    expect((await wsRequest(srv.port, "t", { op: "preferences.get" }))["preferences"]).not.toHaveProperty("sidebarWidth");

    await srv.close();
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {}, env: NO_LABS }), { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "preferences.get" })).toMatchObject({ ok: true, preferences: { theme: "light", sidebarMode: "spaces", terminalZoom: { ws_a: 2 } } });
  });

  it("the access picked in a workspace lands on the record and the next thread there reads it", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {}, env: NO_LABS });
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { access: { ws_a: "bypassPermissions" } } })).toMatchObject({
      ok: true,
      preferences: { access: { ws_a: "bypassPermissions" } },
    });
    // Per workspace: a pick in one leaves the others alone, and a null drops that workspace's alone.
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { access: { ws_b: "plan" } } })).toMatchObject({
      ok: true,
      preferences: { access: { ws_a: "bypassPermissions", ws_b: "plan" } },
    });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { access: { ws_a: null } } })).toMatchObject({ ok: true, preferences: { access: { ws_b: "plan" } } });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { access: { ws_b: 3 } } })).toMatchObject({ ok: false });

    // It is the host's record, not one browser's: a runtime started later on the same store still has the pick.
    await srv.close();
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {}, env: NO_LABS }), { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "preferences.get" })).toMatchObject({ ok: true, preferences: { access: { ws_b: "plan" } } });
  });

  it("a computer's icon lands on the record, a null clears it, and the next runtime on the store reads it", async () => {
    const store = memoryStore();
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {}, env: NO_LABS }), { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { computerLook: { pl_box: { icon: "server" }, pl_mac: { icon: "laptop" } } } })).toMatchObject({
      ok: true,
      preferences: { computerLook: { pl_box: { icon: "server" }, pl_mac: { icon: "laptop" } } },
    });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { computerLook: { pl_mac: null } } })).toMatchObject({ ok: true, preferences: { computerLook: { pl_box: { icon: "server" } } } });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { computerLook: { pl_box: { icon: "toaster" } } } })).toMatchObject({ ok: false });
    await srv.close();
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {}, env: NO_LABS }), { port: 0, authToken: "t" });
    expect((await wsRequest(srv.port, "t", { op: "preferences.get" }))["preferences"]).toMatchObject({ computerLook: { pl_box: { icon: "server" } } });
  });

  it("a record kept before computers had icons reads with none", async () => {
    const store = memoryStore();
    await store.put("preferences", "default", { theme: "light", projectLook: { pr_1: { icon: "rocket" } } });
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {}, env: NO_LABS }), { port: 0, authToken: "t" });
    expect((await wsRequest(srv.port, "t", { op: "preferences.get" }))["preferences"]).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", projectLook: { pr_1: { icon: "rocket" } }, computerLook: {} });
  });

  it("two patches landing at once keep both fields", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, env: NO_LABS });
    const [a, b] = await Promise.all([rt.preferences.set({ theme: "light" }), rt.preferences.set({ sidebarMode: "spaces" })]);
    expect(a.preferences).toMatchObject({ theme: "light" });
    expect(b.preferences).toMatchObject({ theme: "light", sidebarMode: "spaces" });
    expect(await rt.preferences.get()).toMatchObject({ theme: "light", sidebarMode: "spaces" });
  });

  // The one runtime that reads the process's own environment is the one a host builds: every case above hands its
  // environment in, so without this case a refactor could take LABS_ENV away from the real host and nothing would say
  // so. It sets the variable it reads, in its own process, which is what the environment law asks of it.
  it("a runtime built with no environment of its own reads this process's, which is what a host does", async () => {
    vi.stubEnv(LABS_ENV, "1");
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    expect(await rt.preferences.get()).toMatchObject({ ...DEFAULT_PREFERENCES, labs: true });
    // Handed one that does not carry it, the same runtime reads it off nothing else.
    expect(await createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, env: NO_LABS }).preferences.get()).toMatchObject({ labs: false });
  });

  it("a patch outside the record's values is refused and the record stands", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, env: NO_LABS });
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { theme: "sepia" } })).toMatchObject({ ok: false });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { sidebarWidth: 0 } })).toMatchObject({ ok: false });
    expect(await wsRequest(srv.port, "t", { op: "preferences.get" })).toMatchObject({ ok: true, preferences: DEFAULT_PREFERENCES });
  });

  it("agent version checks follow the person's switch: on by default, and once off the next agents read asks the reader not to ask the vendors", async () => {
    const asked: (boolean | undefined)[] = [];
    const agentsReader: AgentsReader = {
      read: async (_on, o) => (asked.push(o?.latest), { home: "/Users/ada", user: "ada", agents: [], skills: [], servers: [], refused: [] }),
      tools: async () => ({ auth: "open", readAt: "2026-09-26T12:00:00.000Z" }),
    };
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, env: NO_LABS, agentsReader });
    expect((await rt.preferences.get()).agentVersions).toBe(true);
    await rt.agents.read({ placeId: HERE_PLACE_ID });
    await rt.preferences.set({ agentVersions: false });
    await rt.agents.read({ placeId: HERE_PLACE_ID });
    expect(asked).toEqual([true, false]);
  });

  it("icons turned off whose folder cannot be deleted still save, tell every socket, and answer with a notice naming the folder", async () => {
    const folder = join(homedir(), ".wsp", "icons");
    const icons: ServerIcons = {
      folder,
      icon: async () => null,
      forget: () => {
        throw Object.assign(new Error(`EACCES: permission denied, rmdir '${folder}'`), { code: "EACCES" });
      },
    };
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, env: NO_LABS, serverIcons: icons });
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const watcher = await WsClient.connect(srv.port, { token: "t" });
    expect((await watcher.request("events.subscribe")).ok).toBe(true);
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { serverIcons: false } })).toMatchObject({
      ok: true,
      preferences: { serverIcons: false },
      notice: "Server icons are off, but ~/.wsp/icons could not be deleted: permission denied. Delete it by hand.",
    });
    await until(() => watcher.events.some(e => e.type === "preferences.changed"));
    expect(watcher.events.find(e => e.type === "preferences.changed")).toMatchObject({ preferences: { serverIcons: false } });
    watcher.close();
    expect(await rt.preferences.get()).toMatchObject({ serverIcons: false });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { theme: "dark" } })).not.toHaveProperty("notice");
  });
});
