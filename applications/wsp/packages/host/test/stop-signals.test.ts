// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExecStream } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecStream } from "@wsp/protocol";
import { stayOnUncaught, stopOnSignals, type CliIO, type StopProcess, type UncaughtProcess } from "../src/cli.js";
import type { HostHandle } from "../src/server.js";
import { alive, grandchild, sweepStrays } from "../../runtime/test/strays.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO = (errors: string[] = []): CliIO => ({ log: () => {}, error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt });

/** Where the signals arrive and how the process ends, handed to the stop in place of this one: the test runner
 * cannot be sent a real signal, and the stop registers before any turn starts, the way the host does at its start. */
function standInHost(): { self: StopProcess; exits: number[]; signal: (sig: "SIGINT" | "SIGTERM" | "SIGHUP") => void; taken: () => string[] } {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  return {
    self: { on: (sig, listener) => listeners.set(sig, listener), exit: code => void exits.push(code) },
    exits,
    signal: sig => {
      const listener = listeners.get(sig);
      if (listener === undefined) throw new Error(`nothing on this host listens for ${sig}`);
      listener();
    },
    taken: () => [...listeners.keys()],
  };
}

describe("a serving host stopping on a signal", () => {
  let root: string;
  let runDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-stopsignals-"));
    runDir = join(root, "runs");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  /** A local turn whose tree holds a sleeping grandchild, so what is left of the group after a stop can be read. */
  async function turn(name: string): Promise<{ stream: ExecStream; pid: number }> {
    const marker = join(root, `${name}.pid`);
    const stream = localExecStream({ root, runDir })(`sleep 30 & echo $! > ${marker}; sleep 30`, { env: {} });
    void (async () => {
      for await (const line of stream.lines) void line;
    })().catch(() => undefined);
    return { stream, pid: await grandchild(marker) };
  }

  it("takes the three stop signals and nothing under it registers one of its own", async () => {
    const host = standInHost();
    stopOnSignals({ close: async () => {} } as unknown as HostHandle, quietIO(), host.self);
    expect(host.taken()).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    const counted = (): number[] => (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(sig => process.listenerCount(sig));
    const before = counted();
    const running = await turn("counted");
    expect(counted()).toEqual(before);
    running.stream.kill();
    await running.stream.exited;
  }, 20_000);

  it("the first signal closes and exits 0, and the turn running here is left running for the host that comes next", async () => {
    const host = standInHost();
    let closes = 0;
    const handle = { close: async () => void closes++ } as unknown as HostHandle;
    stopOnSignals(handle, quietIO(), host.self);
    const running = await turn("first");
    host.signal("SIGINT");
    await vi.waitFor(() => expect(host.exits).toEqual([0]), { timeout: 5_000 });
    expect(closes).toBe(1);
    // The turn's whole tree outlives the host: nothing in the stop reaches a process group it does not lead.
    expect(alive(running.pid)).toBe(true);
    running.stream.kill();
    await running.stream.exited;
  }, 20_000);

  it("a close that hangs cannot trap the terminal: a second signal exits at once and still leaves the turn", async () => {
    const host = standInHost();
    let closes = 0;
    const handle = {
      close: () => {
        closes++;
        return new Promise<void>(() => {});
      },
    } as unknown as HostHandle;
    stopOnSignals(handle, quietIO(), host.self);
    const running = await turn("hanging");
    host.signal("SIGINT");
    await vi.waitFor(() => expect(closes).toBe(1), { timeout: 5_000 });
    // The close never finishes, so nothing has exited: this is the escape hatch's road.
    expect(host.exits).toEqual([]);
    host.signal("SIGINT");
    await vi.waitFor(() => expect(host.exits).toEqual([130]), { timeout: 5_000 });
    expect(alive(running.pid)).toBe(true);
    expect(closes).toBe(1);
    running.stream.kill();
    await running.stream.exited;
  }, 20_000);
});

describe("a serving host meeting an error nothing caught", () => {
  /** Where the two events arrive, in place of this process: the real ones would end the test runner. It has no exit
   * to call, so the handler cannot end anything through it. */
  function standInProcess(): { self: UncaughtProcess; raise: (event: "unhandledRejection" | "uncaughtException", e: unknown) => void } {
    const listeners = new Map<string, (e: unknown) => void>();
    return {
      self: { on: (event, listener) => listeners.set(event, listener) },
      raise: (event, e) => {
        const listener = listeners.get(event);
        if (listener === undefined) throw new Error(`nothing on this host listens for ${event}`);
        listener(e);
      },
    };
  }

  it("says each in one line naming the error and where it came from, and registers nothing on the real process", () => {
    const errors: string[] = [];
    const before = (["unhandledRejection", "uncaughtException"] as const).map(event => process.listenerCount(event));
    const host = standInProcess();
    stayOnUncaught(quietIO(errors), host.self);
    host.raise("unhandledRejection", new TypeError("Cannot read properties of null (reading 'op')"));
    host.raise("uncaughtException", "a string thrown");
    expect(errors[0]).toMatch(/^unhandled rejection, kept serving: Cannot read properties of null \(reading 'op'\), at .*stop-signals\.test\.ts:\d+:\d+/);
    expect(errors.slice(1)).toEqual(["uncaught exception, kept serving: a string thrown"]);
    expect((["unhandledRejection", "uncaughtException"] as const).map(event => process.listenerCount(event))).toEqual(before);
  });
});
