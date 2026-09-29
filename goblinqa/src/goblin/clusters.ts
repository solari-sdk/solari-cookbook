import { createHash } from "node:crypto"
import type { GoblinFinding } from "./brain.js"
import type { EvidenceRecord, GoblinResult, StepRecord } from "./runner.js"

type Occurrence = {
  runId: string
  persona: string
  step: number
  route: string
  finding: GoblinFinding
  sessionId: string | null
  replay: GoblinResult["replay"]
  video: GoblinResult["video"]
  evidence: EvidenceRecord[]
  // The observed path, not a claim that this is a minimized reproduction.
  observedPath: StepRecord[]
}

export type IssueCluster = {
  id: string
  category: GoblinFinding["category"]
  title: string
  route: string
  severity: "medium" | "low"
  severityReason: string
  affectedPersonas: string[]
  notObservedByPersonas: string[]
  independentRunCount: number
  matchMethod: "exact-title" | "similar-title"
  uncertainty: string
  occurrences: Occurrence[]
}

function normalize(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

function routeOf(url: string): string {
  try {
    const parsed = new URL(url)
    // Keep query/hash distinctions: suitelets and SPAs may route through them.
    parsed.username = ""
    parsed.password = ""
    return parsed.toString()
  } catch {
    return url
  }
}

function similar(a: string, b: string): boolean {
  const left = normalize(a)
  const right = normalize(b)
  if (left === right) return true
  const l = new Set(left.split(" "))
  const r = new Set(right.split(" "))
  if (l.size < 4 || r.size < 4) return false
  // Negation often changes the meaning; never merge across it heuristically.
  for (const word of ["not", "no", "never", "missing", "without"]) {
    if (l.has(word) !== r.has(word)) return false
  }
  const shared = [...l].filter((word) => r.has(word)).length
  return shared / new Set([...l, ...r]).size >= 0.8
}

export function clusterIssues(results: GoblinResult[]): IssueCluster[] {
  const occurrences: Occurrence[] = []
  for (const result of results) {
    for (const step of result.steps) {
      const finding = step.decision?.finding
      if (!finding) continue
      occurrences.push({
        runId: result.runId,
        persona: result.persona.name,
        step: step.step,
        route: routeOf(step.observation.url),
        finding,
        sessionId: result.sessionId,
        replay: result.replay,
        video: result.video,
        evidence: result.evidence.filter((record) => record.step === step.step),
        observedPath: result.steps.filter((record) => record.step <= step.step),
      })
    }
  }
  occurrences.sort((a, b) =>
    JSON.stringify([a.finding.category, a.route, normalize(a.finding.title), a.runId, a.step])
      .localeCompare(JSON.stringify([b.finding.category, b.route, normalize(b.finding.title), b.runId, b.step])),
  )
  const groups: Occurrence[][] = []
  for (const occurrence of occurrences) {
    // Complete-link matching prevents a chain of weak matches from merging
    // unrelated issues. Categories and observed routes must match exactly.
    const group = groups.find((members) => members.every((member) =>
      member.finding.category === occurrence.finding.category &&
      member.route === occurrence.route &&
      similar(member.finding.title, occurrence.finding.title),
    ))
    if (group) group.push(occurrence)
    else groups.push([occurrence])
  }
  const personas = [...new Set(results.map((result) => result.persona.name))].sort()
  return groups.map((members) => {
    const first = members[0]!
    const affectedPersonas = [...new Set(members.map((member) => member.persona))].sort()
    const exact = members.every((member) => normalize(member.finding.title) === normalize(first.finding.title))
    const functional = ["functional_error", "broken_navigation"].includes(first.finding.category)
    return {
      id: `issue-${createHash("sha256").update(JSON.stringify([
        first.finding.category, first.route, normalize(first.finding.title),
      ])).digest("hex").slice(0, 16)}`,
      category: first.finding.category,
      title: first.finding.title,
      route: first.route,
      severity: functional ? "medium" : "low",
      severityReason: functional
        ? "Provisional: observed functional/navigation symptom; blocking impact requires review."
        : "Provisional: observed friction/validation symptom; blocking impact requires review.",
      affectedPersonas,
      notObservedByPersonas: personas.filter((persona) => !affectedPersonas.includes(persona)),
      independentRunCount: new Set(members.map((member) => member.runId)).size,
      matchMethod: exact ? "exact-title" : "similar-title",
      uncertainty: "Candidate grouping by category, URL and title similarity—not verified shared root cause. Absence of a finding does not prove a persona was unaffected. Observed paths are not minimized reproductions.",
      occurrences: members,
    }
  })
}
