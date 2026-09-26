// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DaemonEvent, EventUnion, PortForward, RuntimeRequest } from "../src/index.js";

describe("localhost forward wire shapes", () => {
  it("localhost.url carries a port the laptop can bind, and nothing else", () => {
    for (const port of [1024, 8123, 65535]) expect(DaemonEvent.parse({ type: "localhost.url", port })).toEqual({ type: "localhost.url", port });
    for (const port of [80, 1023, 65536, 70000, 1.5, -1, "8123"]) expect(() => DaemonEvent.parse({ type: "localhost.url", port })).toThrow();
    expect(() => DaemonEvent.parse({ type: "localhost.url" })).toThrow();
  });

  it("a forward names the workspace by id and by name, the port, when it opened, and which kind it is", () => {
    const f = { workspaceId: "ws_1", port: 8123, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" };
    expect(PortForward.parse(f)).toEqual(f);
    expect(PortForward.parse({ ...f, kind: "callback" })).toEqual({ ...f, kind: "callback" });
    expect(() => PortForward.parse({ ...f, port: 80 })).toThrow();
    expect(() => PortForward.parse({ ...f, kind: "other" })).toThrow();
    const { kind: _k, ...noKind } = f;
    expect(() => PortForward.parse(noKind)).toThrow();
    expect(() => PortForward.parse({ workspaceId: "ws_1", port: 8123, name: "api", kind: "url" })).toThrow();
    expect(() => PortForward.parse({ workspaceId: "ws_1", port: 8123, startedAt: f.startedAt, kind: "url" })).toThrow();
  });

  it("forward.open and forward.close ride the runtime event stream", () => {
    const f = { workspaceId: "ws_1", port: 8123, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" };
    expect(EventUnion.parse({ type: "forward.open", forward: f })).toEqual({ type: "forward.open", forward: f });
    expect(EventUnion.parse({ type: "forward.close", workspaceId: "ws_1", port: 8123 })).toEqual({ type: "forward.close", workspaceId: "ws_1", port: 8123 });
    expect(() => EventUnion.parse({ type: "forward.open" })).toThrow();
    expect(() => EventUnion.parse({ type: "forward.close", workspaceId: "ws_1", port: 80 })).toThrow();
  });

  it("forwards.list takes nothing; forwards.stop names a workspace and a bindable port", () => {
    expect(RuntimeRequest.parse({ id: 1, op: "forwards.list" })).toEqual({ id: 1, op: "forwards.list" });
    expect(RuntimeRequest.parse({ id: 2, op: "forwards.stop", workspaceId: "ws_1", port: 8123 })).toEqual({ id: 2, op: "forwards.stop", workspaceId: "ws_1", port: 8123 });
    expect(() => RuntimeRequest.parse({ id: 3, op: "forwards.stop", workspaceId: "ws_1" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 4, op: "forwards.stop", workspaceId: "ws_1", port: 80 })).toThrow();
  });
});
