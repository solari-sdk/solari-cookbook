# solari-doctor

[![CI](https://github.com/nitheshkummarc/solari-cookbook/actions/workflows/solari-doctor-ci.yml/badge.svg?branch=main)](https://github.com/nitheshkummarc/solari-cookbook/actions/workflows/solari-doctor-ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-5fa04e)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

**A deterministic diagnostic CLI for Solari developers. It checks your
environment against Solari's documented failure modes, tells you which ones you
are actually hitting, and shows the evidence it used.**

A Solari API call returning successfully does not always mean the thing behind
it is healthy. A session can be dead while the status endpoint still reports it
alive. A sandbox can keep running after you closed it. A script can finish its
work and then never exit. These behaviours are documented — in the cookbook's
gotcha list and in open issues — but nothing checks them for you, so each one
gets rediscovered by hitting it in real code.

`solari-doctor` turns that recurring debugging knowledge into executable
diagnostics. It runs seven checks against your real environment, reports what it
observed rather than what it assumed, and correlates observations into a named
cause when two of them mean something together that neither means alone.

Nothing in the diagnostic path calls a model. The same broken environment
produces the same answer every time, which is the property that makes a
diagnostic worth trusting.

---

### Contents

**Start here** — [The problem](#the-problem) · [A real failure it catches](#a-real-failure-it-catches) · [What it checks](#what-it-checks)

**Run it** — [Quick start](#quick-start) · [Usage](#usage)

**How it is built** — [How it works](#how-it-works) · [Why deterministic diagnostics](#why-deterministic-diagnostics) · [Key engineering decisions](#key-engineering-decisions)

**How far to trust it** — [Verification approach](#verification-approach) · [What it settled, and what it didn't](#what-that-verification-actually-settled--and-what-it-didnt) · [Testing](#testing) · [Limitations](#limitations) · [Notes worth flagging](#notes-worth-flagging)

**Context** — [What this is not](#what-this-is-not) · [Project structure](#project-structure) · [Why I built it](#why-i-built-it) · [Tech stack](#tech-stack) · [License](#license)

Deeper reading: [`docs-public/DESIGN.md`](docs-public/DESIGN.md) for architecture and trade-offs, [`docs-public/FINDINGS.md`](docs-public/FINDINGS.md) for the evidence behind every claim.

---

## The problem

Concretely, these are the failures it exists for:

- You set `SOLARI_API_KEY` and every call 401s. The key-creation modal closed
  before you finished copying it, or a pasted line break came along for the ride.
- Your script does its work, prints its output, and then just sits there. On
  `@solarisdk/browser` below 0.1.3 the connection-retry listener holds Node's
  event loop open, so `browser.close()` alone is not enough to exit.
- You called `close()` on a sandbox. The VM is still running.
- `run("ls -la")` fails, because commands are not shell-interpreted and it is
  looking for a binary literally named `ls -la`.
- Your agent keeps scheduling work onto a session that ended minutes ago,
  because `GET /sessions/:id` still says `active`.
- The replay endpoint 404s, because `recording: true` has to be set when the
  session is created — and no field anywhere confirms whether it was.

Each of these costs an afternoon the first time. None of them announces itself
clearly; they present as "the SDK is broken" or "the network is flaky".

## A real failure it catches

Run against a real `@solarisdk/browser` 0.1.2 install, with the free and cheap
checks selected. Captured output:

```
+ auth               the API key authenticated successfully                  928ms
! sdk-version        @solarisdk/browser 0.1.2 is older than 0.1.3            1ms
x browser-lifecycle  the process did not exit within 5000ms of closing       8.0s

diagnosis
  the installed @solarisdk/browser is older than 0.1.3, and a process that
  opened a session did not exit — the documented loopback-proxy hang
    confidence: high · from: sdk-version, browser-lifecycle
3 checks · 1 passed · 1 warned · 1 failed                                exit 1
```

For contrast, the same command against the 0.1.3 install:

```
+ auth               the API key authenticated successfully                  1.0s
+ sdk-version        @solarisdk/browser 0.1.3 is at or above 0.1.3           0ms
+ browser-lifecycle  the process exited on its own after closing the browser 2.9s
3 checks · 3 passed                                                     exit 0
```

**Observed** — a version number, and a child process still alive five seconds
after it closed its browser.

**Evidence** — `sdk-version` read `0.1.2` from the manifest in *your* project
tree. `browser-lifecycle` spawned a real child that opened a real session,
closed the browser, and did not exit; the parent killed it at 8.0s. A process
cannot credibly report its own hang, so the observation is made from outside it.

**Diagnosis** — neither fact is conclusive alone. An old SDK is exposure, not a
symptom; a slow exit could be anything. Together they are the documented
loopback-proxy hang, and the tool names it with a confidence level and a
citation.

**Remediation** — upgrade to 0.1.3, or `await solari.close()` in a `finally`
block until you can.

The same discipline in the other direction. With no credentials set, run from a
directory with no SDK, the tool is explicit about what it could not do rather
than guessing (temp path abbreviated to `<cwd>`):

```
  x auth               SOLARI_API_KEY is not set  0ms
  ! sdk-version        @solarisdk/browser is not installed under <cwd>  0ms
  - browser-lifecycle  skipped: "auth" did not pass  0ms
  - sandbox-command    skipped: "auth" did not pass  0ms
  - sandbox-cleanup    skipped: "auth" did not pass  0ms
  - session-liveness   skipped: "auth" did not pass  0ms

6 checks · 1 warned · 1 failed · 4 skipped
```

Skipped checks are named and attributed to the check that blocked them. They are
never silently dropped, and never counted as passes.

## What it checks

| Check | Cost | Default | The developer problem it catches |
|---|---|---|---|
| `auth` | free | yes | A key that is missing, malformed, or rejected — including one broken by a pasted line break, which is caught before the request is sent |
| `sdk-version` | free | yes | `@solarisdk/browser` below 0.1.3, where `browser.close()` alone can leave the process hanging |
| `browser-lifecycle` | cheap | yes | A process that opened a session and does not exit. Observed from a separate process, not inferred |
| `sandbox-command` | cheap | yes | `run("ls -la")` failing because commands are not shell-interpreted |
| `sandbox-cleanup` | cheap | yes | A VM still reachable after `close()`, when only `kill()` ends it |
| `session-liveness` | cheap | yes | Code trusting the status field for liveness, when dead sessions still report `active` |
| `recording-lifecycle` | expensive | `--full` | A replay that 404s because `recording: true` was not set at session creation |

Seven is a cap, not a target. Every check is tied to a documented failure mode
and cites its source — a cookbook gotcha or an open issue.

---

## Quick start

Not published to npm. Clone the cookbook and build it:

```bash
git clone https://github.com/solari-sdk/solari-cookbook.git
cd solari-cookbook/applications/solari-doctor
npm ci
npm run build

export SOLARI_API_KEY=slr_live_...   # from https://console.getsolari.com
node dist/bin.js
```

Requires **Node ≥ 20 to run**. Building and testing from source needs **Node ≥
22.12**, because vitest 5 does not support Node 20 — CI verifies the Node 20
runtime claim separately, against the built output and production dependencies
only. `SOLARI_API_KEY` is the only environment variable, and the
run still works without it: `auth` fails, `sdk-version` still reports, and the
checks that need the API are skipped with the reason named.

To check a different project, run it from that project's directory —
`sdk-version` and `browser-lifecycle` resolve `@solarisdk/browser` from the
current working directory, not from solari-doctor's own `node_modules`. For a
global `solari-doctor` command, `npm link` from `applications/solari-doctor/`.

## Usage

```bash
node dist/bin.js                              # the default run
node dist/bin.js --full                       # also run the expensive check
node dist/bin.js --json                       # machine-readable, on stdout
node dist/bin.js --report                     # write ./solari-doctor-report.json
node dist/bin.js --explain session-liveness   # a documented finding, no network
```

| Flag | |
|---|---|
| `--json` | machine-readable output on stdout |
| `--full` | also run expensive checks (adds a real wait) |
| `--explain <id>` | print the documented finding for one check |
| `--report` | write a sanitised report to `./solari-doctor-report.json` |

One command, four flags. There are no subcommands.

**Exit codes.** `0` when everything passed, warned, or was skipped; `1` when a
check failed; `2` on a usage error. A warning exits `0` on purpose — "you are
exposed to a documented issue" is not "your environment is broken", and a CI
gate should be able to tell them apart.

**Machine-readable output.** `--json` emits a versioned document carrying each
check's status, message, remediation, evidence and issue reference:

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "auth",
      "status": "fail",
      "message": "SOLARI_API_KEY is not set",
      "durationMs": 1,
      "remediation": "Set SOLARI_API_KEY to a key from console.getsolari.com. ...",
      "issueRef": "solari-cookbook#1",
      "evidence": { "keyPresent": false }
    }
  ]
}
```

`--report` writes the same material through a whitelist sanitiser, for attaching
to a bug report. The path is printed on stderr, so `--json --report > out.json`
still produces a clean file; if the report cannot be written the run warns and
keeps the exit code the checks produced.

`--explain <id>` prints a documented finding without running a check or touching
the network. One explanation currently ships, for `session-liveness`; the CLI
lists what is available if you ask for an id it does not have.

---

## How it works

```
CLI
  └─ Check registry        the only place that enumerates checks
      └─ Scheduler         dependency graph · cost tiers · concurrency cap of 3
          └─ CheckResult[]
              └─ Diagnosis engine    pure: CheckResult[] -> Diagnosis[]
                  └─ Renderers       terminal · JSON · sanitised report
```

A check knows only about itself. It reports an observation, its evidence and a
remediation, and nothing about any other check. Correlation happens afterwards,
in a pure function over the results — which is what turns "0.1.2 is installed"
and "the process did not exit" into one named cause without teaching either
check that the other exists.

That layer performs no I/O at all, and the restriction is enforced by a lint
rule rather than by convention: importing `node:fs` or the SDK into
`src/diagnosis/` fails the build.

Full rationale and trade-offs: [docs-public/DESIGN.md](docs-public/DESIGN.md).

## Why deterministic diagnostics

Every conclusion comes from something observable: an API response, a version
string read off disk, whether a real child process exited, whether a sandbox is
still reachable, whether a connection reports itself closed — compared against
documented behaviour.

Nothing in the diagnostic path is probabilistic. That is a reproducibility
requirement, not a position on AI. A diagnostic that answers differently on the
second run cannot be used to file a bug, diff two environments, or gate CI. The
`--json` and `--report` outputs exist for exactly that: stable, machine-readable
evidence you can attach to an issue.

## Key engineering decisions

**Facts and diagnosis are separate layers.** Checks report raw observations and
nothing else. A pure `CheckResult[] -> Diagnosis[]` function correlates them
into named causes with confidence levels. This is what turns two inconclusive
signals into the single high-confidence diagnosis shown above, without teaching
every check about every other check. The layer's purity is enforced by a lint
rule, not by convention — importing the SDK or any I/O from it fails the build.

**Two-model error mapping.** The browser SDK and the core/sandbox SDK expose
genuinely different error surfaces: one untyped `SolariError` matched on
`status`/`code`, and one real typed hierarchy. Both packages export a class
*named* `SolariError`, and they are not the same class — a cross-package
`instanceof` silently returns `false`. Every check routes through one shared
mapping layer whose `instanceof` ordering is locked by a test, rather than each
check guessing.

**Dependency-aware, bounded scheduling.** Free checks run first and unbounded;
resource-creating checks run through a worker pool capped at three, so the tool
never opens six concurrent sessions merely because the language allows it. A
failed dependency marks its dependents `skip` — never silently omitted, always
naming the check that blocked them.

**Out-of-process lifecycle observation.** A process cannot credibly report that
it failed to exit. `browser-lifecycle` spawns a child, watches it from the
parent, and escalates `SIGTERM` to `SIGKILL` if the child ignores the first.

**Resources are released on every path.** Sandboxes are killed in a `finally`
block — including when an assertion fails partway through, and when `kill()`
itself throws. `kill()` is idempotent, so the fallback is safe, and a separate
sweep script cleans up anything a cancelled CI run could strand.

**Verification-first, not documentation-first.** Every check's behaviour was
confirmed against the real installed SDK before being trusted. Where the docs
and reality disagreed, reality won — and the disagreement was written down
rather than smoothed over.

---

## Verification approach

Unit tests were not sufficient, and this is stated as a finding rather than an
apology. Four real defects survived a green suite and were caught only by
running the built tool against the live SDK:

| Defect | How it presented |
|---|---|
| The CLI never read `SOLARI_API_KEY` | The suite was green; the real run reported a present key as missing |
| `package.json` is not an exported subpath | `require` of the SDK manifest throws; the version check needed a filesystem read |
| A cleanup path cancelled its own kill-fallback timer | A child ignoring `SIGTERM` would have been leaked by the code meant to prevent that |
| A fixture resembled but was not the real SDK error class | It satisfied the check's own field read while the shared mapper classified it as unrecognised |

Two more emerged from running all seven checks together rather than in
isolation: one check closed an SDK client three others were sharing, and two
checks disagreed about whether a missing SDK was a warning or a failure.

The working order was **inspect → implement → test → verify at runtime →
document the evidence**, and the last two steps are the ones that mattered:
every check was run against the real installed SDK before it was considered
done. The `browser-lifecycle` boundary, for instance, was established by running
the same script against two real installs — 0.1.2 hung until it was killed at 75
seconds, 0.1.3 exited in about 3.

### What that verification actually settled — and what it didn't

The evidence is not uniform, so it is not reported as though it were:

| Claim | Status |
|---|---|
| Four of the five README gotchas | **Confirmed live**, two of them with corrections to the documented wording |
| Recording is per session, not per account | **Confirmed live** with a parallel control session |
| The README's "poll for ~30s" for a replay | **Contradicted by measurement** — three runs disagreed with each other and with the SDK's own ~1-3s doc comment |
| `timeoutMs` as a rolling idle window (gotcha 5) | **Partially observed.** No check depends on it |
| Issue #1 — the key-creation modal | **Partially corroborated.** The console UI event is not observable from a CLI; the downstream 401 and the pasted-newline key were reproduced |
| Issue #25 — sessions dying at ~10 min | **Partially corroborated.** All three liveness signals confirmed live; the ten-minute timeline deliberately not reproduced |
| Issue #27 — the missing default base URL | **Not reproducible here** — it is a Go issue. Corroborated cross-language: the standalone `@solarisdk/sandbox` requires `baseUrl` while `@solarisdk/sdk` defaults it |

An adversarial pass against the finished tool then found four further defects —
two of them security — which are fixed and regression-tested.

**And CI itself was a claim that had not been checked.** Four consecutive runs
had been red on the Node 20 matrix leg — `vitest@5` requires
`^22.12 || ^24 || >=26`, and `.npmrc` sets `engine-strict`, so `npm ci` could
never complete there — while the local suite was green. The gate now runs on
Node 22 and 24, all four legs passing, and a separate job covers the
`engines.node >= 20` claim against the built output and production dependencies
only, rather than dropping the claim to make the badge green.

That second job then failed for its own reason, and the first explanation for it
turned out to be wrong. It took a controlled experiment to settle: npm 10, which
Node 20 ships, evaluates devDependency engine ranges even under `--omit=dev`,
while npm 11 — used in development — does not. Fixed by upgrading npm in that
job, and every job in the workflow is now green.

**The docs had drifted too.** An audit of every number in every document found
nine wrong — a per-suite test table summing to 352 against an actual 347, each
row correct when written and none re-derived since. Counts now come from
`vitest --reporter=json` rather than from memory, and three flagged items were
left alone because checking showed they were right.

Full evidence, per claim, in
[docs-public/FINDINGS.md](docs-public/FINDINGS.md).

## Testing

```bash
npm run typecheck    # tsc --noEmit, source and tests
npm run lint         # eslint, including the layer-purity rules
npm test             # vitest run
npm run build        # tsc
npm run check        # typecheck + lint + test
```

At the current commit `npm test` reports **347 tests across 15 files, all
passing**, and typecheck, lint and build each exit 0.

| Layer | What it covers |
|---|---|
| Unit (vitest, mocked SDK) | Every check, the scheduler, the error mapper, the diagnosis engine and all three renderers. No test reaches a live service |
| Runtime verification (manual, credentialed) | Each check run against the real SDK before it was considered complete, including an A/B against real 0.1.2 and 0.1.3 installs |
| CI — PR gate | typecheck · lint · test · build, on ubuntu and windows across Node 22 and 24, with no credentials |
| CI — Node 20 runtime | The built CLI plus production dependencies only, on Node 20 — the version `engines` claims and the dev toolchain cannot install on. Green |
| CI — live | A separate workflow: secret-gated, manual dispatch plus a weekly schedule, with an always-run cleanup sweep |

Two suites are mutation-verified: the concurrency bound and the `instanceof`
ordering were each broken deliberately, to confirm the tests fail when they
should.

## Limitations

- **Five of the seven checks create real resources, and all but `sdk-version`
  need a key.** Without `SOLARI_API_KEY` the five are skipped, not faked. Each
  creates a browser session or a sandbox and cleans it up; `--full` adds a
  session held open for a poll window.
- **SDK discovery is filesystem-based.** `@solarisdk/browser/package.json` is
  not an exported subpath and the package has no `require` condition, so the
  version is read from `node_modules` under the current working directory.
  Layouts that break that assumption — pnpm's store, Yarn PnP, some workspace
  hoisting — have not been tested.
- **Replay timing is not settled.** Three live runs disagreed with each other
  and with both documented figures, so `recording-lifecycle` reports a timeout
  as *inconclusive* rather than as a violation.
- **`sandbox-cleanup` makes no billing claim.** The API exposes no billing
  field, so the wording stops at "may result in continued resource
  consumption/billing". What was proven is that the sandbox stays reachable
  after `close()` and is gone after `kill()`.
- **`session-liveness` does not reproduce issue #25's ten-minute timeline.**
  That would cost ten minutes on every run. It verifies the liveness signals
  instead; `--explain session-liveness` carries the documented finding.
- **Cross-SDK conformance is out of scope.** Three SDK READMEs reference a
  `PROTOCOL.md` that is not in any public repository, so no claim is made about
  wire compatibility between languages.

## Notes worth flagging

**The recording poll window is empirically variable.** Three live runs
disagreed — no replay in 60s, a replay at 8.2s, no replay in 46s — against a
documented ~30s and an SDK doc comment saying ~1-3s. `recording-lifecycle`
reports a timeout as *inconclusive*, states Solari's figure and its own ceiling
as separate numbers, and does not claim a guarantee was breached. This is stated
honestly rather than presented as settled.

**`PROTOCOL.md` is referenced but not published.** Three SDK READMEs point at a
protocol contract that is absent from every public repository. Cross-SDK
conformance is out of scope for that reason, and three questions are open for
the maintainers.

**A related, separate contribution.** The cookbook's TypeScript examples still
described the pre-0.1.3 close behaviour. That fix is open upstream as
[solari-cookbook#47](https://github.com/solari-sdk/solari-cookbook/pull/47) — a distinct contribution, not part of this project.

---

## What this is not

- **Not an LLM chatbot.** Nothing in the diagnostic path calls a model.
- **Not a dashboard.** It is a CLI that runs, prints, and exits.
- **Not an auto-fixer.** It never changes your project, credentials, or
  infrastructure. There is no `--fix`.
- **Not application observability.** It diagnoses a development environment
  against known Solari failure modes; it does not monitor a running service.

## Project structure

```
solari-doctor/
├── src/
│   ├── checks/            one file per check, plus the registry
│   │   ├── auth.ts  sdk-version.ts  browser-lifecycle.ts
│   │   ├── sandbox-command.ts  sandbox-cleanup.ts
│   │   ├── session-liveness.ts  recording-lifecycle.ts
│   │   ├── browser-lifecycle-harness.ts   the child process
│   │   ├── sdk-install.ts                 locates the user's SDK
│   │   └── index.ts                       the registry
│   ├── runner/            scheduler.ts · errors.ts
│   ├── diagnosis/         engine.ts (pure) · rules.ts (data)
│   ├── report/            terminal.ts · json.ts · bundle.ts
│   └── cli.ts  bin.ts  context.ts  types.ts  explain.ts  version.ts
├── test/                  mirrors src/, plus fixtures/
├── ci/cleanup.mjs         sweeps resources a cancelled CI run left behind
├── docs-public/           DESIGN.md · FINDINGS.md
└── LICENSE
```

CI runs on the [development fork](https://github.com/nitheshkummarc/solari-cookbook/tree/main/.github/workflows),
not in this repository, so nothing outside this directory changes: a PR gate
that needs no credentials, and a separate secret-gated live workflow.

## Why I built it

Working through the Solari SDKs, the same debugging kept recurring: check the
version, check whether the process actually exited, check whether the sandbox
actually died, stop trusting the status field. That knowledge existed — in a
README gotcha, in an issue thread, in someone's memory — but it was not
executable, so it kept being rediscovered rather than reused.

This is that knowledge made runnable. The checks are bounded to what the
documentation already describes, and each one cites where it came from.

## Tech stack

| | |
|---|---|
| Language | TypeScript 6.0, strict, `exactOptionalPropertyTypes` |
| Runtime | Node ≥ 20 to run · ≥ 22.12 to build and test · ESM (the SDK is ESM-only) |
| SDKs | `@solarisdk/browser`, `@solarisdk/sandbox`, `@solarisdk/sdk` — all `^0.1.3` |
| Tests | vitest 5 |
| Lint | ESLint 10 flat config + typescript-eslint, with layer rules enforced |
| CI | GitHub Actions — ubuntu + windows × Node 22/24, plus a Node 20 runtime job |

## License

[MIT](LICENSE), matching the cookbook this lives in.
