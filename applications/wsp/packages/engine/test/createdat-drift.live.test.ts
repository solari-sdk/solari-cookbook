// SPDX-License-Identifier: AGPL-3.0-only
// Live and opt-in (WSP_LIVE=1 WSP_LIVE_LONG=1): a measurement, not a guard.
// The provider's createdAt on a never-paused sandbox tracks the wall clock
// about five minutes behind (measured 2026-09-04: +6 s at 2 min, +306 s at
// 10 min, +3606 s at 65 min), so nothing in wsp reads it for a decision. This
// case records the readings so the next person can see whether that changed.
// One base sandbox with the builder's lifecycle, read right after create and
// at 2, 10 and 65 minutes, never exec'd or paused, then killed by id. About
// $0.11 at Starter rates.

import { afterAll, describe, expect, it } from "vitest";
import type { WspError } from "../src/errors.js";
import { BUILDER_IDLE_MS, killUntilGone } from "../src/golden.js";
import { SolariBackend } from "../src/solari-backend.js";
import { LIVE, sleep, solariKey } from "./live.js";

const LONG = LIVE && process.env.WSP_LIVE_LONG === "1";
const READ_AT_MIN = [2, 10, 65];

interface View { state: string; createdAt?: string; expiresAt?: string }
// Cleanup may run killUntilGone, three kills with a 30 s grace each; vitest's
// default hook budget is 10 s.
const CLEANUP_MS = 180_000;

describe.runIf(LONG)("createdAt drift, live", () => {
  const backend = LONG ? new SolariBackend({ apiKey: solariKey() }) : (undefined as never);
  let id: string | undefined;

  afterAll(async () => {
    if (id === undefined) return;
    const state = await backend.get(id).then(
      m => m.state(),
      (e: unknown) => ((e as WspError).kind === "missing" ? "gone" : Promise.reject(e)),
    );
    if (state !== "gone") await killUntilGone(backend, await backend.get(id));
    console.log(`[createdat-drift] ${id.slice(0, 20)}... ${state === "gone" ? "was already gone" : "killed by id"}`);
  }, CLEANUP_MS);

  it("records createdAt on a never-paused sandbox right after create and at 2, 10 and 65 minutes", { timeout: 70 * 60_000 }, async () => {
    const t0 = Date.now();
    const m = await backend.create({
      kind: "sandbox",
      template: "base",
      cpu: 2,
      memMb: 4096,
      onIdle: "kill",
      idleTimeoutMs: BUILDER_IDLE_MS,
      labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": "h_canary", "wsp-test": "createdat-drift", createdAt: new Date(t0).toISOString() },
    });
    id = m.id;
    const readings: { atMin: number; view: View; readAt: string }[] = [];
    const read = async (atMin: number): Promise<View> => {
      const view = await backend.request<View>("GET", `/sandboxes/${encodeURIComponent(m.id)}`);
      const readAt = new Date().toISOString();
      readings.push({ atMin, view, readAt });
      console.log(`[createdat-drift] t+${atMin} min (${readAt}): state ${view.state}, createdAt ${view.createdAt}, expiresAt ${view.expiresAt}`);
      return view;
    };
    let drifts: { atMin: number; state: string; driftS: number }[] = [];
    try {
      const first = await read(0);
      if (first.createdAt === undefined) throw new Error(`GET right after create carries no createdAt: ${JSON.stringify(first)}`);
      for (const min of READ_AT_MIN) {
        await sleep(t0 + min * 60_000 - Date.now());
        await read(min);
      }
    } finally {
      // The summary covers whatever was read, so a run cut short still reports its measurement.
      const birth = Date.parse(readings[0]?.view.createdAt ?? "");
      drifts = readings.slice(1).map(r => ({
        atMin: r.atMin,
        state: r.view.state,
        driftS: r.view.createdAt === undefined ? Number.NaN : (Date.parse(r.view.createdAt) - birth) / 1000,
      }));
      console.log(`[createdat-drift] ${readings.length} of ${READ_AT_MIN.length + 1} reads; drift from the first read: ${drifts.length === 0 ? "none taken" : drifts.map(d => `${d.atMin} min ${d.driftS.toFixed(1)} s`).join(", ")}`);
      await killUntilGone(backend, m);
    }
    const paused = drifts.filter(d => d.state !== "running");
    expect(paused, `the machine left running: ${JSON.stringify(paused)}; the reading needs a never-paused machine`).toEqual([]);
    const after = await backend.get(m.id).then(
      x => x.state(),
      (e: unknown) => ((e as WspError).kind === "missing" ? "gone" : Promise.reject(e)),
    );
    expect(after).toBe("gone");
  });
});
