import type { Evidence } from "./types.ts";
export function receipt(e: Evidence) {
  const t = e.takeover;
  const list = (items: string[]) =>
    items.length
      ? items.map((x) => "  - " + x).join("\n")
      : "  None established.";
  const carry =
    t?.historicalClaims
      ?.filter((c: any) => c.currentness === "CURRENT")
      .map((c: any) => c.scope.path) ?? [];
  return (
    [
      "HITO × SOLARI",
      "SEMANTIC TAKEOVER",
      "",
      `CASE: ${e.mode === "same" ? "SAME REALITY" : "CHANGED REALITY"}`,
      "",
      "SAFE TO CARRY FORWARD",
      list(
        [...new Set<string>(carry)].map(
          (p) =>
            p +
            " — historical supporting bytes match; behavior remains unverified.",
        ),
      ),
      "",
      "RE-OBSERVED",
      list(t?.reobserved?.map((o: any) => o.path + " — " + o.state) ?? []),
      "",
      "CHANGED",
      list(t?.changed ?? []),
      "",
      "STILL UNKNOWN",
      list(
        t
          ? [
              ...t.unknowns,
              ...t.uncertain.map(
                (p: string) => p + " — currentness INDETERMINATE",
              ),
            ]
          : ["Takeover evidence unavailable."],
      ),
      "",
      "PROTECTED",
      "  Execution authority: disabled. Canonical authority: false.",
      "",
      "NEXT",
      "  " + (t?.nextStep?.state ?? "NO_JUSTIFIED_NEXT_STEP"),
      "",
      "COMPUTE TERMINATION",
      list(
        e.sessions.map(
          (s) =>
            s.label +
            " — " +
            (s.termination?.terminated ? "confirmed gone" : "NOT CONFIRMED"),
        ),
      ),
      "",
      `RESULT: ${e.result}`,
      "  " + e.scope,
      ...(e.errors.length ? ["", "INCOMPLETE EVIDENCE", list(e.errors)] : []),
    ].join("\n") + "\n"
  );
}
