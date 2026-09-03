# Verified Agent Runtime

Run an AI coding agent inside a fresh Solari sandbox, judge the result from an independent Solari Browser, and keep a tamper-evident proof bundle.

The runtime treats issue text and agent output as hypotheses. Only runtime observations and explicit gates can produce `PASSED`.

## Why Solari

Solari provides two separate trust domains for one coding task: the sandbox is disposable execution for untrusted agent mutations, while a fresh Solari Browser independently observes the running result through the preview capability. The agent cannot mark its own work correct. Run-scoped sandbox metadata makes cleanup attributable even under concurrent work or a lost create response, and the final proof can be re-verified offline without either live credential.

That turns the useful unit from "AI produced a patch" into "AI produced a bounded change that a separate runtime observer proved and that can be audited later."

```text
immutable repo SHA
      |
      v
 SOURCE -> BASELINE -> MUTATE -> STATIC_VERIFY -> RUNTIME_VERIFY -> JUDGE
                ^                                              |
                |-------------- bounded retry -----------------|
                                                               v
                                                           EVIDENCE
                                                               |
                                                               v
                                                            CLEANUP
```

## What is generic

`run-job.ts` contains the execution state machine. Repository-specific behavior lives in a validated JSON job spec under `jobs/`.

A job declares:

- an immutable 40-character Git SHA;
- the agent endpoint/model and explicit file allowlist;
- bootstrap and verification commands;
- preview command, port, browser route, and optional deterministic localStorage seed;
- one typed browser verifier;
- retry budget and evidence directory.

The current verifier kinds are:

- `button-accessibility`: compare the browser accessibility tree before and after;
- `text`: assert included/excluded UI text without storing the page body.

Adding a job does not require modifying the runtime.

## Safety and blast radius

The job parser rejects mutable refs, non-canonical paths, cross-origin browser routes, duplicate allowlist entries, and type coercion. Each allowlisted target file is also resolved inside the sandbox before mutation; symlink or realpath redirection is rejected.

The model credential is scoped to the single bounded-agent process through Solari command-level environment variables. Target bootstrap, tests, build, and preview processes never receive it. Captured command output also redacts every command-scoped secret value dynamically, independent of key prefix.

The bounded edit agent validates the full edit plan in memory before writing files. Every attempt is checked against the allowlist, and bootstrap plus baseline must leave the Git tree clean before attribution begins. Static gates must pass without changing the attributed agent diff, and the independent browser judge must also pass. Preview processes run in an owned process group, so baseline and final observations cannot accidentally share a stale server. Each sandbox is tagged with a unique run metadata ID before creation. Cleanup and create-failure recovery query only that tag, so even a lost create response can recover its orphan without touching unrelated concurrent Solari work.

Evidence stores hashes and sanitized logs, not raw patches, API keys, signed preview capabilities, raw sandbox capabilities, host paths, or absolute sandbox paths.

## Real proofs

Two committed jobs exercise the same state machine with different verifier kinds.

| Job | Immutable target | Browser proof | Mutation scope |
| --- | --- | --- | --- |
| `jobs/buddy-harmony.json` | `Marthijs-Berfelo/buddy-harmony@9a6fea34...` | 4 unnamed buttons -> 0 while 6 buttons and existing `Key`/`Scale` names are preserved | 8 source/i18n files |
| `jobs/fixture-ai.json` | `MisterWanted/solari-cookbook@2efa5a79...` | placeholder absent after repair and `AI repaired this UI in Solari` present | 1 HTML file |

The Buddy job bootstraps checksum-pinned Node 24.15.0 and uses `npm ci`. It also commits the exact public issue context used for the run at `jobs/buddy-harmony-482.issue.json` and binds those canonical bytes with SHA-256 `1c85d0a268effc22c0f2603015c67bffa53067ca1f967552e2af9e6fb830191e`. Its browser policy seeds `i18nextLng=en-US` before navigation so independent baseline/final sessions cannot drift languages and invalidate preserved-name comparisons.

The semantic browser delta is intentionally more useful than the identical before/after pixels:

```text
BEFORE  ["", "", "", "", "Key", "Scale"]
AFTER   ["Menu", "Settings", "Print scale", "Select language", "Key", "Scale"]
```

### Upstream follow-through

The immutable Solari proof remains anchored to `9a6fea34...`, but the same issue was rechecked against Buddy Harmony's then-current `main` (`882920c90af52d4c90f2c85484bb5a70b7f2d5e7`). None of the eight proof-scope files had drifted. A clean current-main patch was independently verified with typecheck, zero-warning lint, 41/41 tests, production build, and a browser audit showing 6 buttons preserved while unnamed buttons went from 4 to 0. That exact patch is published as [Buddy Harmony PR #599](https://github.com/Marthijs-Berfelo/buddy-harmony/pull/599) at head `99da9ca6ea300a99b5bb13f5a2f56500ea874a2d`.

The upstream repository's `pull_request_target` CI currently refuses to check out fork code before commitlint/tests run; the PR comment records that as an upstream workflow-security limitation rather than weakening checkout protections.

## Run a live job

```bash
npm ci
export SOLARI_API_KEY=...
export ZAI_CODING_PLAN_API_KEY=...
npm run demo:buddy
# or
npm run demo:fixture
```

The agent provider is job data, not runtime code. A different OpenAI-compatible coding endpoint can be used by changing the job spec and secret environment name.

## Verify committed evidence without secrets

```bash
npm run check
```

`check` runs TypeScript, unit tests, then verifies both committed proof bundles. The verifier recomputes:

- job-spec SHA-256 and the complete public runtime policy (model, endpoint, allowlist, retry budget, commands, verifier kind);
- immutable repository/checkout identity plus the committed issue-snapshot SHA-256 when present;
- exactly one final accepted attempt, its non-empty diff hash, allowlist, exact gate commands, and zero exit codes;
- baseline and final browser acceptance semantics, not only their stored `PASSED` status;
- canonical accessibility delta / visual-parity claims and baseline/final screenshot SHA-256 values;
- a manifest re-derived field-for-field from `evidence.json`, plus the evidence JSON SHA-256;
- zero remaining run-owned sandboxes without assuming the account has no concurrent work;
- leak checks for credentials, signed preview tokens, and local paths.

This means CI can reject altered or incomplete evidence without having a Solari key or model key.

## Evidence bundle

Each live job writes:

```text
artifacts-<job>/
  baseline.png
  final.png
  evidence.json
  manifest.json
```

`evidence.json` is the detailed event/attempt record. `manifest.json` is the compact review surface: source identity, policy, phase results, accepted mutation hash, verification gates, browser delta, cleanup state, and a SHA-256 of `evidence.json`. The offline verifier does not trust the manifest: it re-derives the complete canonical manifest from the detailed evidence and rejects any difference.

## Method

The Buddy proof follows a runtime-first blast-radius discipline: the issue is not trusted blindly. The browser baseline showed that `Key` and `Scale` were already named, so the agent was explicitly forbidden from changing that behavior. The acceptance criteria encode the facts the change is safe because of, then prove them on the running app.
