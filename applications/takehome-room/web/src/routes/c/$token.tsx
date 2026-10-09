import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, type ErrorComponentProps } from '@tanstack/react-router'
import { ApiError, candidateAction, candidateQuery, explain, type CandidateAction, type CandidateView } from '../../api'
import { Rail } from '../../components/Rail'
import { RoomScreen } from '../../components/RoomScreen'
import { formatClock, useCountdown } from '../../components/useCountdown'

export const Route = createFileRoute('/c/$token')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(candidateQuery(params.token)),
  component: CandidatePage,
  errorComponent: LinkError,
})

function useAction(token: string) {
  const queryClient = useQueryClient()
  const { queryKey } = candidateQuery(token)
  return useMutation({
    mutationFn: (action: CandidateAction) => candidateAction(token, action),
    onSuccess: (view) => queryClient.setQueryData(queryKey, view),
    // A 409 means the server already moved on, for example time ran out. Resync.
    onError: () => queryClient.invalidateQueries({ queryKey }),
  })
}

function CandidatePage() {
  const { token } = Route.useParams()
  const { data, dataUpdatedAt } = useSuspenseQuery(candidateQuery(token))
  switch (data.phase) {
    case 'invited':
      return <CoverSheet view={data} token={token} />
    case 'opening':
      return <Opening view={data} />
    case 'setup':
    case 'working':
      return <Room view={data} token={token} fetchedAt={dataUpdatedAt} />
    case 'failed':
      return <Stopped view={data} />
    default:
      return <Handed view={data} />
  }
}

function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl px-4 py-12 sm:py-20">{children}</main>
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs tracking-wide text-graphite uppercase">{children}</p>
}

function CoverSheet({ view, token }: { view: CandidateView; token: string }) {
  const open = useAction(token)
  return (
    <Page>
      <Eyebrow>{view.demo ? 'Demo · take-home interview' : 'Take-home interview'}</Eyebrow>
      <h1 className="display mt-2 text-3xl font-extrabold sm:text-4xl">{view.title}</h1>
      {view.demo && (
        <p className="mt-3 max-w-2xl text-graphite">
          You are the candidate. This runs on a real cloud desktop with a shortened clock. After you submit, you get the
          reviewer's report for your own attempt.
        </p>
      )}

      <section className="mt-8 rounded-xl border border-rule bg-sheet">
        <dl className="divide-y divide-rule">
          <Row term="Where you work">
            A Linux desktop that runs in the cloud and appears in this tab. It has VS Code, Git and Python. Use any AI
            tools you like.
          </Row>
          <Row term="Setup time">
            {view.setupMinutes} minutes to sign in and arrange your tools. It does not count. It ends early when you
            press Start.
          </Row>
          <Row term="Work time">{view.workMinutes} minutes, from when you press Start or when setup time runs out.</Row>
          <Row term="Recording">
            <span className="flex items-start gap-2">
              <span className="mt-2 size-2 shrink-0 rounded-full bg-proctor" aria-hidden />
              <span>The desktop's screen is recorded for the hiring team. Your webcam and microphone are never used.</span>
            </span>
          </Row>
        </dl>
        <div className="border-t border-rule px-5 py-5">
          <Rail setupMinutes={view.setupMinutes} workMinutes={view.workMinutes} />
        </div>
      </section>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          className="rounded-lg bg-ink px-5 py-3 font-semibold text-paper hover:opacity-90 disabled:opacity-50"
          disabled={open.isPending}
          onClick={() => open.mutate('open')}
        >
          {open.isPending ? 'Opening…' : 'Agree and open the desktop'}
        </button>
        <p className="text-sm text-graphite">The remote screen can feel a little slower than your own computer.</p>
      </div>
      {open.error && <p className="mt-3 text-sm text-proctor">{explain(open.error)}</p>}

      <h2 className="display mt-14 text-lg font-bold">The task</h2>
      <pre className="mt-3 overflow-x-auto rounded-xl border border-rule bg-sheet p-5 font-mono text-sm leading-7 whitespace-pre-wrap">
        {view.instructions}
      </pre>
    </Page>
  )
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-5 py-4 sm:grid-cols-[10rem_1fr] sm:gap-6">
      <dt className="text-sm font-semibold text-graphite">{term}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  )
}

function Opening({ view }: { view: CandidateView }) {
  return (
    <Page>
      <Eyebrow>{view.title}</Eyebrow>
      <h1 className="display mt-2 text-3xl font-extrabold" role="status">
        Opening your desktop
      </h1>
      <p className="mt-3 text-graphite">This takes about 30 seconds. Setup time starts when the desktop appears.</p>
      <div className="mt-8 max-w-md">
        <Rail setupMinutes={view.setupMinutes} workMinutes={view.workMinutes} compact />
      </div>
    </Page>
  )
}

