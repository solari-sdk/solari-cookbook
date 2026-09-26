// SPDX-License-Identifier: AGPL-3.0-only
// Live canary: post every create body wsp sends to the real provider and, on a
// refusal, quote the provider's answer word for word next to the body sent.
// On the morning of 2026-09-04 the host pool refused diskGb, a field it had
// accepted and ignored two days earlier, and every init booted nothing until a
// person read the error off a live run; by 17:22Z the same day it honoured it
// (a 20 GB root on the guest), so every body here carries diskGb 20 and the
// cases that can still reach their machine read the granted size back off GET,
// since a dropped or misspelled disk field boots the 4 GB default and says
// nothing. Each case builds its body with the code the runtime calls, asserts
// the 201, and kills what it made by recorded id. The listing case pins the
// row fields the sweep's cost and owner lines read; the exec case pins the
// 29 s cut every inline timeout and detached run rests on.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { WspError } from "../src/errors.js";
import { BUILDER_IDLE_MS, forkGolden, goldenHead, killUntilGone, prepareBuilder, sealGolden, type GoldenManifest } from "../src/golden.js";
import { BUILDER_DISK_GB } from "../src/tool-sizes.js";
import type { Machine } from "../src/machine.js";
import { SolariBackend } from "../src/solari-backend.js";
import { LIVE, sleep, solariKey } from "./live.js";

const TEST = "create-canary";
const OWNER = "h_canary";
const SIZE = { cpu: 2, memMb: 4096 };
const ENVS = { WSP_CANARY: "1" };

/** The labels the runtime stamps, with a foreign owner so no host's sweep claims these machines. */
const labelsFor = (role: Record<string, string>): Record<string, string> => ({
  wsp: "1",
  ...role,
  "wsp-owner": OWNER,
  "wsp-test": TEST,
  createdAt: new Date().toISOString(),
});

const short = (id: string): string => `${id.slice(0, 20)}...`;
// Cleanup may run killUntilGone, three kills with a 30 s grace each, per leftover
// machine plus a snapshot delete; vitest's default hook budget is 10 s.
const CLEANUP_MS = 180_000;

interface Create {
  status: number;
  body: Record<string, unknown>;
  reply: Record<string, unknown>;
  key: string | null;
  replayed: boolean;
}

/** The provider's answer word for word, minus the fields that double as credentials on a
 * success; the body sent with env names only, so a case forking with real envs prints no value. */
const refused = (c: Create): string => {
  const reply = { ...c.reply };
  for (const k of ["sandboxId", "controlUrl", "streamUrl"]) delete reply[k];
  const body = { ...c.body, ...(c.body.envs !== undefined ? { envs: Object.keys(c.body.envs as object) } : {}) };
  return `POST /sandboxes answered ${c.status} with ${JSON.stringify(reply)}; body sent: ${JSON.stringify(body)}`;
};

