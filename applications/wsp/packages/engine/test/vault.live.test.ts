import { afterAll, describe, expect, it } from "vitest";
import { buildGolden, forkGolden } from "../src/golden.js";
import { SolariBackend } from "../src/solari-backend.js";
import { exportPaths, importInto } from "../src/vault.js";
import type { Machine } from "../src/machine.js";
import { GOLDEN_SETUP } from "@wsp/catalog";
import { claudeEnvs, isReserved, LIVE, liveEnv } from "./live.js";

const TEST_LABEL = { wsp: "1", "wsp-test": "vault-live" };
const CLAUDE_FLAGS = "--output-format json --dangerously-skip-permissions </dev/null";

describe.runIf(LIVE)("vault (live: P8 replay, cross-machine claude resume)", () => {
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

  it("moves a session between machines: export cfg, fresh fork, --resume recalls", { timeout: 600_000 }, async () => {
    const { manifest, version } = await buildGolden({
      backend, hostId: "live", baseTemplate: "base", cpu: 2, memMb: 4096,
      envs: claudeEnvs(env), labels: TEST_LABEL,
      setup: GOLDEN_SETUP, smoke: "claude --version",
    });

    let a: Machine | undefined;
    let b: Machine | undefined;
    try {
      a = await forkGolden(backend, manifest, { envs: claudeEnvs(env), labels: TEST_LABEL });
      const turn1 = await a.exec(
        `claude -p "Remember this codeword: MANGOSTEEN-77. Confirm you stored it." ${CLAUDE_FLAGS}`,
        { timeoutMs: 180_000 },
      );
      expect(turn1.exitCode).toBe(0);
      const sid = (turn1.stdout.match(/"session_id"\s*:\s*"([a-f0-9-]+)"/) ?? [])[1];
      expect(sid).toBeTruthy();

      const turn2 = await a.exec(
        `claude -p --resume ${sid} "Also remember: the launch city is Bengaluru." ${CLAUDE_FLAGS}`,
        { timeoutMs: 180_000 },
      );
      expect(turn2.exitCode).toBe(0);

      const t0 = Date.now();
      const vaulted = await exportPaths(a, ["/root/.claude-cfg"]);
      const tExport = Date.now() - t0;
      expect(vaulted.length).toBeGreaterThan(1000);
      await a.kill();
      a = undefined;

      b = await forkGolden(backend, manifest, { envs: claudeEnvs(env), labels: TEST_LABEL });
      const t1 = Date.now();
      // Export tars are rooted at /, so a faithful restore extracts at /.
      await importInto(b, vaulted, "/");
      const tImport = Date.now() - t1;

      const recall = await b.exec(
        `claude -p --resume ${sid} "In one line: what is the codeword and what is the launch city?" ${CLAUDE_FLAGS}`,
        { timeoutMs: 180_000 },
      );
      // eslint-disable-next-line no-console
      console.log(`[vault.live] vault=${vaulted.length}B export=${tExport}ms import=${tImport}ms recall.exit=${recall.exitCode} stderr=${recall.stderr.slice(-200)}`);
      expect(recall.exitCode).toBe(0);
      expect(recall.stdout).toMatch(/MANGOSTEEN-77/);
      expect(recall.stdout).toMatch(/Bengaluru/i);
    } finally {
      await a?.kill().catch(() => {});
      await b?.kill().catch(() => {});
      await backend.deleteSnapshot(version.snapshotId).catch(() => {});
    }

    const leftovers = (await backend.list()).filter(
      x => x.labels["wsp-test"] === TEST_LABEL["wsp-test"] && x.state === "running",
    );
    expect(leftovers).toEqual([]);
  });
});
