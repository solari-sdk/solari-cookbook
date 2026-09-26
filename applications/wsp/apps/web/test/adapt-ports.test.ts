// SPDX-License-Identifier: AGPL-3.0-only
// Listening ports from the daemon link into the browser pane's server list.
import { describe, expect, it } from "vitest";
import { applyPortEvent, applyPortsSnapshot, applyStoppedEvent, MOVED_WINDOW_MS, stoppedSentence, toPreviewableServers, type KnownPort, type StoppedPort } from "../src/adapt/index.js";

describe("applyPortsSnapshot / applyPortEvent", () => {
  it("seeds from the ports.watch reply, sorted, first pid wins on a duplicate", () => {
    expect(applyPortsSnapshot({ ports: [{ port: 5173, pid: 40, process: "node" }, { port: 3000 }, { port: 5173, pid: 41 }] })).toEqual([
      { port: 3000, pid: null, process: null },
      { port: 5173, pid: 40, process: "node" },
    ]);
  });

  const known = (port: number, pid: number | null, process: string | null = null): KnownPort => ({ port, pid, process });

  it.each<[string, KnownPort[], Parameters<typeof applyPortEvent>[1], KnownPort[]]>([
    ["daemon port.open adds with the process name", [], { type: "port.open", port: 3000, pid: 7, process: "node" }, [known(3000, 7, "node")]],
    ["runtime port.open adds too", [], { type: "port.open", workspaceId: "ws", port: 3000 }, [known(3000, null)]],
    ["re-open keeps the first pid", [known(3000, 7)], { type: "port.open", port: 3000, pid: 9 }, [known(3000, 7)]],
    ["close removes", [known(3000, 7), known(5173, null)], { type: "port.close", port: 3000 }, [known(5173, null)]],
    ["close of an unknown port changes nothing", [known(3000, 7)], { type: "port.close", workspaceId: "ws", port: 81 }, [known(3000, 7)]],
    ["open keeps the list sorted", [known(5173, null)], { type: "port.open", port: 80 }, [known(80, null), known(5173, null)]],
  ])("%s", (_name, before, event, after) => {
    expect(applyPortEvent(before, event)).toEqual(after);
    expect(applyPortEvent(before, event)).not.toBe(before);
  });
});

describe("toPreviewableServers", () => {
  it("uses the minted preview route when it exists and the loopback url otherwise; requestedUrl is always loopback", () => {
    const servers = toPreviewableServers({
      ports: [{ port: 3000, pid: 7, process: "node" }, { port: 5173, pid: null, process: null }],
      reachUrl: port => (port === 3000 ? "https://m1-3000.preview.example/?pt_token=e" : undefined),
    });
    expect(servers).toEqual([
      { host: "localhost", port: 3000, url: "https://m1-3000.preview.example/?pt_token=e", processName: "node", pid: 7, terminal: null, source: "scanner", requestedUrl: "http://localhost:3000" },
      { host: "localhost", port: 5173, url: "http://localhost:5173", processName: null, pid: null, terminal: null, source: "scanner", requestedUrl: "http://localhost:5173" },
    ]);
  });
});

describe("applyStoppedEvent", () => {
  const AT = "2026-09-05T12:04:00.000Z";
  const T0 = 1_000_000;
  const closeHeld = { type: "port.close", port: 8412, pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at: AT } as const;
  const heldRow: StoppedPort = { port: 8412, pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at: AT, seenAt: T0, movedTo: null };

  it("a close records who held the port and when, stamped with the local clock it arrived on", () => {
    const next = applyStoppedEvent(new Map(), closeHeld, T0);
    expect([...next.values()]).toEqual([heldRow]);
  });

  it("a plain close records the port with nothing known about its holder", () => {
    const next = applyStoppedEvent(new Map(), { type: "port.close", workspaceId: "ws", port: 3000 }, T0);
    expect(next.get(3000)).toEqual({ port: 3000, pid: null, process: null, command: null, exited: null, at: null, seenAt: T0, movedTo: null });
  });

  it("the same port opening again forgets the stop; an unrelated open returns the same map", () => {
    const stopped = applyStoppedEvent(new Map(), closeHeld, T0);
    expect(applyStoppedEvent(stopped, { type: "port.open", port: 5173, process: "node" }, T0 + 1)).toBe(stopped);
    expect(applyStoppedEvent(stopped, { type: "port.open", port: 8412, pid: 60000, process: "python3" }, T0 + 1).size).toBe(0);
  });

  it("the same process opening another port within a minute marks where it went; later or under another name it does not", () => {
    const stopped = applyStoppedEvent(new Map(), closeHeld, T0);
    const moved = applyStoppedEvent(stopped, { type: "port.open", port: 8413, pid: 60000, process: "python3" }, T0 + MOVED_WINDOW_MS);
    expect(moved.get(8412)).toEqual({ ...heldRow, movedTo: 8413 });
    expect(applyStoppedEvent(stopped, { type: "port.open", port: 8413, pid: 60000, process: "python3" }, T0 + MOVED_WINDOW_MS + 1)).toBe(stopped);
    expect(applyStoppedEvent(stopped, { type: "port.open", port: 8413, pid: 60000, process: "node" }, T0 + 1)).toBe(stopped);
    expect(applyStoppedEvent(stopped, { type: "port.open", port: 8413 }, T0 + 1)).toBe(stopped);
  });
});

describe("stoppedSentence", () => {
  const clock = () => "12:04";
  const base: StoppedPort = { port: 8412, pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at: "2026-09-05T12:04:00.000Z", seenAt: 0, movedTo: null };

  it.each<[string, StoppedPort | undefined, string]>([
    ["nothing known", undefined, ":8412 stopped listening"],
    ["time only", { ...base, pid: null, process: null, command: null, exited: null }, ":8412 stopped listening at 12:04"],
    ["holder that exited", base, ":8412 stopped listening at 12:04, held by python3 -m http.server 8412 (pid 53479), which exited"],
    ["holder still running", { ...base, exited: false }, ":8412 stopped listening at 12:04, held by python3 -m http.server 8412 (pid 53479), which is still running"],
    ["comm when the argv is unknown", { ...base, command: null }, ":8412 stopped listening at 12:04, held by python3 (pid 53479), which exited"],
    ["pid when neither comm nor argv is known", { ...base, process: null, command: null }, ":8412 stopped listening at 12:04, held by pid 53479, which exited"],
    ["moved to another port", { ...base, movedTo: 8413 }, ":8412 stopped listening at 12:04, held by python3 -m http.server 8412 (pid 53479), which exited, now on :8413"],
  ])("%s", (_name, stopped, sentence) => {
    expect(stoppedSentence(8412, stopped, clock)).toBe(sentence);
  });
});
