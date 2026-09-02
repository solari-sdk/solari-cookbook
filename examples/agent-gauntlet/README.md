# Agent reliability testing (TypeScript)

Run the same browser task twice — once on a clean page, once with a cookie
banner covering the button — and judge each run by the page's own state rather
than by what the script believes happened.

That distinction is the point. An agent reporting success is not evidence of
success, so the verdict here comes from `isVisible()` on the confirmation the
page renders, which the script cannot fake.

## Run

```bash
cd examples/agent-gauntlet
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

Two browser sessions, about a minute.

## Expected output

```
PASS  baseline       2 steps
FAIL  cookie_popup   2 steps

Reliability 50% (1/2)
The agent completes the task, but not when the environment changes.
```

The agent is deliberately naive — it never looks for an overlay — so the banner
defeats it. A single-run benchmark would have reported success and stopped.

Source: [`index.ts`](index.ts)

---

## The full version

**[AgentGauntlet](https://github.com/Konuktor/agent-gauntlet)** applies this idea
properly: ten perturbations across UI, network, viewport, session state and
locale; reliability as a Wilson interval; deterministic failure classification;
regression comparison; and a replay for every failure. It uses Solari Sandbox
too — to host a controlled benchmark site on a preview URL, and to execute
*external agent repositories* in isolation, handing them a scoped CDP endpoint
rather than an API key.

**Live demo:** https://http--agent-gauntlet-web--hjwypxsqnrjv.code.run

Measured there on four real Solari sessions: `baseline` PASS in 7 steps,
`cookie_popup` PASS in 7, `unexpected_modal` PASS in **19**, `expired_session`
FAIL. The third one is the interesting case — it passed, and took nearly three
times as many steps. Four runs is a demonstration, not a benchmark.
