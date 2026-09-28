// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { readJsonc } from "../src/jsonc.js";

describe("reading JSON with comments", () => {
  it("drops comments and trailing commas outside strings and keeps everything inside them", () => {
    const text = '{\n  // a, b }\n  "a": "x // not a comment, /* nor this */",\n  "b": ["\\"q\\"", 1, /* c */ ],\n  "c": { "d": 2, // e\n  },\n}';
    expect(readJsonc(text)).toEqual({ value: { a: "x // not a comment, /* nor this */", b: ['"q"', 1], c: { d: 2 } } });
    expect(readJsonc('{ "a": [1, 2] }')).toEqual({ value: { a: [1, 2] } });
    expect(() => readJsonc('{ "a": 1 // no close')).toThrow();
    expect(() => readJsonc('{ "a": , }')).toThrow();
  });

  it("reads a config of tens of megabytes in one pass", () => {
    const projects = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`/p/${i}`, { history: Array.from({ length: 10 }, (_, j) => ({ display: `${"x".repeat(150)}${j}` })) }]));
    const text = JSON.stringify({ mcpServers: {}, projects }, null, 2);
    expect(text.length).toBeGreaterThan(10_000_000);
    const started = Date.now();
    expect(Object.keys((readJsonc(text).value as { projects: object }).projects)).toHaveLength(5000);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
