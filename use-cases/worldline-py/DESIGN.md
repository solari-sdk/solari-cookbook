# Worldline design

## Product claim

Worldline is a transaction layer for fallible agents. It does not make a plan
correct by declaring it correct. It gives several plans the same starting state,
observes their consequences, and commits only an independently verified result.

```text
PREPARE -> CHECKPOINT -> CLONE -> ACT -> VERIFY -+-> REJECT
                       ^                        |
                       +---- next candidate ----+

CHECKPOINT -> CLONE -> REPLAY WINNER -> VERIFY -> COMMIT -> CLEANUP
```

## Trust boundaries

The candidate controls only its action strategy. It does not control:

- the base-state fingerprint;
- checkpoint creation;
- required invariant definitions;
- artifact reads used by the verifier;
- scoring or winner selection;
- cleanup accounting.

For the ledger task, the verifier reads the resulting CSV through Solari's file
channel after the strategy finishes. Required checks cover schema, row count,
the requested target transition, both untouched rows, and an exact final digest.
A plan that fails any required check receives score zero regardless of speed.

The winning plan is not promoted from an explored worker. Worldline creates one
more clean clone, replays the selected strategy, and verifies it again. This
prevents hidden state accumulated during exploration from entering the commit.

## Live backends

### Solari Sandbox

The tested free-tier path prepares one sandbox, writes the base artifact, takes a
snapshot, and destroys the base. Each candidate then receives a newly created
`fromSnapshot` microVM. Workers run sequentially because the free plan permits
one concurrent sandbox or desktop.

### Solari Desktop

The desktop adapter prepares Mousepad with the same ledger, captures a real PNG,
and performs candidate edits through mouse, clipboard, and keyboard controls.
The current account cannot execute this path because the live API returns
`Desktop requires a paid plan`; the adapter remains available behind
`--surface desktop` and uses the same engine and verifier.

## Observed platform behavior

The public snapshot docs show direct in-place `revert()`. On the live sandbox
gateway tested September 1, 2026, an immediate revert returned `Not revertable`,
and a subsequent pause returned `Not found`. Worldline therefore uses fresh
`fromSnapshot` workers rather than depending on in-place revert. This also gives
branches stronger isolation.

Snapshots persist after their source VM is killed. Cleanup must therefore remove
both every worker and the named checkpoint. Live QA verifies account inventory
returns to zero active sessions and zero snapshots after each run.

## Evidence format

`run.json` is the canonical report. It includes:

- a versioned schema and engine version;
- redacted environment and checkpoint identifiers;
- base and result SHA-256 digests;
- every branch's status, duration, action count, checks, and score;
- the selected branch and separate commit replay;
- cleanup outcome and resource counts.

The API key is loaded from process state or an ignored `.env` and is never copied
into the runner, subprocess environments, evidence JSON, HTML, or screenshots.

## Non-goals

- Worldline does not claim that three hard-coded strategies constitute an AI
  planner. The bundled fixture is a deterministic proof of the execution layer.
- It does not claim complete GUI equivalence from the free-tier sandbox proof.
- SHA-256 detects artifact drift; it is not an operator-independent signature.
- The ledger verifier is task-specific. A production system needs a verifier
  contract appropriate to each task domain.
