import { describe, it, expect } from "vitest";

import { createCheckRegistry } from "../../src/checks/index.js";
import { createDoctorContext } from "../../src/context.js";
import { runChecks, DEFAULT_CONCURRENCY } from "../../src/runner/scheduler.js";
import { fakeCheck } from "../fixtures/fake-check.js";

const ctx = createDoctorContext();

/**
 * Advances the microtask queue without touching the clock. Concurrency
 * assertions use this plus explicit gates, so none depend on wall-clock timing.
 */
async function flush(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** A set of checks that block until explicitly released, with a live counter. */
function makeGate() {
  const releases: Array<() => void> = [];
  let inFlight = 0;
  let max = 0;

  return {
    async onRun(): Promise<void> {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
    },
    get inFlight() {
      return inFlight;
    },
    get max() {
      return max;
    },
    releaseOne(): void {
      releases.shift()?.();
    },
    /** Release everything, refilling as the pool starts more work. */
    async drain(): Promise<void> {
      while (releases.length > 0) {
        for (const release of releases.splice(0)) release();
        await flush();
      }
    },
  };
}

describe("concurrency bound", () => {
  it("never runs more than `concurrency` resource-creating checks at once", async () => {
    const gate = makeGate();
    const checks = ["a", "b", "c", "d", "e", "f"].map((id) =>
      fakeCheck(id, { costTier: "cheap", onRun: gate.onRun }),
    );
    const run = runChecks(createCheckRegistry(checks), ctx, { concurrency: 3 });

    await flush();
    // Six available, three started.
    expect(gate.inFlight).toBe(3);

    gate.releaseOne();
    await flush();
    // Refilled to three, not four.
    expect(gate.inFlight).toBe(3);

    await gate.drain();
    await run;
    expect(gate.max).toBe(3);
  });

  it("honours a concurrency of 1 — strictly serial", async () => {
    const gate = makeGate();
    const checks = ["a", "b", "c"].map((id) =>
      fakeCheck(id, { costTier: "cheap", onRun: gate.onRun }),
    );
    const run = runChecks(createCheckRegistry(checks), ctx, { concurrency: 1 });

    await flush();
    expect(gate.inFlight).toBe(1);

    await gate.drain();
    await run;
    expect(gate.max).toBe(1);
  });

  it("defaults to 3, per design.md §7", async () => {
    expect(DEFAULT_CONCURRENCY).toBe(3);

    const gate = makeGate();
    const checks = ["a", "b", "c", "d", "e"].map((id) =>
      fakeCheck(id, { costTier: "cheap", onRun: gate.onRun }),
    );
    const run = runChecks(createCheckRegistry(checks), ctx);

    await flush();
    expect(gate.inFlight).toBe(3);

    await gate.drain();
    await run;
  });

  it("rejects a nonsensical concurrency rather than hanging", async () => {
    const registry = createCheckRegistry([fakeCheck("a", { costTier: "cheap" })]);
    await expect(runChecks(registry, ctx, { concurrency: 0 })).rejects.toThrow(
      /at least 1/,
    );
  });
});

describe("free tier", () => {
  it("runs free checks unbounded, ignoring the concurrency cap", async () => {
    const gate = makeGate();
    const checks = ["a", "b", "c", "d", "e"].map((id) =>
      fakeCheck(id, { costTier: "free", onRun: gate.onRun }),
    );
    // Cap of 1: if free checks obeyed it, only one would start.
    const run = runChecks(createCheckRegistry(checks), ctx, { concurrency: 1 });

    await flush();
    expect(gate.inFlight).toBe(5);

    await gate.drain();
    await run;
    expect(gate.max).toBe(5);
  });

  it("finishes every free check before the bounded pool starts", async () => {
    const order: string[] = [];
    const record = (id: string): void => {
      order.push(id);
    };
    const registry = createCheckRegistry([
      fakeCheck("cheap-1", { costTier: "cheap", onRun: record }),
      fakeCheck("free-1", { costTier: "free", onRun: record }),
      fakeCheck("cheap-2", { costTier: "cheap", onRun: record }),
      fakeCheck("free-2", { costTier: "free", onRun: record }),
    ]);

    await runChecks(registry, ctx, { concurrency: 3 });

    expect(order.slice(0, 2).sort()).toEqual(["free-1", "free-2"]);
    expect(order.slice(2).sort()).toEqual(["cheap-1", "cheap-2"]);
  });
});

describe("skip propagation", () => {
  it("skips a direct dependent and names the failing check", async () => {
    const registry = createCheckRegistry([
      fakeCheck("auth", { result: { status: "fail", message: "no key" } }),
      fakeCheck("sandbox-cleanup", { costTier: "cheap", dependsOn: ["auth"] }),
    ]);

    const results = await runChecks(registry, ctx);
    const skipped = results.find((r) => r.id === "sandbox-cleanup");

    expect(skipped?.status).toBe("skip");
    expect(skipped?.message).toContain("auth");
    expect(skipped?.evidence).toMatchObject({ blockedBy: "auth", rootCause: "auth" });
  });

  it("propagates transitively, naming the root cause not just the neighbour", async () => {
    const registry = createCheckRegistry([
      fakeCheck("a", { result: { status: "fail", message: "boom" } }),
      fakeCheck("b", { costTier: "cheap", dependsOn: ["a"] }),
      fakeCheck("c", { costTier: "cheap", dependsOn: ["b"] }),
    ]);

    const results = await runChecks(registry, ctx);
    const byId = new Map(results.map((r) => [r.id, r]));

    expect(byId.get("b")?.status).toBe("skip");
    expect(byId.get("c")?.status).toBe("skip");
    // "c" was blocked by "b"; the actionable cause is "a".
    expect(byId.get("c")?.evidence).toMatchObject({ blockedBy: "b", rootCause: "a" });
    expect(byId.get("c")?.message).toContain("a");
  });

  it("never omits a skipped check from the results", async () => {
    const registry = createCheckRegistry([
      fakeCheck("auth", { result: { status: "fail", message: "no key" } }),
      fakeCheck("x", { costTier: "cheap", dependsOn: ["auth"] }),
      fakeCheck("y", { costTier: "cheap", dependsOn: ["auth"] }),
    ]);

    const results = await runChecks(registry, ctx);
    expect(results.map((r) => r.id).sort()).toEqual(["auth", "x", "y"]);
  });

  it("never re-attempts a skipped check", async () => {
    let ran = 0;
    const registry = createCheckRegistry([
      fakeCheck("auth", { result: { status: "fail", message: "no key" } }),
      fakeCheck("dependent", {
        costTier: "cheap",
        dependsOn: ["auth"],
        onRun: () => {
          ran += 1;
        },
      }),
    ]);

    await runChecks(registry, ctx);
    expect(ran).toBe(0);
  });

  it("treats a `warn` dependency as satisfied, not as a blocker", async () => {
    let ran = false;
    const registry = createCheckRegistry([
      fakeCheck("sdk-version", { result: { status: "warn", message: "0.1.2 installed" } }),
      fakeCheck("dependent", {
        costTier: "cheap",
        dependsOn: ["sdk-version"],
        onRun: () => {
          ran = true;
        },
      }),
    ]);

    const results = await runChecks(registry, ctx);
    expect(ran).toBe(true);
    expect(results.find((r) => r.id === "dependent")?.status).toBe("pass");
  });
});

describe("cycle detection", () => {
  it("rejects a direct cycle, naming both checks", async () => {
    const registry = createCheckRegistry([
      fakeCheck("a", { dependsOn: ["b"] }),
      fakeCheck("b", { dependsOn: ["a"] }),
    ]);

    await expect(runChecks(registry, ctx)).rejects.toThrow(/Dependency cycle detected/);
    await expect(runChecks(registry, ctx)).rejects.toThrow(/"a"/);
    await expect(runChecks(registry, ctx)).rejects.toThrow(/"b"/);
  });

  it("rejects an indirect cycle, naming every check involved", async () => {
    const registry = createCheckRegistry([
      fakeCheck("a", { dependsOn: ["c"] }),
      fakeCheck("b", { dependsOn: ["a"] }),
      fakeCheck("c", { dependsOn: ["b"] }),
    ]);

    const attempt = runChecks(registry, ctx);
    await expect(attempt).rejects.toThrow(/Dependency cycle detected/);
    for (const id of ["a", "b", "c"]) {
      await expect(runChecks(registry, ctx)).rejects.toThrow(new RegExp(`"${id}"`));
    }
  });

  it("rejects a self-dependency", async () => {
    const registry = createCheckRegistry([fakeCheck("a", { dependsOn: ["a"] })]);
    await expect(runChecks(registry, ctx)).rejects.toThrow(/Dependency cycle detected/);
  });

  it("does not mistake a diamond for a cycle", async () => {
    const registry = createCheckRegistry([
      fakeCheck("root"),
      fakeCheck("left", { costTier: "cheap", dependsOn: ["root"] }),
      fakeCheck("right", { costTier: "cheap", dependsOn: ["root"] }),
      fakeCheck("join", { costTier: "cheap", dependsOn: ["left", "right"] }),
    ]);

    const results = await runChecks(registry, ctx);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });
});

describe("a check that throws", () => {
  it("becomes a fail result, not an exception out of the scheduler", async () => {
    const registry = createCheckRegistry([
      fakeCheck("explodes", {
        onRun: () => {
          throw new TypeError("cannot read properties of undefined");
        },
      }),
    ]);

    const results = await runChecks(registry, ctx);
    const result = results[0];

    expect(result?.status).toBe("fail");
    expect(result?.message).toContain("TypeError");
    expect(result?.details).toContain("cannot read properties of undefined");
    expect(result?.evidence).toMatchObject({ threw: "TypeError" });
  });

  it("does not abort the rest of the run", async () => {
    const registry = createCheckRegistry([
      fakeCheck("explodes", {
        onRun: () => {
          throw new Error("boom");
        },
      }),
      fakeCheck("healthy"),
    ]);

    const results = await runChecks(registry, ctx);
    expect(results.find((r) => r.id === "healthy")?.status).toBe("pass");
  });

  it("blocks dependents the same way an ordinary failure does", async () => {
    const registry = createCheckRegistry([
      fakeCheck("explodes", {
        onRun: () => {
          throw new Error("boom");
        },
      }),
      fakeCheck("dependent", { costTier: "cheap", dependsOn: ["explodes"] }),
    ]);

    const results = await runChecks(registry, ctx);
    expect(results.find((r) => r.id === "dependent")?.status).toBe("skip");
  });
});

describe("cost-tier selection", () => {
  it("excludes expensive checks by default", async () => {
    const registry = createCheckRegistry([
      fakeCheck("cheap-one", { costTier: "cheap" }),
      fakeCheck("recording-lifecycle", { costTier: "expensive" }),
    ]);

    const results = await runChecks(registry, ctx);
    expect(results.map((r) => r.id)).toEqual(["cheap-one"]);
  });

  it("includes them under --full", async () => {
    const registry = createCheckRegistry([
      fakeCheck("cheap-one", { costTier: "cheap" }),
      fakeCheck("recording-lifecycle", { costTier: "expensive" }),
    ]);

    const results = await runChecks(registry, ctx, { full: true });
    expect(results.map((r) => r.id).sort()).toEqual(["cheap-one", "recording-lifecycle"]);
  });
});

describe("result shape", () => {
  it("returns results in registry order", async () => {
    const registry = createCheckRegistry([
      fakeCheck("gamma"),
      fakeCheck("alpha"),
      fakeCheck("beta"),
    ]);
    const results = await runChecks(registry, ctx);
    expect(results.map((r) => r.id)).toEqual(["gamma", "alpha", "beta"]);
  });

  it("returns exactly one result per selected check", async () => {
    const registry = createCheckRegistry([fakeCheck("a"), fakeCheck("b")]);
    const results = await runChecks(registry, ctx);
    expect(results).toHaveLength(2);
  });

  it("is an empty list for an empty registry, not an error", async () => {
    await expect(runChecks(createCheckRegistry([]), ctx)).resolves.toEqual([]);
  });

  it("sets durationMs itself, so a check cannot forget to", async () => {
    const registry = createCheckRegistry([fakeCheck("a")]);
    const results = await runChecks(registry, ctx);
    expect(typeof results[0]?.durationMs).toBe("number");
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("tier ordering (finding F38)", () => {
  it("rejects a free check that depends on a bounded one", async () => {
    const registry = createCheckRegistry([
      fakeCheck("cheap-dep", { costTier: "cheap" }),
      fakeCheck("free-check", { costTier: "free", dependsOn: ["cheap-dep"] }),
    ]);

    await expect(runChecks(registry, ctx)).rejects.toThrow(
      /"free-check" is costTier "free" but depends on "cheap-dep"/,
    );
  });

  it("allows a bounded check to depend on a free one — the normal case", async () => {
    const registry = createCheckRegistry([
      fakeCheck("auth", { costTier: "free" }),
      fakeCheck("sandbox-command", { costTier: "cheap", dependsOn: ["auth"] }),
    ]);

    const results = await runChecks(registry, ctx);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });
});
