import { describe, it, expect } from "vitest";

import {
  buildReportBundle,
  renderReportBundle,
  sanitizeValue,
} from "../../src/report/bundle.js";
import { DOCTOR_VERSION } from "../../src/version.js";
import type { CheckResult } from "../../src/types.js";

const REAL_KEY_SHAPE = "slr_live_abcd_efghijklmnop_qrstuvwxyz0123456789";

function result(evidence?: Record<string, unknown>): CheckResult {
  return {
    id: "auth",
    status: "pass",
    message: "authenticated",
    durationMs: 12,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

describe("bundle shape (design.md §9)", () => {
  it("carries the documented environment fields", () => {
    const bundle = buildReportBundle({
      results: [],
      diagnoses: [],
      nodeVersion: "v24.19.0",
      platform: "win32",
    });

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.environment).toMatchObject({
      doctorVersion: DOCTOR_VERSION,
      node: "v24.19.0",
      platform: "win32",
    });
  });

  it("includes region and baseUrl only when configured", () => {
    const without = buildReportBundle({ results: [], diagnoses: [] });
    expect("region" in without.environment).toBe(false);
    expect("baseUrl" in without.environment).toBe(false);

    const with_ = buildReportBundle({
      results: [],
      diagnoses: [],
      region: "us-west",
      baseUrl: "https://staging.example.invalid",
    });
    expect(with_.environment.region).toBe("us-west");
  });

  it("ends with a newline", () => {
    expect(renderReportBundle({ results: [], diagnoses: [] }).endsWith("\n")).toBe(true);
  });
});

describe("sanitizeValue", () => {
  it("redacts a key-shaped token anywhere in a string", () => {
    expect(sanitizeValue(`failed with ${REAL_KEY_SHAPE}`)).toBe(
      "failed with slr_***redacted***",
    );
  });

  it("passes primitives through unchanged", () => {
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(null)).toBe(null);
  });

  it("recurses through arrays and plain objects", () => {
    expect(sanitizeValue({ a: [1, { b: REAL_KEY_SHAPE }] })).toEqual({
      a: [1, { b: "slr_***redacted***" }],
    });
  });

  it("redacts forbidden keys regardless of their value", () => {
    const sanitized = sanitizeValue({
      apiKey: "not-key-shaped-at-all",
      Cookie: "session=abc",
      storageState: { cookies: [] },
      screenshot: "iVBORw0KGgo=",
      safe: "kept",
    }) as Record<string, unknown>;

    expect(sanitized["apiKey"]).toBe("[redacted]");
    expect(sanitized["Cookie"]).toBe("[redacted]");
    expect(sanitized["storageState"]).toBe("[redacted]");
    expect(sanitized["screenshot"]).toBe("[redacted]");
    expect(sanitized["safe"]).toBe("kept");
  });

  it("reduces a non-plain object to its type name", () => {
    // A whitelist, not a blacklist: an unknown shape cannot leak its contents.
    expect(sanitizeValue(new Error("boom"))).toBe("[object]");
    expect(sanitizeValue(() => undefined)).toBe("[function]");
    expect(sanitizeValue(new Date())).toBe("[object]");
  });

  it("stops at a depth limit rather than recursing forever", () => {
    const deep = { a: { b: { c: { d: { e: "too far" } } } } };
    expect(JSON.stringify(sanitizeValue(deep))).toContain("depth limit");
  });

  it("survives a self-referential object", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(() => sanitizeValue(cyclic)).not.toThrow();
  });

  it("truncates a very long string", () => {
    expect((sanitizeValue("x".repeat(5000)) as string).length).toBeLessThanOrEqual(500);
  });
});

describe("security boundary end to end", () => {
  it("removes a key that a check placed in evidence", () => {
    const rendered = renderReportBundle({
      results: [result({ apiKey: REAL_KEY_SHAPE, note: `used ${REAL_KEY_SHAPE}` })],
      diagnoses: [],
    });

    expect(rendered).not.toContain("slr_live_abcd");
    expect(rendered).toContain("[redacted]");
  });

  it("removes a key that appears in a message or details", () => {
    const rendered = renderReportBundle({
      results: [
        {
          id: "auth",
          status: "fail",
          message: `rejected key ${REAL_KEY_SHAPE}`,
          details: `header was Bearer ${REAL_KEY_SHAPE}`,
          durationMs: 1,
        },
      ],
      diagnoses: [],
    });

    expect(rendered).not.toContain("slr_live_abcd");
  });

  it("drops page content, cookies and screenshots a check should never emit", () => {
    const rendered = renderReportBundle({
      results: [
        result({
          cookies: [{ name: "session", value: "secret" }],
          screenshot: "iVBORw0KGgoAAAANS",
          pageTitle: "kept — not a forbidden key",
        }),
      ],
      diagnoses: [],
    });

    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("iVBORw0KGgo");
    expect(rendered).toContain("kept");
  });

  it("preserves the evidence that makes a report useful", () => {
    const bundle = buildReportBundle({
      results: [result({ sdkVersion: "0.1.2", processExited: false, deadlineMs: 5000 })],
      diagnoses: [],
    });

    expect(bundle.checks[0]?.evidence).toEqual({
      sdkVersion: "0.1.2",
      processExited: false,
      deadlineMs: 5000,
    });
  });

  it("keeps ids, statuses and timings intact", () => {
    const bundle = buildReportBundle({ results: [result()], diagnoses: [] });
    expect(bundle.checks[0]).toMatchObject({
      id: "auth",
      status: "pass",
      durationMs: 12,
    });
  });
});

describe("hostile evidence keys", () => {
  it("makes __proto__ an own key rather than the object's prototype", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": "yes"}, "safe": 1}') as Record<
      string,
      unknown
    >;
    const out = sanitizeValue(hostile) as Record<string, unknown>;

    // Plain assignment would have reshaped the output instead of storing a key.
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out).sort()).toEqual(["__proto__", "safe"]);
  });

  it("never pollutes Object.prototype", () => {
    sanitizeValue(JSON.parse('{"__proto__": {"pwned": true}}'));
    sanitizeValue(JSON.parse('{"constructor": {"prototype": {"pwned": true}}}'));
    expect(({} as Record<string, unknown>)["pwned"]).toBeUndefined();
  });

  it("survives a hostile key through the whole bundle path", () => {
    const rendered = renderReportBundle({
      results: [
        {
          id: "x",
          status: "pass",
          message: "m",
          durationMs: 0,
          evidence: JSON.parse('{"__proto__": {"pwned": true}, "kept": 1}') as Record<
            string,
            unknown
          >,
        },
      ],
      diagnoses: [],
    });

    expect(JSON.parse(rendered)).toBeTruthy();
    expect(({} as Record<string, unknown>)["pwned"]).toBeUndefined();
  });
});
