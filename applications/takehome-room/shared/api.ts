// The JSON the server sends to the browser. Types only: the server and the web
// app both import this file, so the two sides cannot drift apart.

import type { Phase } from "../src/interview.ts"

export type { Phase }

export interface CandidateView {
  phase: Phase
  title: string
  instructions: string
  setupMinutes: number
  workMinutes: number
  /** Seconds until the current phase ends by itself. Only in setup and working. */
  secondsLeft?: number
  /**
   * The Room's live stream. It grants full control of the desktop, so only the
   * Candidate's view carries it, and only while the Room is open.
   */
  streamUrl?: string
  endReason?: "submitted" | "timeout"
  error?: string
  demo: boolean
  /** Only for a demo, once it has ended: the visitor's own Report. */
  reportPath?: string
}

export interface ReviewerView {
  phase: Phase
  title: string
  setupMinutes: number
  workMinutes: number
  openedAt?: number
  startedAt?: number
  endedAt?: number
  endReason?: "submitted" | "timeout"
  error?: string
  grade?: { passed: number; failed: number; total: number; output: string }
  gitLog?: string
  hasRecording: boolean
  hasFinalState: boolean
}

export interface TaskSummary {
  name: string
  title: string
  workMinutes: number
  setupMinutes: number
}

/** One row of the interviewer's list. Links are paths: the browser adds its own origin. */
export interface InterviewSummary {
  id: string
  title: string
  phase: Phase
  createdAt: number
  workMinutes: number
  setupMinutes: number
  candidatePath: string
  reviewerPath: string
  grade?: { passed: number; total: number }
}

export interface NewInterview {
  task: string
  workMinutes?: number
  setupMinutes?: number
}

export interface DemoStatus {
  enabled: boolean
  available?: boolean
  reason?: "busy" | "cap"
  retryAfterSeconds?: number
  workMinutes?: number
  setupMinutes?: number
}
