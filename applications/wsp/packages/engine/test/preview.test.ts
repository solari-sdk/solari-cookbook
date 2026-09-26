// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/lifecycle.js";
import type { Machine, PreviewReach } from "../src/machine.js";
import { refreshPreviewToken } from "../src/preview.js";

/** A route that outlives every test here by an hour, as a provider's token would. */
const FRESH_MS = 60 * 60_000;

function stubMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "m1", kind: "sandbox",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    snapshot: async () => "snap_x", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async () => "https://x", uploadUrl: async () => "https://x",
    streamUrl: undefined, ...overrides,
  };
}

describe("refreshPreviewToken", () => {
  const reachAt = (expiresAt: number, tag = "a"): PreviewReach => ({
    url: `https://${tag}-7070.preview.getsolari.com?pt_token=t`,
    token: "t",
    expiresAt,
  });

  it("keeps a fresh reach without minting", async () => {
    const previewUrl = vi.fn(async () => reachAt(Date.now() + FRESH_MS, "new"));
    const m = stubMachine({ previewUrl });
    const current = reachAt(Date.now() + 30 * 60_000);
    expect(await refreshPreviewToken(m, 7070, current)).toBe(current);
    expect(previewUrl).not.toHaveBeenCalled();
  });

  it("remints when under 10 minutes remain (older than ~50 min)", async () => {
    const fresh = reachAt(Date.now() + FRESH_MS, "new");
    const previewUrl = vi.fn(async () => fresh);
    const m = stubMachine({ previewUrl });
    const stale = reachAt(Date.now() + 5 * 60_000);
    expect(await refreshPreviewToken(m, 7070, stale)).toBe(fresh);
    expect(previewUrl).toHaveBeenCalledWith(7070);
  });

  it("refuses on a backend without preview support", async () => {
    await expect(refreshPreviewToken(stubMachine(), 7070)).rejects.toThrow(/preview/i);
  });
});

const machineWithPreview = (id: string, expiresInMs: number) => {
  const previewUrl = vi.fn(async (port: number): Promise<PreviewReach> => ({
    url: `https://${id}-${port}.preview.getsolari.com?pt_token=t`,
    token: "t",
    expiresAt: Date.now() + expiresInMs,
  }));
  return { machine: stubMachine({ id, previewUrl }), previewUrl };
};

describe("Workspace.daemonReach", () => {
  it("mints once and reuses across calls on the same running machine", async () => {
    const { machine, previewUrl } = machineWithPreview("m1", FRESH_MS);
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", wakeAttempts: 2 });
    const first = await ws.daemonReach();
    expect(await ws.daemonReach()).toBe(first);
    expect(previewUrl).toHaveBeenCalledTimes(1);
  });

  it("a wake drops the cached routes: the first daemonReach after it mints again on the same machine", async () => {
    const { machine, previewUrl } = machineWithPreview("m1", FRESH_MS);
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", wakeAttempts: 2 });
    const first = await ws.daemonReach();
    await ws.nap();
    await ws.wake();
    const second = await ws.daemonReach();
    // No provider promises the route minted before a nap still stands after it; the machine is asked again.
    expect(second).not.toBe(first);
    expect(second.url).toBe(first.url);
    expect(previewUrl).toHaveBeenCalledTimes(2);
  });

  it("remints once the cached reach goes stale", async () => {
    const { machine, previewUrl } = machineWithPreview("m1", 5 * 60_000);
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", wakeAttempts: 2 });
    await ws.daemonReach();
    await ws.daemonReach();
    expect(previewUrl).toHaveBeenCalledTimes(2);
  });

  it("remints when the machine was replaced", async () => {
    const a = machineWithPreview("m1", FRESH_MS);
    const b = machineWithPreview("m2", FRESH_MS);
    const ws = new Workspace(a.machine, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => b.machine,
    });
    const first = await ws.daemonReach();
    await ws.upgrade();
    const second = await ws.daemonReach();
    expect(first.url).toContain("m1-7070");
    expect(second.url).toContain("m2-7070");
    expect(b.previewUrl).toHaveBeenCalledTimes(1);
  });
});

describe("Workspace.portReach", () => {
  it("caches per port: two ports mint twice, asking again reuses each, and 7070 is the daemon's own route", async () => {
    const { machine, previewUrl } = machineWithPreview("m1", FRESH_MS);
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", wakeAttempts: 2 });
    const a = await ws.portReach(3000);
    const b = await ws.portReach(5173);
    expect(a.url).toContain("m1-3000");
    expect(b.url).toContain("m1-5173");
    expect(await ws.portReach(3000)).toBe(a);
    expect(await ws.portReach(5173)).toBe(b);
    expect(previewUrl).toHaveBeenCalledTimes(2);
    const daemon = await ws.daemonReach();
    expect(await ws.portReach(7070)).toBe(daemon);
    expect(previewUrl).toHaveBeenCalledTimes(3);
  });

  it("a replaced machine voids every port's route", async () => {
    const a = machineWithPreview("m1", FRESH_MS);
    const b = machineWithPreview("m2", FRESH_MS);
    const ws = new Workspace(a.machine, { goldenSnapshot: "snap_g", wakeAttempts: 2, resurrect: async () => b.machine });
    expect((await ws.portReach(3000)).url).toContain("m1-3000");
    await ws.upgrade();
    expect((await ws.portReach(3000)).url).toContain("m2-3000");
    expect(b.previewUrl).toHaveBeenCalledTimes(1);
  });

  it("remintPortReach drops one port's fresh route and mints it again; the other ports keep theirs", async () => {
    const { machine, previewUrl } = machineWithPreview("m1", FRESH_MS);
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", wakeAttempts: 2 });
    const a = await ws.portReach(3000);
    const b = await ws.portReach(5173);
    const fresh = await ws.remintPortReach(3000);
    expect(fresh).not.toBe(a);
    expect(fresh.url).toContain("m1-3000");
    expect(await ws.portReach(3000)).toBe(fresh);
    expect(await ws.portReach(5173)).toBe(b);
    expect(previewUrl).toHaveBeenCalledTimes(3);
  });
});
