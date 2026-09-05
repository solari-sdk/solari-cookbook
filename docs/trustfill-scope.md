# TrustFill — build scope

**Status:** M0–M4 passed 2026-09-05 · M5 (video + README) not started
**Decision record:** [`candidate-evaluation.md` §6](candidate-evaluation.md)
**Working name:** TrustFill (changeable)

> A vendor must answer a 30-question security questionnaire in a customer's
> procurement portal. TrustFill grounds every answer in the company's own security
> documents with citations — and leaves the questions it cannot support **blank**,
> for a human.

---

## 1. The beat

Everything below exists to earn one line on screen:

```
  ✓ 26 of 30 answered — every one cited
  ⚠  4 left blank — no supporting evidence
     → routed to a human
```

**The climax is the agent declining to act.** In a field of 34 submissions all
showing what an agent *did*, this shows what it *refused* to do. If a design
decision doesn't make those four blanks more convincing, it's out of scope.

The four refusals must fail for **four different reasons** — this is the detail
that turns the beat from a gimmick into evidence of judgment:

| # | Question | Why it's refused |
| --- | --- | --- |
| 1 | "Do you maintain cyber liability insurance?" | Nothing in the corpus mentions it at all |
| 2 | "How frequently do you conduct penetration testing?" | Corpus confirms pen tests exist but never states cadence — **adjacent evidence that doesn't answer** |
| 3 | "What is your RTO for a regional outage?" | Two documents disagree — **stale/contradictory evidence** |
| 4 | "Do you agree to a 24-hour breach notification SLA?" | Requests a *commitment*, not a fact — outside the agent's authority |

#2 and #3 are the important ones. A naive system answers both confidently.

---

## 2. What it does

**Evidence** — a small corpus of the vendor's own documents, written as genuine
prose: security policy, incident response plan, architecture overview, SOC 2
summary. **Not labeled key/value fields.** This is what prevents the
fixture round-trip that spoiled the PolicyGuard design: the questions must be
phrased differently from the documents so retrieval and inference do real work.

**Answer** — for each question, two passes: draft an answer with verbatim
citations and a sufficiency classification, then verify it claim by claim.
Abstain when the evidence is absent, conflicting, or when the question asks for a
commitment rather than a fact. Schema-validated; **abstention is a first-class
value, never an error.**

The trust score is `supportedClaims / totalClaims`, computed from what the
citations actually establish — *not* from the model's opinion of its own
reliability. M0 measured that opinion at ~0.95 even while abstaining, which is
exactly why it isn't used.

**Fill** — Solari browser drives the customer's procurement portal, filling the
answered questions and leaving abstentions blank with a review flag.

**Never submit.** The agent prepares a draft. A human approves. This is both the
safety property and the ending of the video.

---

## 3. Solari primitives, and honest justification

| Primitive | Why | Tier |
| --- | --- | --- |
| **Sandbox — isolation boundary** | The corpus is SOC 2 reports, IR plans, architecture docs. Processing them in an ephemeral hardware-isolated VM that is killed after the run is a *product requirement* for a tool that automates **security** questionnaires. | **1** |
| Sandbox — hosts the portal | Reproducibility; reviewer needs no credentials | 2 |
| Browser + Profile | Drives the customer's portal without re-authenticating | 2 |
| ~~Recording~~ | **UNVERIFIED — `getReplayUrl` 404s on this account (see M4).** Sessions are created with `recording: true` and the code degrades gracefully, but no replay URL has ever been observed. Do not claim it. | — |

**⚠️ Required README section: *What Solari buys here — and what it doesn't.***
State plainly that browser driving and profile persistence are replicable in local
Playwright, and that what isn't replicable is isolated processing of confidential
evidence in a VM that is destroyed with the run.

Three things this section must **not** overstate, all discovered by building it:
1. **The corpus does reach the model provider.** The sandbox keeps it off local
   disk and kills it with the run; it does not keep it inside the VM.
2. **Session replay is unverified.** Never seen working here.
3. **Profile reuse is demonstrated within one portal lifetime**, not across runs —
   an ephemeral sandbox gets a new hostname each time and cookies are domain-scoped.
