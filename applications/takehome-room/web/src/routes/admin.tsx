import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ApiError, createInterview, interviewsQuery, tasksQuery, type InterviewSummary, type TaskSummary } from '../api'
import { SiteNav } from '../components/SiteNav'

export const Route = createFileRoute('/admin')({ component: AdminPage })

// The token stays in this browser so the Reviewer signs in once. Storage can
// be blocked (private windows), so every access is guarded.
const KEY = 'takehome-room.admin-token'
const readToken = () => {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}
const writeToken = (t: string) => {
  try {
    if (t) localStorage.setItem(KEY, t)
    else localStorage.removeItem(KEY)
  } catch {
    // Signed in for this tab only.
  }
}

const absolute = (path: string) => new URL(path, window.location.origin).toString()

const PHASE: Record<InterviewSummary['phase'], string> = {
  invited: 'Link not opened',
  opening: 'Opening',
  setup: 'Setting up',
  working: 'Working',
  collecting: 'Saving work',
  grading: 'Grading',
  done: 'Finished',
  failed: 'Failed',
}

const OPEN = new Set<InterviewSummary['phase']>(['invited', 'opening', 'setup', 'working'])

function AdminPage() {
  const [token, setToken] = useState(readToken)
  const tasks = useQuery({ ...tasksQuery(token), enabled: token !== '' })
  const signOut = () => {
    writeToken('')
    setToken('')
  }

  const rejected = tasks.error instanceof ApiError && tasks.error.status === 401
  if (!token || rejected) {
    return (
      <SignIn
        rejected={rejected}
        onToken={(t) => {
          writeToken(t)
          setToken(t)
        }}
      />
    )
  }
  if (tasks.error) {
    return (
      <Shell>
        <p className="mt-6 rounded-xl border border-proctor/40 bg-sheet p-5 text-proctor">{tasks.error.message}</p>
      </Shell>
    )
  }

  return (
    <Shell onSignOut={signOut}>
      {tasks.data ? <NewInterviewForm token={token} tasks={tasks.data} /> : <p className="mt-8 text-graphite">Loading tasks…</p>}
      <InterviewList token={token} />
    </Shell>
  )
}

function Shell({ children, onSignOut }: { children: React.ReactNode; onSignOut?: () => void }) {
  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-12 sm:pb-16">
      <SiteNav />
      <div className="mt-10 flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs tracking-wide text-graphite uppercase">Reviewer</p>
          <h1 className="display mt-2 text-3xl font-extrabold sm:text-4xl">Interviews</h1>
        </div>
        {onSignOut && (
          <button className="text-sm text-graphite underline underline-offset-4 hover:text-ink" onClick={onSignOut}>
            Sign out
          </button>
        )}
      </div>
      {children}
    </main>
  )
}

function SignIn({ rejected, onToken }: { rejected: boolean; onToken: (t: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <Shell>
      <form
        className="mt-8 max-w-md rounded-xl border border-rule bg-sheet p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onToken(value.trim())
        }}
      >
        <label className="block text-sm font-semibold text-graphite" htmlFor="token">
          Admin token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          className="mt-2 w-full rounded-lg border border-rule bg-paper px-3 py-2 font-mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="mt-2 text-sm text-graphite">It is the ADMIN_TOKEN value in the server's .env file.</p>
        {rejected && <p className="mt-2 text-sm text-proctor">That token is wrong. Check it and try again.</p>}
        <button className="mt-4 rounded-lg bg-ink px-4 py-2 font-semibold text-paper hover:opacity-90">Sign in</button>
      </form>
    </Shell>
  )
}