describe.runIf(LIVE)("create canary, live", () => {
  const creates: Create[] = [];
  const created: string[] = [];
  const backend = LIVE
    ? new SolariBackend({
        apiKey: solariKey(),
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
            creates.push({
              status: res.status,
              body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
              reply,
              key: new Headers(init?.headers).get("Idempotency-Key"),
              replayed: res.headers.get("Idempotent-Replayed") === "true",
            });
            if (res.status === 201 && typeof reply.sandboxId === "string") created.push(reply.sandboxId);
          }
          return res;
        },
      })
    : (undefined as never);
  let manifest: GoldenManifest | undefined;

  const stateOf = (id: string): Promise<string> =>
    backend.get(id).then(
      m => m.state(),
      (e: unknown) => ((e as WspError).kind === "missing" ? "gone" : Promise.reject(e)),
    );

  /** The disk the provider granted, read off GET by id: the one place that says whether the asked-for size took. */
  const grantedDiskGb = async (m: Machine): Promise<number | undefined> => (await m.describe?.())?.diskGb;

  /** Runs one create through the real code and judges the POST it sent, not the exception it raised. */
  async function posted<T>(run: () => Promise<T>): Promise<{ result: T; create: Create }> {
    const mark = creates.length;
    let failure: unknown;
    let result: T | undefined;
    try {
      result = await run();
    } catch (e) {
      failure = e;
    }
    const create = creates.slice(mark).reverse()[0];
    if (create === undefined) throw failure ?? new Error("no POST /sandboxes was sent");
    expect(create.status, refused(create)).toBe(201);
    if (failure !== undefined) throw failure;
    return { result: result as T, create };
  }

  afterAll(async () => {
    if (!LIVE) return;
    const alive: string[] = [];
    for (const id of created) {
      if ((await stateOf(id)) === "gone") continue;
      await killUntilGone(backend, await backend.get(id)).catch(() => alive.push(id));
    }
    const snapshotId = goldenHead(manifest)?.snapshotId;
    let snapshot = "no snapshot";
    if (snapshotId !== undefined) {
      snapshot = await backend.deleteSnapshot(snapshotId).then(
        () => "snapshot deleted",
        (e: unknown) => `snapshot ${snapshotId} not deleted: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    console.log(`[create-canary] ${created.length} machine${created.length === 1 ? "" : "s"} created, ${alive.length === 0 ? "all gone" : `still alive: ${alive.map(short).join(", ")}`}; ${snapshot}`);
    if (alive.length > 0) throw new Error(`machines still alive after the canary: ${alive.join(", ")}`);
  }, CLEANUP_MS);

  it("builder: the body prepareBuilder posts is accepted", { timeout: 180_000 }, async () => {
    const { result: builder, create } = await posted(() =>
      prepareBuilder({ backend, ...SIZE, envs: ENVS, labels: labelsFor({ "wsp-builder": "1" }), setup: "true" }),
    );
    expect(create.body).toMatchObject({ kind: "sandbox", template: "base", ...SIZE, diskGb: BUILDER_DISK_GB, lifecycle: { onTimeout: "kill" }, timeoutMs: BUILDER_IDLE_MS });
    const disk = await grantedDiskGb(builder.machine);
    console.log(`[create-canary] builder ${short(builder.machine.id)}: 201 for ${Object.keys(create.body).join(", ")}; built as cpu ${builder.size.cpu} memMb ${builder.size.memMb} diskGb ${disk}`);
    expect(disk, "GET /sandboxes/:id did not grant the disk the body asked for").toBe(BUILDER_DISK_GB);
    await killUntilGone(backend, builder.machine);
    expect(await stateOf(builder.machine.id)).toBe("gone");
  });

  it("smoke fork: the body sealGolden posts from a fresh snapshot is accepted", { timeout: 300_000 }, async () => {
    const { result: builder } = await posted(() =>
      prepareBuilder({ backend, ...SIZE, envs: ENVS, labels: labelsFor({ "wsp-builder": "1" }), setup: "true" }),
    );
    const stages: string[] = [];
    const { result, create } = await posted(() =>
      sealGolden(builder, {
        backend,
        hostId: "live",
        smoke: "true",
        ...SIZE,
        envs: ENVS,
        labels: labelsFor({ "wsp-smoke": "1" }),
        onStage: (stage, detail) => stages.push(detail === undefined ? stage : `${stage}:${detail}`),
      }),
    );
    manifest = result.manifest;
    // The seal kills the smoke fork before this returns, so its disk cannot be read back; the body is what this case pins.
    expect(create.body).toMatchObject({ kind: "sandbox", fromSnapshot: result.version.snapshotId, ...SIZE, diskGb: BUILDER_DISK_GB });
    const forkId = String(create.reply.sandboxId);
    console.log(`[create-canary] smoke fork ${short(forkId)}: 201 for ${Object.keys(create.body).join(", ")}; stages ${stages.join(" > ")}`);
    expect(await stateOf(builder.machine.id)).toBe("gone");
    expect(await stateOf(forkId)).toBe("gone");
  });

  it("workspace fork: the body forkGolden posts is accepted", { timeout: 180_000 }, async () => {
    if (manifest === undefined) throw new Error("nothing to fork: the smoke fork case sealed no snapshot");
    const sealed = manifest;
    const { result: fork, create } = await posted(() => forkGolden(backend, sealed, { ...SIZE, envs: ENVS, labels: labelsFor({}) }));
    expect(create.body).toMatchObject({ kind: "sandbox", fromSnapshot: sealed.versions[0]?.snapshotId, ...SIZE, diskGb: BUILDER_DISK_GB });
    const disk = await grantedDiskGb(fork);
    console.log(`[create-canary] fork ${short(fork.id)}: 201 for ${Object.keys(create.body).join(", ")}; diskGb ${disk}`);
    expect(disk, "GET /sandboxes/:id did not grant the disk the fork asked for").toBe(BUILDER_DISK_GB);
    await killUntilGone(backend, fork);
    expect(await stateOf(fork.id)).toBe("gone");
  });

  it("the same body twice under one key replays the first machine instead of booting a second", { timeout: 180_000 }, async () => {
    const labels = labelsFor({});
    const spec = { kind: "sandbox" as const, template: "base", cpu: 1, memMb: 2048, labels, idempotencyKey: `${TEST}/${randomUUID()}` };
    const { result: first, create: booted } = await posted(() => backend.create(spec));
    try {
      const { result: second, create: again } = await posted(() => backend.create(spec));
      console.log(`[create-canary] key ${spec.idempotencyKey}: first ${short(first.id)} replayed ${booted.replayed}, second ${short(second.id)} replayed ${again.replayed}`);
      expect(booted.key).toBe(spec.idempotencyKey);
      expect(again.key).toBe(spec.idempotencyKey);
      expect(booted.replayed).toBe(false);
      expect(again.replayed, "the second POST under the same key did not answer Idempotent-Replayed: true").toBe(true);
      expect(second.replayed).toBe(true);
      expect(second.id).toBe(first.id);
      expect(again.reply).toEqual(booted.reply);
    } finally {
      await killUntilGone(backend, first);
    }
    expect(await stateOf(first.id)).toBe("gone");
  });

  it("the raw exec cuts a 40 s command with a 502, and run carries the same command to its end", { timeout: 600_000 }, async () => {
    const { result: m } = await posted(() => backend.create({ kind: "sandbox", template: "base", cpu: 1, memMb: 2048, labels: labelsFor({}) }));
    try {
      // Every inline timeout in wsp assumes the exec endpoint answers 502 at about 29 s for a command still running
      // (measured 2026-09-05); request() retries a 502 twice, so the raw call takes about three cuts to fail.
      const t0 = Date.now();
      const raw = await m.exec("sleep 40; echo done", { timeoutMs: 300_000 }).then(
        r => ({ answered: r }),
        (e: unknown) => ({ refused: e as WspError }),
      );
      const rawS = ((Date.now() - t0) / 1000).toFixed(1);
      if ("answered" in raw) {
        throw new Error(`the exec cap moved: sleep 40 answered exit ${raw.answered.exitCode} with ${JSON.stringify(raw.answered.stdout)} after ${rawS} s; INLINE_EXEC_MS and every run() deadline rest on the 29 s cut`);
      }
      console.log(`[create-canary] raw exec of sleep 40 on ${short(m.id)}: ${raw.refused.kind} ${raw.refused.status} ${JSON.stringify(raw.refused.message)} after ${rawS} s`);
      expect(raw.refused.status, "the exec endpoint no longer answers 502 for a command still running").toBe(502);

      const t1 = Date.now();
      const lines: string[] = [];
      const run = await m.run("sleep 40; echo done", { deadlineMs: 180_000, onLine: l => lines.push(l) });
      console.log(`[create-canary] run of sleep 40 on ${short(m.id)}: exit ${run.exitCode} ${JSON.stringify(run.stdout)} after ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      expect(run).toEqual({ exitCode: 0, stdout: "done\n", stderr: "" });
      expect(lines).toEqual(["done"]);
    } finally {
      await killUntilGone(backend, m);
    }
    expect(await stateOf(m.id)).toBe("gone");
  });

  it("listing rows carry metadata, cpu and memMb for a machine just created", { timeout: 180_000 }, async () => {
    interface Row { sandboxId: string; state: string; metadata?: Record<string, string>; cpu?: number; memMb?: number }
    const labels = labelsFor({});
    const { result: m } = await posted(() => backend.create({ kind: "sandbox", template: "base", cpu: 1, memMb: 2048, labels }));
    try {
      let row: Row | undefined;
      for (let attempt = 1; attempt <= 6 && row === undefined; attempt++) {
        const page = await backend.request<{ sandboxes?: Row[] }>("GET", `/sandboxes?metadata.wsp-test=${TEST}`);
        row = (page.sandboxes ?? []).find(r => r.sandboxId === m.id);
        if (row === undefined) await sleep(2000);
      }
      if (row === undefined) throw new Error(`the listing never showed ${short(m.id)} in six reads over ten seconds`);
      for (const field of ["metadata", "cpu", "memMb"] as const) {
        expect(row, `listing row lacks ${field}: ${JSON.stringify(row)}`).toHaveProperty(field);
      }
      expect(row.metadata).toEqual(labels);
      expect(typeof row.cpu).toBe("number");
      expect(typeof row.memMb).toBe("number");
      console.log(`[create-canary] listing row for ${short(m.id)}: state ${row.state}, cpu ${row.cpu}, memMb ${row.memMb}, metadata keys ${Object.keys(row.metadata ?? {}).join(", ")}`);
    } finally {
      await killUntilGone(backend, m);
    }
    expect(await stateOf(m.id)).toBe("gone");
  });
});
