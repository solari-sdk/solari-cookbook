# Browser agent perturbation suite

An agent that completes a task once has told you very little. This runs the
same task across a grid of deliberately perturbed environments — a consent
banner over the button, a slow endpoint, a phone-sized viewport, a session that
expires halfway — and scores each attempt from the shop's own server-side
state rather than from anything the agent says about itself.

Two things make that possible, and both need real infrastructure:

- **A Solari Sandbox hosts the benchmark shop** and exposes it on a public
  `https://` preview URL, so the site is genuinely remote and genuinely
  stateful. The browser reaches it over the open internet.
- **A Solari Browser session runs each trial**, and the perturbations that
  cannot be faked in markup — viewport, locale, network delay — are applied by
  building the browser context differently, because there is nowhere else to
  apply them.

The verdict is a separate `fetch` from this process to the shop's `/__suite/state`
endpoint, after the browser has been released. The agent never touches it.

## Run

```bash
cd applications/browser-agent-perturbation-suite
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

The script reads the environment variable; it does not load `.env` automatically.

The default suite is 4 variants x 2 repetitions: **1 sandbox and 8 browser
sessions**. To see the perturbations without spending anything:

```bash
npm start -- --list
```

The cheapest run that still shows the point is two sessions:

```bash
npm start -- --variants baseline,cookie_banner --repetitions 1
```

## What it prints

The default grid against real Solari infrastructure:

```
  variant          pass   score  flips
  baseline          2/2   1.00   0.00
  cookie_banner     0/2   0.30   0.00
  mobile_viewport   2/2   1.00   0.00
  expired_session   0/2   0.60   0.00

  Reliability   50.0%  (4/8)    95% CI 21.5% - 78.5%
  Baseline     100.0%  (n=2)
  Perturbed     33.3%  (n=6)

  Why the failures failed
    cookie_banner    x2  An overlay blocked the agent and it did not dismiss it.
    expired_session  x2  The session expired and the agent did not resume it.

  FAIL  reliability required 85.0%, got 50.0%
  PASS  baseline required 100.0%, got 100.0%

  FAIL
