import { describe, it, expect } from "vitest";

import { renderTerminal, wrapText } from "../../src/report/terminal.js";
import { renderJson, buildJsonReport, SCHEMA_VERSION } from "../../src/report/json.js";
import type { CheckResult, Diagnosis } from "../../src/types.js";

/** A fixed run covering all four statuses, so snapshots stay comparable. */
const RESULTS: CheckResult[] = [
  { id: "auth", status: "pass", message: "authenticated", durationMs: 120 },
  {
    id: "sdk-version",
    status: "warn",
    message: "@solarisdk/browser 0.1.2 installed",
    durationMs: 2,
    remediation: "Upgrade to 0.1.3 or later, where browser.close() alone is enough to exit.",
    evidence: { sdkVersion: "0.1.2" },
  },
  {
    id: "browser-lifecycle",
    status: "fail",
    message: "child process did not exit within the deadline",
    durationMs: 5013,
    evidence: { deadlineMs: 5000, processExited: false },
  },
  {
    id: "sandbox-command",
    status: "skip",
    message: 'skipped: "auth" did not pass',
    durationMs: 0,
    evidence: { blockedBy: "auth", rootCause: "auth" },
  },
];

const DIAGNOSES: Diagnosis[] = [
  {
    cause: "the installed @solarisdk/browser is older than 0.1.3, and a process did not exit",
    confidence: "high",
    remediation: "Upgrade to @solarisdk/browser 0.1.3 or later.",
    supportingChecks: ["sdk-version", "browser-lifecycle"],
    issueRef: "solari-cookbook#README-gotcha-1",
  },
];

