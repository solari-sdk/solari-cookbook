import { describe, expect, it } from "vitest";
import { execFailedLine, machineUnreachableLine, machineUnreachedLine } from "@wsp/protocol";
import { classify, ExecFailedError, isNetworkError, MachineUnreachableError, MachineUnreached, shouldRetry, untilReached } from "../src/errors.js";

/** The link rule's waits, each with the jitter it draws on top of its own base. */
const expectBackoffs = (waits: readonly number[], bases: readonly number[]): void => {
  expect(waits).toHaveLength(bases.length);
  waits.forEach((wait, i) => {
    expect(wait).toBeGreaterThanOrEqual(bases[i]!);
    expect(wait).toBeLessThan(bases[i]! + 250);
  });
};

describe("error policy", () => {
  it("never retries 429", () => {
    const e = classify(429, { code: "ConcurrencyLimitExceeded", error: "Too many concurrent sessions" });
    expect(e.kind).toBe("concurrency");
    expect(shouldRetry(e, 1)).toBe(false);
  });
  it("retries generic 502 up to 3 attempts", () => {
    const e = classify(502, { error: "upstream sad" });
    expect(shouldRetry(e, 1)).toBe(true);
    expect(shouldRetry(e, 3)).toBe(false);
  });
  it("does NOT retry the snapshot-502 signature", () => {
    const e = classify(502, { error: "Failed to snapshot sandbox" });
    expect(e.kind).toBe("snapshotUnavailable");
    expect(shouldRetry(e, 1)).toBe(false);
  });
  it("maps 402/403/404 to permanent", () => {
    expect(classify(402, { code: "InsufficientCredit" }).kind).toBe("plan");
    expect(classify(404, {}).kind).toBe("missing");
  });
});

describe("the provider's refusal of a running machine", () => {
  it("is the base for an exec the provider cannot run, with that answer's own sentence", () => {
    const e = new ExecFailedError("m1", "exec failed", 502);
    expect(e).toBeInstanceOf(MachineUnreachableError);
    expect(e.message).toBe(execFailedLine("exec failed"));
    expect(e).toMatchObject({ name: "ExecFailedError", machineId: "m1", said: "exec failed", status: 502 });
  });

  it("keeps the sentence it was handed for the answer that it cannot reach the machine, and is no ExecFailedError", () => {
    const e = new MachineUnreachableError("m1", "Sandbox is not reachable", 502, machineUnreachableLine("Sandbox is not reachable"));
    expect(e.message).toBe(machineUnreachableLine("Sandbox is not reachable"));
    expect(e).toMatchObject({ name: "MachineUnreachableError", machineId: "m1", said: "Sandbox is not reachable", status: 502 });
    expect(e).not.toBeInstanceOf(ExecFailedError);
  });
});

describe("isNetworkError", () => {
  it("is a fetch that threw, or a socket or DNS code on the error or its cause", () => {
    expect(isNetworkError(new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.example"), { code: "EAI_AGAIN" }) }))).toBe(true);
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isNetworkError(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }))).toBe(true);
  });
  it("is not an answer: a gateway status the backend already retried, gone, paused, refused, or any plain error", () => {
    expect(isNetworkError(Object.assign(new Error("upstream sad"), classify(503, { error: "upstream sad" })))).toBe(false);
    expect(isNetworkError(Object.assign(new Error("gone"), classify(404, { error: "gone" })))).toBe(false);
    expect(isNetworkError(Object.assign(new Error("paused"), classify(409, { error: "paused" })))).toBe(false);
    expect(isNetworkError(Object.assign(new Error("Failed to snapshot sandbox"), classify(502, { error: "Failed to snapshot sandbox" })))).toBe(false);
    expect(isNetworkError(new Error("exit 1: no such file"))).toBe(false);
    expect(isNetworkError("fetch failed")).toBe(false);
  });
});

describe("untilReached", () => {
  /** A clock the retry's own sleeps move, and a call that costs five seconds and fails `times` times. */
  const fixture = (times: number, make: () => Error) => {
    let now = 0;
    let calls = 0;
    const waits: number[] = [];
    return {
      once: async (): Promise<string> => {
        calls++;
        now += 5_000;
        if (calls <= times) throw make();
        return "answered";
      },
      clock: {
        now: () => now,
        sleep: async (ms: number): Promise<void> => {
          waits.push(ms);
          now += ms;
        },
      },
      calls: () => calls,
      waits,
    };
  };

  it("retries a call nothing answered at the link rule's backoff and returns the answer that came", async () => {
    const f = fixture(2, () => new TypeError("fetch failed"));
    expect(await untilReached(f.once, f.clock)).toBe("answered");
    expect(f.calls()).toBe(3);
    expectBackoffs(f.waits, [500, 1_000]);
  });

  it("rethrows a failure that is not the network at once, after one call and no wait", async () => {
    const f = fixture(9, () => Object.assign(new Error("gone"), classify(404, { error: "gone" })));
    await expect(untilReached(f.once, f.clock)).rejects.toThrow("gone");
    expect(f.calls()).toBe(1);
    expect(f.waits).toEqual([]);
  });

  it("gives up once the next wait would end past the link window, with the count and the time in the protocol's words", async () => {
    const f = fixture(99, () => new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }) }));
    const e = await untilReached(f.once, f.clock).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MachineUnreached);
    const unreached = e as MachineUnreached;
    // Five-second calls with the rule's waits between them: the seventh ends a minute and half a second in, past
    // the window a name that will not resolve is given, so no eighth is made.
    expect(unreached.attempts).toBe(7);
    expectBackoffs(f.waits, [500, 1_000, 2_000, 4_000, 8_000, 10_000]);
    expect(unreached.elapsedMs).toBeGreaterThanOrEqual(7 * 5_000 + 25_500);
    expect(unreached.elapsedMs).toBeLessThan(7 * 5_000 + 27_000);
    expect(unreached.message).toBe(machineUnreachedLine(7, unreached.elapsedMs));
    expect((unreached.cause as Error).message).toBe("fetch failed");
    expect(f.calls()).toBe(7);
  });
});

describe("the provider's request id", () => {
  it("rides on the error when the reply carried one, and is absent, not empty, when it did not", () => {
    expect(classify(502, { error: "Failed to snapshot sandbox" }, "req_7")).toEqual({ kind: "snapshotUnavailable", status: 502, code: undefined, message: "Failed to snapshot sandbox", requestId: "req_7" });
    expect(classify(502, { error: "Failed to snapshot sandbox" })).not.toHaveProperty("requestId");
  });
});