Every other submission will claim their project is impossible without Solari.
**Drawing the line accurately is the same judgment as the refusal beat, applied to
our own pitch** — and a founder can smell overselling instantly.

---

## 4. Milestones

### M0 — Abstention spike ✅ **PASSED 2026-09-05**

*Was:* the riskiest assumption is not the plumbing — it's whether the model
reliably refuses. Tested offline, no Solari, before building anything.

**Result** — `moonshotai/kimi-k3` via NVIDIA NIM, `reasoning_effort: max`,
temperature 1, no fixed seed (a seed would have made repeated runs identical and
the reliability measurement meaningless).

```
30/30 correct · 4/4 traps abstained · 0 false abstentions
traps stable across 3 runs
```

**Each trap was caught by a different category** — the design working end to end,
not four instances of one behavior:

| Trap | Caught as | Stable ×3 |
| --- | --- | --- |
| T1 absent | `INSUFFICIENT` | ✓ |
| T2 adjacent-but-unanswered | `INSUFFICIENT` | ✓ |
| T3 contradictory sources | `CONFLICTING` | ✓ |
| T4 commitment-not-fact | `OUT_OF_SCOPE` | ✓ |

Trust scores across the 26 answered: mean **0.96**, range **0.71–1.00**, 21 at
1.00. 143 claims decomposed, ~5.5 per answer.

#### Findings that change M1

1. **Claim-level verification is the primitive, not answer-level.** The first run
   failed the gate at 15% false abstentions. Root cause was mine, not the model's:
   binary entailment judged the whole answer as one unit, so an incidental clause
   the model volunteered but hadn't quoted (*"version 3.1, last reviewed January
   2026"*) nullified an otherwise fully-supported answer. The verifier's own
   objection said it: *"All other claims … are supported."*
   Fix: decompose into atomic claims, mark each **essential** or **incidental**,
   abstain only when an *essential* claim is unsupported.
   **This is also the only way to get a trust SCORE rather than a trust boolean** —
   the thing that broke the gate was the thing missing from the design.

2. **`selfConfidence` is unusable as specified — drop or redefine it.** It reports
   ~0.95 *while abstaining*, because it measures confidence in the classification,
   not in an answer. Trap mean 0.94 vs answerable 0.97 is not a usable separation.
   The trust score must be `supportedClaims / totalClaims`, gated on essential
   claims. Being able to say *"I didn't use self-reported confidence because it
   isn't calibrated — I measured entailment"* is a strong interview answer, and it
   is now measured rather than asserted.

3. **This model cannot drive a live demo — RESOLVED 2026-09-05 by replaying fixtures.**
   Measured, not guessed:

   | | max effort, serial | low effort, concurrency 3 |
   | --- | --- | --- |
   | wall time | 140 min | 57 min |
   | completed | 30/30 | 26/30 (4 lost to 429) |
   | correct, of completed | 30/30 | 26/26 |

   Lower effort is 2.4x faster with correctness intact, but concurrency trips rate
   limits even behind 5-attempt exponential backoff. Neither knob gets near a
   one-command demo, so **the demo replays captured fixtures and `--live` is opt-in.**
   The fixtures are real model output, so nothing is fabricated — M1's record/replay,
   built for test speed, turned out to be the reproducibility answer too.
   Incomplete `-low` fixtures were deleted rather than kept beside the real ones.

4. **Prediction that was wrong, recorded:** I expected the verifier to reject the
   NEGATIVES (Q26–Q28, where the corpus explicitly says *no*). Q27 passed cleanly.
   The failure pattern was scope creep, not negation.

**Harness:** `spike/m0-abstention.mjs` — zero dependencies, providers for
anthropic / openai / openrouter / nvidia, `--only Q05,Q10` to re-run a subset,
full records always written to `spike/last-run.json`. That dump exists because the
first failure was undiagnosable from summary output alone; it cost a re-run.

### M1 — Grounded answering (offline) ✅ **PASSED 2026-09-05**

**34 tests · typecheck clean · 376 lines of src · no network in the suite.**
Live capture: 30/30 correct, 4 traps in 3 distinct categories, ~140 min.
Trust scores 1.00 except Q05 0.67, Q11 0.78, Q23 0.83 — trimming has real work.

