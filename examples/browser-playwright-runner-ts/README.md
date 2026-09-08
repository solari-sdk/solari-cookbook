# Run your Playwright suite on Solari (TypeScript)

Point the tests you already have at a cloud browser. Change one import per spec,
install without downloading a browser, and no Chromium is ever fetched or
launched locally.

```ts
- import { test, expect } from "@playwright/test"
+ import { test, expect } from "./solari"
```

Nothing else in your specs changes. `solari.global.ts` mints one session before
the suite and releases it after, so `SOLARI_API_KEY` is the only thing the
environment needs.

## Run

```bash
cd examples/browser-playwright-runner-ts
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

Already have a session? Export `SOLARI_CDP_ENDPOINT` and the setup leaves it
alone, so CI that mints its own does not create a second.

## What to know before porting a real suite

- **It connects over CDP, not the Playwright wire protocol.** `connectOptions`
  in the config would speak the wire protocol, and the browser server rejects
  clients whose version does not match its own with a 428. Connecting in a
  fixture over CDP has no version gate, so your suite survives a Playwright
  upgrade on either side.
- **One session is one browser, so the suite runs serially.** `workers: 1` is
  deliberate: a second worker would fight the first over the same remote Chrome.
  For parallelism, mint a session per worker.
- **Tests share a context.** Local Playwright gives each test a fresh one; here
  they inherit the session's cookies and storage. Convenient for a login done
  once, surprising if your suite assumes isolation.
- **Playwright's trace, video and screenshot-on-failure are off**, because the
  fixture overrides `context`. Solari's session replay is the artifact instead.

Source: [`solari.ts`](solari.ts) · [`solari.global.ts`](solari.global.ts)

Extracted from [ghostspec](https://github.com/badnikhil) by @badnikhil, who
worked out the CDP-over-wire-protocol reasoning above.
