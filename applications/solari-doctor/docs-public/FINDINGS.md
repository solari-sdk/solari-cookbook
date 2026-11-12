# Findings

What was verified about the Solari SDKs while building `solari-doctor`, what
broke in `solari-doctor` itself along the way, and what is still unresolved.

**Contents** — [1. Evidence standard](#1-evidence-standard) · [2. Final status at a glance](#2-final-status-at-a-glance) · [3. Verified Solari behaviour](#3-verified-solari-behaviour) · [4. Bugs found while verifying solari-doctor](#4-bugs-found-while-verifying-solari-doctor) · [5. What remains unresolved](#5-what-remains-unresolved) · [6. Final verification summary](#6-final-verification-summary) · [7. Sources](#7-sources)

---

# 1. Evidence standard

Every claim here carries the evidence actually obtained for it. Status is given
**per claim**, never as a blanket assurance, because the levels genuinely
differ.

### Evidence levels

| Level | Name | What it proves |
|:--|:--|:--|
| **L1** | Static | Read from source, type declarations, docs, or git history |
| **L2** | Unit | Deterministic logic, exercised by the test suite |
| **L3** | Integration | A real call against the real SDK |
| **L4** | Runtime | Actual process, resource, or lifecycle behaviour |

### Status labels

| Label | Meaning |
|:--|:--|
| **Confirmed** | Reproduced directly, at the level shown. A correction may be noted where the documented wording is imprecise |
| **Partial** | The observable part was reproduced; another part of the claim was not, and is named |
| **Unresolved** | Sources disagree, or the evidence needed is out of this project's reach |

---

# 2. Final status at a glance

## The README gotchas

Five gotchas, listed as six claims — gotcha 2 makes two separable ones, and they
did not land the same way.

| # | Claim | Status | Evidence |
|:--|:--|:--|:--|
| 1 | `browser.close()` is enough to exit as of 0.1.3 | **Confirmed** | **L4** — A/B against real 0.1.2 and 0.1.3 installs |
| 2a | Recording is per session, not per account | **Confirmed** | **L3** — a parallel control session, without `recording: true`, 404'd for 240s |
| 2b | "poll for ~30s before giving up" | **Unresolved** — measurement disagrees | **L3** — three runs: 404 through 60s, replay at 8.2s, 404 through 46s |
| 3 | Sandbox commands are not shell-interpreted | **Confirmed**, with a correction | **L3** — the raw form *throws `ActionError`*; it does not exit non-zero |
| 4 | `kill()`, not `close()`, ends a VM | **Confirmed**, with a correction | **L4** — termination shows as a **404**, not a state transition |
| 5 | `timeoutMs` is a rolling idle window | **Partial** | **L3** — a sandbox's `expiresAt` advanced after activity. The window was never driven to expiry, and no check depends on it |

> Gotcha 5 is in unresolved tension with issue #25, which reports sessions
> ending long before any documented deadline. Neither was measured against the
> other.

## The three cited issues

Referenced in check output, and **not** verified to the same degree. The checks
are worded to match.

| Issue | Subject | Status | What was actually done |
|:--|:--|:--|:--|
| [**#1**](https://github.com/solari-sdk/solari-cookbook/issues/1) | The key-creation modal loses the secret | **Partial** | The console UI event is unobservable from a CLI and was never reproduced. The downstream failures were: a truncated key producing a 401, and a key carrying a pasted line break being rejected before the request is sent |
| [**#25**](https://github.com/solari-sdk/solari-cookbook/issues/25) | Sessions end at ~10 min while the status endpoint says `active` | **Partial** | All three liveness signals confirmed live (L4). The ~10-minute death itself was **not** reproduced — it needs a 10-minute idle run, outside this project's scope by design |
| [**#27**](https://github.com/solari-sdk/solari-cookbook/issues/27) | Go examples need an explicit `-base-url` | **Not reproducible here** | It is a Go issue and this is a TypeScript tool. Corroborated cross-language instead — see [§3.7](#37-sdk-version-discovery-and-the-esm-constraint) |

---

# 3. Verified Solari behaviour

## 3.1 Browser lifecycle — 0.1.2 vs 0.1.3

`@solarisdk/browser` keeps a loopback proxy open for connection retries. Before
0.1.3 that listener held Node's event loop open, so a script that called
`browser.close()` without also calling `solari.close()` printed its output and
then hung. **0.1.3 unrefs the listener.**

Measured directly — same script, same account, one variable:

| Version | Calls | Result |
|:--|:--|:--|
| **0.1.2** | `browser.close()` only | **Hung** — killed at 75s |
| **0.1.3** | `browser.close()` only | **Exited in ~3s** |

*(**L4**.)*

This is why `sdk-version` and `browser-lifecycle` are **separate checks**: a
version read shows *exposure*, a lifecycle observation shows a *symptom*, and
only together do they name the documented bug.

> **A stale comment in the cookbook.** The README gotcha was corrected when
> 0.1.3 shipped, but the TypeScript examples still told readers `solari.close()`
> was required. Fixed and open upstream as
> [solari-cookbook#47](https://github.com/solari-sdk/solari-cookbook/pull/47) — a documentation fix this
> work surfaced, not part of this project.

## 3.2 Authentication and the error model

`@solarisdk/browser` exports exactly **one** error class:

```ts
class SolariError extends Error {
  readonly status?: number;
  readonly cause?: unknown;
  readonly code?: SolariErrorCode | string;
}
```

`@solarisdk/core` — re-exported by `@solarisdk/sdk` and `@solarisdk/sandbox` —
exports a **full hierarchy** instead:

```
SolariError
├── GatewayError
│   ├── AuthError
│   ├── PlanError
│   ├── ConcurrencyLimitError
│   └── NoCapacityError
├── ActionError
├── TimeoutError
└── ConnectionError
```

The same split exists in the Go SDKs, so it is a property of the **products**
rather than of TypeScript.

**Two consequences before writing any error handling:**

1. **The two `SolariError` classes are different classes.** A browser error is
   not `instanceof` the core one, or vice versa. A cross-package `instanceof`
   returns `false` silently — no crash, no type error, just a branch that never
   fires. *(**L1**.)*
2. **`code` is `undefined` for a 401 on both SDKs.** Authentication must be
   detected from `status === 401`; matching auth on an error code never fires.
   *(**L3** — verified with a deliberately invalid key against both clients.)*

## 3.3 Sandbox `close()` vs `kill()`

`close()` is **synchronous** and drops only the local control channel. `kill()`
destroys the VM and is **idempotent**.

| Step | `sandboxes.get()` reports |
|:--|:--|
| After `close()` | `state: "running"` — the VM is still there |
| After `kill()` | **404** — the record is gone |

*(**L4**.)* Termination is confirmed by the record disappearing, **not** by a
state transition. That is the correction to gotcha 4's wording.

The response carries **no billing field of any kind**, which is why the check's
wording stops at *"may result in continued resource consumption/billing"* and
never claims a cost was incurred.

## 3.4 Sandbox command semantics

| Call | Outcome |
|:--|:--|
| `run("ls -la")` | **Throws `ActionError`** — it does not merely exit non-zero |
| `run("ls", { args: ["-la", "/tmp"] })` | Succeeds |
| `run("sh", { args: ["-c", "..."] })` | The way to get pipes, globs or redirection |

*(**L3**.)* The correction to gotcha 3 is the *throw*: code that checks an exit
code will never see one.

## 3.5 Session liveness

All three signals issue #25 names as reliable were confirmed against a session
released server-side *(**L4**)*:

1. `isConnected()` flipped to `false`
2. The `disconnected` event fired
3. A subsequent page call threw

> **The thrown class arrived as `TargetClosedError2`** — a bundler-renamed
> Playwright-family error from `patchright-core`, not a Solari export. Matching
> on that name would break on any rebuild, so `isConnected()` is the primary
> signal and the class name is recorded as **evidence only**.

## 3.6 Recording is per session

Two sessions run in parallel from the same account and polled for 240s:

| Session | `recording` at create | Replay |
|:--|:--|:--|
| **A** | `true` | Available after **8.2s** (`expiresInSeconds: 900`, `contentEncoding: "gzip"`) |
| **B** (control) | omitted | **404 for the entire 240s** |

*(**L3**.)* The control is what makes this conclusive: B reproduced the README's
*"without it the replay endpoint 404s forever"* precisely, while A produced a
replay from the same account minutes apart.

> **There is no confirmation signal.** The `Session` object returned by
> `sessions.create()` exposes `id`, `wsEndpoint`, `cdpEndpoint`, `expiresAt`,
> `storageState?` and `proxy?` — and nothing about recording. A 404 cannot be
> distinguished from a slow upload without waiting. See [§5.1](#51-replay-timing-and-reliability).

## 3.7 SDK version discovery and the ESM constraint

`@solarisdk/browser/package.json` is **not an exported subpath**, so importing
it throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The package is also **ESM-only** —
its `exports` map declares `types` and `import` with no `require` condition — so
CommonJS cannot load it at all. *(**L1**.)*

`sdk-version` therefore reads the manifest **from the filesystem, anchored at
the user's project root**. That anchoring matters: `solari-doctor` depends on
the same package, so module resolution would report *its own* version and the
check would always pass.

**A second discovery constraint, from issue #27.** The Go issue is not
reproducible here, but the same shape exists in the TypeScript packages:

| Package | `baseUrl` |
|:--|:--|
| `@solarisdk/sdk` → `SolariClient` | Defaults to `https://api.getsolari.com` |
| `@solarisdk/sandbox` → `SandboxClient` | Declared `baseUrl: string` — **required, no `?`** — with no default |

*(**L1**, from the published `.d.ts`.)* The same defect in a second language is
evidence that it belongs to the **standalone packages** rather than to one SDK.
It decided a design choice: the sandbox checks use `SolariClient`, because the
standalone client would have forced this tool to hardcode a gateway address.

---

# 4. Bugs found while verifying solari-doctor

Defects in this tool itself, none of which the unit suite caught. They are
recorded because the pattern matters more than the individual bugs: **unit tests
verify units, and these defects lived in the wiring between them** — or, in the
last two, outside the code entirely, in the CI and the documentation that
describe it.

## 4.1 A live-environment wiring bug

Shipped with 194 passing tests, including 21 for `auth`. The first real run:

```
$ node --env-file=.env dist/bin.js
  x auth  SOLARI_API_KEY is not set  0ms
```

The key was present and the check reported it missing. `runCli` built its
context with `createDoctorContext()` and no arguments, so `apiKey` was always
`undefined` — **nothing read `process.env`.** Every test passed because each one
either injected a context directly or deliberately supplied no key, so the one
path that mattered in production was the one path nothing exercised.

**The fix is not "read env inside the context."** That would make the whole unit
suite depend on the shell running it: a developer with a key exported would see
different results from CI, and the missing-key tests would fail for them alone.
The environment is injected at the composition root instead — `CliDeps.env`,
defaulting to `{}`, with `main()` passing `process.env`.

*(**L4**. After the fix: `+ auth  the API key authenticated successfully  942ms`.)*

## 4.2 A shared client closed by a borrower

Found by the first run of all seven checks together. Every per-check run had
already passed.

```
FAIL  recording-lifecycle  the recording probe could not run: an unrecognised error
      evidence: { "errorClass": "Error", "sanitizedMessage": "LocalProxy not started" }
```

`ctx.browser()` memoises one `Solari` instance so the checks share a client
rather than opening seven. Both browser checks then called `solari.close()` in
their own `finally`. `session-liveness` runs first, closed the shared client,
and `recording-lifecycle` inherited a dead one.

Each check was individually correct. The defect exists only in the composition.

**Fix: the owner disposes, not the borrower.** `DoctorContext` gained
`dispose()`, the CLI calls it once after every check has finished, and no check
closes a client it did not create. *(**L4**.)*

## 4.3 A unit test reaching the live API

Two CLI tests ran `runCli` without injecting a registry, so they used the real
one. Once all seven checks were registered, `auth` began making a genuine
`sandboxes.list()` call during `npm test` — a live network request in a suite
required to be hermetic.

It surfaced as a **flaky** failure, not an obvious one: it passed on re-run,
which is the characteristic signature of a suite that depends on the network.

Both tests now inject a one-check registry that records the `apiKey` it was
handed — testing the wiring the cases were actually about, without a request.
*(**L2**.)*

## 4.4 Two checks disagreeing about the same environment

Found by an integrated run from a directory with no `@solarisdk/browser`
installed:

```
!  sdk-version        @solarisdk/browser is not installed under <tmpdir>
x  browser-lifecycle  the harness failed: SdkNotFound
exit 1
```

Both checks observed the same condition and disagreed about its severity.
`sdk-version` treats *"the SDK is not here"* as **cannot determine** and warns;
`browser-lifecycle` treated it as a failure. Because a `fail` exits 1, running
the tool in any directory without the SDK reported a broken environment when
nothing was wrong.

**Fixed:** `SdkNotFound` now maps to `warn`, with wording matching
`sdk-version`'s. The same directory now reports `4 passed · 2 warned`, exit `0`.
*(**L4**.)*

## 4.5 Security and redaction findings

Four defects from an adversarial pass against the finished tool — a deliberate
attempt to break it rather than to confirm it works. Two are security defects.
All four are reachable only through a malformed key or a hostile filesystem.

**Key material survived redaction past a whitespace character.** The redaction
pattern stopped at the first character outside the key's character class, so a
key broken by a pasted newline kept its tail:

```
'Headers.append: "Bearer slr_live_aaaa\nSECRETTAIL" is invalid'
  ->  'Headers.append: "Bearer slr_***redacted***\nSECRETTAIL" is invalid'
                                                   ^^^^^^^^^^ key material
```

This was a live channel, not a hypothetical: the SDK echoes the whole
`Authorization` header when it rejects one, and that message reaches `--report`.
**Fixed** by redacting the entire `Bearer` value before the key pattern runs.

**A newline in the key produced a diagnosis about the transport.** The same key
reported *"the control connection is not open"*. `fetch` rejects an invalid
header before any connection is attempted, and the mapper classified the result
as a connection error — technically defensible, diagnostically useless, on the
exact failure mode issue #1 documents. **Fixed:** `auth` now tests the key for
header-legal characters before spending a call, and reports the character
problem directly.

> Worth naming what the fix does *not* reject: **tab and space are legal in an
> HTTP header value**, so they are allowed. The first version of that test
> asserted they should fail, which was wrong — over-rejecting would fail a key
> the API would have accepted.

**A failed report write discarded the run's verdict.** `--report` to an
unwritable path threw out of the CLI and exited **2 — usage error** — even
though the diagnosis had already been printed. A healthy environment reported as
a usage error. **Fixed:** the write is wrapped, a failure warns on stderr, and
the check-derived exit code stands. *(**L4** — against a real read-only file:
`2` → `0`.)*

**A hostile evidence key reshaped the sanitised object.** `output[key] = value`
with `key === "__proto__"` sets the object's **prototype** rather than creating
a property. `Object.prototype` was never polluted — the payload landed on the
local object — but the sanitiser's output silently acquired a hostile prototype,
and the key it was asked to preserve vanished. **Fixed** with
`Object.defineProperty`.

## 4.6 CI was red on Node 20 from the very first push

The badge was never checked after the workflows were added. The Actions API
showed **four consecutive failed runs**, one per push, all failing identically:

```
ubuntu-latest  · node 24   success
ubuntu-latest  · node 20   failure  -> step "npm ci --ignore-scripts"
windows-latest · node 24   success
windows-latest · node 20   failure  -> step "npm ci --ignore-scripts"
```

Never the tests — always the install, and only on Node 20.

**Cause:** two deliberate decisions combining into one nobody made.
`vitest@5.0.0` requires `^22.12.0 || ^24.0.0 || >=26.0.0`, excluding Node 20;
`.npmrc` sets `engine-strict=true`, which turns npm's engine warning into a hard
failure. `engine-strict` was added with the comment *"Fail loudly if Node is
older than a package requires (SDK needs >= 20)"* — and it did, for a
**devDependency**, on the version the matrix pinned.

Reproduced locally to confirm rather than infer, by patching a scratch copy of
the lockfile to give vitest an impossible range:

| Command | Result |
|:--|:--|
| `npm ci --ignore-scripts` | **`EBADENGINE`** on the devDependency |
| `npm ci --ignore-scripts --omit=dev` | Succeeded — devDependency engines are not evaluated |

**Why local gates never caught it:** development ran on Node v24.19.0
throughout, and `npm run check` cannot fail on a constraint that only binds on
20. Every production dependency does admit Node 20, and `lockfileVersion` is
`3`, which npm 10 reads — so neither is implicated.

**The fix, and the one deliberately not taken.** Dropping Node 20 from the
matrix would have made the badge green and quietly abandoned the
`engines.node >= 20` claim in `package.json`. Instead the full gate runs on Node
22 and 24 — **all four legs now green** — and a separate `runtime-node20` job
verifies the claim actually made to users, against the built output and
production dependencies only.

### The second failure, and why the first explanation did not survive

That new job then failed at its own install step, and the obvious answer — that
`engine-strict` still evaluates vitest's range — had just been *disproved* by
the table above. Rather than guess again, one more experiment held everything
constant except the npm version:

| npm | `npm ci --ignore-scripts --omit=dev` (same lockfile, same Node) |
|:--|:--|
| **11.17.0** | Succeeds — devDependency engines not evaluated |
| **10.9.9** | **`EBADENGINE` on vitest** |

**npm 10 evaluates devDependency engine ranges even under `--omit=dev`; npm 11
does not.** Node 20 ships npm 10, while development here runs npm 11 on Node 24
— which is exactly why the same command passed locally and failed in CI.

Fixed by upgrading npm in that job, and **the workflow is now green on every
job.** The alternative, `--engine-strict=false`, was rejected: `engine-strict`
is the mechanism that would catch a **production** dependency dropping Node 20,
which is the whole point of the job.

*(**L4**.)* A CI badge is a claim like any other, and this one had not been
verified: four red runs sat in the Actions tab while the local suite was green.
The wider lesson is that "it reproduces locally" was not sufficient either —
the local environment differed from CI in a variable nobody had enumerated.

## 4.7 The documentation had drifted from the code

Asked whether every document was up to date, the honest answer required an
audit rather than an assertion. Nine claims across three internal documents were
wrong — all of them numbers, all of them true when written.

The per-suite test table summed to **352** against an actual **347**: nine
hand-maintained numbers, each correct at the module it was written in, none
re-derived since, and the sum never checked against the runner.

| Claim | Documented | Actual |
|:--|:--|:--|
| Total tests | 332 | **347** |
| `cli` suite | 46 | **33** |
| `auth` suite | 21 | **26** |
| `runner/errors` suite | 24 | **28** |
| `report/bundle` suite | 16 | **19** |
| Findings recorded | 46 | **51** |
| Evidence-matrix rows | "~60" | **99** |

**Resolved by deriving instead of remembering.** Counts now come from
`vitest run --reporter=json`, read per file, and any number in any document must
be reproducible from it. Thirty corrections were applied across the internal
docs, and a matrix row now tracks the claim itself.

Three flagged items were **left alone because they were correct**: the renderer
sub-counts (13 terminal, 8 JSON) and the snapshot count, all confirmed
per-`describe`; the *"shipped with 194 passing tests"* in [§4.1](#41-a-live-environment-wiring-bug),
which is a historical statement rather than a current count; and the live
workflow's `unverified` status, which is genuine — it has never been dispatched,
and marking it verified to tidy a table would be the exact failure this project
exists to catch.

A stale number is a small error with the same shape as the large one in
[§4.6](#46-ci-was-red-on-node-20-from-the-very-first-push): a claim that was true
once and got carried forward without re-verification. A CI badge nobody read; a
test count nobody re-ran. The remedy is the same — derive it, don't recall it.

---

# 5. What remains unresolved

None of these block the tool. All are recorded rather than resolved.

## 5.1 Replay timing and reliability

Three live runs of the recording cycle disagree:

| Run | Session activity | Poll schedule | Result |
|:--|:--|:--|:--|
| 1 | one `goto` | every 2s for 60s | **404 on all 25 polls** |
| 2 | two `goto`s + 1.5s dwell | every 5s for 240s | **Replay at 8.2s** |
| 3 | one `goto`, via the built check | every 2s for 45s | **404 on all 20 polls**, stopped at 46,020 ms |

Solari's own figures disagree too:

| Source | Figure |
|:--|:--|
| SDK doc comment on `getReplayUrl` | *"Available ~1-3s after `releaseAndWait`"* |
| Cookbook README, gotcha 2 | *"poll for ~30s before giving up"* |

Two of three runs produced **no replay at all**, so the open question is not
*"how long does the upload take"* but *"does a replay reliably appear"*. Since
there is no confirmation signal on the `Session` object ([§3.6](#36-recording-is-per-session)),
a 404 at the 30s mark is ambiguous between a slow upload and recording never
having been on.

`recording-lifecycle` therefore reports a timeout as **inconclusive**, states
Solari's documented figure and this project's polling ceiling as **separate
numbers**, and does not claim a guarantee was breached.

## 5.2 Session expiry discrepancy

| Source | Value |
|:--|:--|
| Issue #25, Starter tier | `createdAt + 5h` |
| Measured here | `createdAt + 1h` |

The plan tier of this account is unknown, so the two are not necessarily in
conflict and the discrepancy is **unresolved**.

It changes nothing in the tool — `session-liveness` is structural and never
trusts `expiresAt` or the status endpoint — but it is one more reason not to.

## 5.3 `PROTOCOL.md` is not publicly available

Three SDK READMEs reference an authoritative protocol contract —
`sdk/PROTOCOL.md` from the Rust SDK, `../PROTOCOL.md` from the Go one — that is
**not present in any public repository**, and the `sdk/` directory they point at
has no public counterpart.

Cross-SDK protocol conformance is therefore out of scope, and this project makes
no claim about wire compatibility.

**Three questions for the maintainers, whenever convenient:**

1. Does `PROTOCOL.md` exist in a private or internal location?
2. Is it available through another repository or path?
3. Or is cross-SDK conformance intentionally outside the public surface?

---

# 6. Final verification summary

Measured at the current commit, not quoted from an earlier run.

| Gate | Command | Result |
|:--|:--|:--|
| **Tests** | `npm test` | **347 passing, 15 files.** No test reaches a live service |
| **Typecheck** | `npm run typecheck` | **Exit 0** — source and tests, strict + `exactOptionalPropertyTypes` |
| **Lint** | `npm run lint` | **Exit 0** — including the layer-purity rules |
| **Build** | `npm run build` | **Exit 0** |

**Live checks — 7/7.** Every check was run against the real SDK before being
considered complete, including the A/B against real 0.1.2 and 0.1.3 installs.

**CI — every job green.** The PR gate runs typecheck · lint · test · build on
ubuntu and windows across Node 22 and 24. Node 20 is excluded from the gate for
the reason in [§4.6](#46-ci-was-red-on-node-20-from-the-very-first-push), and is
covered instead by a `runtime-node20` job that installs production dependencies
only and runs the built CLI there — so the `engines.node >= 20` claim in
`package.json` is verified rather than assumed.

---

# 7. Sources

**Official cookbook** — [`solari-sdk/solari-cookbook`](https://github.com/solari-sdk/solari-cookbook),
the README gotcha list and the TypeScript examples.

**Issues** — [#1](https://github.com/solari-sdk/solari-cookbook/issues/1) ·
[#25](https://github.com/solari-sdk/solari-cookbook/issues/25) ·
[#27](https://github.com/solari-sdk/solari-cookbook/issues/27)

**Published SDK declarations** — the `.d.ts` files shipped in each package, read
from `node_modules` rather than from documentation.

**Package versions all findings were obtained against:**

| Package | Version |
|:--|:--|
| `@solarisdk/browser` | 0.1.3 (and 0.1.2 for the A/B) |
| `@solarisdk/sdk` · `@solarisdk/sandbox` · `@solarisdk/core` | 0.1.3 |
| `@solarisdk/desktop` | 0.1.2 |
| `patchright-core` | 1.62.2 |
| TypeScript | 6.0.3 |
| vitest | 5.0.0 |
| ESLint · typescript-eslint | 10.10.0 · 8.69.0 |
| Node (development) | v24.19.0 |
