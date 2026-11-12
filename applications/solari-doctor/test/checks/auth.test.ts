import { describe, it, expect } from "vitest";
import { AuthError, ConcurrencyLimitError, GatewayError } from "@solarisdk/sdk";

import { authCheck } from "../../src/checks/auth.js";
import { fakeContext } from "../fixtures/fake-context.js";

const VALID_KEY = "slr_live_abcd_efghijklmnop_qrstuvwxyz0123456789";

describe("check metadata", () => {
  it("is free and depends on nothing — everything else depends on it", () => {
    expect(authCheck.id).toBe("auth");
    expect(authCheck.costTier).toBe("free");
    expect(authCheck.dependsOn).toBeUndefined();
  });

  it("describes what it can observe, not the issue #1 UI event", () => {
    // design.md §6.1 locks this wording.
    expect(authCheck.description).toMatch(/resulting authentication failure/i);
    expect(authCheck.description).not.toMatch(/modal/i);
  });
});

describe("missing key", () => {
  it("fails without making any API call", async () => {
    const { ctx, calls } = fakeContext({ apiKey: undefined });
    const result = await authCheck.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("SOLARI_API_KEY is not set");
    expect(calls.sandboxRequested).toBe(0);
    expect(result.evidence).toMatchObject({ keyPresent: false });
  });

  it("treats an empty string as missing", async () => {
    const { ctx, calls } = fakeContext({ apiKey: "" });
    expect((await authCheck.run(ctx)).status).toBe("fail");
    expect(calls.sandboxRequested).toBe(0);
  });

  it("treats a whitespace-only key as missing", async () => {
    const { ctx, calls } = fakeContext({ apiKey: "   \t\n " });
    expect((await authCheck.run(ctx)).status).toBe("fail");
    expect(calls.sandboxRequested).toBe(0);
  });

  it("cites issue #1, which documents how the secret gets lost", async () => {
    const { ctx } = fakeContext({ apiKey: undefined });
    expect((await authCheck.run(ctx)).issueRef).toBe("solari-cookbook#1");
  });
});

describe("successful authentication", () => {
  it("passes and records structural facts about the key", async () => {
    const { ctx } = fakeContext({ apiKey: VALID_KEY });
    const result = await authCheck.run(ctx);

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({
      keyPresent: true,
      keyPrefixOk: true,
      keyLength: VALID_KEY.length,
      keySegments: 5,
    });
  });

  it("uses the cheapest call that creates nothing", async () => {
    const { ctx, calls } = fakeContext({ apiKey: VALID_KEY });
    await authCheck.run(ctx);
    expect(calls.sandboxListCalls).toEqual([{ limit: 1 }]);
  });

  it("passes an unusually shaped key that nonetheless authenticates", async () => {
    // Finding F21: one real key has been observed. A different shape that the
    // API accepts is valid, and reporting it as malformed would be a defect.
    const { ctx } = fakeContext({ apiKey: "slr_live_something_else_entirely" });
    const result = await authCheck.run(ctx);
    expect(result.status).toBe("pass");
  });

  it("passes a key with an unexpected prefix if the API accepts it", async () => {
    const { ctx } = fakeContext({ apiKey: "slr_test_aaaa_bbbb" });
    const result = await authCheck.run(ctx);

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ keyPrefixOk: false });
  });
});

describe("rejected key", () => {
  it("fails on a 401", async () => {
    const { ctx } = fakeContext({
      apiKey: VALID_KEY,
      sandboxList: () => Promise.reject(new AuthError("Unauthorized")),
    });
    const result = await authCheck.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("401");
    expect(result.evidence).toMatchObject({ status: 401, errorClass: "AuthError" });
  });

  it("mentions the prefix only when the key was also rejected", async () => {
    const rejected = await authCheck.run(
      fakeContext({
        apiKey: "not-a-solari-key",
        sandboxList: () => Promise.reject(new AuthError("Unauthorized")),
      }).ctx,
    );
    expect(rejected.remediation).toMatch(/truncated or copied incompletely/i);

    const accepted = await authCheck.run(fakeContext({ apiKey: "not-a-solari-key" }).ctx);
    expect(accepted.status).toBe("pass");
    expect(accepted.remediation).toBeUndefined();
  });
});

