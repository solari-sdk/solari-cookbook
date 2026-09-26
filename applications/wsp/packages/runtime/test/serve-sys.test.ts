import { HERE_PLACE_ID } from "@wsp/protocol";
// SPDX-License-Identifier: AGPL-3.0-only
// The readings of the workspace that is this computer, over the socket the
// page already holds. Nothing here wires a daemon at all, so a figure that
// reaches the page cannot have come off one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@wsp/engine";
import type { SysSample } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { localExecStream } from "../src/local-exec.js";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { copyingFake, createOn, stubBackend, testPlatform } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

const HOST_TOKEN = "secret";

const sample = (at: number): SysSample => ({ type: "sys.sample", cpu: 12, load1: 0.4, mem: { used: 1, total: 2 }, disk: { used: 3, total: 4 }, at });

/** The host's one sampler, as the wiring hands it out: every listener rides it, and it counts what it was asked. */
function fakeSampler() {
  const listeners = new Set<(s: SysSample) => void>();
  let asks = 0;
  return {
    get asks() {
      return asks;
    },
    get listeners() {
      return listeners.size;
    },
    emit: (s: SysSample) => {
      for (const fn of [...listeners]) fn(s);
    },
    subscribe: async (fn: (s: SysSample) => void) => {
      asks++;
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

let srv: RuntimeServer | undefined;
let rt: Runtime | undefined;
let root: string | undefined;

/** A host serving this computer as a workspace and nothing else: no daemon road, so no pane here can dial one. */
async function served(sampler: ReturnType<typeof fakeSampler>): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "wsp-serve-sys-"));
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root: root!, runDir: join(root!, "runs"), ...o }),
    home: () => join(root!, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier: copyingFake(),
    sysSamples: sampler.subscribe,
  };
  rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, local });
  srv = await serveRuntime(rt, { port: 0, authToken: HOST_TOKEN });
  return (await createOn(rt, { on: HERE_PLACE_ID, name: "this computer" })).id;
}

const client = (): Promise<WsClient> => WsClient.connect(srv!.port, { token: HOST_TOKEN });
const samplesOn = (c: WsClient, workspaceId: string): Record<string, unknown>[] => c.events.filter(e => e.type === "workspace.sys" && e["workspaceId"] === workspaceId) as Record<string, unknown>[];

afterEach(async () => {
  await srv?.close();
  srv = undefined;
  await rt?.close();
  rt = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("the readings of the workspace that is this computer", () => {
  it("reach the page over its own socket, with no daemon wired to dial", async () => {
    const sampler = fakeSampler();
    const workspaceId = await served(sampler);
    const c = await client();

    expect(await c.request("sys.subscribe", { workspaceId })).toMatchObject({ ok: true });
    await until(() => sampler.listeners === 1);
    sampler.emit(sample(1));
    await until(() => samplesOn(c, workspaceId).length === 1);
    expect(samplesOn(c, workspaceId)[0]).toEqual({ type: "workspace.sys", workspaceId, sample: sample(1) });

    // The same host has no road to a daemon at all: what the rows just read came from this process.
    expect(await c.request("daemon.open", { workspaceId })).toMatchObject({ ok: false });
    c.close();
  });

  it("ride one subscription however many panes ask, and one sampler however many pages are open", async () => {
    const sampler = fakeSampler();
    const workspaceId = await served(sampler);
    const one = await client();

    expect(await one.request("sys.subscribe", { workspaceId })).toMatchObject({ ok: true });
    expect(await one.request("sys.subscribe", { workspaceId })).toMatchObject({ ok: true });
    await until(() => sampler.listeners === 1);
    expect(sampler.asks).toBe(1);
    sampler.emit(sample(2));
    await until(() => samplesOn(one, workspaceId).length === 1);

    // A second page is a second listener on the one sampler the host holds, never a second sampler.
    const two = await client();
    expect(await two.request("sys.subscribe", { workspaceId })).toMatchObject({ ok: true });
    await until(() => sampler.listeners === 2);
    sampler.emit(sample(3));
    await until(() => samplesOn(two, workspaceId).length === 1);
    expect(samplesOn(one, workspaceId)).toHaveLength(2);

    // A page that goes takes its own listener and nothing else with it.
    two.close();
    await until(() => sampler.listeners === 1);
    one.close();
    await until(() => sampler.listeners === 0);
  });

  it("are refused for a machine that reads its own, which a pane asks over its daemon link", async () => {
    const sampler = fakeSampler();
    await served(sampler);
    const fork = await createOn(rt!, { golden: "snap_g", name: "fork" });
    const c = await client();
    expect(await c.request("sys.subscribe", { workspaceId: fork.id })).toMatchObject({ ok: false, error: expect.stringMatching(/over its daemon link/) });
    expect(sampler.asks).toBe(0);
    c.close();
  });
});
