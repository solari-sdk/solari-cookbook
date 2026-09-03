# Design rationale

Forklift uses the smallest mechanism found during development that preserved
both fail-closed acceptance and useful completion. Valid clean work remained
selectable while crash and wrong-value states were refused.

## Required contract

One fallible visible GUI attempt may mutate only a disposable copy of the
canonical internal state. The exact frozen result must
be read by a fresh semantic auditor. Only an all-pass, lineage- and receipt-
bound snapshot may become durable. External bank, email, and SaaS effects remain
outside the claim and must not execute.

## Why it resembles CI artifact promotion

A CI job builds an isolated artifact, freezes it, tests that artifact in a
separate step, and releases only the bytes that passed. Forklift maps the Odoo
branch to the build, the candidate snapshot to the artifact, the semantic oracle
to the test suite, and durable template creation to release.

The analogy stops at external side effects. A CI artifact normally cannot send
a bank transfer while it is being built; a GUI workflow can. Forklift therefore
does not treat snapshot discard as reversal of effects that have left the VM.

## Complexity removed

- three simultaneous or competing candidate branches per trial;
- voting, best-of-N selection, and branch portfolio rhetoric;
- a custom persistent browser-worker template (the stock desktop plus an
  attempt-local Playwright install is slower but proved less ambiguous);
- treating rollback as reversal of arbitrary external side effects; and
- keeping an accepted candidate live after its immutable snapshot exists.

## Minimal construction

```text
canonical sandbox snapshot
          |
          v
one candidate sandbox <--signed preview-- one disposable visible desktop
          |
          v
immutable candidate snapshot --> fresh read-only auditor
          |
          +-- all checks + lineage + receipt --> durable template
          |
          `-- anything else -----------------> delete / retain nothing
```

## Why each part remains

Isolation makes the worker's result a proposal rather than
authoritative state; snapshotting removes the check-then-change race; a fresh
auditor supplies the business semantics; exact snapshot and receipt bindings
make promotion refer to the bytes that were judged.

The implementation reuses Odoo's business rules, PostgreSQL facts, Solari's
snapshot and promotion primitives, and the same raw artifacts for the matched
baseline. It does not require multi-candidate voting or a custom persistent
browser template.

One attempt peaks at one GUI desktop and two sandboxes only during
candidate/auditor overlap, matching the campaign's two-sandbox resource cap.
Development produced 16 audited trials with 8 valid selections, 8 safe
refusals, and zero false acceptances. The matched worker-self-report baseline
falsely accepted three of those audited states.

## Limits and alternatives

A side effect sent to a real bank or email server cannot be abandoned with the
candidate sandbox. Such actions need staging or a domain-specific external
commit protocol. A renderer crash after the first business mutation is not
retried as if nothing happened; the attempt must be sealed and audited or
classified as inconclusive.

The design could be simplified further if one mutable instance can preserve the
canonical state under the same failures and checks, or if a Solari primitive
atomically provides the same isolation, semantic validation, and exact durable
commit. Until then, removing the snapshot, fresh auditor, semantic oracle, or
exact receipt binding weakens the tested acceptance boundary.
