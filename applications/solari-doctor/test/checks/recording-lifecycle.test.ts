import { describe, it, expect } from "vitest";
import { SolariError } from "@solarisdk/browser";

import { recordingLifecycleCheck } from "../../src/checks/recording-lifecycle.js";
import { createDoctorContext } from "../../src/context.js";
import { fakeSolari, fakeClock, type FakeBrowserOptions } from "../fixtures/fake-browser.js";

const KEY = "slr_live_abcd_efghijklmnop_qrstuvwxyz0123456789";

async function runWith(script: FakeBrowserOptions = {}, replayPollMs = 45_000) {
  const { solari, calls } = fakeSolari(script);
  const { clock, slept } = fakeClock();
  const base = createDoctorContext({ apiKey: KEY, clock, deadlines: { replayPollMs } });
  const ctx = { ...base, browser: () => solari };
  const result = await recordingLifecycleCheck.run(ctx);
  return { result, calls, slept };
}

/** A replay that 404s a few times and then appears. */
function replayAfter(polls: number): FakeBrowserOptions["getReplayUrl"] {
  return (_id, callIndex) => {
    if (callIndex < polls) throw new SolariError("replay not ready", 404);
    return { url: "https://replay.example/x", expiresInSeconds: 900, contentEncoding: "gzip" };
  };
}

describe("check metadata", () => {
  it("is expensive, so it runs only under --full", () => {
    expect(recordingLifecycleCheck.id).toBe("recording-lifecycle");
    expect(recordingLifecycleCheck.costTier).toBe("expensive");
    expect(recordingLifecycleCheck.dependsOn).toEqual(["auth"]);
  });
});

describe("the documented behaviour", () => {
  it("requests recording at session creation, not afterwards", async () => {
    const { calls } = await runWith();
    // Recording is per-session; the flag has to be passed at creation.
    expect(calls.launchOptions).toEqual([{ recording: true }]);
  });

  it("passes when a replay appears immediately", async () => {
    const { result } = await runWith();

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({
      recordingRequested: true,
      replayAvailable: true,
      polls: 1,
      expiresInSeconds: 900,
      contentEncoding: "gzip",
    });
  });

  it("keeps polling through 404s while the upload is in flight", async () => {
    const { result, slept } = await runWith({ getReplayUrl: replayAfter(3) });

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ polls: 4, replayAvailable: true });
    expect(slept).toEqual([2000, 2000, 2000]);
  });

  it("reports how long it actually waited", async () => {
    const { result } = await runWith({ getReplayUrl: replayAfter(2) });
    expect(result.evidence).toMatchObject({ waitedMs: 4000 });
  });

  it("never waits in the test suite — the clock is injected", async () => {
    const started = Date.now();
    await runWith({ getReplayUrl: replayAfter(20) });
    // 20 polls of 2s would be 40 real seconds if the clock were real.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("A6 variance is stated, not hidden", () => {
  it("separates Solari's documented figure from our margin, on the pass path", async () => {
    const { result } = await runWith();
    const text = result.remediation ?? "";

    expect(text).toContain("Solari documents ~30s");
    expect(text).toContain("our margin rather than a documented figure");
    expect(text).toContain("8.2s");
    expect(result.evidence).toMatchObject({ documentedWindowMs: 30_000, ourCeilingMs: 45_000 });
  });

  it("cites the variance rather than implying a breached guarantee, on the fail path", async () => {
    const { result } = await runWith(
      { getReplayUrl: () => { throw new SolariError("not ready", 404); } },
      6_000,
    );

    expect(result.status).toBe("fail");
    expect(result.remediation).toContain("independent runs during this project");
    expect(result.remediation).toContain("treat this as inconclusive");
    // No language suggesting Solari failed to meet a commitment.
    expect(result.remediation).not.toMatch(/SLA|violat|guarantee|breach/i);
    expect(result.message).toContain("within 6s");
  });

  it("records both numbers so a report can show the gap", async () => {
    const { result } = await runWith(
      { getReplayUrl: () => { throw new SolariError("not ready", 404); } },
      6_000,
    );
    expect(result.evidence).toMatchObject({ documentedWindowMs: 30_000, ourCeilingMs: 6_000 });
  });

  it("still reminds the caller that recording is per-session", async () => {
    const { result } = await runWith(
      { getReplayUrl: () => { throw new SolariError("not ready", 404); } },
      4_000,
    );
    expect(result.remediation).toContain("per-session, not per-account");
    expect(result.issueRef).toBe("solari-cookbook#README-gotcha-2");
  });
});

describe("the ceiling is respected", () => {
  it("stops polling once the ceiling is passed", async () => {
    const { result } = await runWith(
      { getReplayUrl: () => { throw new SolariError("not ready", 404); } },
      10_000,
    );

    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ replayAvailable: false });
    expect(result.evidence?.["waitedMs"]).toBeLessThanOrEqual(12_000);
  });

  it("polls at least once even with a zero ceiling", async () => {
    const { result } = await runWith({ getReplayUrl: replayAfter(0) }, 0);
    expect(result.evidence).toMatchObject({ polls: 1 });
  });
});

describe("infrastructure failures", () => {
  it("maps a launch failure through the shared error layer", async () => {
    const { result } = await runWith({
      launch: () => {
        throw new SolariError("Solari POST /sessions failed: 401", 401);
      },
    });

    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ status: 401, product: "browser" });
    expect(result.message).not.toContain("no replay URL");
  });

  it("maps a release failure", async () => {
    const { result } = await runWith({
      releaseAndWait: () => {
        throw new SolariError("gateway error", 503);
      },
    });
    expect(result.evidence).toMatchObject({ status: 503 });
  });
});

describe("the session is always cleaned up", () => {
  it("never closes the shared client — the CLI disposes of it (F43)", async () => {
    const { calls } = await runWith();
    expect(calls.clientClosed).toBe(0);
  });

  it("closes an unreleased session when release failed", async () => {
    const { calls } = await runWith({
      releaseAndWait: () => {
        throw new SolariError("boom", 500);
      },
    });
    expect(calls.closed).toBe(1);
  });

  it("does not close the client when launch failed", async () => {
    const { calls } = await runWith({
      launch: () => {
        throw new SolariError("nope", 401);
      },
    });
    expect(calls.clientClosed).toBe(0);
  });

  it("does not double-release a released session", async () => {
    const { calls } = await runWith();
    expect(calls.closed).toBe(0);
    expect(calls.released).toHaveLength(1);
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

  it("never records the replay URL itself", async () => {
    const { result } = await runWith();
    expect(JSON.stringify(result)).not.toContain("replay.example");
  });

  it("records only primitives", async () => {
    const { result } = await runWith();
    for (const value of Object.values(result.evidence ?? {})) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });
});

describe("the check never throws", () => {
  it("returns a result for every failure shape", async () => {
    const shapes: unknown[] = [new SolariError("x", 401), new Error("x"), "a string", null, 9];

    for (const shape of shapes) {
      const { result } = await runWith({
        launch: () => {
          throw shape;
        },
      });
      expect(result.id).toBe("recording-lifecycle");
      expect(result.status).toBe("fail");
    }
  });
});
