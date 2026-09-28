// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { ACCESS_WORD, accessLabel, REASONING_WORD, reasoningLabel } from "./format";

const high = { value: "high", label: "High" };
const million = { value: "1m", label: "1M" };
const bypass = { value: "bypassPermissions", label: "Bypass" };
const kept = { value: "bypassPermissions", label: "Bypass on this Mac", short: "Bypass" };

describe("reasoningLabel", () => {
  it("names the effort as its row does, then the context window, either alone when the other is missing", () => {
    expect(reasoningLabel(high, million)).toBe("High 1M");
    expect(reasoningLabel(high, undefined)).toBe("High");
    expect(reasoningLabel(undefined, million)).toBe("1M");
  });

  it("takes the short form where a row carries one", () => {
    expect(reasoningLabel({ value: "xhigh", label: "Extra high", short: "XHigh" }, undefined)).toBe("XHigh");
  });

  it("falls back to the picker's own word when neither resolves", () => {
    expect(reasoningLabel(undefined, undefined)).toBe(REASONING_WORD);
  });
});

describe("accessLabel", () => {
  it("names the mode in its short form where the row has one, else its label, else the picker's own word", () => {
    expect(accessLabel(kept)).toBe("Bypass");
    expect(accessLabel(bypass)).toBe("Bypass");
    expect(accessLabel({ value: "plan", label: "Plan" })).toBe("Plan");
    expect(accessLabel(undefined)).toBe(ACCESS_WORD);
  });
});
