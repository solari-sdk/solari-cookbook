# Solari Intern Project Proposals

Three candidate projects, each built on the Solari SDK (cloud browsers, sandboxes, desktops). All three follow the same logic: instead of demoing what the platform can do, measure whether it still does it. Each one produces something Solari's own team could adopt internally.

---

## Context

Solari's public positioning rests on a single claim: it is the fastest agent infrastructure. The homepage cites the open-source nibzard benchmark (create the machine, run the code, tear it down) and the browser product page publishes head-to-head numbers against Kernel, Steel, Browserbase, Hyperbrowser, and Anchorbrowser.

A published benchmark number has a structural weakness. It is true on the day it was measured, from the machine it was measured on, at concurrency one. It says nothing about tail latency, regional variance, behaviour under load, or whether the number still holds this morning. The same is true of the browser's other advertised features (stealth, managed proxies, captcha solving), which decay silently as the other side of the arms race updates.

That gap is the thread all three projects pull on.

---

## Project 1 — Observatory

**A continuous, independent latency and reliability benchmark for agent infrastructure.**

### The problem

Solari's most important marketing asset is a static number. Nobody is continuously verifying it, and nobody anywhere publishes the dimensions that matter most to a customer running agents at scale: p99 rather than best case, per region, and under concurrency. Internally, the create-and-resume path is also the part of the system most likely to degrade silently as customer load grows, and there is no alarm on it.

### What it is

A benchmark harness plus a public dashboard that runs the same workload on a schedule, forever, and publishes the raw data alongside the charts.

### What it measures

- **Phase-split timings**, so a regression is attributable rather than merely visible: create → first usable action → workload → teardown.
- **Full distribution**: p50, p95, p99, and failure rate. Not the best-of-N figure marketing uses.
- **Cold create vs snapshot resume**, since these are different code paths with different failure modes.
- **All three products** (browser, sandbox, desktop), which hit different parts of the stack.
- **Every region offered.**
- **Concurrency fan-out at 1, 10, 50, and 200 simultaneous environments.** This is the chart that does not currently exist anywhere. Solari's own marketing argues that environments must start fast and run in parallel, but the published figure is a single serial round trip. The shape of the curve as parallelism increases is the most interesting artifact this project can produce.
- **Error taxonomy**: what actually goes wrong, classified, not just how long things took.

### How it runs

- Nightly GitHub Action, executed from runners in more than one geography. A latency number is meaningless without stating where the client sat.
- Raw results committed to the repo as JSONL so any reader can recompute every chart independently.
- A published methodology covering warmup, outlier handling, network jitter, and sample size.
- A static dashboard with historical time series per metric.
- A regression alert that fires when a p95 drifts past a configured threshold.

### Design constraints

- **Provider-agnostic structure.** Even if only Solari is wired up at launch, the harness should treat providers as pluggable adapters. This makes it read as infrastructure rather than fan work, and lets Solari extend it themselves.
- **Publish unflattering results.** A benchmark whose sponsor always wins is worthless and transparently so. A benchmark that occasionally reports a regional regression is a tool a team will actually wire into CI.

### Deliverables

1. Public repo with the harness, adapters, and a one-command local run.
2. Hosted dashboard (GitHub Pages is sufficient).
3. `METHODOLOGY.md` written to a standard a skeptical reader could attack and fail.
4. Raw dataset in-repo, growing nightly.
5. A written analysis post covering the first two weeks of data.

### Success criteria

- Someone outside the project can reproduce a published chart from the raw data.
- At least one finding that was not obvious in advance (a region that underperforms, a concurrency cliff, a phase that dominates the round trip).
- The nightly job runs unattended for two weeks without manual intervention.

### Effort and risk

Largest of the three. Two to three weeks for a solid version, though a single-region, single-product v1 is achievable in a few days and can grow.

Main risks: API spend under high concurrency (cap it, and ask Solari for credits when you email them); noisy results from GitHub Actions runners (mitigate with sample size, and report the noise floor honestly); and the awkwardness of publishing a number that makes the sponsor look bad (address it up front by framing the project as regression detection rather than as a leaderboard).

### Why Solari would care

It converts their central claim from a screenshot into a live, independently verifiable asset, and doubles as an internal alarm on the scheduler and snapshot path.

### Hiring signal

Distributed measurement, tail-latency reasoning, statistical honesty, and clear technical writing. For an infrastructure company that is close to the whole job.

---

## Project 2 — Decay Canary

**Continuous regression tracking for the browser's stealth, proxy, and captcha features.**

### The problem

Solari's browser advertises stealth, real-world proxy egress, and automatic captcha solving. All three are adversarial features, and adversarial features degrade without anyone shipping a bug. A detection vendor updates on Tuesday and a capability that worked on Monday quietly stops working, usually discovered when a customer complains. There is no continuous signal on this.

### What it is

The same shape as Observatory, applied to correctness rather than speed. A daily job that scores the browser's fingerprint and detection posture against public, purpose-built testing playgrounds, and charts the drift over time.

