// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { WorkspacePorts } from "../src/browser/model.js";

const WS = "ws_browser01";

describe("WorkspacePorts", () => {
  it("port.open adds, port.close drops, and a close for an unknown port drops nothing but is remembered", () => {
    let notified = 0;
    const d = new WorkspacePorts();
    d.onChange(() => notified++);
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 1, process: "nginx" });
    expect(d.ports()).toEqual([{ port: 80, pid: 1, process: "nginx" }]);
    const ports = d.ports();
    d.feedEvent({ type: "port.close", workspaceId: WS, port: 81 });
    expect(d.ports()).toBe(ports);
    expect(d.stopped(81)?.port).toBe(81);
    expect(notified).toBe(2);
    d.feedEvent({ type: "port.close", workspaceId: WS, port: 80 });
    expect(d.ports()).toEqual([]);
    expect(notified).toBe(3);
  });

  it("a re-open of a known port keeps the first pid and does not notify", () => {
    let notified = 0;
    const d = new WorkspacePorts();
    d.onChange(() => notified++);
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 1 });
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 2 });
    expect(d.ports()).toEqual([{ port: 80, pid: 1, process: null }]);
    expect(notified).toBe(1);
  });
});

describe("WorkspacePorts across a restart", () => {
  it("open, close, open for one port leaves it listed with the new pid", () => {
    const d = new WorkspacePorts();
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 8412, pid: 100, process: "node" });
    d.feedEvent({ type: "port.close", workspaceId: WS, port: 8412 });
    expect(d.ports()).toEqual([]);
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 8412, pid: 200, process: "node" });
    expect(d.ports()).toEqual([{ port: 8412, pid: 200, process: "node" }]);
    d.feedEvent({ type: "port.close", workspaceId: WS, port: 8412 });
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 8412 });
    expect(d.ports()).toEqual([{ port: 8412, pid: null, process: null }]);
  });
});

describe("WorkspacePorts.seeded", () => {
  it("is false until the daemon has said anything, then true even for an empty snapshot, with one notify", () => {
    let notified = 0;
    const d = new WorkspacePorts();
    d.onChange(() => notified++);
    expect(d.seeded()).toBe(false);
    d.syncPorts([]);
    expect(d.seeded()).toBe(true);
    expect(notified).toBe(1);
    d.syncPorts([]);
    expect(notified).toBe(1);
  });
});

describe("WorkspacePorts.syncPorts", () => {
  it("adopts the daemon's snapshot: adds missing, drops absent, sorted by port, notifies once", () => {
    let notified = 0;
    const d = new WorkspacePorts();
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 1 });
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 81 });
    d.onChange(() => notified++);
    d.syncPorts([{ port: 9000, pid: 5, process: "node" }, { port: 80, pid: 1 }]);
    expect(d.ports()).toEqual([
      { port: 80, pid: 1, process: null },
      { port: 9000, pid: 5, process: "node" },
    ]);
    expect(notified).toBe(1);
  });

  it("an identical snapshot changes nothing and does not notify", () => {
    let notified = 0;
    const d = new WorkspacePorts();
    d.syncPorts([{ port: 80, pid: 1 }]);
    const before = d.ports();
    d.onChange(() => notified++);
    d.syncPorts([{ port: 80, pid: 1 }]);
    expect(d.ports()).toBe(before);
    expect(notified).toBe(0);
  });

  it("ignores a malformed reply rather than clearing the directory", () => {
    const d = new WorkspacePorts();
    d.syncPorts([{ port: 80 }]);
    d.syncPorts(undefined);
    d.syncPorts("nope");
    d.syncPorts([{ port: "80" }]);
    d.syncPorts([null]);
    expect(d.ports()).toEqual([{ port: 80, pid: null, process: null }]);
  });
});

describe("WorkspacePorts.stopped", () => {
  const AT = "2026-09-05T12:04:00.000Z";
  it("a close keeps the holder for the port until it listens again, notifying on each change", () => {
    let notified = 0;
    let now = 1_000;
    const d = new WorkspacePorts(() => now);
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 8412, pid: 53479, process: "python3" });
    d.onChange(() => notified++);
    expect(d.stopped(8412)).toBeUndefined();
    d.feedEvent({ type: "port.close", workspaceId: WS, port: 8412, pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at: AT });
    expect(d.stopped(8412)).toEqual({ port: 8412, pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at: AT, seenAt: 1_000, movedTo: null });
    expect(notified).toBe(1);

    now = 31_000;
    const ports = d.ports();
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 8413, pid: 60000, process: "python3" });
    expect(d.stopped(8412)?.movedTo).toBe(8413);
    expect(notified).toBe(2);
    expect(d.ports()).not.toBe(ports);

    d.feedEvent({ type: "port.open", workspaceId: WS, port: 8412, pid: 60001, process: "python3" });
    expect(d.stopped(8412)).toBeUndefined();
    expect(notified).toBe(3);
  });

  it("a stop with nothing new for the directory still notifies, and the ports array keeps its identity", () => {
    let notified = 0;
    const d = new WorkspacePorts(() => 5);
    d.syncPorts([{ port: 80 }]);
    d.feedEvent({ type: "port.close", workspaceId: WS, port: 80 });
    const ports = d.ports();
    d.onChange(() => notified++);
    d.feedEvent({ type: "port.close", workspaceId: WS, port: 80, at: AT });
    expect(d.ports()).toBe(ports);
    expect(d.stopped(80)?.at).toBe(AT);
    expect(notified).toBe(1);
  });
});
