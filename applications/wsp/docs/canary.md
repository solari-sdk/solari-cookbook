# Live tests and the canary

The unit suite (`pnpm test`) creates no machines and needs no key. Two kinds
of test stay out of it and run only when asked.

## The canary

The provider changes under us. On 2026-09-04 its host pool started refusing
a create field it had accepted and ignored two days earlier, and every
`wsp init` booted nothing until someone read the error off a live run. The
canary posts every create body wsp sends to the real API and fails naming
the provider's answer word for word, next to the body it sent.

```sh
pnpm canary                    # about three minutes, a few cents
WSP_LIVE_LONG=1 pnpm canary    # adds the 65 minute createdAt reading, about $0.11
```

It needs `SOLARI_API_KEY` in `.env` at the repo root and a free slot under
the account's machine cap: it holds one machine at a time, kills everything
it makes by id, deletes the snapshot it sealed, and never touches a machine
it did not create. Run it once a day and before every release; a red case is
the signal to change a create body on purpose, not a flake to rerun. Under
`WSP_LIVE=1` the root vitest config runs test files one at a time, so
nothing else live should run beside it.

What it covers:

- `packages/engine/test/create-canary.live.test.ts`: the builder body from
  `prepareBuilder`, the smoke fork body from `sealGolden` and the fork body
  from `forkGolden`, each asserted 201 and killed until gone; and the listing
  row of a machine it just created carrying `metadata`, `cpu` and `memMb`,
  which the sweep's owner and cost lines read.
- `packages/runtime/test/create-canary.live.test.ts`: the workspace body the
  runtime itself posts (owner label, lifecycle pause, idle backstop), created
  through `workspaces.create` on a snapshot the case takes and deletes, and
  removed through `workspaces.delete` with the machine read gone.
- `packages/engine/test/solari-quirks.live.test.ts`: the platform bugs we
  coded around, one case each, shouting when the platform changes so a guard
  is relaxed on purpose.
- `packages/engine/test/createdat-drift.live.test.ts` (only with
  `WSP_LIVE_LONG=1`): one base sandbox with the builder's lifecycle, never
  exec'd or paused, read right after create and at 2, 10 and 65 minutes. A
  measurement, not a guard: it prints every `createdAt` and `expiresAt`,
  asserts only that the machine stayed running and is gone after the kill.
  Measured 2026-09-04, the provider's `createdAt` tracks the wall clock about
  five minutes behind, so nothing in wsp reads it for a decision.

## Other live tests

Every file named `*.live.test.ts` creates real machines and runs only under
`WSP_LIVE=1`. They respect the account's two-machine cap, kill everything
they create, never touch a machine labeled `poc=ttl-test`, and check that
nothing is left running at the end. Never add parallelism flags to them.

## The render test

The terminal pane's glyph test
(`apps/web/src/terminal/ghostty/glyphs.browser.test.ts`) starts a Vite dev
server and Playwright's Chromium to draw Nerd Font codepoints through the
real pane and read the pixels back. It runs only under
`WSP_RENDER=1 pnpm test`, needs `pnpm exec playwright install chromium`
once, and skips, saying so, when that browser is missing.
