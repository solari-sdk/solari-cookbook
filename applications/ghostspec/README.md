# ghostspec

**Describe a user flow in English. Get a Playwright test that is verified to pass before you're handed it.**

```bash
npx ghostspec https://www.saucedemo.com \
  "log in as standard_user / secret_sauce, add a backpack to the cart, check out"
```

---

## The problem

Ask any model to write you a Playwright test and it will write one from memory. Memory is stale.

Here is `example.com` — the most stable page on the internet, in every training set ever assembled:

```ts
// what a model writes from memory        // what is actually on the page today
page.getByRole('link',                    page.getByRole('link',
  { name: 'More information...' })          { name: 'Learn more' })
```

The link was renamed. The from-memory test fails on the first run, and you spend your
afternoon debugging a selector instead of your app. Now scale that to an app the model
has *never seen* — your app — and every selector is a guess.

**ghostspec never guesses.** It opens your app on a real cloud browser, does the flow,
and writes the test from the locators it watched work.

## How it works

```
  url + "log in, add to cart, check out"
    │
    ├─ 1. explore    a real Chrome on Solari. Reads the page as an accessibility
    │                tree, picks one action, does it, looks again. Every locator
    │                that works is recorded. Session is recorded too.
    │
    ├─ 2. generate   the trace is ground truth. The model may not invent a
    │                locator — it only had ones that already clicked something.
    │
    ├─ 3. verify     runs the generated spec on a FRESH browser.
    │                Passes ⇒ you get it. Fails ⇒ you get the failure, not a lie.
    │
    └─ spec + HTML report + a shareable session replay
```

Step 3 is the part other tools skip. A generated test that has never been executed is a
guess with syntax highlighting.

## Install

```bash
npm i -g ghostspec     # or just npx ghostspec
```

Two things needed:

| | |
|---|---|
| `SOLARI_API_KEY` | free at [console.getsolari.com](https://console.getsolari.com) — env var or `.env` |
| a model | uses your `claude` CLI if you have one. Otherwise set `ANTHROPIC_API_KEY`. |

If you already run Claude Code, **you need no second API key.**

## Usage

```
npx ghostspec <url> "<flow in plain English>" [options]

  --out <dir>       where to write everything      (default ./ghostspec-out)
  --name <slug>     spec filename                  (default: from the flow)
  --max-steps <n>   ceiling on exploration steps   (default 25)
  --no-verify       write the spec without proving it passes
```

Exit code is `1` if the generated spec did not pass, so CI can branch on it.

## What you get

```
ghostspec-out/
  log-in-and-check-out.spec.ts   an ordinary Playwright spec. Yours. Commit it.
  log-in-and-check-out.html      what it did, screenshots, replay link, verdict
  playwright.config.ts           so the spec keeps running on a cloud browser
  solari.ts                      fixture: connects the runner over CDP
  solari.global.ts               mints one session per suite, releases it after
  checkout.replay.ndjson.gz      the recorded session (rrweb)

A real one is committed in `demo/` — spec, report, screenshots and all.
```

The spec is a **normal** `@playwright/test` file with no ghostspec import. Delete this
tool tomorrow and your tests still run.

## Running the tests afterwards, with no browsers installed

The emitted `solari.ts` points the runner at a Solari browser over CDP:

```ts
import { test, expect } from './solari'   // instead of '@playwright/test'
```

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i -D @playwright/test
SOLARI_API_KEY=slr_live_... npx playwright test
```

`solari.global.ts` mints one browser session before the suite and releases it after, so
`SOLARI_API_KEY` is the only thing you need in the environment. Set `SOLARI_CDP_ENDPOINT`
yourself if CI already holds a session and shouldn't mint a second.

No Chromium download, on your laptop or in CI. Verified against Playwright **1.62.1**
— we connect over **CDP**, which has no version gate, rather than the Playwright wire
protocol, which hard-pins you to 1.59.x and answers HTTP 428 to anything else.

## Why a cloud browser

Because "it works on my machine" is precisely the bug class E2E tests exist to catch.
Exploration needs a browser that is clean, disposable, and identical for every run —
and it needs to be somewhere you can point CI at without installing 300 MB of Chromium.
[Solari](https://getsolari.com) gives a session in ~2.8s, records it, and hands back a
replay URL you can put in a PR.

## Honest limits

- **Free-plan Solari** allows 3 concurrent browsers and 1-hour sessions, which is
  plenty here. Stealth, proxies and captcha are paid features — ghostspec needs none
  of them, because you are testing your own app.
- **Logins**: pass credentials in the flow text for now. They land in the generated
  spec, so treat it like any test fixture and use throwaway accounts.
- The replay is rrweb NDJSON, saved next to the report. It plays in an rrweb player;
  ghostspec does not ship a viewer yet.
- Exploration costs model calls and browser-seconds. `--max-steps` is the brake.
- **Exploration is not deterministic.** Two runs of the same flow explore slightly
  differently and assert different things. Every run is guaranteed to assert and to end
  on an assertion of the final state — but *which* intermediate assertions you get
  varies. If a run produces a weak spec, run it again.
- **Assertion quality is not judged, only assertion presence.** A run may assert on
  something legal but nearly worthless (a cart badge count). Read the spec before you
  commit it — it is a first draft written by something that watched your app, not a
  substitute for knowing what matters.
- **If exploration cannot finish the flow, you get `INCOMPLETE` and exit code 1** — the
  spec still covers what it reached, and the report is badged accordingly. A green
  report for a flow that stopped a third of the way in would be the one lie this tool
  exists to avoid.

## Built with

[Solari](https://getsolari.com) cloud browsers · [Playwright](https://playwright.dev) ·
Claude. Part of the [Solari cookbook](https://github.com/solari-sdk/solari-cookbook) ecosystem.

MIT.