Two findings worth carrying forward:

- **Mutation testing found a hole in the acceptance suite.** The test named
  "trimming removes exactly the unsupported incidental claims" asserted only on
  the `removed` list and re-ran `trim()` separately — it never checked the
  *returned answer text* was trimmed. A mutation bypassing the trim call passed
  unnoticed. Fixed by asserting the answer no longer contains each removed span.
  **The suite passing is not evidence the suite works.**
- **`score()`'s sufficiency arm is unreachable from the pipeline.** `DraftSchema`
  forbids a non-null answer unless SUFFICIENT, and the pipeline returns early on
  a null answer. Kept as defence in depth, covered by unit tests, documented in
  place — a mutation there correctly does not fail the acceptance suite.

*Rewritten 2026-09-05 to match what M0 measured. The original said "answer,
citations, confidence, abstain flag" — M0 showed confidence is not a usable
signal and that verification has to be claim-level, so both change.*

**Two passes, not one.**

**Pass 1 — draft.** Corpus + question → `sufficiency` classification, answer,
verbatim citations. Sufficiency is the four-way enum M0 validated:
`SUFFICIENT` / `INSUFFICIENT` / `CONFLICTING` / `OUT_OF_SCOPE`. Answer is `null`
for anything but `SUFFICIENT`.

**Pass 2 — verify.** Decompose the drafted answer into atomic claims. Each claim
carries `essential` (the question actually asked for it) and `supported` (the
cited quotes establish it). Runs only when pass 1 returned an answer.

**Then:**

```
abstain    ⟸ sufficiency ≠ SUFFICIENT  OR  any ESSENTIAL claim unsupported
trustScore ⟸ supportedClaims / totalClaims
finalAnswer ⟸ drafted answer with unsupported INCIDENTAL claims removed
```

That last line is new and is a product feature, not cleanup. M0 produced answers
scoring 0.71 purely because the model volunteered a document version number it
had not cited. **"We removed this sentence because it wasn't in your evidence"**
is a better thing to show a reviewer than a silently lower score.

**No `selfConfidence`.** M0 finding #2 — it reports ~0.95 while abstaining. Drop
the field rather than carry a number that means nothing.

**No vector DB.** M0 confirmed empirically: 24,941 chars ≈ 6.2k tokens, whole
corpus in context.

#### Record/replay belongs in M1

M0 took ~40 minutes for one full pass. **A test suite cannot call the model.** So
M1 splits into:

- `capture` — run live against a provider, write every draft + verification
  response to `fixtures/<model>/<questionId>.json`
- `replay` — the default; tests read fixtures and exercise the scoring, gating,
  trimming, and schema logic with zero network

This is not gold-plating — it is the only way M1 is testable at all. Capture is
re-run when the prompt or the model changes; replay runs in milliseconds.

It pays a second time at M3/M4: the same recorded responses let the browser-fill
step be developed and re-run without waiting on the model, which matters when the
questionnaire has to be filled repeatedly to get the shot right.

#### Provider stays swappable

M0 finding #3: Kimi-K3 proves the design but is too slow to fill a questionnaire
on camera. Keep the provider seam from the spike (anthropic / openai / openrouter
/ nvidia) so M3 can swap models, and **re-run the M0 gate against whatever model
records the video** before trusting it.

*Done when:* `npm test` runs offline from fixtures and asserts —
1. the 26/4 split;
2. all four traps abstain, each landing in its own distinct category;
3. no essential claim is unsupported in any answered question;
4. `trustScore` is in `[0,1]` and every answer below 1.0 has at least one
   unsupported claim that is `essential: false`;
5. both pass-1 and pass-2 payloads validate against their Zod schemas;
6. trimming removes exactly the unsupported incidental claims and nothing else.

### M2 — Portal in a Sandbox ✅ **PASSED 2026-09-05**

Northwind Corp vendor portal, Python stdlib only (no `pip` inside the VM).
Login + 30-question form + draft save, every control carrying a `data-testid`.

```
portal up in 5.7s
GET  /login          200 · login-email, login-password, login-submit
GET  /questionnaire  302 → /login (unauthenticated)
POST /login          302 · cookie set
GET  /questionnaire  200 · 30 answer fields
sandbox killed
```

