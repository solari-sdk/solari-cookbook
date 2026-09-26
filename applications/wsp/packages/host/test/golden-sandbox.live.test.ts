// SPDX-License-Identifier: AGPL-3.0-only
// The wizard's road end to end on the default builder kind: prepare through
// ready with the real recipe, dial the builder's daemon through its reach and
// open one pty, read the disk, seal. Nothing but poc-labelled machines may be
// left on the account afterwards.
import { SolariBackend, isReserved, type GoldenStage } from "@wsp/engine";
import { connectDaemon, createRuntime, memoryStore } from "@wsp/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";
import { goldenRecipe } from "../src/cli.js";

const LABEL = { wsp: "1", "wsp-test": "golden-sandbox-live" };

describe.runIf(LIVE)("golden on a sandbox builder (live)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);

  afterAll(async () => {
    if (!LIVE) return;
    for (const m of await backend.list()) {
      if (isReserved(m.labels)) continue;
      if (m.labels["wsp-test"] === LABEL["wsp-test"] && m.state !== "gone") {
        await (await backend.get(m.id)).kill().catch(() => {});
      }
    }
  });

  it("prepares with the real recipe, serves a terminal on the builder, and seals v1 of sandbox kind", { timeout: 900_000 }, async () => {
    const t0 = Date.now();
    const stages: { stage: GoldenStage; at: number; detail?: string }[] = [];
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: {},
      goldenRecipe: { ...goldenRecipe(), labels: LABEL },
    });
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") stages.push({ stage: e.stage, at: Date.now() - t0, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
    });

    const view = await rt.golden.prepare().catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.log(`[golden-sandbox.live] prepare failed: ${JSON.stringify(e, Object.getOwnPropertyNames(e as object))}\n` +
        stages.map(s => `  ${s.stage.padEnd(20)} ${String(s.at).padStart(7)}ms ${s.detail ?? ""}`).join("\n"));
      throw e;
    });
    let sealed: Awaited<ReturnType<typeof rt.golden.seal>> | undefined;
    let df = "";
    let pty = "";
    try {
      expect(view.kind).toBe("sandbox");
      expect(view.screen).toBeUndefined();
      expect(stages.map(s => s.stage)).toEqual(["creating", "deploying-daemon", "deploying-daemon", "installing-harness", "ready"]);
      expect(stages[2]?.detail).toMatch(/^node v\d+/);

      const reach = await rt.golden.builderReach(view.id);
      expect(reach.daemonToken).toBeDefined();
      const link = connectDaemon({ previewUrl: reach.url, token: reach.daemonToken!, heartbeatMs: 60_000, onEvent: () => {} });
      try {
        await link.ready;
        const created = await link.request("pty.create", { cols: 80, rows: 24 });
        pty = String(created["ptyId"]);
        expect(pty).not.toBe("");
      } finally {
        link.close();
      }

      const machine = await backend.get(view.id);
      const probe = await machine.exec("df -h | sed 1d; lsblk -o NAME,SIZE,MOUNTPOINT 2>/dev/null; node --version; claude --version", { timeoutMs: 60_000 });
      df = probe.stdout.trim();
      expect(probe.exitCode).toBe(0);

      const t1 = Date.now();
      sealed = await rt.golden.seal(view.id);
      // eslint-disable-next-line no-console
      console.log(
        `[golden-sandbox.live] prepare=${stages.find(s => s.stage === "ready")?.at}ms seal=${Date.now() - t1}ms pty=${pty}\n` +
          stages.map(s => `  ${s.stage.padEnd(20)} ${String(s.at).padStart(7)}ms ${s.detail ?? ""}`).join("\n") +
          `\n  df -h before seal: ${df.replace(/\n/g, " | ")}`,
      );
      expect(sealed.version).toMatchObject({ version: 1, kind: "sandbox", baseTemplate: "base", smoke: { exitCode: 0 } });
    } finally {
      await backend.get(view.id).then(m => m.kill()).catch(() => {});
      if (sealed) await backend.deleteSnapshot(sealed.version.snapshotId).catch(() => {});
    }

    const alive = (await backend.list()).filter(m => !isReserved(m.labels) && m.state !== "gone");
    expect(alive).toEqual([]);
  });
});
