# HITO × Solari

**Semantic continuity for disposable compute.**

Compute is disposable. Project understanding shouldn't be.

This application creates a Solari sandbox, observes three files in an original tiny project, captures a portable Semantic Checkpoint, and destroys the sandbox. A fresh sandbox restores the checkpoint alongside current source files and observes those files again. A plain-language receipt separates reusable historical support, changed support, unknowns, and authority.

**Persist the work, not the worker.** A checkpoint carries bounded evidence and its provenance. It does not make an old machine's facts current.

## Run

Requires Node.js **22.18 or later** and a Solari account. From this directory:

```sh
npm install
export SOLARI_API_KEY='your-key'
npm run demo
```

On PowerShell, set the same variable using `$env:SOLARI_API_KEY` in your local terminal. The program reads the process environment; it does not automatically load `.env`.

The default is **same reality**, using at most **two sandboxes**. To demonstrate an external source change:

```sh
npm run demo -- changed
```

To run both cases sequentially, at most four sandboxes:

```sh
npm run demo -- both
```

Each case destroys A and confirms its absence before creating B. Both sandboxes are terminated in cleanup paths. A failed or uncertain cleanup is reported as failure; do not blindly retry it. Evidence and the human receipt are written under `runs/`, which is excluded from publication.

Only `SOLARI_API_KEY` is required. There is no model provider, agent-memory service, or paid model dependency. Solari supplies remote compute. The guest may download a fixed Node.js release from its publisher if a suitable runtime is absent.

## What you will see

```text
SANDBOX A — created
PROJECT X — observed
SEMANTIC CHECKPOINT — captured
SANDBOX A — destroyed (confirmed)
SANDBOX B — fresh
CONTINUITY — restored
CURRENT REALITY — re-observed

SAFE TO CARRY FORWARD
RE-OBSERVED
CHANGED
STILL UNKNOWN
PROTECTED
NEXT
RESULT: PASS / PARTIAL / FAIL
```

In the changed case, `src/index.js` has different physical bytes. Its old supporting claims become **STALE**, while matching historical support remains reusable within its original scope. The receipt never turns observed source bytes into verified runtime behavior. Execution and canonical authority remain false.

PASS means the selected case established its bounded transport, reobservation, currentness, and termination conditions. It does not mean the fixture has been behaviorally tested or authorized for deployment.

## Proven today — historical evidence

The earlier integration experiments recorded:

- **R1:** prior HITO state reopened in a distinct sandbox after origin destruction, and supporting files were re-observed. Unknowns and disabled execution remained explicit. [R1 evidence summary](evidence/R1_SUMMARY.json)
- **R1C:** a supported external change was detected and its old hash was not retained as current truth. [R1C evidence summary](evidence/R1C_SUMMARY.json)
- **R2:** native Solari Snapshot and HITO Semantic Checkpoint exhibited different, complementary persistence behavior. [R2 evidence summary](evidence/R2_SUMMARY.json)

These summaries identify exact historical artifacts, hashes and fields. They are sanitized disclosures, not public access to the underlying private logs. They **do not establish that this newly extracted public application has run live**. This release candidate is locally tested; its exact Solari smoke test remains pending.

The tiny R1 fixture HITO path was **not faster than Cold**. Snapshot size and semantic checkpoint size are **not comparable compression measurements**. This application makes no universal speed, cost, or compression claim.

## What is included

This is a limited public HITO capability: four existing bounded observation/currentness routines, a strict checkpoint wrapper, two deterministic fixtures, a Solari controller and a derived receipt. It is not the full HITO runtime or canonical model. [Public subset and license boundary](docs/public-subset.md)

Solari provides disposable Sandbox, Desktop and Browser compute. This application uses **Sandbox only**. HITO explores a candidate continuity layer for deciding which prior support can carry forward and what must be observed again. It does not replace Git, snapshots, volumes, agent memory, or Solari.

## Where this could go with Solari

**Design direction, not shipped functionality or Solari endorsement:** continuity-aware fresh compute, safer handoffs, and evidence requirements distinguished across Sandbox, Desktop and Browser. Future semantic scheduling might use unresolved evidence requirements to help choose a compute primitive. None of those additional capabilities is implemented here. [Bounded proposal](docs/solari-opportunity.md)

## Inspect and test

```sh
npm run typecheck
npm test
```

Tests make no network calls and create no Solari sessions. They exercise actual local observations with simulated transport, checkpoint tampering, stale support, uncertainty, termination failure and create-budget enforcement. [Architecture](docs/architecture.md) · [Evidence limits and smoke policy](docs/evidence-boundary.md) · [Dependency notices](THIRD_PARTY_NOTICES.md)

MIT applies only to the contribution in this application directory. It does not license the separate full HITO project.
