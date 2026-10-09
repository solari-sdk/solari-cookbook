import { queryOptions } from '@tanstack/react-query'
import type { CandidateView, DemoStatus, InterviewSummary, NewInterview, ReviewerView, TaskSummary } from '../../shared/api.ts'

export type { CandidateView, DemoStatus, InterviewSummary, NewInterview, ReviewerView, TaskSummary }

export class ApiError extends Error {
  readonly status: number
  /** Set on a 429: how long until the desktop is free or the demo cap resets. */
  readonly retryAfterSeconds?: number
  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message)
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** "Try again in about 7 minutes." for a 429, the plain message otherwise. */
export function explain(error: Error): string {
  if (!(error instanceof ApiError) || error.retryAfterSeconds === undefined) return error.message
  const minutes = Math.ceil(error.retryAfterSeconds / 60)
  const wait = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : minutes === 1 ? '1 minute' : `${minutes} minutes`
  return `${error.message} Try again in about ${wait}.`
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.retryAfterSeconds)
  return body as T
}

export const candidateQuery = (token: string) =>
  queryOptions({
    queryKey: ['candidate', token],
    queryFn: () => call<CandidateView>(`/api/c/${token}`),
    // Poll fast while the Room opens, slowly while it runs (the server owns the
    // clock, so this only resyncs the display), and not at all once it is over.
    refetchInterval: (q) => {
      const phase = q.state.data?.phase
      if (phase === 'opening') return 2000
      if (phase === 'setup' || phase === 'working') return 10_000
      return false
    },
  })

export const reviewerQuery = (token: string) =>
  queryOptions({
    queryKey: ['reviewer', token],
    queryFn: () => call<ReviewerView>(`/api/r/${token}`),
    refetchInterval: (q) => {
      const phase = q.state.data?.phase
      return phase === 'done' || phase === 'failed' ? false : 5000
    },
  })

export type CandidateAction = 'open' | 'start' | 'submit'

export const candidateAction = (token: string, action: CandidateAction) =>
  call<CandidateView>(`/api/c/${token}/${action}`, { method: 'POST' })

// --- The Reviewer's page (/admin) ---

const admin = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } })

export const tasksQuery = (token: string) =>
  queryOptions({
    queryKey: ['admin', token, 'tasks'],
    queryFn: () => call<TaskSummary[]>('/api/admin/tasks', admin(token)),
    staleTime: Infinity,
  })

export const interviewsQuery = (token: string) =>
  queryOptions({
    queryKey: ['admin', token, 'interviews'],
    queryFn: () => call<InterviewSummary[]>('/api/admin/interviews', admin(token)),
    refetchInterval: 10_000,
  })

export const createInterview = (token: string, body: NewInterview) =>
  call<InterviewSummary>('/api/admin/interviews', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

// --- Demo ---

export const demoQuery = () =>
  queryOptions({
    queryKey: ['demo'],
    queryFn: () => call<DemoStatus>('/api/demo'),
    refetchInterval: 30_000,
  })

export const startDemo = () => call<{ candidatePath: string }>('/api/demo', { method: 'POST' })
