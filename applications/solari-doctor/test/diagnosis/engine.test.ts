import { describe, it, expect } from "vitest";

import { diagnose, type DiagnosisRule } from "../../src/diagnosis/engine.js";
import { DIAGNOSIS_RULES } from "../../src/diagnosis/rules.js";
import type { CheckResult, CheckStatus } from "../../src/types.js";

const ALL_STATUSES: CheckStatus[] = ["pass", "warn", "fail", "skip"];

function result(id: string, status: CheckStatus, evidence?: Record<string, unknown>): CheckResult {
  return {
    id,
    status,
    message: `${id} -> ${status}`,
    durationMs: 0,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

function causesFor(results: CheckResult[]): string[] {
  return diagnose(results, DIAGNOSIS_RULES).map((d) => d.cause);
}

describe("purity (design.md §4)", () => {
  it("is deterministic — identical input, identical output, every time", () => {
    const results = [result("sdk-version", "warn"), result("browser-lifecycle", "fail")];
    const first = diagnose(results, DIAGNOSIS_RULES);
    for (let i = 0; i < 5; i++) {
      expect(diagnose(results, DIAGNOSIS_RULES)).toEqual(first);
    }
  });

  it("does not mutate the results it is given", () => {
    const results = [result("auth", "fail"), result("sdk-version", "warn")];
    const snapshot = structuredClone(results);
    diagnose(results, DIAGNOSIS_RULES);
    expect(results).toEqual(snapshot);
  });

  it("returns an empty list for no results, not an error", () => {
    expect(diagnose([], DIAGNOSIS_RULES)).toEqual([]);
  });

  it("returns an empty list when nothing correlates", () => {
    expect(causesFor([result("auth", "pass"), result("sdk-version", "pass")])).toEqual([]);
  });
});

describe("the design.md §4 example: sdk-version + browser-lifecycle", () => {
  // Exhaustive over both checks: 16 combinations.
  it("fires the known-bug rule on exactly one of 16 combinations", () => {
    const fired: Array<[CheckStatus, CheckStatus]> = [];

    for (const version of ALL_STATUSES) {
      for (const lifecycle of ALL_STATUSES) {
        const causes = causesFor([
          result("sdk-version", version),
          result("browser-lifecycle", lifecycle),
        ]);
        if (causes.some((c) => c.includes("older than 0.1.3"))) {
          fired.push([version, lifecycle]);
        }
      }
    }

    expect(fired).toEqual([["warn", "fail"]]);
  });

  it("fires the regression rule on exactly one of 16 combinations", () => {
    const fired: Array<[CheckStatus, CheckStatus]> = [];

    for (const version of ALL_STATUSES) {
      for (const lifecycle of ALL_STATUSES) {
        const causes = causesFor([
          result("sdk-version", version),
          result("browser-lifecycle", lifecycle),
        ]);
        if (causes.some((c) => c.includes("this is not the known bug"))) {
          fired.push([version, lifecycle]);
        }
      }
    }

    expect(fired).toEqual([["pass", "fail"]]);
  });

  it("never fires both hang rules at once — they are mutually exclusive", () => {
    for (const version of ALL_STATUSES) {
      for (const lifecycle of ALL_STATUSES) {
        const causes = causesFor([
          result("sdk-version", version),
          result("browser-lifecycle", lifecycle),
        ]);
        const hangCauses = causes.filter((c) => c.includes("did not exit"));
        expect(hangCauses.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("gives the known bug high confidence and the unexplained one low", () => {
    const known = diagnose(
      [result("sdk-version", "warn"), result("browser-lifecycle", "fail")],
      DIAGNOSIS_RULES,
    );
    const unknown = diagnose(
      [result("sdk-version", "pass"), result("browser-lifecycle", "fail")],
      DIAGNOSIS_RULES,
    );

    expect(known[0]?.confidence).toBe("high");
    // Finding F18 established that 0.1.3 exits cleanly, so the cause is unknown.
    expect(unknown[0]?.confidence).toBe("low");
  });

  it("needs both checks — neither alone produces the correlated cause", () => {
    expect(causesFor([result("sdk-version", "warn")])).toEqual([]);
    expect(causesFor([result("browser-lifecycle", "fail")])).toEqual([]);
  });
});

describe("supportingChecks", () => {
  it("cites both checks that fed a correlated diagnosis", () => {
    const [diagnosis] = diagnose(
      [result("sdk-version", "warn"), result("browser-lifecycle", "fail")],
      DIAGNOSIS_RULES,
    );
    expect(diagnosis?.supportingChecks.sort()).toEqual(["browser-lifecycle", "sdk-version"]);
  });

  it("never cites a check that did not run", () => {
    const rule: DiagnosisRule = {
      id: "test",
      reads: ["auth", "never-ran"],
      matches: (r) => r.is("auth", "fail"),
      cause: "c",
      confidence: "high",
      remediation: "r",
    };
    const [diagnosis] = diagnose([result("auth", "fail")], [rule]);
    expect(diagnosis?.supportingChecks).toEqual(["auth"]);
  });

  it("is non-empty for every diagnosis the real rule set produces", () => {
    const everything = [
      result("auth", "fail"),
      result("sdk-version", "warn"),
      result("browser-lifecycle", "fail"),
      result("sandbox-cleanup", "fail"),
    ];
    for (const diagnosis of diagnose(everything, DIAGNOSIS_RULES)) {
      expect(diagnosis.supportingChecks.length).toBeGreaterThan(0);
    }
  });
});

describe("rule evaluation", () => {
  it("preserves rule declaration order", () => {
    const order = ["a", "b", "c"];
    const rules: DiagnosisRule[] = order.map((id) => ({
      id,
      reads: ["auth"],
      matches: () => true,
      cause: id,
      confidence: "low",
      remediation: "r",
    }));
    expect(diagnose([result("auth", "pass")], rules).map((d) => d.cause)).toEqual(order);
  });

  it("contains a rule that throws, without losing the others", () => {
    const rules: DiagnosisRule[] = [
      {
        id: "explodes",
        reads: [],
        matches: () => {
          throw new Error("bad rule");
        },
        cause: "should not appear",
        confidence: "high",
        remediation: "r",
      },
      {
        id: "healthy",
        reads: ["auth"],
        matches: () => true,
        cause: "still here",
        confidence: "low",
        remediation: "r",
      },
    ];

    const diagnoses = diagnose([result("auth", "pass")], rules);
    expect(diagnoses.map((d) => d.cause)).toEqual(["still here"]);
  });

  it("omits issueRef entirely when a rule has none", () => {
    const rule: DiagnosisRule = {
      id: "no-ref",
      reads: [],
      matches: () => true,
      cause: "c",
      confidence: "low",
      remediation: "r",
    };
    const [diagnosis] = diagnose([], [rule]);
    // exactOptionalPropertyTypes: absent, not an explicit undefined.
    expect("issueRef" in (diagnosis ?? {})).toBe(false);
  });

  it("carries issueRef through when a rule has one", () => {
    const [diagnosis] = diagnose([result("auth", "fail")], DIAGNOSIS_RULES);
    expect(diagnosis?.issueRef).toBe("solari-cookbook#1");
  });
});

describe("ResultLookup", () => {
  it("treats a check that did not run as absent, not as a failure", () => {
    const rule: DiagnosisRule = {
      id: "probe",
      reads: [],
      matches: (r) => r.status("nope") === undefined && !r.is("nope", "fail"),
      cause: "absent handled",
      confidence: "low",
      remediation: "r",
    };
    expect(diagnose([], [rule])).toHaveLength(1);
  });

  it("reads evidence without throwing on a missing check or key", () => {
    const rule: DiagnosisRule = {
      id: "probe",
      reads: [],
      matches: (r) =>
        r.evidence("nope", "k") === undefined &&
        r.evidence("here", "missing") === undefined &&
        r.evidence("here", "present") === 42,
      cause: "evidence handled",
      confidence: "low",
      remediation: "r",
    };
    expect(diagnose([result("here", "pass", { present: 42 })], [rule])).toHaveLength(1);
  });
});

describe("the real rule set", () => {
  it("names auth as the single cause when it fails", () => {
    const causes = causesFor([
      result("auth", "fail"),
      result("sandbox-command", "skip"),
      result("sandbox-cleanup", "skip"),
    ]);
    expect(causes).toEqual(["authentication failed, so no check that needs the API could run"]);
  });

  it("reports a leaked sandbox without claiming a billing fact", () => {
    const [diagnosis] = diagnose([result("sandbox-cleanup", "fail")], DIAGNOSIS_RULES);
    expect(diagnosis?.cause).toContain("remained running after close()");
    // design.md §6.6: the API proves the resource is running and exposes no
    // billing field.
    expect(diagnosis?.remediation).toMatch(/may result in/i);
    expect(diagnosis?.remediation).not.toMatch(/is costing you|definitely billed/i);
  });

  it("every rule carries a non-empty cause and remediation", () => {
    for (const rule of DIAGNOSIS_RULES) {
      expect(rule.cause.length).toBeGreaterThan(0);
      expect(rule.remediation.length).toBeGreaterThan(0);
      expect(rule.reads.length).toBeGreaterThan(0);
    }
  });

  it("has unique rule ids", () => {
    const ids = DIAGNOSIS_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
