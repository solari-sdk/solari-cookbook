# Forge

An autonomous coding agent that uses **only Solari's sandbox** product —
deliberately split out from [`qa-agent`](../qa-agent) (browser+sandbox) as a
second, sandbox-focused submission, since the challenge counts single-product
demos too ("browsers, sandboxes, **and/or** desktops").

Give it a task in plain English. A Mistral model (via AWS Bedrock, same setup
as `qa-agent` — see its README for why not Claude) writes code, runs it
inside the sandbox, reads the real stdout/stderr/exit code, and **iterates
until it actually works** — a write → run → fix loop, not a single
code-generation call graded on vibes.

## Results (live runs against real Bedrock + Solari, not mocks)

- **Genuine self-debug loop, caught on the first live run.** Task: build a
  `/reverse` HTTP endpoint, expose it, prove it works. Forge wrote the
  server, started it, exposed port 8000 — then its own verification request
  came back `401 invalid preview token` (Solari's preview URLs require a
  `pt_token` query param the model hadn't included). It read the real error
  text, appended the token, retried, and got the correct `olleh` response —
  a real write → run → read-the-actual-error → fix cycle, not a stumble that
  got silently retried by the harness. See
  [`reports/report-20260904-194327.md`](reports/report-20260904-194327.md).
- **A real bug in this harness, caught by its own verification design.**
  That same run self-reported `success: true` with a correct proof — but the
  independent post-run check (`main.py` fetching `service_url` from outside
  the sandbox) got a 404. Root cause turned out to be in *this* code, not
  the model: `Orchestrator.run()` was killing the sandbox in a `finally`
  block immediately after `finish`, tearing down the very server the next
  step was about to verify. Fixed by moving teardown to `main.py`, after
  verification runs. Re-ran the identical task and got a genuine end-to-end
  green result: `reachable=True, status=200, contains_expected=True,
  body='olleh'` — see
  [`reports/report-20260904-194449.md`](reports/report-20260904-194449.md).
  Kept both reports: the first is the more interesting one to read (it's
  where the false-positive actually happened), the second is the proof the
  fix works.
- **Three more live runs, stress-testing beyond the default task** (a
  logic-only script, a stateful HTTP service, and environment discovery):
  - Wrote `is_prime`/`nth_prime` against 9 assertions (edge cases: 0,
    negatives, 1, primality boundary at 97/100) and got them all correct on
    the first run — [`reports/report-20260905-031327.md`](reports/report-20260905-031327.md).
    Manually checked the math myself; the code is genuinely correct, not
    just lucky output.
  - Built a stateful in-memory counter service (`POST /increment`,
    `GET /count`), called increment three times, and the independently
    re-checked count still read `3` after the run — proving persisted
    server state survives past `finish`, not just a one-shot response:
    `status=200, contains_expected=True, body='3'` —
    [`reports/report-20260905-031411.md`](reports/report-20260905-031411.md).
  - Told to actually check (not assume) whether `flask`/`fastapi`/`requests`
    are importable before picking an approach. It ran real `import` attempts,
    got real `ModuleNotFoundError`s, correctly concluded none are available,
    and fell back to `http.server` — independently verified body
    `'sandbox-check-ok'` —
    [`reports/report-20260905-031449.md`](reports/report-20260905-031449.md).
  - **Same environment gotcha hit and self-corrected twice, independently:**
    both the counter service and the package-discovery run tried
    `run_command(cmd='python', ...)` first, got a real
    `exec: "python": executable file not found in $PATH`, and retried with
    `python3` on their own — confirms `is_prime`/`hello-world`-tier
    correctness isn't the interesting part; recovering from a real,
    reproducible environment fact on the first try, unprompted, is.

Across all 4 live runs: 3 independent HTTP re-checks, all green; one genuine
harness bug found and fixed; two distinct classes of real error hit and
self-corrected (a Solari-specific 401, and a missing `python` binary,
twice). Not a large sample, but every single result here is a real API call
against real infrastructure — nothing mocked, nothing hand-picked after the
fact (failed/partial runs are linked above alongside the clean ones).

## The verification discipline (same principle as `qa-agent`)

`qa-agent`'s biggest lesson was that a tool-using model will confidently
claim success it didn't actually achieve unless something *other than the
model* checks the claim. Forge applies the same discipline here:

- `finish`'s `proof` field must cite the exact command and exact output the
  model saw — not what it expects the output to be.
- If the task stands up a service, the model must set `service_url` /
  `verify_contains`, and **after** the run ends, `main.py` independently
  fetches that URL itself (`agent/verify.py`) — a real HTTP request from
  outside the sandbox, from code the model never touches — before the report
  is allowed to say "independently verified."

## Architecture

```
main.py
  -> Orchestrator (agent/orchestrator.py)
       tools: write_file / run_command / run_code / expose_port  -> SandboxToolkit (sandbox only)
              finish                                               -> ends the run, records outcome
  -> verify.py independently re-fetches service_url from outside the sandbox
  -> report.py writes reports/report-<timestamp>.md
```

`agent/solari_tools.py` is the only file that talks to Solari directly.
`agent/bedrock_client.py` is copied verbatim from `qa-agent` — it's a
product-agnostic wrapper around Bedrock's `converse()` API, nothing in it is
QA-specific.

## Setup

1. `cd code-agent && pip install -r requirements.txt`
2. Copy `.env.example` to `.env` and fill in `SOLARI_API_KEY` and AWS
   credentials with Bedrock Mistral model access — identical requirements to
   `qa-agent`, see its README for the exact steps.
3. `python main.py`

The default task builds a tiny HTTP server with a `/reverse` endpoint,
exposes it, and self-verifies a real request before finishing. Give it your
own:

```sh
python main.py --task "Write a script that computes the first 20 prime numbers and prints them" --max-steps 15
```

## Known rough edges

- **Sandbox environment facts, now actually verified (2026-09-05) instead of
  assumed:** the `base` template runs Python 3.11.2 as `python3` - **not**
  `python` (that binary doesn't exist; every run that tried it hit a real
  `exec: "python": executable file not found in $PATH` and had to recover).
  None of `flask`, `fastapi`, or `requests` are installed - confirmed via
  real `import` attempts, not assumption. Stick to `python3` + the standard
  library unless a task first confirms a package is installed.
- **No independent check for non-HTTP tasks.** `verify.py` only re-checks
  `service_url` claims. A task with no running service (e.g. the prime-number
  script) has no automated cross-check beyond the transcript itself and
  manual review - same limitation `qa-agent` has for anything that isn't a
  re-queryable API endpoint.
- **Every clean run so far has been single-pass or a one-line fix** (a wrong
  URL, a wrong binary name) - none has needed more than two attempts at the
  same piece of logic. The self-debug loop's behavior under a genuinely hard,
  multi-iteration bug (not just an environment surprise) is still unproven.

## Cost note

Every run spins up one sandbox VM on first tool call, billed against your
Solari balance. Bedrock inference is billed per-token by AWS separately —
see `qa-agent`'s README for the same note on model cost.
