// SPDX-License-Identifier: AGPL-3.0-only
// host.restart over the wire: answered before the host goes, refused in the
// road's own words where a restart would not bring it back, and refused on a
// socket a ticket let in.
import { HOST_NO_RESTART_LINE, HOST_RESTART_TICKET_REFUSAL } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, serveRuntime, type RestartDoor, type RuntimeServer } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { WsClient, wsRequest } from "./ws-client.js";

describe("restarting the host over the wire", () => {
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });
  const serving = async (restart?: RestartDoor): Promise<RuntimeServer> => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    srv = await serveRuntime(rt, { port: 0, authToken: "t", ...(restart !== undefined ? { restart } : {}) });
    return srv;
  };

  it("answers first and restarts after, so the page reads its reply before the host goes", async () => {
    const restart = vi.fn(async () => {
      await srv?.close();
      srv = undefined;
    });
    const { port } = await serving({ restart });
    expect(await wsRequest(port, "t", { op: "host.restart" })).toMatchObject({ ok: true });
    await expect.poll(() => restart.mock.calls.length).toBe(1);
  });

  it("starts one restart for asks that overlap, answering each", async () => {
    let finish: () => void = () => undefined;
    const restart = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
    const { port } = await serving({ restart });
    expect(await wsRequest(port, "t", { op: "host.restart" })).toMatchObject({ ok: true });
    expect(await wsRequest(port, "t", { op: "host.restart" })).toMatchObject({ ok: true });
    finish();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("refuses in the road's own words where a restart would not bring the host back, and restarts nothing", async () => {
    const restart = vi.fn(async () => undefined);
    const { port } = await serving({ refusal: "Ctrl-C the terminal running wsp up and run it again.", restart });
    expect(await wsRequest(port, "t", { op: "host.restart" })).toMatchObject({ ok: false, error: "Ctrl-C the terminal running wsp up and run it again." });
    expect(restart).not.toHaveBeenCalled();
  });

  it("refuses a socket a ticket let in, since a restart is the computer's own", async () => {
    const restart = vi.fn(async () => undefined);
    const { port } = await serving({ restart });
    const host = await WsClient.connect(port, { token: "t" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(port, { ticket });
    try {
      expect(await relayed.request("host.restart")).toMatchObject({ ok: false, error: HOST_RESTART_TICKET_REFUSAL });
    } finally {
      relayed.close();
    }
    expect(restart).not.toHaveBeenCalled();
  });

  it("a server with no restart road refuses in the one line the release view carries for it", async () => {
    const { port } = await serving();
    expect(await wsRequest(port, "t", { op: "host.restart" })).toMatchObject({ ok: false, error: HOST_NO_RESTART_LINE });
  });

  it("a restart that failed while the host still serves lets a later ask start another", async () => {
    const lines: string[] = [];
    const restart = vi.fn().mockRejectedValueOnce(new Error("the host is still starting")).mockResolvedValue(undefined);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    srv = await serveRuntime(rt, { port: 0, authToken: "t", restart: { restart }, log: line => lines.push(line) });
    expect(await wsRequest(srv.port, "t", { op: "host.restart" })).toMatchObject({ ok: true });
    await expect.poll(() => lines).toContain("host.restart failed: the host is still starting");
    expect(await wsRequest(srv.port, "t", { op: "host.restart" })).toMatchObject({ ok: true });
    await expect.poll(() => restart.mock.calls.length).toBe(2);
  });
});
