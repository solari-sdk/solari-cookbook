import { describe, it, expect } from "vitest";

import { SolariError as BrowserSolariError } from "@solarisdk/browser";
import {
  ActionError,
  AuthError,
  ConcurrencyLimitError,
  ConnectionError,
  GatewayError,
  NoCapacityError,
  PlanError,
  SolariError as CoreSolariError,
  TimeoutError,
} from "@solarisdk/sdk";

import { mapSdkError, sanitizeErrorMessage } from "../../src/runner/errors.js";

/** Shape observed live during verification (finding F28). */
const OBSERVED_BROWSER_401_MESSAGE =
  'Solari POST /sessions failed: 401 {"error":"Unauthorized"}';

describe("model A — @solarisdk/browser", () => {
  it("maps a 401 by status, since a 401 carries no code (F28)", () => {
    const error = new BrowserSolariError(OBSERVED_BROWSER_401_MESSAGE, 401);
    const mapped = mapSdkError(error, "browser");

    expect(mapped.evidence.code).toBeUndefined();
    expect(mapped.evidence.status).toBe(401);
    expect(mapped.message).toMatch(/authentication was rejected/i);
    expect(mapped.evidence.recognized).toBe(true);
  });

  it("gives each documented SolariErrorCode a distinct message", () => {
    const codes = [
      "FeatureRequiresPlan",
      "PlanLimitExceeded",
      "ConcurrencyLimitExceeded",
      "BrowserUnhealthy",
      "InvalidSessionId",
    ] as const;

    const messages = codes.map(
      (code) => mapSdkError(new BrowserSolariError("x", 400, undefined, code), "browser").message,
    );

    // Distinct, not merely present.
    expect(new Set(messages).size).toBe(codes.length);
    for (const message of messages) expect(message).not.toMatch(/unrecognised/i);
  });

  it("carries the code through to evidence", () => {
    const mapped = mapSdkError(
      new BrowserSolariError("x", 429, undefined, "ConcurrencyLimitExceeded"),
      "browser",
    );
    expect(mapped.evidence.code).toBe("ConcurrencyLimitExceeded");
    expect(mapped.evidence.status).toBe(429);
  });

  it("falls back to a structured result for an unknown status and no code", () => {
    const mapped = mapSdkError(new BrowserSolariError("odd", 418), "browser");
    expect(mapped.evidence.status).toBe(418);
    expect(mapped.message).toBeTruthy();
    expect(mapped.remediation).toBeTruthy();
  });

  it("still returns a structured result for a SolariError with no status at all", () => {
    const mapped = mapSdkError(new BrowserSolariError("bare"), "browser");
    expect(mapped.evidence.recognized).toBe(false);
    expect(mapped.evidence.status).toBeUndefined();
    expect(mapped.message).toBeTruthy();
  });
});

describe("model B — instanceof ordering is load-bearing", () => {
  // All four extend GatewayError. Testing the parent first maps every one of
  // them to the generic gateway message, with no compile or type error.
  it("maps each GatewayError subclass to its own message, not the parent's", () => {
    const gatewayMessage = mapSdkError(new GatewayError(500, "boom"), "core").message;

    const subclasses = [
      new AuthError("unauthorized"),
      new PlanError("plan"),
      new ConcurrencyLimitError("busy"),
      new NoCapacityError("no host"),
    ];

    const messages = subclasses.map((e) => mapSdkError(e, "core").message);

    for (const message of messages) {
      expect(message).not.toBe(gatewayMessage);
    }
    expect(new Set(messages).size).toBe(subclasses.length);
  });

  it("maps AuthError to the auth message, not the gateway one", () => {
    const mapped = mapSdkError(new AuthError("unauthorized"), "core");
    expect(mapped.message).toMatch(/authentication was rejected/i);
    expect(mapped.evidence.errorClass).toBe("AuthError");
    expect(mapped.evidence.status).toBe(401);
  });

  it("confirms the hierarchy the ordering depends on", () => {
    const authError = new AuthError("unauthorized");
    // If this stops holding, the ordering above is no longer sufficient.
    expect(authError instanceof GatewayError).toBe(true);
    expect(authError instanceof CoreSolariError).toBe(true);
  });

  it("maps the non-gateway siblings distinctly", () => {
    const action = mapSdkError(new ActionError("cmd.run", "failed"), "core");
    const timeout = mapSdkError(new TimeoutError("cmd.run", 5000), "core");
    const connection = mapSdkError(new ConnectionError("closed"), "core");

    expect(action.message).toMatch(/remote action/i);
    expect(timeout.message).toMatch(/timeout/i);
    expect(connection.message).toMatch(/control connection/i);
    expect(new Set([action.message, timeout.message, connection.message]).size).toBe(3);
  });

  it("maps a bare GatewayError to the generic gateway message", () => {
    const mapped = mapSdkError(new GatewayError(500, "boom"), "core");
    expect(mapped.evidence.status).toBe(500);
    expect(mapped.evidence.recognized).toBe(true);
  });
});

