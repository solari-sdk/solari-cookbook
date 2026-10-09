import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, type ErrorComponentProps } from '@tanstack/react-router'
import { ApiError, reviewerQuery, type ReviewerView } from '../../api'
import { Rail } from '../../components/Rail'

export const Route = createFileRoute('/r/$token')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(reviewerQuery(params.token)),
  component: ReportPage,
  errorComponent: ReportError,
})

const STATUS: Record<ReviewerView['phase'], string> = {
  invited: 'Waiting for the candidate to open the desktop',
  opening: 'The desktop is opening',
  setup: 'The candidate is setting up',
  working: 'The candidate is working',
  collecting: 'Saving the work and the recording',
  grading: 'Running the hidden tests',
  done: 'Finished',
  failed: 'Stopped with an error',
}

// A test run can last seconds, so short spans show seconds instead of "0 min".
const span = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)

function ReportPage() {
  const { token } = Route.useParams()
  const { data: r } = useSuspenseQuery(reviewerQuery(token))
  const base = `/api/r/${token}`
  const setupUsedMs = r.openedAt && r.startedAt ? r.startedAt - r.openedAt : undefined
  const workUsedMs = r.startedAt && r.endedAt ? r.endedAt - r.startedAt : undefined

  return (
    <main className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
      <p className="font-mono text-xs tracking-wide text-graphite uppercase">Report</p>
      <h1 className="display mt-2 text-3xl font-extrabold sm:text-4xl">{r.title}</h1>
      <p className={`mt-2 font-semibold ${r.phase === 'failed' ? 'text-proctor' : 'text-graphite'}`} role="status">
        {STATUS[r.phase]}
        {r.error ? `: ${r.error}` : ''}
      </p>

      <section className="mt-8 grid gap-4 md:grid-cols-[16rem_1fr]">
        <Score grade={r.grade} />
        <div className="rounded-xl border border-rule bg-sheet p-5">
          <h2 className="text-sm font-semibold text-graphite">Time used</h2>
          <div className="mt-4">
            <Rail
              setupMinutes={r.setupMinutes}
              workMinutes={r.workMinutes}
              setupUsed={setupUsedMs === undefined ? 0 : setupUsedMs / (r.setupMinutes * 60_000)}
              workUsed={workUsedMs === undefined ? 0 : workUsedMs / (r.workMinutes * 60_000)}
            />
          </div>
          <p className="mt-4 text-sm">
            {setupUsedMs !== undefined && `Started after ${span(setupUsedMs)} of ${r.setupMinutes} min of setup. `}
            {workUsedMs !== undefined && `Worked ${span(workUsedMs)} of ${r.workMinutes} min. `}
            {r.endReason === 'submitted' && 'Ended by Submit.'}
            {r.endReason === 'timeout' && 'Ended when time ran out.'}
            {setupUsedMs === undefined && workUsedMs === undefined && 'Not started yet.'}
          </p>
        </div>
      </section>

      <Section title="Recording">
        {r.hasRecording ? (
          <video className="w-full rounded-xl bg-black" controls preload="metadata" src={`${base}/recording.mp4`} />
        ) : (
          <Empty>{r.phase === 'done' || r.phase === 'failed' ? 'No recording was saved.' : 'Appears when the interview ends.'}</Empty>
        )}
      </Section>

      <div className="grid gap-x-6 md:grid-cols-2">
        <Section title="Commits">
          {r.gitLog ? <Mono>{r.gitLog}</Mono> : <Empty>Appears when the interview ends.</Empty>}
        </Section>
        <Section title="Hidden test output">
          {r.grade ? <Mono>{r.grade.output}</Mono> : <Empty>Appears after grading.</Empty>}
        </Section>
      </div>

      {r.hasFinalState && (
        <p className="mt-8">
          <a className="font-semibold underline underline-offset-4" href={`${base}/final-state.tgz`}>
            Download the final state
          </a>
          <span className="text-graphite"> · the task folder as the candidate left it, with its Git history</span>
        </p>
      )}
    </main>
  )
}

function Score({ grade }: { grade: ReviewerView['grade'] }) {
  if (!grade) {
    return (
      <div className="rounded-xl border border-rule bg-sheet p-5">
        <h2 className="text-sm font-semibold text-graphite">Hidden tests</h2>
        <p className="mt-3 text-graphite">Not run yet.</p>
      </div>
    )
  }
  const allPassed = grade.total > 0 && grade.failed === 0
  return (
    <div className="rounded-xl border border-rule bg-sheet p-5">
      <h2 className="text-sm font-semibold text-graphite">Hidden tests passed</h2>
      <p className={`mt-2 font-mono text-5xl font-semibold tabular-nums ${allPassed ? 'text-pass' : 'text-proctor'}`}>
        {grade.passed}
        <span className="text-2xl text-graphite"> / {grade.total}</span>
      </p>
      {grade.total === 0 && <p className="mt-2 text-sm text-proctor">The tests did not run. See the output below.</p>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="display mb-3 text-lg font-bold">{title}</h2>
      {children}
    </section>
  )
}

function Mono({ children }: { children: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-xl border border-rule bg-sheet p-4 font-mono text-xs leading-6 whitespace-pre-wrap">
      {children}
    </pre>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-rule p-5 text-graphite">{children}</p>
}

function ReportError({ error }: ErrorComponentProps) {
  const missing = error instanceof ApiError && error.status === 404
  return (
    <main className="mx-auto max-w-xl px-4 py-24">
      <h1 className="display text-2xl font-bold">{missing ? 'This report link does not lead anywhere' : 'The report could not load'}</h1>
      <p className="mt-3 text-graphite">{missing ? 'Check that you copied the whole link.' : error instanceof Error ? error.message : String(error)}</p>
    </main>
  )
}
