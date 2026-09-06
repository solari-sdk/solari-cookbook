# Self-healing E2E (TypeScript)

Run a browser test on a recorded Solari session, then run the same steps against a build where a
release renamed the button the test clicks. The click fails, a model is asked for the selector that
now serves that step, the whole spec is re-run to prove the repair holds, and the result lands in a
static evidence page linking each session's replay.

The app under test is two inline HTML strings served with `page.setContent()` — no server, no build
step, nothing past the SDK to install. Swap them for your own URLs.

## Run

```bash
cd examples/self-healing-e2e-ts
cp .env.example .env      # SOLARI_API_KEY, and a healer if you want one
npm install
npm start
```

The healer is optional: without it the run stops at the drift and exits 1, still the interesting
half. `HEALER=openai` calls any OpenAI-compatible `/chat/completions`; `HEALER=claude` shells out to
the Claude Code CLI and needs no key. Replays upload asynchronously after release, so the evidence
page polls ~60s and otherwise prints the session id and how to fetch it later.

The full engine behind this idea — spec files, real apps, repair PRs — is
[e2e-doctor](https://github.com/hive-controls/e2e-doctor), optionally configured by
[`@hive-controls/formic`](https://www.npmjs.com/package/@hive-controls/formic).

Source: [`index.ts`](index.ts)
