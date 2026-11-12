import { describe, it, expect } from "vitest";
import { AuthError, NoCapacityError } from "@solarisdk/sdk";

import { sandboxCleanupCheck } from "../../src/checks/sandbox-cleanup.js";
import { fakeContext } from "../fixtures/fake-context.js";
import {
  fakeSandboxClient,
  gatewayError,
  type FakeSandboxOptions,
} from "../fixtures/fake-sandbox.js";

const KEY = "slr_live_abcd_efghijklmnop_qrstuvwxyz0123456789";

async function runWith(script: FakeSandboxOptions = {}) {
  const { client, calls } = fakeSandboxClient(script);
  const { ctx } = fakeContext({ apiKey: KEY, sandboxClient: client });
  const result = await sandboxCleanupCheck.run(ctx);
  return { result, calls };
}

/** The documented sequence: running after close(), 404 after kill(). */
const DOCUMENTED: FakeSandboxOptions = {
  get: (_id, callIndex) => {
    if (callIndex === 0) return { state: "running" };
    throw gatewayError(404, "sandbox not found");
  },
};

describe("check metadata", () => {
  it("is cheap and depends on auth", () => {
    expect(sandboxCleanupCheck.id).toBe("sandbox-cleanup");
    expect(sandboxCleanupCheck.costTier).toBe("cheap");
    expect(sandboxCleanupCheck.dependsOn).toEqual(["auth"]);
  });
});

describe("the documented sequence", () => {
  it("passes when close() leaves it running and kill() removes it", async () => {
    const { result } = await runWith(DOCUMENTED);

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({
      stateAfterClose: "running",
      stillRunningAfterClose: true,
      terminatedAfterKill: true,
      stateAfterKill: "404",
    });
  });

  it("calls close() before querying, and kills afterwards", async () => {
    const { calls } = await runWith(DOCUMENTED);

    expect(calls.created).toBe(1);
    expect(calls.closed).toBe(1);
    expect(calls.killed).toBe(1);
    expect(calls.got).toHaveLength(2);
  });

  it("accepts a non-running state after kill instead of a 404", async () => {
    // F29 observed a 404, but a state transition is an equally valid signal.
    const { result } = await runWith({
      get: (_id, callIndex) =>
        callIndex === 0 ? { state: "running" } : { state: "terminated" },
    });

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ stateAfterKill: "terminated" });
  });
});

describe("the locked claim (design.md §6.6)", () => {
  it("says consumption may continue, never that it definitely costs money", async () => {
    const { result } = await runWith(DOCUMENTED);
    const text = `${result.message} ${result.remediation ?? ""}`;

    expect(text).toContain("may result in continued resource consumption/billing");
    // The message stays short enough for one terminal line.
    expect(result.message.length).toBeLessThan(80);
    expect(text).not.toMatch(/is costing you|definitely billed|you are being charged/i);
  });

  it("makes no billing claim on the failure path either", async () => {
    const { result } = await runWith({ get: () => ({ state: "running" }) });
    const text = `${result.message} ${result.remediation ?? ""}`;

    expect(text).not.toMatch(/is costing you|definitely billed/i);
    expect(text).toContain("may result in continued resource consumption/billing");
  });

  it("reports no billing field, because the API exposes none (F19)", async () => {
    const { result } = await runWith(DOCUMENTED);
    expect(Object.keys(result.evidence ?? {})).not.toContain("billed");
    expect(Object.keys(result.evidence ?? {})).not.toContain("cost");
  });
});