describe("other failures are not misreported as auth problems", () => {
  it("maps a 429 to the concurrency message, not the auth one", async () => {
    const { ctx } = fakeContext({
      apiKey: VALID_KEY,
      sandboxList: () => Promise.reject(new ConcurrencyLimitError("busy")),
    });
    const result = await authCheck.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.message).not.toContain("401");
    expect(result.message).toMatch(/too many sessions/i);
    expect(result.issueRef).toBeUndefined();
  });

  it("maps a 500 to the gateway message", async () => {
    const { ctx } = fakeContext({
      apiKey: VALID_KEY,
      sandboxList: () => Promise.reject(new GatewayError(500, "boom")),
    });
    const result = await authCheck.run(ctx);
    expect(result.evidence).toMatchObject({ status: 500 });
    expect(result.message).not.toContain("401");
  });

  it("handles a plain network error without throwing", async () => {
    const { ctx } = fakeContext({
      apiKey: VALID_KEY,
      sandboxList: () => Promise.reject(new Error("ECONNRESET")),
    });
    const result = await authCheck.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.evidence).toMatchObject({ recognized: false, errorClass: "Error" });
  });

  it("handles a non-Error throw", async () => {
    const { ctx } = fakeContext({
      apiKey: VALID_KEY,
      sandboxList: () => Promise.reject("just a string"),
    });
    await expect(authCheck.run(ctx)).resolves.toMatchObject({ status: "fail" });
  });
});

describe("the check never throws", () => {
  it("returns a result for every failure shape", async () => {
    const shapes: unknown[] = [
      new AuthError("x"),
      new GatewayError(503, "x"),
      new Error("x"),
      "string",
      null,
      undefined,
      42,
    ];

    for (const shape of shapes) {
      const { ctx } = fakeContext({
        apiKey: VALID_KEY,
        sandboxList: () => Promise.reject(shape),
      });
      await expect(authCheck.run(ctx)).resolves.toMatchObject({ id: "auth" });
    }
  });
});

describe("the key never leaks (design.md §9)", () => {
  it("appears in no field of a passing result", async () => {
    const { ctx } = fakeContext({ apiKey: VALID_KEY });
    expect(JSON.stringify(await authCheck.run(ctx))).not.toContain(VALID_KEY);
  });

  it("appears in no field of a failing result", async () => {
    const { ctx } = fakeContext({
      apiKey: VALID_KEY,
      sandboxList: () => Promise.reject(new AuthError("Unauthorized")),
    });
    expect(JSON.stringify(await authCheck.run(ctx))).not.toContain(VALID_KEY);
  });

  it("is redacted even when the SDK echoes it back in an error message", async () => {
    const { ctx } = fakeContext({
      apiKey: VALID_KEY,
      sandboxList: () => Promise.reject(new AuthError(`rejected key ${VALID_KEY}`)),
    });
    const serialized = JSON.stringify(await authCheck.run(ctx));

    expect(serialized).not.toContain(VALID_KEY);
    expect(serialized).toContain("redacted");
  });

  it("records only primitive evidence", async () => {
    const { ctx } = fakeContext({ apiKey: VALID_KEY });
    const { evidence } = await authCheck.run(ctx);
    for (const value of Object.values(evidence ?? {})) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });
});

describe("a key that cannot be sent as a header", () => {
  const NEWLINE_KEY = ["slr_live_aaa", "bbb"].join("\n");

  it("reports the character problem instead of a transport error", async () => {
    // Without this check, fetch fails with "the control connection is not
    // open", which points at the transport rather than the key.
    const { ctx } = fakeContext({ apiKey: NEWLINE_KEY });
    const result = await authCheck.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.message).toContain("cannot be sent in a header");
    expect(result.remediation).toMatch(/line break/i);
    expect(result.evidence).toMatchObject({ keyHeaderSafe: false });
  });

  it("does not spend an API call on a key that cannot be sent", async () => {
    const { ctx, calls } = fakeContext({ apiKey: NEWLINE_KEY });
    await authCheck.run(ctx);
    expect(calls.sandboxRequested).toBe(0);
  });

  it("rejects carriage returns, nulls and non-ASCII too", async () => {
    const keys = [
      ["slr_live_a", "b"].join(String.fromCharCode(13)),
      ["slr_live_a", "b"].join(String.fromCharCode(0)),
      "slr_live_ключ",
    ];
    for (const key of keys) {
      const { ctx } = fakeContext({ apiKey: key });
      expect((await authCheck.run(ctx)).message).toContain("cannot be sent in a header");
    }
  });

  it("allows tab and space, which are legal in a header value", async () => {
    // Over-rejecting here would fail a key the API would have accepted.
    const legal = [
      ["slr_live_a", "b"].join(String.fromCharCode(9)),
      ["slr_live_a", "b"].join(" "),
    ];
    for (const key of legal) {
      const { ctx } = fakeContext({ apiKey: key });
      expect((await authCheck.run(ctx)).status).toBe("pass");
    }
  });

  it("accepts an ordinary printable-ASCII key", async () => {
    const { ctx } = fakeContext({ apiKey: VALID_KEY });
    expect((await authCheck.run(ctx)).status).toBe("pass");
  });
});