function NewInterviewForm({ token, tasks }: { token: string; tasks: TaskSummary[] }) {
  const queryClient = useQueryClient()
  const [taskName, setTaskName] = useState(tasks[0]?.name ?? '')
  const [work, setWork] = useState('')
  const [setup, setSetup] = useState('')
  const task = tasks.find((t) => t.name === taskName)
  const create = useMutation({
    mutationFn: () =>
      createInterview(token, {
        task: taskName,
        workMinutes: work === '' ? undefined : Number(work),
        setupMinutes: setup === '' ? undefined : Number(setup),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: interviewsQuery(token).queryKey }),
  })

  return (
    <section className="mt-8 rounded-xl border border-rule bg-sheet">
      <form
        className="grid gap-4 p-5 sm:grid-cols-[1fr_8rem_8rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <Field label="Task" htmlFor="task">
          <select
            id="task"
            className="w-full rounded-lg border border-rule bg-paper px-3 py-2"
            value={taskName}
            onChange={(e) => setTaskName(e.target.value)}
          >
            {tasks.map((t) => (
              <option key={t.name} value={t.name}>
                {t.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Work, min" htmlFor="work">
          <input
            id="work"
            inputMode="numeric"
            className="w-full rounded-lg border border-rule bg-paper px-3 py-2 font-mono"
            placeholder={String(task?.workMinutes ?? '')}
            value={work}
            onChange={(e) => setWork(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <Field label="Setup, min" htmlFor="setup">
          <input
            id="setup"
            inputMode="numeric"
            className="w-full rounded-lg border border-rule bg-paper px-3 py-2 font-mono"
            placeholder={String(task?.setupMinutes ?? '')}
            value={setup}
            onChange={(e) => setSetup(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <button
          className="rounded-lg bg-ink px-5 py-2 font-semibold text-paper hover:opacity-90 disabled:opacity-50"
          disabled={create.isPending || !taskName}
        >
          {create.isPending ? 'Creating…' : 'Create interview'}
        </button>
      </form>
      {create.error && <p className="px-5 pb-5 text-sm text-proctor">{create.error.message}</p>}
      {create.data && (
        <div className="border-t border-rule p-5">
          <p className="font-semibold">Interview created. Send the candidate link, and keep the reviewer link.</p>
          <LinkRow label="Candidate link" note="Send this" path={create.data.candidatePath} />
          <LinkRow label="Reviewer link" note="Keep this" path={create.data.reviewerPath} />
        </div>
      )}
    </section>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-graphite" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

function LinkRow({ label, note, path }: { label: string; note: string; path: string }) {
  const url = absolute(path)
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-center">
      <p className="text-sm leading-tight">
        <span className="block font-semibold">{label}</span>
        <span className="text-graphite">{note}</span>
      </p>
      <code className="truncate rounded-lg border border-rule bg-paper px-3 py-2 font-mono text-xs">{url}</code>
      <CopyButton text={url} />
    </div>
  )
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="rounded-lg border border-ink px-3 py-1.5 text-sm font-semibold hover:bg-ink hover:text-paper"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => window.prompt('Copy this link:', text))
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

function InterviewList({ token }: { token: string }) {
  const { data, error } = useQuery(interviewsQuery(token))
  return (
    <section className="mt-12">
      <h2 className="display mb-3 text-lg font-bold">All interviews</h2>
      {error && <p className="text-sm text-proctor">{error.message}</p>}
      {data?.length === 0 && (
        <p className="rounded-xl border border-dashed border-rule p-5 text-graphite">
          No interviews yet. Create one above to get its links.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="divide-y divide-rule rounded-xl border border-rule bg-sheet">
          {data.map((iv) => (
            <li key={iv.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_9rem_5rem_auto] sm:items-center sm:gap-4">
              <div className="min-w-0">
                <p className="truncate font-semibold">{iv.title}</p>
                <p className="font-mono text-xs text-graphite">
                  {new Date(iv.createdAt).toLocaleString()} · {iv.setupMinutes} + {iv.workMinutes} min
                </p>
              </div>
              <p className={`text-sm ${iv.phase === 'failed' ? 'text-proctor' : 'text-graphite'}`}>{PHASE[iv.phase]}</p>
              <p className="font-mono text-sm tabular-nums">{iv.grade ? `${iv.grade.passed} / ${iv.grade.total}` : '–'}</p>
              <div className="flex gap-2 sm:justify-end">
                {/* The candidate link is only useful until the candidate submits. */}
                {OPEN.has(iv.phase) && <CopyButton text={absolute(iv.candidatePath)} label="Copy candidate link" />}
                <Link
                  to="/r/$token"
                  params={{ token: iv.reviewerPath.slice(3) }}
                  className="rounded-lg border border-rule px-3 py-1.5 text-sm font-semibold hover:border-ink"
                >
                  Report
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