describe("outcomes that are not the documented one", () => {
  it("warns, not fails, when close() already stopped the VM", async () => {
    // The documented behaviour did not reproduce. That is worth reporting, but
    // it is not a problem with the user's environment.
    const { result } = await runWith({
      get: (_id, callIndex) =>
        callIndex === 0 ? { state: "terminated" } : { state: "terminated" },
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain('not "running"');
    expect(result.evidence).toMatchObject({ stillRunningAfterClose: false });
  });

  it("fails when the sandbox survives kill()", async () => {
    const { result } = await runWith({ get: () => ({ state: "running" }) });

    expect(result.status).toBe("fail");
    expect(result.message).toContain("still present after kill()");
    expect(result.evidence).toMatchObject({ terminatedAfterKill: false });
  });

  it("does not treat a non-404 error on re-query as termination", async () => {
    const { result } = await runWith({
      get: (_id, callIndex) => {
        if (callIndex === 0) return { state: "running" };
        throw gatewayError(500, "gateway blew up");
      },
    });

    // A 500 says nothing about whether the VM is gone.
    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ status: 500 });
  });
});

describe("infrastructure failures", () => {
  it("maps a creation failure through the shared error layer", async () => {
    const { result } = await runWith({
      create: () => {
        throw new NoCapacityError("no host");
      },
    });

    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ errorClass: "NoCapacityError", status: 503 });
  });

  it("maps a connect failure", async () => {
    const { result } = await runWith({
      connect: () => {
        throw new AuthError("Unauthorized");
      },
    });
    expect(result.evidence).toMatchObject({ status: 401 });
  });
});

describe("the VM is always killed", () => {
  it("kills exactly once on the documented path", async () => {
    const { calls } = await runWith(DOCUMENTED);
    expect(calls.killed).toBe(1);
  });

  it("kills when the first query throws", async () => {
    const { calls } = await runWith({
      get: () => {
        throw gatewayError(500, "boom");
      },
    });
    expect(calls.killed).toBe(1);
  });

  it("kills when connect throws", async () => {
    const { calls } = await runWith({
      connect: () => {
        throw new AuthError("Unauthorized");
      },
    });
    expect(calls.killed).toBe(1);
  });

  it("never kills a VM it did not create", async () => {
    const { calls } = await runWith({
      create: () => {
        throw new NoCapacityError("no host");
      },
    });
    expect(calls.killed).toBe(0);
  });

  it("still returns a result when the cleanup kill fails", async () => {
    const { result } = await runWith({
      connect: () => {
        throw new AuthError("Unauthorized");
      },
      kill: () => {
        throw new Error("kill failed too");
      },
    });

    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ status: 401 });
  });
});

describe("evidence is safe for --report", () => {
  it("redacts a key echoed by the gateway", async () => {
    const { result } = await runWith({
      create: () => {
        throw new AuthError(`rejected ${KEY}`);
      },
    });

    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("records only primitives", async () => {
    const { result } = await runWith(DOCUMENTED);
    for (const value of Object.values(result.evidence ?? {})) {
      expect(["string", "number", "boolean", "object"]).toContain(typeof value);
      if (typeof value === "object") expect(value).toBeNull();
    }
  });
});

describe("the check never throws", () => {
  it("returns a result for every failure shape", async () => {
    const shapes: unknown[] = [new AuthError("x"), new Error("x"), "a string", null, 7];

    for (const shape of shapes) {
      const { result } = await runWith({
        create: () => {
          throw shape;
        },
      });
      expect(result.id).toBe("sandbox-cleanup");
      expect(result.status).toBe("fail");
    }
  });
});

describe("created resources are tagged", () => {
  it("marks the sandbox so a cancelled CI run can sweep it", async () => {
    const created: unknown[] = [];
    const { client } = fakeSandboxClient(DOCUMENTED);
    const inner = client as unknown as {
      sandboxes: { create: (o?: unknown) => Promise<unknown> };
    };
    const spy = {
      sandboxes: {
        ...inner.sandboxes,
        create: async (options?: unknown) => {
          created.push(options);
          return inner.sandboxes.create(options);
        },
      },
    } as unknown as typeof client;

    const { ctx } = fakeContext({ apiKey: KEY, sandboxClient: spy });
    await sandboxCleanupCheck.run(ctx);

    expect(created[0]).toMatchObject({ metadata: { createdBy: "solari-doctor" } });
  });
});
