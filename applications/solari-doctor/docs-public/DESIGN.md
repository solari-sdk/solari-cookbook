# solari-doctor — Design

A deterministic CLI that checks a developer's environment against a fixed set of
documented Solari failure modes, and reports for each one what is wrong, why,
and what to do about it.

**Contents** — [1. Problem](#1-problem) · [2. Goal and non-goals](#2-goal-and-non-goals) · [3. Design principles](#3-design-principles) · [4. System architecture](#4-system-architecture) · [5. Checks](#5-checks) · [6. Context and dependency ownership](#6-context-and-dependency-ownership) · [7. Diagnosis model](#7-diagnosis-model) · [8. Error model](#8-error-model) · [9. Scheduling](#9-scheduling) · [10. Security](#10-security) · [11. CLI contract](#11-cli-contract) · [12. Verification strategy](#12-verification-strategy) · [13. Deliberately out of scope](#13-deliberately-out-of-scope)

---

# 1. Problem

The Solari cookbook README documents five gotchas *"that cost you an afternoon
if you meet them cold"*, and the repository's open issues are largely the same
class of problem being rediscovered independently:

| Issue | Rediscovered problem |
|:--|:--|
| [#1](https://github.com/solari-sdk/solari-cookbook/issues/1) | A key that was never fully copied |
| [#25](https://github.com/solari-sdk/solari-cookbook/issues/25) | Sessions that die while the status endpoint still reports them alive |
| [#27](https://github.com/solari-sdk/solari-cookbook/issues/27) | An SDK that needs an explicit base URL |

The unifying developer problem: **a Solari API call returning successfully does
not always mean the thing behind it is healthy.** A session can be dead while
the status endpoint says `active`. A sandbox can keep running after `close()`. A
script can finish its work and never exit.

None of it is exotic. It is a fixed, enumerable set of known failure modes that
a new developer currently discovers by hitting them one at a time in real code.
There is no single command that says, before you write anything, which of the
known problems apply to your environment right now.

> **In one sentence:** recurring, already-documented Solari failure modes are
> diagnosed manually and repeatedly, with no automated first pass.

---

# 2. Goal and non-goals

**The tool is responsible for exactly this:** observing a developer's
environment against seven documented failure modes, and reporting for each one
what was observed, the evidence for it, and what to do about it.

| It is responsible for | It is explicitly not responsible for |
|:--|:--|
| Observing, and reporting what it observed | Guessing at anything it could not observe |
| Naming a cause when observations correlate | Claiming a cause a single observation cannot support |
| Citing a gotcha, issue, or measurement for every claim | Asserting behaviour that is documented but unverified |
| Cleaning up every resource it creates | Touching resources it did not create |
| Exiting with a code CI can gate on | Changing the project, credentials, or infrastructure |

**The scope is capped at seven checks.** Each is isolated, testable, cited, and
actionable; an eighth *"because we had time"* is how a bounded diagnostic
becomes an unbounded one.

---

# 3. Design principles

| | Principle | Why |
|:--|:--|:--|
| **1** | **Deterministic over clever** | No LLM anywhere in the diagnostic path. A tool that gives two answers for one broken environment erodes trust in every check, not just the flaky one |
| **2** | **Cheap by default, expensive by consent** | Anything costing more than a few seconds is opt-in behind `--full`. A diagnostic nobody runs has no value |
| **3** | **Facts, then diagnosis** | Checks report observations. A separate layer combines them into named causes |
| **4** | **Never touch what you didn't create** | No mutation of infrastructure, credentials, or project files |
| **5** | **Every claim has a source** | And no check claims more than it can observe |

---

# 4. System architecture

```
CLI                       parses argv, owns every write, returns an exit code
  └─ Registry             the only place that enumerates checks
      └─ Scheduler        dependency graph · cost tiers · bounded concurrency
          └─ Checks       observe, and return facts — never print, never throw
              └─ CheckResult[]
                  └─ Diagnosis engine    pure: CheckResult[] -> Diagnosis[]
                      └─ Renderers       terminal · JSON · sanitised report
```

| Layer | Responsibility | Never does |
|:--|:--|:--|
| **CLI** | Argument parsing, wiring, all I/O, exit code | Contain diagnostic logic |
| **Registry** | Identity, uniqueness, dependency validity | Execute anything |
| **Scheduler** | Order, concurrency, skip propagation, timing | Interpret a result |
| **Checks** | One observation each, with evidence | Print, throw, or know about another check |
| **Diagnosis** | Correlate results into named causes | Perform any I/O |
| **Renderers** | Return strings | Decide anything |

**The layering is enforced, not requested:**

| Boundary | Enforcement |
|:--|:--|
| The diagnosis layer is pure | A lint rule — importing the SDK, `node:*`, or any I/O layer **fails the build** |
| Checks cannot print | `no-console` is an error outside the renderers and CLI |
| Only the registry enumerates checks | Nothing downstream switches on check ids |
| SDK errors map in one module | So identical failures read identically everywhere |

---

# 5. Checks

| Check | Failure it catches | What it observes | Cost | Depends on | Important limitation |
|:--|:--|:--|:--|:--|:--|
| `auth` | A key that is missing, malformed, or rejected | `sandboxes.list({ limit: 1 })` — the cheapest call that creates nothing. A key with header-illegal characters is rejected before any call | free | — | Cannot observe the key-creation modal in issue #1; that happened in a browser before the tool ran |
| `sdk-version` | `@solarisdk/browser` below 0.1.3, where `browser.close()` alone can hang the process | The manifest read from the filesystem, anchored at the user's project root | free | — | Reports **exposure**, not a hang. Never `fail`s — an absent or unreadable SDK is a `warn`, because "cannot determine" is not "broken" |
| `browser-lifecycle` | A process that opened a session and does not exit | A real child process, watched from the parent, with `SIGTERM` escalated to `SIGKILL` | cheap | `auth` | The 5s deadline is a margin (~1.7× the measured healthy exit), not a Solari figure |
| `sandbox-command` | `run("ls -la")` failing because commands are not shell-interpreted | The raw form throwing, and the `args` form succeeding, in the same VM | cheap | `auth` | Creates a real VM; killed on every path including a mid-assertion failure |
| `sandbox-cleanup` | A VM still reachable after `close()`, when only `kill()` ends it | `sandboxes.get()` after `close()`, then after `kill()` | cheap | `auth` | The API exposes no billing field, so the wording stops at *"may result in continued resource consumption/billing"* — never *"this is costing you money"* |
| `session-liveness` | Code trusting the status field for liveness, when dead sessions still report `active` | `isConnected()` polled across a server-side release, with the event and the thrown class recorded as corroboration | cheap | `auth` | Structural. Does **not** reproduce issue #25's ten-minute timeline — that would cost ten minutes per run. Available on demand via `--explain session-liveness` |
| `recording-lifecycle` | A replay that 404s because `recording: true` was not set at session creation | `getReplayUrl` polled after `releaseAndWait`, against an injected clock | expensive (`--full`) | `auth` | Reports a timeout as **inconclusive**, not a breach. Three live runs disagreed with each other and with both documented figures, so the ceiling is stated as this project's margin |

---

# 6. Context and dependency ownership

`DoctorContext` is the single object passed to every check. Its fields are
**derived from what the seven checks actually require** — not from what a
diagnostic tool might plausibly need.

| Field | Purpose |
|:--|:--|
| `apiKey` | Never logged, never placed in `evidence`, never in `--report` |
| `projectRoot` | Root used to resolve the **user's** installed SDK. Defaults to `process.cwd()` |
| `region` · `baseUrl` | Omitted means the SDK default. Absent, not `undefined` |
| `browser()` · `sandbox()` | Lazy, memoised client accessors |
| `dispose()` | Releases anything the accessors constructed |
| `clock` · `deadlines` | Injected so poll and deadline logic is testable without real waits |

**Deliberately absent:** a logger (checks do not print), a `full` flag (the
scheduler gates by cost tier), and clients no check uses.

### `projectRoot`

`solari-doctor` depends on `@solarisdk/browser` itself, so resolving through its
own module graph would report **the doctor's** version rather than the user's,
and `sdk-version` would always pass. The manifest is read from the filesystem,
anchored at `projectRoot`, because the package is ESM-only and its
`package.json` is not an exported subpath.

### Environment injection

The environment is injected at the composition root — `CliDeps.env`, defaulting
to `{}`, with `main()` passing `process.env`.

Reading `process.env` inside `createDoctorContext` would be the obvious repair
for the wiring bug that motivated this, and it would make the entire unit suite
depend on the shell running it: a developer with a key exported would see
different results from CI, and the missing-key tests would fail for them alone.
Injection keeps the suite hermetic by construction.

### Lazy clients and resource ownership

No client is constructed until its accessor is called, so a run that never
authenticates never opens one. The accessors memoise, so the seven checks share
one client rather than opening seven.

**Sharing forces an ownership rule: the owner disposes, not the borrower.** A
check must never close a client it did not create — the first check to finish
would close the client the next one needs. The CLI calls `dispose()` exactly
once, after every check has finished.

### Cleanup

| Resource | Rule |
|:--|:--|
| Shared SDK clients | Disposed once by the CLI. Best-effort — a disposal error must not mask a check's result |
| Sandboxes | Killed in a `finally`, including when an assertion fails partway through and when `kill()` itself throws. `kill()` is idempotent, so the fallback is safe |
| Child processes | `SIGTERM`, escalated to `SIGKILL` if ignored |
| Sessions | Released on every path |
| A cancelled CI run | A separate sweep script removes sandboxes tagged `createdBy: solari-doctor` |

---

# 7. Diagnosis model

A check knows only about itself. *"The installed SDK is 0.1.2"* and *"the
process did not exit"* are two independent observations in isolation, and **one
high-confidence cause together**. Correlating after the fact is the only way to
get that without duplicating cross-check awareness into every check.

```
CheckResult[]  ──▶  diagnose(results, RULES)  ──▶  Diagnosis[]
   (facts)              pure function              (named causes)
```

| `CheckResult` | | `Diagnosis` | |
|:--|:--|:--|:--|
| `id` | one of the seven | `cause` | what is actually wrong |
| `status` | `pass` · `warn` · `fail` · `skip` | `confidence` | `low` · `medium` · `high` |
| `message` | one line; for `skip`, names the blocker | `remediation` | what to do |
| `details` · `remediation` | optional | `supportingChecks` | non-empty; ids the cause came from |
| `durationMs` | set by the scheduler | `issueRef` | optional citation |
| `issueRef` · `evidence` | citation and structured facts | | |

Rules are **data**, separated from the engine, and each cites a gotcha, an
issue, or a measurement.

### Examples

**Two inconclusive signals, one high-confidence cause.**

| Input | |
|:--|:--|
| `sdk-version` | `warn` |
| `browser-lifecycle` | `fail` |

→ *"the installed @solarisdk/browser is older than 0.1.3, and a process that
opened a session did not exit — the documented loopback-proxy hang"* ·
**high** · from `sdk-version, browser-lifecycle`

**The same symptom on a fixed version — deliberately low confidence.**

| Input | |
|:--|:--|
| `sdk-version` | `pass` |
| `browser-lifecycle` | `fail` |

→ *"a process that opened a session did not exit, on an SDK version where the
documented hang is fixed — this is not the known bug"* · **low**

The documented cause does not apply at that version, and the tool says so rather
than reaching for the nearest familiar explanation.

**A cascade collapsed into one statement.** Every resource-creating check
depends on `auth`, so a failed key yields one failure and five skips. Each skip
already names its blocker; the diagnosis adds a single cause for the run:
*"authentication failed, so no check that needs the API could run"*.

---

# 8. Error model

The two SDKs expose errors differently, and this is easy to get wrong:

| Package | Model |
|:--|:--|
| `@solarisdk/browser` | One class, `SolariError`, matched on `.status` / `.code` |
| `@solarisdk/core` (via `sdk`, `sandbox`) | A typed hierarchy: `AuthError` ← `GatewayError` ← `SolariError` |

**Cross-package identity.** Both packages export a class *named* `SolariError`,
and they are **not the same class**. A cross-package `instanceof` returns
`false` silently — no crash, no type error, just a branch that never fires.

**One shared mapper.** Every check routes through a single mapping module rather
than guessing locally. The mapper takes the product explicitly, imports the two
classes under distinct aliases, and records a mismatch in evidence rather than
letting it surface as an unhelpful diagnosis. Identical failures then read
identically wherever they occur.

**Ordering is load-bearing.** The four gateway subclasses must be tested before
`GatewayError`, or every 401 becomes a generic gateway error — with no compile
error and no type error to warn you. A test locks the ordering, and it was
verified by deliberately reversing the real implementation to confirm the test
fails.

A `code` of `undefined` on a 401 is normal on both SDKs, so authentication is
detected from `status === 401` and never from a code.

---

# 9. Scheduling

**Cost tiers** are declared on the check, so they cannot drift from the code
they govern.

| Tier | Behaviour |
|:--|:--|
| `free` | Runs first, **unbounded** — no resource is created |
| `cheap` | Runs through the bounded pool |
| `expensive` | Runs only under `--full` |

**Bounded concurrency.** Resource-creating checks run through a worker pool
capped at **3**, so the tool never opens six concurrent sessions merely because
the language allows it. The bound is verified by an instrumented in-flight
counter rather than by timing, and mutation-verified: removing it fails the
tests.

**Dependency semantics.** `dependsOn` names checks that must **pass** first. The
registry rejects a dependency on an unregistered check at construction, and the
scheduler rejects cycles — direct, indirect, and self — naming every id
involved. A diamond is not a cycle and is not reported as one.

**Skip propagation.** A failed dependency marks its dependents `skip`, directly
and transitively. A skipped check is **never silently omitted**, always names
the check that blocked it, and is never re-attempted. A `warn` is not blocking.

**A check that throws becomes a `fail`**, never an exception that escapes: one
check cannot take down the run.

---

# 10. Security

### Secret handling

The API key never appears in output, logs, or a `--report` bundle. Only
*present / correct format / auth succeeded* booleans are recorded. Redaction
covers the whole `Authorization` value, not just the key pattern — a key broken
by a pasted newline would otherwise leave its tail in an echoed error message.

A key containing header-illegal characters is rejected **before** any request,
so it is never transmitted, and the diagnosis names the character problem rather
than the transport error it would otherwise produce.

### Report sanitisation

The sanitiser is a **whitelist**, so a check added later cannot leak a shape it
has never seen:

| Input | Treatment |
|:--|:--|
| Strings | Redacted and truncated |
| Numbers, booleans | Pass through |
| Arrays, plain objects | Recurse to a depth limit; cycle-safe |
| Anything else — class instance, function, buffer | Replaced by its type name |
| Keys named like credentials — `apiKey`, `cookie`, `storageState`, `screenshot` | Dropped regardless of value |

Keys are written with `Object.defineProperty`, so a hostile key such as
`__proto__` becomes an own property rather than reshaping the object.

### Cleanup as a security property

Every resource is released on every path — see [§6](#cleanup). A leaked sandbox
is both a cost and an exposure, and a cancelled CI run is swept by tag.

### Adversarial verification

The tool was attacked deliberately, not merely tested: malformed keys, shell
metacharacters in the key, hostile evidence keys, unwritable report paths, a
SIGKILL mid-run, and a fresh clone installed from the committed lockfile. The
cleanup sweep was proven non-trivial by deliberately stranding a tagged sandbox
and confirming the sweep killed it.

---

# 11. CLI contract

```
solari-doctor [--json] [--full] [--explain <id>] [--report]
```

One command, four flags. No subcommands, and no `--fix`: automatically running
`npm install` or rewriting a user's config is the riskiest possible thing to
demo, and a partially-tested auto-fix is worse than none.

| Flag | Effect |
|:--|:--|
| `--json` | Machine-readable output on stdout, `schemaVersion: 1` |
| `--full` | Also run expensive checks |
| `--explain <id>` | Print the documented finding for one check. Runs nothing, touches no network |
| `--report` | Write a sanitised report to `./solari-doctor-report.json` |

| Exit | Meaning |
|:--|:--|
| `0` | Every check passed, warned, or was skipped |
| `1` | At least one check failed |
| `2` | Usage error — the diagnostic did not run |

> `warn` exits `0` **deliberately**: *"you are exposed to a documented issue"*
> is not *"your environment is broken"*, and CI should not go red for it.

**stdout / stderr.** Results go to stdout; the report path and any warning go to
**stderr**, so `solari-doctor --json --report > out.json` produces a valid file.

**Report semantics.** The report is a sanitised bundle, written after the
diagnosis has already been printed. If the write fails, the run **warns and
keeps the exit code the checks produced** — losing the file must not turn a
healthy environment into a usage error.

---

# 12. Verification strategy

The working order is **inspect → implement → test → verify at runtime →
document the evidence.** A claim is only settled when evidence at its own risk
level has actually been produced — not when it looks right.

| Level | Name | Proves | Used for |
|:--|:--|:--|:--|
| **L1** | Static | Source, types, docs, history | API surface, engine ranges, export maps |
| **L2** | Unit | Deterministic logic | Every check, the scheduler, the mapper, the engine, the renderers |
| **L3** | Integration | Real SDK interaction | Command semantics, cleanup semantics, recording |
| **L4** | Runtime | Process, resource, lifecycle behaviour | The hang boundary, exit codes, orphan checks |

**Unit tests are necessary and not sufficient**, and that is recorded as a
finding rather than an apology: five real defects survived a green suite and
were caught only by running the built tool. Each lived in the wiring **between**
units — the CLI not reading the environment, one check closing a client three
others shared, a test silently reaching the live API, two checks disagreeing
about the same condition.

**Integration and runtime.** Every check is run against the real installed SDK
before it is considered complete. The `browser-lifecycle` boundary was
established by running one script against two real installs rather than by
reading a changelog.

**Mutation and adversarial.** Assertions are only worth having if they can fail,
so two are mutation-verified — the concurrency bound and the `instanceof`
ordering were each broken deliberately to confirm the tests go red. A separate
adversarial pass attacked the finished tool and found four further defects, two
of them security.

**CI is a claim too.** The workflows were written, and then not checked. Four
consecutive runs had been red on one matrix leg while the local suite was green
and the README described a matrix that had never once succeeded. The gate now
runs on the Node versions the toolchain actually supports, and the runtime
version claim is verified by its own job rather than assumed.

Diagnosing that took three passes, and only the last one held: an inference from
strong circumstantial evidence, a local reproduction that carried an unnoticed
second variable, and finally a controlled experiment isolating one. **"It
reproduces locally" is not the same standard as "one variable changed."**

Evidence per claim is in [`FINDINGS.md`](FINDINGS.md).

---

# 13. Deliberately out of scope

| Excluded | Reason |
|:--|:--|
| **No LLM** in the diagnostic path | Reproducibility. A diagnostic that answers differently on the second run cannot gate CI or support a bug report |
| **No auto-fix** | Rewriting a user's config or running `npm install` for them is the riskiest possible behaviour, and a partially-tested fix is worse than none |
| **No dashboard**, telemetry, or daemon | It is a CLI that runs, prints, and exits |
| **No cross-SDK protocol suite** | The referenced `PROTOCOL.md` is not in any public repository, so no claim about wire compatibility can be supported |
| **No scope expansion** | Seven checks, four flags, no subcommands. And no collapsing the layers under time pressure — **if something has to give, a check goes before a layer does** |
