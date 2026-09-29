/** Render results so a failure explains itself without reading the code. */
import type { ClassResult } from "./check.js"

export function table(results: ClassResult[]): string {
  const rows = results.map((r) => {
    const detail = r.error
      ? `error: ${r.error}`
      : r.findings.length === 0
        ? "as expected"
        : r.findings.map((f) => (f.kind === "leaked" ? `LEAKED ${f.testid}` : `missing ${f.testid}`)).join(", ")
    return `| ${r.name} | ${r.ok ? "pass" : "FAIL"} | ${detail} | ${r.ms}ms |`
  })
  return [
    "| user class | verdict | what was wrong | time |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n")
}

export function explain(results: ClassResult[]): string {
  return results.filter((r) => !r.ok).map((r) =>
    `${r.name}: ${r.because}\n  saw: ${r.saw.join(", ") || "(nothing)"}\n  ${
      r.error ?? r.findings.map((f) => `${f.kind}: ${f.testid}`).join("; ")}`,
  ).join("\n\n")
}
