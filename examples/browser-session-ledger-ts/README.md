# A ledger for sessions you cannot list (TypeScript)

Browser time is billed per hour while a session is open, so a process that dies
between `launch()` and `close()` leaves something running that costs money and
holds one of your concurrent slots.

Sandboxes have `sandboxes.list()` for finding strays like that. Browser
sessions have no `list`, and `GET /sessions` is a 404, so there is nothing to
ask. See [#61](https://github.com/solari-sdk/solari-cookbook/issues/61).

Until that exists, write down what you started: record the id before doing any
work, drop it on a clean close, and release whatever is still recorded next
time you start.

```
ledger clean, nothing to reap
clean run: "Example Domain" — ledger now has 0 entries

leaked a session on purpose — ledger has 1 entry
this is what a process dying mid-run leaves behind

next run reaps it:
  released crashed-run (open since 2026-09-08T17:55:24.012Z)
```

## Two things it deliberately does not do

**It does not check whether a recorded session is still alive first.**
`GET /sessions/:id` reports dead sessions as `"status":"active"`, so the answer
cannot be trusted. `releaseAndWait` is idempotent, so releasing something
already gone is free — just release.

**It cannot find sessions it did not record.** Another machine, another CI job,
or a crash before the ledger write are all invisible from the client side.
That is the missing endpoint, not a limitation of this pattern.

## Run

```bash
cd examples/browser-session-ledger-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

It leaks a session on purpose and then reaps it, so you can watch both halves.

Source: [`index.ts`](index.ts)
