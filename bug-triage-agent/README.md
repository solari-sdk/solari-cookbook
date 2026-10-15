# Bug Triage Agent — the gap, not the tool

"I spent 3 days scoping what this would take locally. It took a working,
real pipeline on Solari in a weekend. Here's the diff."

## What it does — real, not simulated

Given a natural-language bug report against a real GUI checkout app, it:

1. **Reproduces it** — opens the app on a real Solari Desktop (VNC), drives
   the exact repro steps (select Express shipping, click Submit), records
   the session. Real run: **36.75s**, live MP4 replay produced.
2. **Diagnoses it** — pulls the source into a Solari Sandbox, runs static
   analysis, generates a candidate patch, and *statically verifies the
   patch actually contains the fix* (not asserted — real check: patched
   file greped for the re-bind call it's supposed to add).
3. **Checks prior art** — uses a real Solari Browser session against
   GitHub's search API to check if this pattern is already known elsewhere.
4. **Outputs a triage report**: severity, root cause, the patch, a
   before/after screenshot pair, and the recording URL as proof.

All three Solari primitives feed one continuous pipeline, confirmed
end-to-end on live infra, not three disconnected demos wearing the same
README.

**Honest limitation, stated plainly:** the prior-art check is keyword
search, not semantic matching — it can return real but loosely-related
GitHub issues (confirmed in testing). Read `known_issue_elsewhere` as "the
search found something," not "this exact bug is confirmed elsewhere."

**Also honest:** `tests_pass` is a static check (does the patch file
contain the expected fix), not a full re-run of the click sequence against
the patched page. That full runtime retest is the natural next step, not
done in this pass.

## The actual pitch: three quantified contrasts, all run live

### 1. Parallel scale (Browser)
Real run: 10 concurrent Solari browser sessions, capped at the free tier's
actual concurrency limit (3 at once — confirmed live via a 429
`ConcurrencyLimitExceeded` error before the cap was respected in code).
**Result: 10/10 succeeded, 16.47s total wall-clock**, via a semaphore and
zero proxy/fingerprint/orchestration code.
- Local-infra cost estimate for the same throughput: `evidence/local_infra_estimate.md`.
- Worth saying directly in a demo: raising the concurrency ceiling past 3
  is a plan upgrade, not an engineering project. That's the actual pitch.

### 2. Isolation (Sandbox)
Corrected from an earlier draft of this demo that tested the wrong thing
(writing to `/etc/passwd` inside your *own* disposable sandbox — not a
real vulnerability, that's expected root access on your own throwaway VM).
Real, meaningful tests instead:
- **Network egress**: confirmed open by default. Factual, not a bug —
  worth knowing before running untrusted agent code unsupervised.
- **Cross-session isolation**: wrote a secret in sandbox A, destroyed it,
  spun up a fresh sandbox B, confirmed B cannot see A's file. **Isolation
  held** — this is the real security property Solari's actually claiming.

### 3. GUI + code + web in one continuous session
The full pipeline above IS this proof, run live: one Python process, three
Solari SDKs, no VM juggling, no message bus stitching a VNC box to a
headless browser to a Docker container by hand.

## Repo layout

```text
bugtriage/
├── target_app/                 # deliberately-buggy checkout app (real, reproducible JS bug)
├── pipeline/
│   ├── desktop_repro.py        # step 1: reproduce on Solari Desktop, record
│   ├── sandbox_diagnose.py     # step 2: static analysis + patch + real patch verification
│   ├── browser_check.py        # step 3: prior-art check via Solari Browser + GitHub API
│   └── orchestrator.py         # wires all three into one triage run
├── evidence/
│   ├── sandbox_escape_demo.py  # contrast #2 — network egress + cross-session isolation
│   ├── parallel_scale_demo.py # contrast #1 — real concurrent sessions, respects plan cap
│   └── local_infra_estimate.md # the DIY-cost side of the diff
└── requirements.txt
```


## Setup

```bash
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...
python pipeline/orchestrator.py --bug-report "Submit button on checkout does nothing after selecting express shipping"
```

Target app needs to be reachable by the Solari desktop session (a separate
VM, not your laptop) — run it locally and tunnel it (e.g. ngrok) rather
than pointing at `localhost`.

## Status

Fully wired against live Solari infra — desktop, sandbox, and browser all
confirmed working end to end, real recordings, real static patch
verification, real isolation tests. Remaining honest gap: `tests_pass`
verifies the patch text, not a full re-run of the click flow against the
patched page — the natural next step, not yet built.
