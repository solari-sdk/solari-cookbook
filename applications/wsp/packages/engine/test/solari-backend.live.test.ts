import { afterAll, describe, expect, it } from "vitest";
import { SolariBackend } from "../src/solari-backend.js";
import { isReserved, LIVE, liveEnv, sleep } from "./live.js";

const TEST_LABEL = { wsp: "1", "wsp-test": "backend-smoke" };

describe.runIf(LIVE)("SolariBackend (live)", () => {
  const backend = LIVE ? new SolariBackend({ apiKey: liveEnv().SOLARI_API_KEY }) : (undefined as never);

  afterAll(async () => {
    if (!LIVE) return;
    const all = await backend.list();
    for (const m of all) {
      if (isReserved(m.labels)) continue;
      if (m.labels["wsp-test"] === TEST_LABEL["wsp-test"] && m.state !== "gone") {
        await (await backend.get(m.id)).kill().catch(() => {});
      }
    }
  });

  it("create -> running -> exec pong -> kill -> gone", { timeout: 180_000 }, async () => {
    const m = await backend.create({ kind: "sandbox", template: "base", cpu: 1, memMb: 2048, labels: TEST_LABEL });
    try {
      let state = await m.state();
      const deadline = Date.now() + 60_000;
      while (state !== "running" && Date.now() < deadline) {
        await sleep(1000);
        state = await m.state();
      }
      expect(state).toBe("running");

      const r = await m.exec("echo pong");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("pong");
    } finally {
      await m.kill();
    }

    let state = await m.state();
    const deadline = Date.now() + 30_000;
    while (state !== "gone" && Date.now() < deadline) {
      await sleep(1000);
      state = await m.state();
    }
    expect(state).toBe("gone");

    // Cap hygiene: nothing from this test may remain running.
    const leftovers = (await backend.list()).filter(
      x => x.labels["wsp-test"] === TEST_LABEL["wsp-test"] && x.state === "running",
    );
    expect(leftovers).toEqual([]);
  });
});
