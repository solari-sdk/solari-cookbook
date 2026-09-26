// SPDX-License-Identifier: AGPL-3.0-only
// Live: pause and wake one golden fork five times through the verified wake
// path and print each timing, so a resume that hands back a zombie (running
// per GET, guest never serves) is caught, retried, replaced, and recorded
// with its machine id and provider view for the Solari bundle.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SolariBackend, type MachineShape } from "@wsp/engine";
import { GoldenManifest, goldenHead, type EventUnion } from "@wsp/protocol";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn } from "./stub-backend.js";

const LIVE = process.env.WSP_LIVE === "1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEST_LABEL = { wsp: "1", "wsp-test": "wake", createdAt: new Date().toISOString() };
const CYCLES = 5;

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

const fmt = (ms: number): string => (ms < 10_000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

describe.runIf(LIVE)("verified wake, live", () => {
  const backend = LIVE ? new SolariBackend({ apiKey: apiKey() }) : (undefined as never);
  const created: string[] = [];
  let rt: Runtime | undefined;

  afterAll(async () => {
    if (!LIVE) return;
    for (const w of (await rt?.workspaces.list()) ?? []) await rt?.workspaces.delete(w.id).catch(() => {});
    // Fleet truth is persisted ids + get(id); list() is best-effort and only sweeps stragglers by label.
    for (const id of created) {
      await backend.get(id).then(m => m.kill()).catch(() => {});
    }
    for (const m of await backend.list()) {
      if ("poc" in m.labels) continue;
      if (m.labels["wsp-test"] === TEST_LABEL["wsp-test"]) await backend.get(m.id).then(x => x.kill()).catch(() => {});
    }
    for (const id of created) {
      const gone = await backend.get(id).then(m => m.state(), (e: unknown) => ((e as { kind?: string }).kind === "missing" ? "gone" : "unknown"));
      expect(gone, `machine ${id.slice(-16)} after cleanup`).toBe("gone");
    }
    // list() lags a DELETE by seconds; a few retries separate that from a real leak.
    let left: string[] = [];
    for (let i = 0; i < 6; i++) {
      left = (await backend.list()).filter(m => !("poc" in m.labels) && m.state !== "gone").map(m => m.id);
      if (left.length === 0) break;
      await new Promise(r => setTimeout(r, 5_000));
    }
    console.log(`non-poc machines left on the account: ${left.length}`);
    expect(left).toEqual([]);
  });

  it(`forks the golden, then naps and wakes it ${CYCLES} times through the verified path`, { timeout: 20 * 60_000 }, async () => {
    const golden = goldenId();
    const events: EventUnion[] = [];
    const shapes: string[] = [];
    rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    rt.events.on("*", e => events.push(e));
    rt.events.on("workspace.created", e => { if (e.type === "workspace.created") created.push(e.workspace.machineId); });
    rt.events.on("workspace.woken", e => { if (e.type === "workspace.woken") created.push(e.machineId); });

    const t0 = Date.now();
    const ws = await createOn(rt, { golden, name: "wake-live", labels: TEST_LABEL });
    const born = await (await backend.get(ws.machineId)).describe!();
    console.log(`fork ${ws.machineId} in ${fmt(Date.now() - t0)} from ${golden}; shape ${JSON.stringify(born)}`);
    await rt.workspaces.exec(ws.id, "echo nap-vault-marker > /root/nap-marker.txt");

    const rows: string[] = [];
    for (let i = 1; i <= CYCLES; i++) {
      const before = (await rt.workspaces.get(ws.id)).machineId;
      const n0 = Date.now();
      await rt.workspaces.nap(ws.id);
      const napMs = Date.now() - n0;
      const w0 = Date.now();
      const woken = await rt.workspaces.wake(ws.id);
      const wakeMs = Date.now() - w0;
      const status = events.filter(e => e.type === "workspace.status").at(-1);
      const reason = status?.type === "workspace.status" ? status.status.reason : undefined;
      const shape: MachineShape = await (await backend.get(woken.machineId)).describe!();
      shapes.push(JSON.stringify(shape));
      const marker = await rt.workspaces.exec(ws.id, "cat /root/nap-marker.txt");
      rows.push(
        `cycle ${i}: nap ${fmt(napMs)}, wake ${fmt(wakeMs)}, machine ${before === woken.machineId ? "kept" : `REPLACED ${before} -> ${woken.machineId}`}` +
          `, view ${JSON.stringify(shape)}, marker ${marker.stdout.trim() || `(exit ${marker.exitCode})`}${reason ? `, reason: ${reason}` : ""}`,
      );
      console.log(rows.at(-1));
      expect(woken.phase).toBe("running");
      expect(marker.stdout.trim()).toBe("nap-vault-marker");
    }
    console.log(["", "verified wake, live:", ...rows].join("\n"));
    const zombies = events.filter(e => e.type === "workspace.woken" && e.resurrected);
    console.log(`resurrections: ${zombies.length}`);
  });
});
