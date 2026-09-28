// SPDX-License-Identifier: AGPL-3.0-only
// Live: fork one golden, give it a three-minute idle window, leave it alone
// with the status poller running, and prove two things against the real
// provider: the runtime naps it with the idle reason, and the poller made no
// GET /sandboxes/:id in between (each one would have reset the provider's
// own idle timer, which is the bug this policy replaces).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SolariBackend } from "@wsp/engine";
import { GoldenManifest, goldenHead, type EventUnion, type WorkspaceStatus } from "@wsp/protocol";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn } from "./stub-backend.js";

const LIVE = process.env.WSP_LIVE === "1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEST_LABEL = { wsp: "1", "wsp-test": "idle", createdAt: new Date().toISOString() };
const WINDOW_MS = 3 * 60_000;

function apiKey(): string {
  const text = readFileSync(join(root, ".env"), "utf8");
  const m = text.match(/^SOLARI_API_KEY=(.+)$/m);
  if (!m?.[1]) throw new Error("Missing SOLARI_API_KEY in .env at repo root");
  return m[1].trim();
}

/** The golden already sealed on this account: the runtime store the host uses, or WSP_GOLDEN. */
function goldenId(): string {
  if (process.env.WSP_GOLDEN) return process.env.WSP_GOLDEN;
  const statePath = process.env.WSP_LIVE_STATE ?? join(homedir(), "wsp-live", ".home", "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { goldens?: Record<string, unknown> };
  const head = goldenHead(GoldenManifest.optional().parse(state.goldens?.["default"]));
  if (!head) throw new Error(`no golden head in ${statePath}; set WSP_GOLDEN`);
  return head.snapshotId;
}

const stamp = (): string => new Date().toISOString().slice(11, 19);
const isBareMachineGet = (url: string, init?: RequestInit): boolean =>
  (init?.method ?? "GET") === "GET" && /^\/sandboxes\/[^/]+$/.test(new URL(url).pathname);

describe.runIf(LIVE)("idle policy, live", () => {
  const gets: string[] = [];
  const backend = LIVE
    ? new SolariBackend({
        apiKey: apiKey(),
        fetch: (url, init) => {
          if (isBareMachineGet(String(url), init)) gets.push(`${stamp()} GET ${new URL(String(url)).pathname.slice(-12)}`);
          return fetch(url, init);
        },
      })
    : (undefined as never);
  const created: string[] = [];
  let rt: Runtime | undefined;

  afterAll(async () => {
    if (!LIVE) return;
    for (const w of (await rt?.workspaces.list()) ?? []) await rt?.workspaces.delete(w.id).catch(() => {});
    await rt?.close();
    for (const id of created) await backend.get(id).then(m => m.kill()).catch(() => {});
    for (const m of await backend.list()) {
      if ("poc" in m.labels) continue;
      if (m.labels["wsp-test"] === TEST_LABEL["wsp-test"]) await backend.get(m.id).then(x => x.kill()).catch(() => {});
    }
    for (const id of created) {
      const gone = await backend.get(id).then(m => m.state(), (e: unknown) => ((e as { kind?: string }).kind === "missing" ? "gone" : "unknown"));
      expect(gone, `machine ${id.slice(-16)} after cleanup`).toBe("gone");
    }
    // Other machines on the account are not this test's to touch: name them, assert none are ours.
    const left = (await backend.list()).filter(m => !("poc" in m.labels) && m.state !== "gone");
    for (const m of left) console.log(`left on the account (not ours): ${m.id.slice(-16)} ${m.state} ${JSON.stringify(m.labels)}`);
    expect(left.filter(m => m.labels["wsp-test"] === TEST_LABEL["wsp-test"])).toEqual([]);
  });

  it("naps an untouched fork after its window while the poller never asks the provider", { timeout: 12 * 60_000 }, async () => {
    const runningOthers = (await backend.list()).filter(m => m.state === "running");
    if (runningOthers.length >= 2) throw new Error(`no slot under the 2-machine cap: ${runningOthers.map(m => m.id.slice(-16)).join(", ")}`);

    const events: EventUnion[] = [];
    const statuses: WorkspaceStatus[] = [];
    rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    rt.events.on("*", e => events.push(e));
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));

    const t0 = Date.now();
    const ws = await createOn(rt, { golden: goldenId(), name: "idle-t51", labels: TEST_LABEL, idleWindowMs: WINDOW_MS });
    created.push(ws.machineId);
    console.log(`${stamp()} created ${ws.machineId.slice(-16)} in ${Date.now() - t0} ms, window ${WINDOW_MS / 60_000} min`);

    // The provider's word on the backstop, read once before the interval begins.
    const view = await backend.request<{ expiresAt?: string; timeoutMs?: number }>("GET", `/sandboxes/${encodeURIComponent(ws.machineId)}`);
    const listed = (await backend.list()).find(m => m.id === ws.machineId) as { expiresAt?: string } | undefined;
    const expiresAt = view.expiresAt ?? listed?.expiresAt;
    console.log(`${stamp()} provider view: timeoutMs=${view.timeoutMs ?? "absent"} expiresAt=${expiresAt ?? "absent"}`);
    if (expiresAt !== undefined) {
      const backstopMin = (Date.parse(expiresAt) - Date.now()) / 60_000;
      console.log(`${stamp()} backstop fires in ${backstopMin.toFixed(1)} min (asked for ${(2 * WINDOW_MS) / 60_000})`);
      expect(backstopMin).toBeGreaterThan((2 * WINDOW_MS) / 60_000 - 1.5);
      expect(backstopMin).toBeLessThan((2 * WINDOW_MS) / 60_000 + 1.5);
    }

    const [first] = await rt.status.list();
    console.log(`${stamp()} first status: machineState=${first!.machineState} reach=${first!.reach.state} idleAt=${first!.idleAt !== undefined ? new Date(first!.idleAt).toISOString().slice(11, 19) : "none"}`);
    expect(first!.idleAt).toBeGreaterThan(Date.now());

    const intervalStart = gets.length;
    const stop = rt.status.watch();
    const armedAt = Date.now();
    const deadline = armedAt + WINDOW_MS + 3 * 60_000;
    while ((await rt.workspaces.get(ws.id)).phase !== "napping") {
      if (Date.now() > deadline) throw new Error(`still ${(await rt.workspaces.get(ws.id)).phase} ${((Date.now() - armedAt) / 60_000).toFixed(1)} min after arming`);
      await new Promise(r => setTimeout(r, 5_000));
    }
    const nappedAt = Date.now();
    stop();
    const intervalGets = gets.slice(intervalStart);

    console.log(`${stamp()} napped ${((nappedAt - t0) / 1000).toFixed(0)} s after create`);
    let lastReach = "";
    for (const s of statuses) {
      if (s.reach.state === lastReach) continue;
      lastReach = s.reach.state;
      console.log(`  reach ${s.reach.state} machineState=${s.machineState} phase=${s.phase}${s.reason ? ` reason="${s.reason}"` : ""}`);
    }
    for (const g of intervalGets) console.log(`  provider asked: ${g}`);

    expect(events.filter(e => e.type === "workspace.napped")).toHaveLength(1);
    const napStatus = statuses.find(s => s.phase === "napping");
    expect(napStatus).toMatchObject({ machineState: "paused", reach: { state: "napping" }, reason: "idle 3 min" });
    expect(intervalGets, "GET /sandboxes/:id during the interval").toEqual([]);
    expect(nappedAt - t0).toBeGreaterThanOrEqual(WINDOW_MS);

    // Allowed now, the interval is over: the provider agrees it is paused.
    expect(await backend.get(ws.machineId).then(m => m.state())).toBe("paused");
  });
});
