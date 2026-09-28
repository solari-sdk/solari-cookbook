// SPDX-License-Identifier: AGPL-3.0-only
// What the host starts for the workspace that is this computer: the daemon
// its panes and Live rows dial, and the line whoever runs the host reads when
// it did not start.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localWiring, type LocalDaemonStart } from "../src/cli.js";
import { LocalDaemon } from "../src/local-daemon.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wsp-this-computer-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the daemon this computer's panes dial", () => {
  const failing = (tries: { n: number }, message: string): LocalDaemonStart => async () => {
    tries.n++;
    throw new Error(message);
  };

  it("says why it did not start in one line, once, whatever a redialling page asks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tries = { n: 0 };
    const wiring = localWiring(dir, { HOME: dir }, failing(tries, "wsp-daemon binary missing"));
    await expect(wiring.daemonRoad!()).rejects.toThrow("wsp-daemon binary missing");
    await expect(wiring.daemonRoad!()).rejects.toThrow("wsp-daemon binary missing");
    // The reason is not kept: every dial tries again, and the log reads the same reason once.
    expect(tries.n).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("wsp-daemon binary missing");
    expect(line).toMatch(/did not start/);
  });

  it("dials again after a failure rather than answering every later pane with the first one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const road = { url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" };
    let tries = 0;
    const start: LocalDaemonStart = async () => {
      if (tries++ === 0) throw new Error("address in use");
      return { road, close: async () => {} } as unknown as Awaited<ReturnType<LocalDaemonStart>>;
    };
    const wiring = localWiring(dir, { HOME: dir }, start);
    await expect(wiring.daemonRoad!()).rejects.toThrow("address in use");
    expect(await wiring.daemonRoad!()).toEqual(road);
    await wiring.close!();
  });

  it("starts another daemon on a restart, after closing the one it was holding", async () => {
    const closed: number[] = [];
    let started = 0;
    const start: LocalDaemonStart = async () => {
      const n = ++started;
      return {
        road: { url: `http://127.0.0.1:${n}`, expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" },
        close: async () => void closed.push(n),
      } as unknown as Awaited<ReturnType<LocalDaemonStart>>;
    };
    const wiring = localWiring(dir, { HOME: dir }, start);
    expect((await wiring.daemonRoad!()).url).toBe("http://127.0.0.1:1");
    await wiring.restartDaemon!();
    expect(closed).toEqual([1]);
    expect(started).toBe(2);
    expect((await wiring.daemonRoad!()).url).toBe("http://127.0.0.1:2");
    await wiring.close!();
  });

  it("starts one on a restart asked before any pane has dialled, which is the host whose first start failed", async () => {
    let started = 0;
    const start: LocalDaemonStart = async () => {
      started++;
      return { road: { url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }, close: async () => {} } as unknown as Awaited<ReturnType<LocalDaemonStart>>;
    };
    const wiring = localWiring(dir, { HOME: dir }, start);
    await wiring.restartDaemon!();
    expect(started).toBe(1);
    await wiring.close!();
  });

  it("raises the reason a restart could not start one, so the button that asked says what refused it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wiring = localWiring(dir, { HOME: dir }, failing({ n: 0 }, "address in use"));
    await expect(wiring.restartDaemon!()).rejects.toThrow("address in use");
  });

  it("hands a restart one bounded line from a daemon that panics at length, and its log every line", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bin = join(dir, "noisy-daemon");
    writeFileSync(bin, '#!/bin/sh\ni=0\nwhile [ $i -lt 400 ]; do echo "thread main panicked at src/main.rs:$i:5: called unwrap on an Err value" >&2; i=$((i+1)); done\nexit 101\n');
    chmodSync(bin, 0o755);
    const logged: string[] = [];
    const wiring = localWiring(dir, { HOME: dir }, opts => LocalDaemon.start({ ...opts, binary: bin }), join(dir, "state.json"), undefined, line => void logged.push(line));
    const why = await wiring.restartDaemon!().then(
      () => "",
      (e: unknown) => (e as Error).message,
    );
    expect(why).toMatch(/did not start/);
    expect(why).toContain("src/main.rs:399:5");
    expect(why.split("\n")).toHaveLength(1);
    expect(why.length).toBeLessThanOrEqual(300);
    expect(why).not.toContain(bin);
    expect(logged).toHaveLength(400);
  });

  it("reads this computer's Live rows off the same daemon the panes dial, started for them if nothing else has", async () => {
    const detached: string[] = [];
    let started = 0;
    const start: LocalDaemonStart = async () =>
      ({
        road: { url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" },
        sysSamples: async (fn: (s: { cpu: number }) => void) => {
          started++;
          fn({ cpu: 1 });
          return () => void detached.push("a");
        },
        close: async () => {},
      }) as unknown as Awaited<ReturnType<LocalDaemonStart>>;
    const wiring = localWiring(dir, { HOME: dir }, start);
    const samples: { cpu: number }[] = [];
    const detach = await wiring.sysSamples!(s => samples.push(s as { cpu: number }));
    expect(samples).toEqual([{ cpu: 1 }]);
    expect(started).toBe(1);
    detach();
    expect(detached).toEqual(["a"]);
    await wiring.close!();
  });
});
