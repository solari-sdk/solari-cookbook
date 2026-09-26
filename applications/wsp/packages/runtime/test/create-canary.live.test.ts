// SPDX-License-Identifier: AGPL-3.0-only
// Live canary for the workspace body the runtime posts. forkSpec is built
// inside the runtime, so the only way to post the real body is to run the
// runtime: one base sandbox is snapshotted and killed to give the fork a
// source, the fork is created through workspaces.create over a backend whose
// fetch records the POST, and removed through workspaces.delete. On a refusal
// the failure quotes the provider's answer word for word beside the body sent.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { killUntilGone, SolariBackend, type WspError } from "@wsp/engine";
import { backstopMs, DEFAULT_IDLE_WINDOW_MS } from "../src/idle.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn } from "./stub-backend.js";

const LIVE = process.env.WSP_LIVE === "1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEST_LABEL = { "wsp-test": "create-canary-runtime" };
/** A foreign owner on the source sandbox, so no host's sweep reads it as an orphan. */
const SOURCE_LABELS = { wsp: "1", "wsp-owner": "h_canary", ...TEST_LABEL };

function apiKey(): string {
  const text = readFileSync(join(root, ".env"), "utf8");
  const m = text.match(/^SOLARI_API_KEY=(.+)$/m);
  if (!m?.[1]) throw new Error("Missing SOLARI_API_KEY in .env at repo root");
  return m[1].trim();
}

interface Create {
  status: number;
  body: Record<string, unknown>;
  reply: Record<string, unknown>;
}

/** The provider's answer word for word, minus the fields that double as credentials on a
 * success; the body sent with env names only, so a case forking with real envs prints no value. */
const refused = (c: Create): string => {
  const reply = { ...c.reply };
  for (const k of ["sandboxId", "controlUrl", "streamUrl"]) delete reply[k];
  const body = { ...c.body, ...(c.body.envs !== undefined ? { envs: Object.keys(c.body.envs as object) } : {}) };
  return `POST /sandboxes answered ${c.status} with ${JSON.stringify(reply)}; body sent: ${JSON.stringify(body)}`;
};

const short = (id: string): string => `${id.slice(0, 20)}...`;
// Cleanup may run killUntilGone, three kills with a 30 s grace each, per leftover
// machine plus a snapshot delete; vitest's default hook budget is 10 s.
const CLEANUP_MS = 180_000;

describe.runIf(LIVE)("workspace create canary, live", () => {
  const creates: Create[] = [];
  const created: string[] = [];
  const backend = LIVE
    ? new SolariBackend({
        apiKey: apiKey(),
        fetch: async (url, init) => {
          const res = await fetch(url, init);
          if ((init?.method ?? "GET") === "POST" && new URL(String(url)).pathname === "/sandboxes") {
            const text = await res.clone().text();
            let reply: Record<string, unknown>;
            try {
              reply = JSON.parse(text) as Record<string, unknown>;
            } catch {
              reply = { error: text };
            }
            creates.push({ status: res.status, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, reply });
            if (res.status === 201 && typeof reply.sandboxId === "string") created.push(reply.sandboxId);
          }
          return res;
        },
      })
    : (undefined as never);
  let rt: Runtime | undefined;
  let snapshotId: string | undefined;

  const stateOf = (id: string): Promise<string> =>
    backend.get(id).then(
      m => m.state(),
      (e: unknown) => ((e as WspError).kind === "missing" ? "gone" : Promise.reject(e)),
    );

  afterAll(async () => {
    if (!LIVE) return;
    for (const w of (await rt?.workspaces.list()) ?? []) await rt?.workspaces.delete(w.id).catch(() => {});
    await rt?.close();
    const alive: string[] = [];
    for (const id of created) {
      if ((await stateOf(id)) === "gone") continue;
      await killUntilGone(backend, await backend.get(id)).catch(() => alive.push(id));
    }
    let snapshot = "no snapshot";
    if (snapshotId !== undefined) {
      snapshot = await backend.deleteSnapshot(snapshotId).then(
        () => "snapshot deleted",
        (e: unknown) => `snapshot ${snapshotId} not deleted: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    console.log(`[create-canary-runtime] ${created.length} machine${created.length === 1 ? "" : "s"} created, ${alive.length === 0 ? "all gone" : `still alive: ${alive.map(short).join(", ")}`}; ${snapshot}`);
    if (alive.length > 0) throw new Error(`machines still alive after the canary: ${alive.join(", ")}`);
  }, CLEANUP_MS);

  it("workspace fork: the body workspaces.create posts is accepted, and delete leaves it gone", { timeout: 300_000 }, async () => {
    const source = await backend.create({ kind: "sandbox", template: "base", cpu: 1, memMb: 2048, labels: { ...SOURCE_LABELS, createdAt: new Date().toISOString() } });
    snapshotId = await source.snapshot("create-canary-source", { firstLife: true });
    await killUntilGone(backend, source);

    rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const mark = creates.length;
    let failure: unknown;
    let ws: Awaited<ReturnType<Runtime["workspaces"]["create"]>> | undefined;
    try {
      ws = await createOn(rt, { golden: snapshotId, name: "canary", labels: TEST_LABEL });
    } catch (e) {
      failure = e;
    }
    const create = creates.slice(mark).reverse()[0];
    if (create === undefined) throw failure ?? new Error("no POST /sandboxes was sent");
    expect(create.status, refused(create)).toBe(201);
    if (failure !== undefined) throw failure;
    if (ws === undefined) throw new Error("workspaces.create returned nothing");

    expect(create.body).toMatchObject({
      kind: "sandbox",
      fromSnapshot: snapshotId,
      cpu: backend.pricing.defaultSize.cpu,
      memMb: backend.pricing.defaultSize.memMb,
      metadata: { wsp: "1", ...TEST_LABEL },
      lifecycle: { onTimeout: "pause" },
      timeoutMs: backstopMs(DEFAULT_IDLE_WINDOW_MS),
    });
    const metadata = create.body.metadata as Record<string, string>;
    expect(metadata["wsp-owner"]).toMatch(/^h_/);
    expect(Date.parse(metadata.createdAt ?? "")).not.toBeNaN();
    console.log(`[create-canary-runtime] workspace fork ${short(ws.machineId)}: 201 for ${Object.keys(create.body).join(", ")}; timeoutMs ${String(create.body.timeoutMs)}`);

    await rt.workspaces.delete(ws.id);
    let state = await stateOf(ws.machineId);
    for (const deadline = Date.now() + 30_000; state !== "gone" && Date.now() < deadline; ) {
      await new Promise(r => setTimeout(r, 1000));
      state = await stateOf(ws.machineId);
    }
    expect(state, `workspace machine ${short(ws.machineId)} after workspaces.delete`).toBe("gone");
  });
});
