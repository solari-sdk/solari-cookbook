# Persistent profiles (TypeScript)

Log in once, reuse the session forever. A profile stores cookies + localStorage server-side; attach it with `profileId`, pass the state it returns to your context, and the browser starts already logged in.

Run it twice: the visit counter survives because the profile is saved between runs.

Two halves are easy to miss, and each one on its own leaves you with a counter stuck at 1. Attaching a profile does not auto-save it, so you must call `profiles.save()`. And attaching a profile does not seed the browser either, so `session.storageState` has to reach `newContext({ storageState })`.

Building the context yourself has one knock-on effect: it no longer inherits the timezone the pool pins when you request a proxy. If you combine a profile with a managed proxy, pass `timezoneId: browser.proxy?.timezoneId` alongside the state.

## Run

```bash
cd examples/browser-profiles-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

Source: [`index.ts`](index.ts)