**Gotcha that cost a run:** the preview URL carries `?pt_token=…`, so
`` `${url}/questionnaire` `` puts the path *inside the query string*. Build request
URLs with `new URL()` and set `pathname`. The gateway also sets its own cookie from
that token — overwriting the `cookie` header logs you out of the *preview*, not the
portal, and returns a confusing 401. Merge cookies, don't replace them.
A real browser handles both automatically; this only bites raw `fetch`.

**Honest scope note on the isolation claim.** The corpus is uploaded into the
sandbox and dies with it, so it never lands on an operator's disk and does not
outlive the run. But the model API is external, so the corpus does travel to the
provider. The README must say exactly that rather than implying the evidence never
leaves the VM.

### M3 — Browser fills it ✅ **PASSED 2026-09-05**

```
portal  https://…preview.getsolari.com
pass 1  logged in with credentials
pass 1  profile saved (cookies + localStorage)
pass 2  restored from profile — no login form touched
filled 26 · blank 4
portal says: Draft saved · 26 of 30 answered
```

The portal's own status line is the confirmation — not our count of our own work.

#### 🔑 The profile does not restore with `browser.newPage()`

The most valuable finding in the project so far, and it silently does nothing
rather than failing:

`launch({ profileId })` fetches the saved state into `session.storageState` but
**does not seed the browser with it**. A context from `newPage()` comes up with
neither cookies nor localStorage, so the profile appears attached, `profiles.save()`
reports rising versions and byte counts, and every run still logs in from scratch.

```ts
// wrong — profile silently does nothing
const page = await browser.newPage()

// right
const context = await browser.newContext({ storageState: browser.session.storageState })
const page = await context.newPage()
```

Independently confirmed by cookbook PR #17 against `browser-profiles-ts` — **the
cookbook's own profiles example has this bug.** That makes it a genuinely
mergeable upstream contribution (see cross-cutting decisions in the eval doc).

Two wrong hypotheses were tested and discarded first, by instrumenting the
round-trip rather than guessing:
1. *Session cookie (`expires=-1`) can't persist* — gave it `Max-Age`; still broken.
2. *`save()`→`launch()` race* — added a 10s delay and confirmed version 8 / S3 key
   `v8.json` was live; still broken.
The decisive evidence was **0 cookies in the fresh context before navigating**,
which ruled out anything about cookie semantics and pointed at restoration itself.

#### Ephemeral portal vs. persistent profile

Each run gets a new sandbox on a new preview hostname, and cookies are
domain-scoped — so a profile saved in one invocation is worthless in the next.
That is an artifact of the demo, not the product: a real customer portal has a
stable domain. Resolved by demonstrating both passes **within one portal
lifetime**, which is more deterministic anyway (no dependence on leftover state).

#### Open for M4

- **The four traps sit at the end of the questionnaire**, so they group together in
  the screenshot. Interleaving them among the 30 makes "it found these four" far
  more convincing than "it stopped before the last four".
- The blanks carry no on-screen reason; the four distinct reasons only appear in
  the CLI. They belong in the review handoff.

### M4 — Review handoff + audit ✅ **PASSED 2026-09-05** (replay unverified)

```
── needs a human ─────────────────────────────────────────
T1   Do you maintain cyber liability insurance? …
     INSUFFICIENT — the evidence does not answer this question
T2   How frequently do you commission third-party penetration testing?
     INSUFFICIENT — the evidence does not answer this question
T3   What is your recovery time objective (RTO) …?
     CONFLICTING — sources disagree; a human must resolve which is current
T4   Do you agree to notify … within 24 hours?
     OUT_OF_SCOPE — asks for a commitment, not a fact; needs someone with authority

3 answer(s) had unsupported detail removed: Q05, Q11, Q23
```

Four blanks, four distinct reasons, each carrying the question text a reviewer
needs. Edited answers are surfaced too — a trust score below 1 means part of the
draft was unsupported and dropped, which the reviewer should see rather than infer.
Written to `.tmp/review-packet.json`.

**Traps are now interleaved** (positions 5, 12, 20, 27). Grouped at the end they
read as "stopped before the last four"; scattered they read as "found these four
among thirty", which is the claim actually being made. Fixtures resolve by id, so
reordering cost nothing.