describe("errors this layer must not choke on", () => {
  it("handles a plain Error without throwing", () => {
    const mapped = mapSdkError(new Error("ECONNRESET"), "core");
    expect(mapped.evidence.recognized).toBe(false);
    expect(mapped.evidence.errorClass).toBe("Error");
    expect(mapped.message).toBeTruthy();
    expect(mapped.remediation).toBeTruthy();
  });

  it("handles a non-Error throw", () => {
    expect(() => mapSdkError("just a string", "browser")).not.toThrow();
    expect(mapSdkError("just a string", "browser").evidence.errorClass).toBe("string");
    expect(mapSdkError(undefined, "core").evidence.recognized).toBe(false);
  });

  it("never throws for any product/shape combination", () => {
    const shapes: unknown[] = [
      new Error("x"),
      new AuthError("x"),
      new BrowserSolariError("x", 401),
      "string",
      42,
      null,
      undefined,
      { message: "not an Error" },
    ];
    for (const shape of shapes) {
      expect(() => mapSdkError(shape, "browser")).not.toThrow();
      expect(() => mapSdkError(shape, "core")).not.toThrow();
    }
  });
});

describe("cross-product mis-import (finding F39)", () => {
  it("the two SolariError classes are genuinely different classes", () => {
    expect(new BrowserSolariError("x", 401) instanceof CoreSolariError).toBe(false);
    expect(new AuthError("x") instanceof BrowserSolariError).toBe(false);
  });

  it("flags a core error mapped as browser, instead of failing silently", () => {
    const mapped = mapSdkError(new AuthError("unauthorized"), "browser");
    expect(mapped.evidence.productMismatch).toBe(true);
  });

  it("flags a browser error mapped as core", () => {
    const mapped = mapSdkError(new BrowserSolariError("x", 401), "core");
    expect(mapped.evidence.productMismatch).toBe(true);
  });

  it("omits the flag entirely when the product is right", () => {
    const mapped = mapSdkError(new AuthError("x"), "core");
    // Absent, not an explicit undefined.
    expect("productMismatch" in mapped.evidence).toBe(false);
  });
});

describe("security boundary (design.md §9)", () => {
  it("redacts an API key that appears in an error message", () => {
    const leaky = new Error("request failed with key slr_live_abcd_efghijklmnop_qrstuvwxyz0123456789");
    const mapped = mapSdkError(leaky, "core");

    expect(mapped.evidence.sanitizedMessage).not.toContain("slr_live_abcd");
    expect(mapped.evidence.sanitizedMessage).toContain("redacted");
  });

  it("redacts every occurrence, not just the first", () => {
    const sanitized = sanitizeErrorMessage("slr_live_aaaa_bbbb and slr_test_cccc_dddd");
    expect(sanitized).not.toMatch(/slr_(live|test)_[a-z]/);
  });

  it("never returns the raw error object or a stack trace", () => {
    const error = new AuthError("unauthorized");
    const mapped = mapSdkError(error, "core");

    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("at Object");
    expect(serialized).not.toContain(".ts:");
    expect(Object.values(mapped.evidence)).not.toContain(error);
  });

  it("keeps evidence to primitives only, so nothing can smuggle a payload", () => {
    const mapped = mapSdkError(new AuthError("x"), "core");
    for (const value of Object.values(mapped.evidence)) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });

  it("caps message length, so a huge body cannot bloat a report", () => {
    const mapped = mapSdkError(new Error("x".repeat(5000)), "core");
    expect(mapped.evidence.sanitizedMessage.length).toBeLessThanOrEqual(300);
  });
});

describe("optional fields follow the exactOptionalPropertyTypes convention", () => {
  it("omits status and code rather than setting them undefined", () => {
    const mapped = mapSdkError(new Error("plain"), "core");
    expect("status" in mapped.evidence).toBe(false);
    expect("code" in mapped.evidence).toBe(false);
  });

  it("includes them only when the SDK actually supplied them", () => {
    const mapped = mapSdkError(new BrowserSolariError("x", 429, undefined, "ConcurrencyLimitExceeded"), "browser");
    expect("status" in mapped.evidence).toBe(true);
    expect("code" in mapped.evidence).toBe(true);
  });
});

describe("a key containing whitespace is fully redacted", () => {
  it("redacts the tail of a key split by a newline", () => {
    // The SDK echoes the whole header when it rejects one. The key pattern
    // alone stops at the newline, leaving the remainder exposed.
    const sanitized = sanitizeErrorMessage(
      'Headers.append: "Bearer slr_live_aaaa\nSECRETTAIL" is an invalid header value.',
    );
    expect(sanitized).not.toContain("SECRETTAIL");
  });

  it("redacts the tail of a key split by a space", () => {
    expect(sanitizeErrorMessage("Bearer slr_live_aaa SECRETTAIL")).not.toContain("SECRETTAIL");
  });

  it("still redacts a bare key with no Bearer prefix", () => {
    expect(sanitizeErrorMessage("failed with slr_live_aaaa_bbbb")).toContain("redacted");
  });

  it("leaves surrounding text readable", () => {
    const sanitized = sanitizeErrorMessage('GET /x failed: "Bearer slr_live_a" is invalid');
    expect(sanitized).toContain("GET /x failed");
    expect(sanitized).toContain("is invalid");
  });
});
