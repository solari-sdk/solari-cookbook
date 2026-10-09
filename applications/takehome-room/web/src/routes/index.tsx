import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { demoQuery, explain, startDemo, type DemoStatus } from '../api'
import { Rail } from '../components/Rail'
import { SiteNav } from '../components/SiteNav'

export const Route = createFileRoute('/')({ component: Home })

// Candidates and Reviewers arrive by their own links. This page is for visitors
// to a hosted copy (the demo) and for whoever runs the server.
function Home() {
  const demo = useQuery(demoQuery())
  return (
    <main className="mx-auto max-w-3xl px-4 pt-6 pb-16 sm:pb-24">
      <SiteNav />
      <h1 className="display mt-14 text-4xl sm:mt-20 leading-[1.05] font-extrabold sm:text-5xl">
        Take-home interviews in a real desktop
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-graphite">
        The candidate works in a recorded Linux desktop in their browser, with any AI tools they like. When the clock
        runs out, the reviewer gets the recording, the commits and the results of tests the candidate never saw.
      </p>

      {demo.data?.enabled && <DemoCard status={demo.data} />}

      <HowItWorks />

      <p className="mt-14 text-sm text-graphite">
        Running an interview?{' '}
        <Link to="/admin" className="font-semibold text-ink underline underline-offset-4">
          Create one and get its links
        </Link>
      </p>
    </main>
  )
}

function DemoCard({ status }: { status: DemoStatus }) {
  const navigate = useNavigate()
  const start = useMutation({
    mutationFn: startDemo,
    onSuccess: ({ candidatePath }) => navigate({ to: '/c/$token', params: { token: candidatePath.slice(3) } }),
  })
  const setup = status.setupMinutes ?? 0
  const work = status.workMinutes ?? 0
  const waitMinutes = Math.ceil((status.retryAfterSeconds ?? 0) / 60)

  return (
    <section id="demo" className="mt-10 scroll-mt-6 rounded-xl border border-rule bg-sheet p-5 sm:p-6">
      <h2 className="display text-lg font-bold">Try it as the candidate</h2>
      <p className="mt-2 text-graphite">
        A short version of a real task: {setup} minutes to settle in, then {work} minutes on the clock. Afterwards you
        see the report a reviewer would get.
      </p>
      <div className="mt-5 max-w-md">
        <Rail setupMinutes={setup} workMinutes={work} />
      </div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          className="rounded-lg bg-ink px-5 py-3 font-semibold text-paper hover:opacity-90 disabled:opacity-50"
          disabled={!status.available || start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending ? 'Starting…' : 'Start the demo'}
        </button>
        {!status.available && (
          <p className="text-sm text-graphite" role="status">
            {status.reason === 'cap'
              ? `Today's demos are used up. More open in about ${waitMinutes >= 120 ? `${Math.round(waitMinutes / 60)} hours` : `${waitMinutes} minutes`}.`
              : `Someone is using the desktop right now. It frees up in about ${waitMinutes} minutes.`}
          </p>
        )}
      </div>
      {start.error && <p className="mt-3 text-sm text-proctor">{explain(start.error)}</p>}
      {(!status.available || start.error) && <Contact />}
      <p className="mt-4 text-xs text-graphite">Demos run one at a time on a shared cloud desktop.</p>
    </section>
  )
}

interface Step {
  title: string
  text: string
  /** A screenshot in web/public/screenshots, as `<name>-light.webp` and `<name>-dark.webp`. */
  shot?: { name: string; alt: string; width: number; height: number }
}

// The steps follow one Interview in order. A step without a screenshot shows its text only.
const STEPS: Step[] = [
  {
    title: 'The reviewer creates an interview',
    text: 'Pick a task and the times, and get two links: one to send to the candidate, one to keep.',
    shot: {
      name: 'admin',
      alt: 'The reviewer page: a form to create an interview, a new candidate link and reviewer link with Copy buttons, and a list of interviews with their status and scores.',
      width: 1888,
      height: 1940,
    },
  },
  {
    title: 'The candidate opens their link',
    text: 'The page explains the two clocks and the screen recording before anything starts.',
    shot: {
      name: 'candidate',
      alt: 'The candidate page for the LRU cache task: where they work, 10 minutes of setup, 45 minutes of work, the recording notice, and the button to open the desktop.',
      width: 1632,
      height: 1276,
    },
  },
  {
    title: 'They work in a recorded desktop in the browser',
    text: 'VS Code, Git and Python, with the starter files already committed. The server owns the clock and collects the work when it runs out.',
    // The real Room page, with a frame from a demo's recording where the live
    // stream goes, because a live Room cannot be captured without opening one.
    shot: {
      name: 'desktop',
      alt: 'The candidate at work: VS Code in the remote desktop, under a bar with the work clock at 0:36 in red, the recording light and the Submit button. The visible tests pass in the terminal.',
      width: 1280,
      height: 775,
    },
  },
  {
    title: 'The reviewer reads the report',
    text: 'Hidden tests run on a copy of the final folder in a separate machine. Here they caught a typo in a branch that the visible tests never reach.',
    shot: {
      name: 'report',
      alt: 'A report: 7 of 9 hidden tests passed, 10 of 10 minutes used, the recording of VS Code, one commit, and the hidden test output with two errors.',
      width: 2144,
      height: 2896,
    },
  },
]

function HowItWorks() {
  return (
    <section id="how-it-works" className="mt-16 scroll-mt-6">
      <h2 className="display text-2xl font-bold">How an interview works</h2>
      <ol className="mt-8 space-y-12">
        {STEPS.map((step, i) => (
          <li key={step.title} className="grid gap-x-4 sm:grid-cols-[2.5rem_1fr]">
            <span className="font-mono text-sm text-graphite tabular-nums sm:pt-1" aria-hidden>
              {String(i + 1).padStart(2, '0')}
            </span>
            <div>
              <h3 className="text-lg font-semibold">{step.title}</h3>
              <p className="mt-1 text-graphite">{step.text}</p>
              {step.shot && (
                <picture>
                  <source srcSet={`/screenshots/${step.shot.name}-dark.webp`} media="(prefers-color-scheme: dark)" />
                  <img
                    className="mt-5 w-full rounded-xl border border-rule"
                    src={`/screenshots/${step.shot.name}-light.webp`}
                    alt={step.shot.alt}
                    width={step.shot.width}
                    height={step.shot.height}
                    loading="lazy"
                    // A copy without the screenshots shows the step's text only.
                    onError={(e) => {
                      e.currentTarget.parentElement!.hidden = true
                    }}
                  />
                </picture>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** For visitors who cannot wait: the author can set up an interview for them. */
const CONTACTS = [
  { label: 'jananitan@gmail.com', href: 'mailto:jananitan@gmail.com' },
  { label: 'X', href: 'https://x.com/iam_nitan' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/nitan-jana' },
]

function Contact() {
  return (
    <p className="mt-3 text-sm">
      Cannot wait? Ask Nitan for your own interview link:{' '}
      {CONTACTS.map((c, i) => (
        <span key={c.href}>
          {i > 0 && ' · '}
          <a
            className="font-semibold underline underline-offset-4"
            href={c.href}
            {...(c.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}
          >
            {c.label}
          </a>
        </span>
      ))}
    </p>
  )
}
