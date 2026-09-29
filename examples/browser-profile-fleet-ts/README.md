# A fleet of profiles (TypeScript)

One profile is a saved login. Several are a cast: the same page rendered as an
anonymous visitor, a free account and a paying one, in parallel, with each
browser proving it got its own state rather than a neighbour's.

The assertion is the part worth copying. Checking that a profile attached tells
you nothing — this reads the value back off a live page and throws if it is
wrong.

Two things are easy to miss, and either one leaves every browser anonymous.
Attaching a profile does not seed the browser, so `session.storageState` has to
reach `newContext({ storageState })` — a page from `browser.newPage()` starts
empty. And a context you build yourself does not inherit the timezone the pool
pins for a proxy, so pass `timezoneId: browser.proxy?.timezoneId` too.

Three browsers is well inside any plan. Starter documents 20 concurrent and
measurably accepts 18, refusing the 19th with
`429 ConcurrencyLimitExceeded`, so a larger fleet should back off rather than
assume the published number.

## Run

```bash
cd examples/browser-profile-fleet-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

Source: [`index.ts`](index.ts)
