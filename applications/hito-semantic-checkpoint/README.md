# HITO × Solari Continuity Reference Implementation

**Persist the work, not the worker.**

## Why this exists

Disposable compute creates a continuity problem. A replacement worker can reconstruct project understanding from scratch, or inherit old state and risk treating stale assumptions as current truth. HITO takes a third approach: **Remember what is justified. Re-check what may be stale.**

**Disposable computers can share project continuity without sharing stale assumptions.** A fresh worker distinguishes SAFE TO CARRY FORWARD, CHANGED, RE-OBSERVE, UNKNOWN, and CONFLICT within the bounded observation scope.

## Live result: PARTIAL

Attempt 2 proved checkpoint capture, fresh continuation, stale-support rejection, distinct workers sharing one parent, semantic fork and conflict refusal on a deterministic three-file subject. All three Sandboxes were confirmed absent after cleanup. Desktop created and terminated but produced no screenshot; Browser failed locally before HTTP dispatch and produced no DOM evidence. Cross-primitive evidence and routing remain PARTIAL. Volume was not requested; Attempt 1 recorded HTTP 501 and an unresolved resource outcome in this environment. [Full history and limits](docs/live-qualification.md).

## What developers get

- Checkpoint — preserve bounded project evidence.
- Resume — continue on a fresh Solari worker and recheck current files.
- Fork — share a checkpoint while keeping current reality worker-local.
- Reconcile — expose disagreement rather than manufacture consensus.
- Route — map evidence needs to Sandbox, Desktop or Browser; peripheral live observations remain unqualified.
- Preserve uncertainty — UNKNOWN remains UNKNOWN.

These are application-owned wrappers, not native Solari continuity methods. Selected source bytes do not prove runtime behavior. Canonical and execution authority remain false.

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


## Continuity-Native Compute

When compute becomes disposable, the durable object increasingly becomes the work rather than the worker: provenance, bounded evidence, currentness boundaries, uncertainty, branch identity, and unresolved contradictions across replaceable compute. HITO × Solari is a reference implementation of this hypothesis. The product layer is a Project Continuity Layer; its first primitive is a Semantic Checkpoint. A Semantic Control Plane is a longer-range architecture direction. These are HITO proposals, not Solari endorsement or roadmap adoption.

A snapshot preserves what the machine was.
A Project Continuity Layer helps a fresh machine determine what prior project evidence is still legitimate to rely on.

## Who this is useful for

- Coding agents/workflows using ephemeral sandboxes.
- CI/debug workflows crossing temporary workers.
- Multi-worker repository investigations.
- Long-running work that outlives a machine.
- Sandbox + Desktop + Browser verification workflows, once peripheral adapters qualify.
- Reproducible engineering handoffs.

## When you probably do not need this

- One-shot scripts.
- No cross-worker continuation.
- Simple tasks where normal source checkout is sufficient.

## Scope and evidence

The public subset observes README.md, package.json and src/index.js in a tiny original fixture. It does not replace Git, snapshots, agent memory or general repository analysis. It makes no universal speed, cost, novelty or usefulness claim. The original R1 fixture was not faster than Cold; snapshot and checkpoint sizes are not comparable compression measurements. [Historical summaries](evidence/README.md), [capability matrix](docs/stretch-matrix.md), [platform opportunity](docs/solari-platform-opportunity.md), and [public subset/license boundary](docs/public-subset.md) distinguish observations from proposals. The MIT license covers this application only, not full HITO. See THIRD_PARTY_NOTICES.md for actual dependencies.
