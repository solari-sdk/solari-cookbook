// SPDX-License-Identifier: AGPL-3.0-only
// One restart road per way a host comes up: the service exits and its manager
// brings it back, a verb's host starts its successor on its own ports and
// exits, and a host wsp up holds in a terminal refuses, since nothing would
// bring it back.
import { UP_RESTART_LINE } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { restartRoads, type RestartingHost } from "../src/restart.js";

function recorded(respawn: (ports: { port: number; wsPort: number }) => Promise<unknown> = async () => undefined, close: () => Promise<void> = async () => undefined) {
  const steps: string[] = [];
  const host: RestartingHost = {
    port: 7101,
    wsPort: 7102,
    close: async () => {
      steps.push("close");
      await close();
    },
  };
  const roads = restartRoads({
    exit: code => void steps.push(`exit ${code}`),
    respawn: async ports => {
      steps.push(`respawn ${ports.port} ${ports.wsPort}`);
      await respawn(ports);
    },
    log: line => void steps.push(`log ${line}`),
  });
  return { steps, host, roads };
}

describe("the restart roads", () => {
  it("the service closes and exits 0, which its manager's KeepAlive or Restart=always brings back on the same line", async () => {
    const { steps, host, roads } = recorded();
    expect(roads.service.refusal).toBeUndefined();
    await roads.service.restart(host);
    expect(steps).toEqual(["close", "exit 0"]);
  });

  it("a verb's host closes, then starts its successor on the ports it held, then exits", async () => {
    const { steps, host, roads } = recorded();
    expect(roads.verb.refusal).toBeUndefined();
    await roads.verb.restart(host);
    expect(steps).toEqual(["close", "respawn 7101 7102", "exit 0"]);
  });

  it("a verb's host whose successor never served says so in its log and exits 1, since nothing serves now", async () => {
    const { steps, host, roads } = recorded(async () => {
      throw new Error("no host answered within 30 s");
    });
    await roads.verb.restart(host);
    expect(steps).toEqual(["close", "respawn 7101 7102", "log the host that was to replace this one did not serve: no host answered within 30 s", "exit 1"]);
  });

  it("a service whose close failed still exits, so its manager brings a host back rather than a process that serves nothing", async () => {
    const { steps, host, roads } = recorded(undefined, async () => {
      throw new Error("the lock is gone");
    });
    await roads.service.restart(host);
    expect(steps).toEqual(["close", "log the host did not close cleanly: the lock is gone", "exit 1"]);
  });

  it("a verb's host whose close failed starts no successor and exits 1, so the next command starts a host", async () => {
    const { steps, host, roads } = recorded(undefined, async () => {
      throw new Error("the lock is gone");
    });
    await roads.verb.restart(host);
    expect(steps).toEqual(["close", "log the host did not close cleanly: the lock is gone", "exit 1"]);
  });

  it("a host wsp up holds in a terminal does not come back from a restart, so it refuses in the terminal's words and closes nothing", async () => {
    const { steps, host, roads } = recorded();
    expect(roads.up.refusal).toBe(UP_RESTART_LINE);
    await expect(roads.up.restart(host)).rejects.toThrow(UP_RESTART_LINE);
    expect(steps).toEqual([]);
  });

  it("names each road by the shape it serves", () => {
    const { roads } = recorded();
    for (const [started, road] of Object.entries(roads)) expect(road.shape).toBe(started);
  });
});
