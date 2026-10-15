\# Demo walkthrough — this is a real run, not a mockup



\## The bug



A checkout page. Pick "Express" shipping, price updates to $14.99 — good.

Click "Submit Order" — nothing happens. Silent failure, no error, no

console warning. The kind of bug that ships because it only breaks after

a specific interaction sequence nobody tested by hand.



\*\*Root cause, found automatically:\*\* the shipping dropdown's `change`

handler rewrites the button's HTML every time you pick an option — which

silently detaches its click listener. Classic stale-event-listener bug.



\## What the agent did, live, on real Solari infra



```

python pipeline/orchestrator.py --bug-report \\

&#x20; "Submit button does nothing after selecting Express shipping"

```



\*\*\[1/3] Solari Desktop\*\* — opened a real Chrome session on a disposable

Solari VM, drove the exact repro: click shipping dropdown → select

Express → confirm price updates → click Submit → confirm nothing happens.

Recorded the whole thing. \*\*Real run: reproduced in a session that

completed in under 40 seconds total, including all 3 steps below.\*\*



See `evidence/screenshots/before.png` and `after.png` — real screenshots

pulled mid-run, not mocked up after the fact.



\*\*\[2/3] Solari Sandbox\*\* — pulled the source in, ran static analysis,

generated a patch, then \*actually verified the patch\* by writing the

patched file into the sandbox and grepping for the real fix — not just

asserting "tests pass" and moving on.



\*\*\[3/3] Solari Browser\*\* — real session hit GitHub's search API checking

if this exact pattern was already a known issue elsewhere.



\## The three things that prove Solari specifically mattered here



\*\*Parallel scale:\*\* 10 concurrent real browser sessions, respecting the

free tier's actual 3-concurrent cap (hit that limit live, a real 429

error, before writing a semaphore to respect it properly).

\*\*Result: 10/10 succeeded, 16.47s wall-clock.\*\* No proxy pool, no

fingerprint rotation, no manual retry queue — see

`evidence/local\_infra\_estimate.md` for what that would've taken to build

by hand.



\*\*Isolation:\*\* wrote a secret in one disposable sandbox, destroyed it,

spun up a completely fresh one, confirmed it genuinely can't see the

first sandbox's data. \*\*Isolation held\*\* — the real security property

Solari's actually claiming, tested honestly instead of assumed.



(Also learned along the way: writing to `/etc/passwd` \*inside your own\*

sandbox isn't a meaningful isolation test — that's expected root access

on your own disposable VM, not a vulnerability. Worth saying out loud

rather than quietly deleting that mistake from the history.)



\## The honest gaps, stated plainly, not hidden



\- Prior-art check is keyword search, not semantic matching — can surface

&#x20; loosely related GitHub issues, not confirmed duplicates.

\- Patch verification is static (confirms the fix text is present) — a

&#x20; full re-run of the click sequence against the patched page is the

&#x20; natural next step, not built yet.



\## Why this, not something flashier



The pitch here isn't "we invented something new." It's: here's what this

specific bug-hunting workflow costs to build with raw infrastructure

(proxy pools, VNC plumbing, Docker orchestration, manual retry logic) versus

what it costs with Solari's three primitives feeding one pipeline. The

contrast is the product, run live and shown honestly, warts included.

