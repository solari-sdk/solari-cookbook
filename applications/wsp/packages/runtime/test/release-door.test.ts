// SPDX-License-Identifier: AGPL-3.0-only
// Over the wire the host's release reading answers release.get and
// release.check, and a changed reading reaches every socket that subscribed;
// a server without one refuses both ops.
import type { ReleaseChangedEvent, ReleaseView } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, serveRuntime, type ReleaseDoor, type RuntimeServer } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { WsClient, wsRequest } from "./ws-client.js";

const CHECKING: ReleaseView = { state: "checking", shape: "app" };
const READ: ReleaseView = { ...CHECKING, state: "read", latest: { version: "0.3.0", tag: "v0.3.0", url: "https://github.com/Zingzy/wsp/releases/tag/v0.3.0", publishedAt: "2026-09-24T10:00:00Z" } };

function fakeDoor(): ReleaseDoor {
  let view = CHECKING;
  const listeners = new Set<(e: ReleaseChangedEvent) => void>();
  return {
    get: () => view,
    check: async () => {
      view = READ;
      for (const fn of listeners) fn({ type: "release.changed", release: view });
      return view;
    },
    on: fn => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

describe("the newest release over the wire", () => {
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it("answers the host's reading, checks on the ask and pushes the change to a socket that subscribed", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    srv = await serveRuntime(rt, { port: 0, authToken: "t", release: fakeDoor() });
    expect(await wsRequest(srv.port, "t", { op: "release.get" })).toMatchObject({ ok: true, release: CHECKING });
    const watcher = await WsClient.connect(srv.port, { token: "t" });
    try {
      expect((await watcher.request("events.subscribe")).ok).toBe(true);
      expect(await wsRequest(srv.port, "t", { op: "release.check" })).toMatchObject({ ok: true, release: READ });
      await expect.poll(() => watcher.events.find(e => e.type === "release.changed")).toEqual({ type: "release.changed", release: READ });
    } finally {
      watcher.close();
    }
  });

  it("a server with no reading refuses both ops in one line", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    for (const op of ["release.get", "release.check"]) {
      expect(await wsRequest(srv.port, "t", { op })).toMatchObject({ ok: false, error: "this runtime does not read the newest release" });
    }
  });
});