#### ⚠️ Session replay is UNVERIFIED — do not claim it in the README

`getReplayUrl` returned 404 on every attempt across repeated probes. Ruled out:
- **Not slow upload** — polled up to 72s after release, well past the ~30s the
  cookbook suggests.
- **Not id format** — `browser.id` and `browser.session.id` are the same composite
  (`ip-…:uuid:orgId:ts.hash`); tried the full composite, the UUID segment, and the
  timestamp segment. All 404.
- **Not a wrong return type** — though there *was* a real bug here:
  `getReplayUrl` returns `{ url, expiresInSeconds, contentEncoding }`, not a
  string. Fixed.

Most likely plan-gated (recording is a paid-tier feature). **The graceful
degradation is real and tested** — the run completes and reports
*"Replay not available — it uploads asynchronously after the session is released."*
Scope §3 lists Recording as an audit artifact; until a replay URL is actually
observed, the README must not promise one.

### M5 — Video + README
First screen: the 26/4 result, one sentence, install command. Plus the honesty
section from §3.

**M0 is a gate. M1–M4 are the build. M5 is the deliverable.**

---

## 5. Design decisions

- **No vector database.** The corpus is ~5 documents. Chunk and put them in
  context. A RAG stack here would be architecture for its own sake, and saying so
  in the README is itself a signal.
- **Deterministic browser automation.** Known portal, stable selectors. AI is for
  the document reasoning, never for navigation.
- **Abstention as a designed output**, not a caught exception.
- **Trust score from entailment, never self-report.** `supportedClaims /
  totalClaims`, gated on essential claims. M0 measured the model's own confidence
  at ~0.95 *while abstaining* — a number that shape is theater, and a reviewer who
  has built retrieval systems will say so.
- **Verification is claim-level, never answer-level.** Judging a whole answer as
  one unit rejects correct answers over an incidental uncited clause. M0 failed
  its gate this way before the fix.
- **Record/replay the model.** Tests must run offline from fixtures. A live pass
  takes ~40 minutes; a test suite that calls the model is a test suite nobody runs.
- **Never auto-submit.** No code path exists that clicks submit.
- **Everything synthetic**, and said plainly rather than dressed up.

---

## 6. Explicit non-goals

No real procurement portal, no customer credentials, no vector DB, no auth system,
no multi-tenancy, no database, no answer-library management UI, no questionnaire
import (CSV/XLSX parsing), no second portal, no framework.

---

## 7. Risks

| Risk | Impact | Mitigation | Status |
| --- | --- | --- | --- |
| ~~Model answers the trap questions confidently~~ | ~~Fatal~~ | M0 gate | **RETIRED** — 4/4, stable ×3 |
| ~~Evidence corpus too easy~~ | ~~Guts the AI claim~~ | Prose not fields; questions phrased unlike the docs | **RETIRED** — 143 claims decomposed, mean trust 0.96 with real spread to 0.71 |
| **Demo model too slow for the live fill** | **High** — M3 is filmed | Provider seam stays swappable; re-run the M0 gate on the faster model | **OPEN** — Kimi-K3 is ~40 min per pass |
| **Verification over-strict on a new model** | Medium — false abstentions return | The essential/incidental gate is model-dependent; capture fixtures per model | **OPEN** |
| Reviewer reads it as a closed loop | Credibility | The honesty section; corpus difficulty is the real defense | Open |
| C2 weakness noticed | Expected | Own it in the README rather than spin it | Open |
| Portal selectors drift | Low | We control the portal | Open |
| Replay not ready in time | Low | Bounded retry; never fail the run | Open |

---

## 8. Open questions

1. **Name.** TrustFill, or something better?
2. **Fictional vendor persona** — company name, product, posture.
3. **Question count.** 30 feels right: enough to look real, small enough to show filling on camera.
4. **Language.** TypeScript, matching the cookbook's browser examples.
5. ~~**Model.**~~ RESOLVED at M0: `moonshotai/kimi-k3` (NVIDIA NIM) abstains reliably — 4/4 traps, stable ×3. Too slow for the M3 live shot; a faster model needs the same gate re-run before it records the video.
