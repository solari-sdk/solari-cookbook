import { afterAll, describe, expect, it } from "vitest";
import { buildGolden, forkGolden, prepareBuilder, sealGolden } from "../src/golden.js";
import { SolariBackend } from "../src/solari-backend.js";
import type { Machine } from "../src/machine.js";
import { GOLDEN_SETUP } from "@wsp/catalog";
import { claudeEnvs, isReserved, LIVE, liveEnv } from "./live.js";

const TEST_LABEL = { wsp: "1", "wsp-test": "golden-live" };

describe.runIf(LIVE)("golden pipeline (live: P1+P2 replay)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);

  afterAll(async () => {
    if (!LIVE) return;
    for (const m of await backend.list()) {
      if (isReserved(m.labels)) continue;
      if (m.labels["wsp-test"] === TEST_LABEL["wsp-test"] && m.state !== "gone") {
        await (await backend.get(m.id)).kill().catch(() => {});
      }
    }
  });

  it("builds a claude golden, forks it, and the fork answers headless", { timeout: 420_000 }, async () => {
    const t0 = Date.now();
    const { manifest, version } = await buildGolden({
      backend,
      hostId: "live",
      baseTemplate: "base",
      cpu: 2,
      memMb: 4096,
      envs: claudeEnvs(env),
      labels: TEST_LABEL,
      setup: GOLDEN_SETUP,
      smoke: "claude --version",
    });
    const tBuild = Date.now() - t0;
    expect(version.smoke.exitCode).toBe(0);
    expect(version.snapshotId).toMatch(/^snap_/);

    let fork: Machine | undefined;
    try {
      const t1 = Date.now();
      fork = await forkGolden(backend, manifest, { envs: claudeEnvs(env), labels: TEST_LABEL });
      const tFork = Date.now() - t1;

      const t2 = Date.now();
      const r = await fork.exec(
        "claude -p 'say ok' --output-format json --dangerously-skip-permissions </dev/null",
        { timeoutMs: 180_000 },
      );
      const tTurn = Date.now() - t2;
      // eslint-disable-next-line no-console
      console.log(`[golden.live] build=${tBuild}ms fork=${tFork}ms turn=${tTurn}ms`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('"result"');
    } finally {
      await fork?.kill().catch(() => {});
      await backend.deleteSnapshot(version.snapshotId).catch(() => {});
    }

    const leftovers = (await backend.list()).filter(
      x => x.labels["wsp-test"] === TEST_LABEL["wsp-test"] && x.state === "running",
    );
    expect(leftovers).toEqual([]);
  });
});

describe.runIf(LIVE)("interactive golden (live: prepare, sit, seal)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);
  const label = { ...TEST_LABEL, "wsp-test": "golden-wizard-live" };

  afterAll(async () => {
    if (!LIVE) return;
    for (const m of await backend.list()) {
      if (isReserved(m.labels)) continue;
      if (m.labels["wsp-test"] === label["wsp-test"] && m.state !== "gone") {
        await (await backend.get(m.id)).kill().catch(() => {});
      }
    }
  });

  it("prepares a desktop builder with claude on it, seals v1 of desktop kind, and ends at zero machines", { timeout: 600_000 }, async () => {
    const stages: string[] = [];
    const t0 = Date.now();
    const builder = await prepareBuilder({
      backend,
      kind: "desktop",
      cpu: 2,
      memMb: 4096,
      envs: claudeEnvs(env),
      labels: label,
      setup: GOLDEN_SETUP,
      onStage: s => stages.push(s),
    });
    const tPrepare = Date.now() - t0;
    let sealed: Awaited<ReturnType<typeof sealGolden>> | undefined;
    try {
      expect(builder.kind).toBe("desktop");
      expect(builder.machine.streamUrl, "a desktop builder streams a display").toMatch(/^wss?:\/\//);
      const inBuilder = await builder.machine.exec("claude --version", { timeoutMs: 60_000 });
      expect(inBuilder.exitCode).toBe(0);

      const t1 = Date.now();
      sealed = await sealGolden(builder, {
        backend,
        hostId: "live",
        smoke: "claude --version",
        envs: claudeEnvs(env),
        labels: label,
        onStage: s => stages.push(s),
      });
      // eslint-disable-next-line no-console
      console.log(`[golden-wizard.live] prepare=${tPrepare}ms seal=${Date.now() - t1}ms stages=${stages.join(">")}`);
      expect(sealed.manifest.head).toBe(1);
      expect(sealed.version).toMatchObject({ version: 1, kind: "desktop", baseTemplate: "default" });
      expect(stages).toEqual([
        "creating", "installing-harness", "ready", "snapshotting", "smoke-forking", "sealed",
      ]);
    } finally {
      await builder.machine.kill().catch(() => {});
      if (sealed) await backend.deleteSnapshot(sealed.version.snapshotId).catch(() => {});
    }

    const alive = (await backend.list()).filter(
      x => x.labels["wsp-test"] === label["wsp-test"] && x.state !== "gone",
    );
    expect(alive).toEqual([]);
  });
});
