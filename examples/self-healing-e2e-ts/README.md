# Self-healing E2E, part one: catch the drift (TypeScript)

Replay a recorded browser test on a Solari session against the build it was recorded on, then
against a release that renamed the button the test clicks. The click times out, and the run prints
the failing step with the DOM it failed against — the thing any repair, human or model, has to
reason from.

The app under test is two inline HTML strings served with `page.setContent()` — no server, no build
step, nothing past the SDK to install. Swap them for your own URLs.

## Run

```bash
cd examples/self-healing-e2e-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

```
run 1 — the build the test was recorded against
  pristine 1/7 fill #email — ok
  ...
  pristine 7/7 expect #confirmation — ok

run 2 — after the release
  drifted  1/7 fill #email — ok
  ...
  drifted  6/7 click #approve — FAILED: locator.click: Timeout 3000ms exceeded.

drift: step 6 #approve — locator.click: Timeout 3000ms exceeded.
DOM at failure: <!DOCTYPE html><html><head>...<button id="confirm-order" class="btn-primary">Approve order</button>...
```

Finding the drift is the point, so that run exits 0. It exits 1 only if the pristine build fails
or the drifted one passes (a stale fixture).

Repairing the step — asking a healer for the selector that now serves it, re-running the whole spec
to prove the repair holds, and keeping the evidence — is what
[e2e-doctor](https://github.com/hive-controls/e2e-doctor) does.

Source: [`index.ts`](index.ts)