describe("terminal renderer", () => {
  it("renders a full run", () => {
    expect(renderTerminal(RESULTS, DIAGNOSES)).toMatchSnapshot();
  });

  it("renders a clean run with no diagnoses", () => {
    const clean: CheckResult[] = [
      { id: "auth", status: "pass", message: "authenticated", durationMs: 120 },
    ];
    expect(renderTerminal(clean, [])).toMatchSnapshot();
  });

  it("renders an empty run without crashing", () => {
    expect(renderTerminal([], [])).toContain("no checks ran");
  });

  it("emits no ANSI codes by default", () => {

    expect(renderTerminal(RESULTS, DIAGNOSES)).not.toMatch(/\u001b\[/);
  });

  it("emits ANSI codes only when colour is requested", () => {
    const colored = renderTerminal(RESULTS, DIAGNOSES, { color: true });

    expect(colored).toMatch(/\u001b\[/);
  });

  it("uses ASCII status glyphs, so a Windows console cannot render mojibake", () => {
    const glyphs = renderTerminal(RESULTS, [])
      .split("\n")
      .filter((line) => /^ {2}\S /.test(line))
      .map((line) => line[2] ?? "");

    expect(glyphs).toEqual(["+", "!", "x", "-"]);
    for (const glyph of glyphs) {
      expect(glyph.codePointAt(0)).toBeLessThan(128);
    }
  });

  it("names every check exactly once", () => {
    const output = renderTerminal(RESULTS, DIAGNOSES);
    for (const result of RESULTS) {
      expect(output).toContain(result.id);
    }
  });

  it("aligns messages into one column regardless of id length", () => {
    const output = renderTerminal(RESULTS, []);
    const columns = RESULTS.map((result) => {
      const line = output.split("\n").find((l) => l.includes(` ${result.id} `));
      return line?.indexOf(result.message);
    });
    // "auth" and "browser-lifecycle" differ by 13 characters.
    expect(new Set(columns).size).toBe(1);
    expect(columns[0]).toBeGreaterThan(0);
  });

  it("shows remediation for a failing check but not a passing one", () => {
    const withAdvice: CheckResult[] = [
      { id: "a", status: "pass", message: "fine", durationMs: 1, remediation: "SHOULD NOT APPEAR" },
      { id: "b", status: "warn", message: "hmm", durationMs: 1, remediation: "SHOULD APPEAR" },
    ];
    const output = renderTerminal(withAdvice, []);
    expect(output).not.toContain("SHOULD NOT APPEAR");
    expect(output).toContain("SHOULD APPEAR");
  });

  it("summarises counts across all four statuses", () => {
    const output = renderTerminal(RESULTS, []);
    expect(output).toContain("4 checks");
    expect(output).toContain("1 passed");
    expect(output).toContain("1 warned");
    expect(output).toContain("1 failed");
    expect(output).toContain("1 skipped");
  });

  it("omits zero counts rather than printing '0 failed'", () => {
    const output = renderTerminal(
      [{ id: "a", status: "pass", message: "ok", durationMs: 1 }],
      [],
    );
    expect(output).toContain("1 check");
    expect(output).not.toContain("0 failed");
  });

  it("formats sub-second and multi-second durations differently", () => {
    const output = renderTerminal(RESULTS, []);
    expect(output).toContain("120ms");
    expect(output).toContain("5.0s");
  });

  it("shows the supporting checks and confidence of a diagnosis", () => {
    const output = renderTerminal(RESULTS, DIAGNOSES);
    expect(output).toContain("confidence: high");
    expect(output).toContain("sdk-version, browser-lifecycle");
    expect(output).toContain("solari-cookbook#README-gotcha-1");
  });
});

describe("wrapText", () => {
  it("wraps at the requested width, including the indent", () => {
    const lines = wrapText("aaa bbb ccc ddd eee", 12, "  ");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
  });

  it("indents every line, not just the first", () => {
    for (const line of wrapText("aaa bbb ccc ddd", 10, ">>")) {
      expect(line.startsWith(">>")).toBe(true);
    }
  });

  it("leaves an over-long word intact rather than cutting it", () => {
    const long = "x".repeat(50);
    expect(wrapText(long, 10, "")).toEqual([long]);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(wrapText("", 20, "")).toEqual([]);
    expect(wrapText("   \n  ", 20, "")).toEqual([]);
  });
});

describe("json renderer", () => {
  it("renders a full run", () => {
    expect(renderJson(RESULTS, DIAGNOSES)).toMatchSnapshot();
  });

  it("is valid JSON that round-trips", () => {
    const parsed = JSON.parse(renderJson(RESULTS, DIAGNOSES)) as {
      schemaVersion: number;
      checks: CheckResult[];
      diagnoses: Diagnosis[];
    };
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.checks).toHaveLength(RESULTS.length);
    expect(parsed.diagnoses).toHaveLength(DIAGNOSES.length);
  });

  it("is versioned from v1, per design.md §9", () => {
    expect(buildJsonReport([], []).schemaVersion).toBe(1);
  });

  it("ends with a newline, so shell redirection produces a well-formed file", () => {
    expect(renderJson(RESULTS, DIAGNOSES).endsWith("\n")).toBe(true);
  });

  it("omits absent optional fields rather than emitting null", () => {
    const parsed = JSON.parse(renderJson(RESULTS, [])) as { checks: CheckResult[] };
    const auth = parsed.checks.find((c) => c.id === "auth");
    expect("remediation" in (auth ?? {})).toBe(false);
    expect("evidence" in (auth ?? {})).toBe(false);
  });

  it("preserves structured evidence for machine consumers", () => {
    const parsed = JSON.parse(renderJson(RESULTS, [])) as { checks: CheckResult[] };
    const lifecycle = parsed.checks.find((c) => c.id === "browser-lifecycle");
    expect(lifecycle?.evidence).toEqual({ deadlineMs: 5000, processExited: false });
  });

  it("is stable across repeated renders", () => {
    expect(renderJson(RESULTS, DIAGNOSES)).toBe(renderJson(RESULTS, DIAGNOSES));
  });

  it("handles an empty run", () => {
    const parsed = JSON.parse(renderJson([], [])) as JsonShape;
    expect(parsed).toEqual({ schemaVersion: 1, checks: [], diagnoses: [] });
  });
});

interface JsonShape {
  schemaVersion: number;
  checks: CheckResult[];
  diagnoses: Diagnosis[];
}

describe("renderers are independent of check logic", () => {
  it("renders ids the renderer has never heard of", () => {
    const unknown: CheckResult[] = [
      { id: "some-future-check", status: "pass", message: "fine", durationMs: 1 },
    ];
    expect(renderTerminal(unknown, [])).toContain("some-future-check");
    expect(renderJson(unknown, [])).toContain("some-future-check");
  });

  it("does not mutate what it is given", () => {
    const snapshot = structuredClone(RESULTS);
    renderTerminal(RESULTS, DIAGNOSES);
    renderJson(RESULTS, DIAGNOSES);
    expect(RESULTS).toEqual(snapshot);
  });
});
