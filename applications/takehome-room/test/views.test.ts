// What each audience may see. The stream link grants control of the desktop, so
// these are the rules that keep it with the Candidate.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createInterview, type Interview, type Phase } from "../src/interview.ts"
import { loadTask } from "../src/tasks.ts"
import { candidateView, interviewSummary, reviewerView } from "../src/views.ts"

const task = loadTask("lru-cache")
const stream = "wss://example/stream/secret"
const at = (phase: Phase, extra: Partial<Interview> = {}): Interview => ({
  ...createInterview({ id: "iv", task: "lru-cache", candidateToken: "c", reviewerToken: "r", workMinutes: 30, setupMinutes: 5, now: 0 }),
  phase,
  streamUrl: stream,
  ...extra,
})
const ALL: Phase[] = ["invited", "opening", "setup", "working", "collecting", "grading", "done", "failed"]

test("the Candidate gets the stream link only while the Room is open", () => {
  for (const phase of ALL) {
    const expected = phase === "setup" || phase === "working" ? stream : undefined
    assert.equal(candidateView(at(phase), task, 0).streamUrl, expected, phase)
  }
})

test("the Reviewer never gets the stream link, in any phase", () => {
  for (const phase of ALL) {
    const view = reviewerView(at(phase), task, { hasRecording: false, hasFinalState: false })
    assert.ok(!JSON.stringify(view).includes(stream), phase)
  }
})

test("the Reviewer's list does not carry the stream link either", () => {
  assert.ok(!JSON.stringify(interviewSummary(at("working"), task)).includes(stream))
})

test("only a finished demo shows the visitor their Report", () => {
  assert.equal(candidateView(at("done", { endedAt: 1 }), task, 0).reportPath, undefined, "a real Candidate never")
  assert.equal(candidateView(at("working", { demo: true }), task, 0).reportPath, undefined, "not before it ends")
  assert.equal(candidateView(at("grading", { demo: true, endedAt: 1 }), task, 0).reportPath, "/r/r")
})