### What it measures

- Fingerprint consistency scores from public detection test pages, which exist specifically to be tested against.
- Score deltas across configurations: stealth on versus off, each proxy country, each region.
- Trend lines per check, so a single failing signal is visible before it becomes a customer-visible outage.
- Time-to-solve and success rate for captcha challenges on public demo endpoints.

### Scope discipline

This project only touches public testing playgrounds and demo endpoints built for exactly this purpose. It does not target any real site's defenses. Solari's own terms prohibit unauthorized access, malicious automation, credential theft, and phishing, and the project should visibly stay well inside them.

Frame it consistently as regression detection on an advertised product feature. Never as defeating any particular website. This framing is both the honest one and the one that makes the work credible to the team.

### Deliverables

1. Public repo with the daily check suite.
2. Dashboard showing per-check history and current status.
3. Alerting on any check that flips from pass to fail.
4. A short writeup on what drifted during the observation window.

### Success criteria

- Catches at least one real change during the observation period, or demonstrates stability with enough resolution that a change would have been caught.
- Adding a new check is a small, obvious diff.

### Effort and risk

Roughly one to two weeks. Lower engineering complexity than Observatory but higher framing risk: this is the project most likely to be misread if described carelessly. Write the README's first paragraph very deliberately.

### Why Solari would care

It gives them an early-warning system on the exact features that are hardest to keep working and easiest to lose without noticing.

---

## Project 3 — Ledger

**A leak and spend profiler for Solari sessions.**

### The problem

Solari's own cookbook documents the footguns. Calling `close()` drops the local control channel while the VM keeps running until its idle timeout, so the correct call is `kill()`. `timeoutMs` is a rolling idle window that resets on every use rather than a hard deadline. The TypeScript browser client hangs on exit if you skip `close()`, because it keeps a loopback proxy open.

Each of these converts a small mistake into a running meter. Orphaned machines become surprise invoices, and surprise invoices are one of the main ways early infrastructure companies lose customers who otherwise liked the product.

### What it is

A thin instrumentation wrapper around the SDK that traces every session, surfaces waste, and makes cost legible during development rather than at the end of the billing cycle.

### What it does

- Wraps session creation and teardown, emitting a structured trace per run: what was created, in which region, how long it lived, how much of that time was active versus idle.
- Flags machines that were released with `close()` rather than `kill()`, and estimates the idle cost incurred before timeout.
- Detects orphans: environments created during a run that were never terminated.
- Prints a per-run cost estimate and a session timeline at process exit.
- Optional CI mode that fails a build when a test run leaks an environment.
- Optional reconciliation against account usage, to catch environments that no local trace accounts for.

### Deliverables

1. Published package (npm and/or PyPI) with a drop-in wrapper and a CLI.
2. A worked example showing a leaky script, the trace that exposes it, and the fix.
3. Documentation of each footgun with the specific symptom a developer would see.

### Success criteria

- Adding it to an existing script is a one-line change.
- It catches a real leak in a naive script written from the cookbook examples.

### Effort and risk

Smallest of the three. Several days to a week for a genuinely useful version.

Main risk: cost estimation depends on pricing that can change, so keep the rate table in a single configurable file and treat estimates as estimates.

### Why Solari would care

It is a retention feature wearing the clothes of a developer tool, and it directly addresses friction they have already documented and clearly know about.

---

## Choosing between them

| | Observatory | Decay Canary | Ledger |
|---|---|---|---|
| Effort | 2–3 weeks | 1–2 weeks | Under 1 week |
| Engineering depth | High | Medium | Medium |
| Strategic value to Solari | Highest | High | High |
| Demo appeal | High (charts, findings) | Medium | Medium |
| Framing risk | Low | Elevated | Low |
| Ongoing content after launch | Yes, indefinitely | Yes | No |

Observatory is the strongest single submission if the time exists. Ledger is the best choice under time pressure and pairs well as a second, smaller artifact alongside either of the others.

---

## Shared execution notes

These apply whichever project is chosen.

**The repo is the deliverable, not the code.** A demo GIF or chart in the first screen of the README, a one-command run, and a short section on what was surprising while building. That last section is the highest-signal thing in the whole repo, because it proves the work ran against the real API rather than against a mock.

**Contribute upstream.** The task already involves forking `solari-sdk/solari-cookbook`, and the repo's contributing section explicitly asks for small examples that run end to end, with any surprising behaviour noted in a comment where it bites. A merged pull request is a stronger signal than any star count.

**Be honest in public.** Every one of these projects is a measurement tool, and a measurement tool that flatters its subject is worth nothing to the subject. Publishing an unflattering result is what makes the rest of the numbers believable.

**Lead the post with the finding, not the architecture.** The first line should be the surprising thing the project discovered, not an announcement that the project exists. Keep one sharp technical detail in the thread for the engineers who stop scrolling.
