import { describe, it, expect } from "vitest";
import { SolariError } from "@solarisdk/browser";

import { sessionLivenessCheck } from "../../src/checks/session-liveness.js";
import { createDoctorContext } from "../../src/context.js";
import { fakeSolari, fakeClock, type FakeBrowserOptions } from "../fixtures/fake-browser.js";
import { EXPLANATIONS } from "../../src/explain.js";

const KEY = "slr_live_abcd_efghijklmnop_qrstuvwxyz0123456789";

async function runWith(script: FakeBrowserOptions = {}) {
  const { solari, calls } = fakeSolari(script);
  const { clock, slept } = fakeClock();
  const base = createDoctorContext({ apiKey: KEY, clock });
  const ctx = { ...base, browser: () => solari };
  const result = await sessionLivenessCheck.run(ctx);
  return { result, calls, slept };
}

describe("check metadata", () => {
  it("is cheap and depends on auth", () => {
    expect(sessionLivenessCheck.id).toBe("session-liveness");
    expect(sessionLivenessCheck.costTier).toBe("cheap");
    expect(sessionLivenessCheck.dependsOn).toEqual(["auth"]);
  });

  it("describes a structural check, not a reproduction", () => {
    expect(sessionLivenessCheck.description).toMatch(/connection, not the status field/i);
  });
});

describe("the documented signals", () => {
  it("passes when isConnected() flips after the session is released", async () => {
    const { result } = await runWith({ connected: [true, false] });

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({
      connectedWhileAlive: true,
      connectedAfterRelease: false,
      disconnectedEventFired: true,
    });
  });

  it("ends the session server-side rather than closing it locally", async () => {
    // A local close is not what a session dying under a running program looks
    // like; releaseAndWait is.
    const { calls } = await runWith({ connected: [true, false] });
    expect(calls.released).toHaveLength(1);
  });

  it("records a throwing page call without matching on its class", async () => {
    const { result } = await runWith({
      connected: [true, false],
      newPage: () => {
        // The real thrown class arrived bundler-renamed as TargetClosedError2.
        const error = new Error("browser.newPage: Target page, context or browser has been closed");
        error.name = "TargetClosedError2";
        throw error;
      },
    });

    expect(result.evidence).toMatchObject({ pageCallThrew: true, thrownClass: "Error" });
  });

  it("still passes when the disconnected event never fires", async () => {
    // Corroborating only: isConnected() is the primary signal.
    const { result } = await runWith({
      connected: [true, false],
      emitDisconnectOnRelease: false,
    });

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ disconnectedEventFired: false });
  });

  it("polls rather than waiting a fixed period", async () => {
    const { result, slept } = await runWith({ connected: [true, true, true, false] });

    expect(result.status).toBe("pass");
    // Two sleeps of 250ms, then the flip on the third read.
    expect(slept).toEqual([250, 250]);
    expect(result.evidence).toMatchObject({ waitedMs: 500 });
  });
});

describe("when the connection signal does not work", () => {
  it("fails if isConnected() stays true past the ceiling", async () => {
    const { result } = await runWith({ connected: [true] });

    expect(result.status).toBe("fail");
    expect(result.message).toContain("still reported true");
    expect(result.evidence).toMatchObject({ connectedAfterRelease: true, waitedMs: 5000 });
  });

  it("points at the status field being unreliable, citing issue #25", async () => {
    const { result } = await runWith({ connected: [true] });

    expect(result.remediation).toContain("GET /sessions/:id");
    expect(result.issueRef).toBe("solari-cookbook#25");
  });
});

describe("this is not a #25 reproduction (design.md §6.7, §13)", () => {
  it("never waits anything like the ten-minute session lifetime", async () => {
    const { slept } = await runWith({ connected: [true] });
    const total = slept.reduce((sum, ms) => sum + ms, 0);

    expect(total).toBeLessThanOrEqual(5_000);
    expect(total).toBeLessThan(600_000);
  });

  it("leaves the ten-minute finding to --explain", async () => {
    const { result } = await runWith({ connected: [true, false] });

    // The check reports its own structural observation; the narrative lives in
    // the explanation, which performs no I/O.
    expect(result.message).not.toContain("600");
    expect(result.message).not.toMatch(/ten minutes|10 minutes/i);
    expect(EXPLANATIONS["session-liveness"]).toContain("issue #25");
  });

  it("never queries the status endpoint it warns about", async () => {
    const { calls } = await runWith({ connected: [true, false] });
    expect(calls.launched).toBe(1);
    expect(calls.released).toHaveLength(1);
  });
});

describe("infrastructure failures", () => {
  it("maps a launch failure through the shared error layer", async () => {
    const { result } = await runWith({
      launch: () => {
        // The real browser SDK exports one error class (finding F39).
        throw new SolariError("Solari POST /sessions failed: 401", 401);
      },
    });

    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ status: 401, product: "browser" });
    expect(result.message).not.toContain("still reported true");
  });

  it("maps a release failure", async () => {
    const { result } = await runWith({
      connected: [true, false],
      releaseAndWait: () => {
        throw new SolariError("gateway error", 503);
      },
    });

    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ status: 503 });
  });
});

describe("the session is always cleaned up", () => {
  it("never closes the shared client — the CLI disposes of it (F43)", async () => {
    const { calls } = await runWith({ connected: [true, false] });
    expect(calls.clientClosed).toBe(0);
  });

  it("closes the session when it was never released", async () => {
    const { calls } = await runWith({
      connected: [true, false],
      releaseAndWait: () => {
        throw new SolariError("boom", 500);
      },
    });

    expect(calls.closed).toBe(1);
  });

  it("does not double-release a session it already released", async () => {
    const { calls } = await runWith({ connected: [true, false] });
    expect(calls.closed).toBe(0);
    expect(calls.released).toHaveLength(1);
  });

  it("does not close the client when launch failed", async () => {
    const { calls } = await runWith({
      launch: () => {
        throw new SolariError("nope", 401);
      },
    });
    expect(calls.clientClosed).toBe(0);
  });
});

describe("evidence is safe for --report", () => {
  it("redacts a key echoed by the gateway", async () => {
    const { result } = await runWith({
      launch: () => {
        throw new SolariError(`rejected ${KEY}`, 401);
      },
    });

    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("records only primitives", async () => {
    const { result } = await runWith({ connected: [true, false] });
    for (const value of Object.values(result.evidence ?? {})) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });
});

describe("the check never throws", () => {
  it("returns a result for every failure shape", async () => {
    const shapes: unknown[] = [new SolariError("x", 401), new Error("x"), "a string", null, 5];

    for (const shape of shapes) {
      const { result } = await runWith({
        launch: () => {
          throw shape;
        },
      });
      expect(result.id).toBe("session-liveness");
      expect(result.status).toBe("fail");
    }
  });
});