function Room({ view, token, fetchedAt }: { view: CandidateView; token: string; fetchedAt: number }) {
  const act = useAction(token)
  const left = useCountdown(view.secondsLeft, fetchedAt)
  const working = view.phase === 'working'
  const phaseSeconds = (working ? view.workMinutes : view.setupMinutes) * 60
  const used = left === undefined || phaseSeconds === 0 ? 0 : 1 - left / phaseSeconds
  const nearEnd = working && left !== undefined && left <= 5 * 60

  const submit = () => {
    if (confirm('Submit now? The desktop closes, and you cannot change your work after this.')) act.mutate('submit')
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-rule bg-sheet px-4 py-2">
        <div className="min-w-0">
          <p className="display truncate text-sm font-bold">{view.title}</p>
          <p className="text-xs text-graphite">{working ? 'Work time' : 'Setup time · not counted'}</p>
        </div>
        <div className="hidden min-w-40 flex-1 md:block">
          <Rail
            setupMinutes={view.setupMinutes}
            workMinutes={view.workMinutes}
            setupUsed={working ? 1 : used}
            workUsed={working ? used : 0}
            compact
          />
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-graphite md:ml-0">
          <span className="size-2 animate-pulse rounded-full bg-proctor" aria-hidden />
          Recording
        </span>
        <p
          className={`font-mono text-xl font-semibold tabular-nums ${nearEnd ? 'text-proctor' : ''}`}
          aria-live="off"
          title={working ? 'Work time left' : 'Setup time left'}
        >
          {left === undefined ? '–' : formatClock(left)}
        </p>
        {working ? (
          <button
            className="rounded-lg border border-ink px-4 py-1.5 font-semibold hover:bg-ink hover:text-paper disabled:opacity-50"
            disabled={act.isPending}
            onClick={submit}
          >
            Submit
          </button>
        ) : (
          <button
            className="rounded-lg bg-ink px-4 py-1.5 font-semibold text-paper hover:opacity-90 disabled:opacity-50"
            disabled={act.isPending}
            onClick={() => act.mutate('start')}
          >
            Start the clock
          </button>
        )}
      </header>
      {view.streamUrl && <RoomScreen streamUrl={view.streamUrl} />}
    </div>
  )
}

function Handed({ view }: { view: CandidateView }) {
  return (
    <Page>
      <Eyebrow>{view.title}</Eyebrow>
      <h1 className="display mt-2 text-3xl font-extrabold">
        {view.endReason === 'timeout' ? 'Time is up. Your work is saved' : 'Submitted'}
      </h1>
      {view.reportPath ? (
        <>
          <p className="mt-3 text-graphite">
            The desktop is closed. Grading takes a minute or two, and the report fills in by itself.
          </p>
          <Link
            to="/r/$token"
            params={{ token: view.reportPath.slice(3) }}
            className="mt-6 inline-block rounded-lg bg-ink px-5 py-2.5 font-semibold text-paper hover:opacity-90"
          >
            See the reviewer's report
          </Link>
        </>
      ) : (
        <p className="mt-3 text-graphite">The desktop is closed, and the hiring team has your work. You can close this tab.</p>
      )}
    </Page>
  )
}

function Stopped({ view }: { view: CandidateView }) {
  return (
    <Page>
      <Eyebrow>{view.title}</Eyebrow>
      <h1 className="display mt-2 text-3xl font-extrabold">Your desktop stopped</h1>
      <p className="mt-3">Send this message to the person who gave you the link, so they can set up a new one.</p>
      {view.error && (
        <pre className="mt-4 rounded-xl border border-proctor/40 bg-sheet p-4 font-mono text-sm whitespace-pre-wrap text-proctor">
          {view.error}
        </pre>
      )}
    </Page>
  )
}

function LinkError({ error, reset }: ErrorComponentProps) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Page>
        <h1 className="display text-2xl font-bold">This link does not lead anywhere</h1>
        <p className="mt-3 text-graphite">Check that you copied the whole link, or ask for a new one.</p>
      </Page>
    )
  }
  return (
    <Page>
      <h1 className="display text-2xl font-bold">The page could not load</h1>
      <p className="mt-3 text-graphite">{error instanceof Error ? error.message : String(error)}</p>
      <button className="mt-6 rounded-lg border border-ink px-4 py-2 font-semibold" onClick={reset}>
        Try again
      </button>
    </Page>
  )
}
