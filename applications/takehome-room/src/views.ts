// What each audience may see of an Interview. Pure, so the security rules below
// are tested directly:
//   - the stream link reaches the Candidate only while their Room is open;
//   - the Reviewer never gets it (viewOnly is enforced only in the viewer page,
//     so the link would let a Reviewer type into the Candidate's Room);
//   - only a demo visitor, who plays both sides, gets a link to their Report.
import type { CandidateView, InterviewSummary, ReviewerView } from "../shared/api.ts"
import { secondsLeft, type Interview } from "./interview.ts"
import type { Task } from "./tasks.ts"

export function candidateView(iv: Interview, task: Task, now: number): CandidateView {
  const roomOpen = iv.phase === "setup" || iv.phase === "working"
  return {
    phase: iv.phase,
    title: task.title,
    instructions: task.instructions,
    setupMinutes: iv.setupMinutes,
    workMinutes: iv.workMinutes,
    secondsLeft: secondsLeft(iv, now),
    streamUrl: roomOpen ? iv.streamUrl : undefined,
    endReason: iv.endReason,
    error: iv.error,
    demo: Boolean(iv.demo),
    reportPath: iv.demo && iv.endedAt ? `/r/${iv.reviewerToken}` : undefined,
  }
}

export function reviewerView(
  iv: Interview,
  task: Task,
  artifacts: { hasRecording: boolean; hasFinalState: boolean },
): ReviewerView {
  return {
    phase: iv.phase,
    title: task.title,
    setupMinutes: iv.setupMinutes,
    workMinutes: iv.workMinutes,
    openedAt: iv.openedAt,
    startedAt: iv.startedAt,
    endedAt: iv.endedAt,
    endReason: iv.endReason,
    error: iv.error,
    grade: iv.grade,
    gitLog: iv.gitLog,
    ...artifacts,
  }
}

/** One row of the Reviewer's list. Links are paths: the browser adds its own origin. */
export function interviewSummary(iv: Interview, task: Task): InterviewSummary {
  return {
    id: iv.id,
    title: task.title,
    phase: iv.phase,
    createdAt: iv.createdAt,
    workMinutes: iv.workMinutes,
    setupMinutes: iv.setupMinutes,
    candidatePath: `/c/${iv.candidateToken}`,
    reviewerPath: `/r/${iv.reviewerToken}`,
    grade: iv.grade ? { passed: iv.grade.passed, total: iv.grade.total } : undefined,
  }
}