```

Your numbers will differ; running it is the point.

Now add one capability. `npm start -- --agent resilient` runs the identical grid
with an agent that clears blocking overlays and resumes an expired session. On
the same four variants it measured `100.0% (8/8)`, `95% CI 67.6% - 100.0%` —
every perturbation that beat the naive agent, handled. The gap between 50% and
100% is the measured worth of that one capability, which is the only thing this
program is really for.

Note what the interval does at the top: those eight passes out of eight print as
`67.6% - 100.0%`, not as `100%`. Small samples are not certainty, and the sample
size travels with every proportion on screen.

Both figures come from real runs, one sandbox and eight browser sessions each.
Individual trials took 7-8s unperturbed and 15-17s under a perturbation the
agent had to work through.

Read those two numbers narrowly. They describe the two scripted reference agents
in `src/agent.ts` on this fixture's four default variants, at n=8 each — which is
why the intervals above are 21.5-78.5% and 67.6-100.0% rather than points. They
are a demonstration that the harness can separate two agents whose capabilities
differ by one thing, not a benchmark of browser agents, and nothing here supports
a claim that resilient agents reach 100% anywhere else.

## How a trial works

1. Resolve the perturbation from a seed derived from
   `(run id, variant, repetition)`. Nothing calls `Math.random` or reads the
   clock, so a suite replays identically.
2. Register the run with the shop, which then renders differently for that run
   id only — one sandbox serves the whole grid.
3. Launch a browser session and build the context to the perturbation's browser
   half: viewport, locale, route interception.
4. Let the agent drive.
5. Release the browser.
6. **Then** read `/__suite/state` and derive the verdict from it.

Step 6 happening after step 5 is not an accident. The verdict needs the server,
not the browser, so there is no reason to hold a paid session open across it.

## The perturbations

| id | applied by | what changes |
| --- | --- | --- |
| `baseline` | — | nothing; this is the control |
| `cookie_banner` | the site | a consent banner covers the primary button, and the server refuses the action beneath it |
| `unexpected_modal` | the site | an interstitial appears after a seeded delay, so it lands at a different point on each repetition |
| `slow_api` | the site | state-changing requests take a seeded ~1.5s |
| `delayed_element` | the site | the add-to-cart control hydrates late |
| `expired_session` | the site | the session expires at the cart or the checkout stage; the cart survives |
| `mobile_viewport` | the browser | `newContext({ viewport, isMobile, hasTouch, ... })`, against the shop's real `max-width:480px` layout |
| `network_delay` | the browser | `context.route()` delays every response |
| `locale_variant` | both | German copy server-side **and** `newContext({ locale })` |

Two channels, because some of these have nowhere else to live: Solari's
`launch()` takes stealth, proxy and profile options, not a screen size, so
anything about the shape of the window has to be a context option.

## Cleanup

Every remote resource is registered for release in the same expression that
creates it, on a stack that tears down in reverse order, joins concurrent
callers, survives a disposer that throws, and abandons one that hangs. Each
trial takes a *child* of the run's stack, so one teardown releases every live
session and then the sandbox — including from the `SIGINT` handler, which is the
path a `finally` alone does not cover.

That nesting is load-bearing. A trial holding a free-standing stack is released
by its own `finally` on the normal path and by nothing at all on Ctrl-C, and the
test that is supposed to catch it will pass anyway unless it reproduces the real
shape. `test/sigint-child.ts` reproduces it.

`src/browser.ts` takes the stack as a required parameter rather than a comment
asking you to remember: you cannot get a page out of it without handing in the
thing that will release the session.

**What "released" can and cannot mean here.** `BrowserSession.close()` releases
the session and waits for the gateway to acknowledge it, and that acknowledgement
is the strongest signal the SDK offers: there is no `sessions.get` or
`sessions.list` to check afterwards, and the gateway acks a release without
consulting the pool. So this program reports that a release was *awaited and
acknowledged*, never that a session was confirmed gone. Sandboxes are different —
`sandboxes.get(id)` exists, and after `kill()` it reports the sandbox as not
found, which is a real confirmation. When a release does fail, the session id is
printed to the terminal, because that id is the only handle you have for cleaning
up by hand.

Ctrl-C was tested against live sessions, not only against fakes: interrupting a
run with two browser sessions open released both, killed the sandbox, and exited
`130`. The interrupted trials are reported `undetermined` rather than failed —
ending them was our doing, not the agent's.

If you only need one browser in one function, none of this is warranted —
`await using browser = await solari.launch()` is the right answer, and
[`browser-quickstart-ts`](../../examples/browser-quickstart-ts) is the example.
This exists because a suite holds one sandbox across every trial with several
sessions underneath it.

## Test

```bash
npm test
```

85 tests, no network and no API key. Alongside the unit tests, `pipeline.test.ts`
starts the shop locally and drives the whole harness through it over HTTP —
perturbation resolution, the agent loop, the server-state verdict, failure
classification and aggregation all run for real, with only the Solari calls
replaced. It includes an agent that does nothing and reports success, and
asserts that it scores zero. A second child-process test raises `SIGINT`
mid-run, with the session on a child stack the way a real trial holds it, and
asserts that both resources came back and the process exited 130.

## Options

```
--variants a,b,c     which perturbations to run
--repetitions N      runs per variant
--concurrency N      sessions open at once
--agent naive|resilient
--suite path.json    the task, grid and thresholds
--out dir            where evidence is written  (default ./runs)
--list               print the perturbations and exit
```

Exit `0` when every configured threshold was met or none was set, `1` when one
was missed, `2` when the suite could not run at all. The last two are separate
on purpose: "the agent is unreliable" and "we measured nothing" are different
facts, and CI cannot act on them if they arrive as the same number.

Thresholds live in `suite.json`. A threshold you do not set is not checked, and
the report says so rather than printing a pass nobody asked for. `baseline` has
its own gate because it is the control: if the agent cannot do the task in the
unperturbed environment, every perturbed number below it is meaningless.

## Evidence

Each run writes `runs/<run id>/` — the suite summary, and per trial the verdict,
the assertion table, the server's own ordered timeline, the agent's claim, and a
screenshot. The timeline and the claim sit in the same file deliberately: when
they disagree, that gap is the most informative thing the run produced.

Session ids, CDP endpoints, preview URLs and tokens are stripped before anything
is written, so a bundle is safe to attach to a bug report. They are printed to
the terminal only, and only when a release fails and you may need to clean up by
hand.

## Limits worth knowing

- **The agent is a scripted driver, not an LLM.** It follows a fixed plan
  against stable element ids. It is a plausible first agent, not a good one and
  not a straw man. Implementing the `Agent` interface in `src/agent.ts` is how
  you point this at a real one; the harness does not care which it measures.
- Because it targets ids rather than visible text, `locale_variant` does not
  defeat it. An agent that reads the page would fail it. That asymmetry is
  itself the reason the agent is behind an interface.
- **Eight trials is a demonstration, not a benchmark.** The confidence interval
  is printed because the sample is small, not despite it.
- **The perturbations are ours** — a site we wrote, misbehaving in ways we
  chose. Real sites also fail through third-party scripts, A/B tests, rate
  limits and bot walls, none of which are modelled here.
- **Seeding fixes the configuration, not the world.** Modal delay and API
  latency replay exactly; the network between you, the gateway and the VM does
  not. That residue is what the flip-rate column measures.
- **Undetermined trials are excluded from the denominator.** A run we could not
  judge is our failure, not the agent's, and is counted separately. If that
  count is not zero, the reliability figure is over a smaller sample than you
  asked for.
- One sandbox serves the whole suite; trials are isolated by run id rather than
  by VM, which keeps a run inside a single-sandbox allowance.
- **Release is confirmed as far as the API allows, which is not all the way.**
  See the note under Cleanup: a clean return from a release is the best evidence
  obtainable for a browser session, and this program does not describe it as
  more than that.

The perturbation model here is adapted from
[AgentGauntlet](https://github.com/Konuktor/agent-gauntlet), which applies it
with more perturbations and a persistent backend.
