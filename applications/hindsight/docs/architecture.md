# Hindsight — architecture

An agent that backtracks without forgetting.

## The claim

Rewind is **not** a speed optimization on Solari. We measured that and it is
false (§ Measurements). Rewind is a *capability*:

> You cannot rebuild to a state nobody scripted.

A provisioned environment can be rebuilt — you have the setup script. An agent's
environment after forty improvised steps cannot: there is no script, only a
history of ad-hoc mutations. Rebuild reproduces a **known** setup. Snapshot
captures an **unknown** one. That distinction is what Hindsight is built on, and
it is unaffected by how long a restore takes.

## The mechanic

A rewind restores the world and *keeps what the failure taught*.

Restoring VM state alone leaves the model holding messages describing a branch
that no longer exists. It gets confused, or it repeats the mistake it just undid.
So a checkpoint records **both** VM state and transcript position, and a rewind:

1. restores the environment to the checkpoint's snapshot
2. truncates the transcript back to the recorded offset
3. appends a note naming the checkpoint and why the branch was abandoned
4. moves the tree head, so the next checkpoint branches from the rewind target
   rather than from the discarded work

Two trees — snapshot lineage and message history — deliberately kept out of sync.
That asymmetry is the idea. The environment goes back; the knowledge does not.

## Module layout

```
hindsight/
  tree.py       CheckpointTree — lineage, lookup, head movement. Pure.
  runner.py     Runner Protocol — the seam. checkpoint() / restore().
  fake.py       FakeRunner — in-memory, deterministic, no credentials.
  sandbox.py    SolariRunner — the ONLY module importing solari_sandbox.
  session.py    Binds Runner + tree + transcript. Owns the rewind mechanic.
  tools.py      checkpoint/rewind exposed as Claude tool definitions.
  agent.py      The manual Claude loop.
  cost.py       Token and sandbox-hour accounting.
  report.py     run.json evidence writer.
```

**Boundary rule.** `tree`, `session`, and `agent` never import a Solari type. They
see `Runner`. Three consequences, all deliberate:

- the interesting logic is unit-testable with no API key and no spend
- the Solari adapter can switch restore strategies without the agent noticing
- the library works against any snapshot-capable backend

This mirrors the ports-and-adapters shape already used by `applications/worldline`.

## Restore strategy

`Runner.restore()` has two viable implementations on Solari:

| strategy | mechanism | cost |
|---|---|---|
| in-place | `sandbox.revert(snapshot_id)` | sandbox id stays stable; no extra concurrency slot |
| fork | `kill()` + `create(from_snapshot=…)` | needs a free slot; stronger isolation |

Hindsight uses **in-place revert**, verified working (§ Measurements). Fork
remains available behind the same Protocol as a fallback, and is what
`applications/worldline` uses.

## Agent loop

A **manual** loop, not the SDK's `tool_runner`. The runner "keeps its own copy
[of the message history] and does not expose it" — and rewriting history is
precisely this project's mechanic. This is the documented reason to drop to a
manual loop.

Claude configuration: `claude-opus-5`, `thinking={"type": "adaptive"}` (never
`budget_tokens` — rejected with a 400 on this model),
`output_config={"effort": "xhigh"}`, `max_tokens=16000`. `stop_reason ==
"refusal"` is checked before reading content, with server-side fallbacks enabled.

## Measurements

From Phase 0 probes against the live gateway, 2026-09-08. Free tier, `base`
template, 1 vCPU / 2 GB.

| operation | result |
|---|---|
| cold create | ~2.2s |
| `snapshot()` | ~10.7s |
| `revert()` — min / **median** / max (n=8) | 9.5s / **23.4s** / 58.9s |
| rebuild (create 2.2s + real setup 6.5s) | **8.7s** |

Setup was `pip install requests`, `pip install flask sqlalchemy`, and a shallow
`git clone`.

**Rebuild beats rewind by ~2.7× at the median**, and revert's tail is 6.7× worse
than its best case. The reason is not that revert is broken — it is that Solari's
create path is genuinely fast, so rebuilding a *scriptable* environment is cheap.

Breakeven is roughly **21s of setup**. Below that, rebuild. Above it, rewind wins
on time as well as on capability.

### Correctness

In-place `revert()` **works and restores correctly** — verified by installing a
package and writing a file, destroying both, reverting, and confirming both
returned (`flask 3.1.3` importable, marker file intact).

This contradicts `applications/worldline/DESIGN.md`, which records that on
2026-09-01 an immediate revert returned `Not revertable`. Either the gateway
changed in the intervening week, or the behavior differs between the Desktop
client (which Worldline used for revert, and documents as never live-verified)
and the Sandbox client. We did not reproduce the failure.

## Benchmark design

Three arms, each given only the tools it is told about — a shared system prompt
naming `checkpoint` to an arm that has no `checkpoint` grades it on an
impossible instruction, and an early sweep did exactly that before the bug was
caught:

| arm | tools | recovery story |
|---|---|---|
| `none` | `run` | whatever the agent invents for itself |
| `rebuild` | `run`, `reset` | rebuild the workspace from scratch, keep the memory |
| `hindsight` | `run`, `checkpoint`, `rewind` | restore a checkpoint, keep the lesson |

`reset` is the honest baseline: it is what a developer without snapshots
actually does. It restores the world and leaves the transcript intact, which is
the single difference from a rewind.

Two tasks, chosen to sit on opposite sides of the boundary the first runs
revealed:

- **`ledger-migration`** — one 51-line CSV and three opaque migrations. State is
  small enough to copy. A capable agent backs it up, simulates all three options
  in `/tmp`, and never needs to recover.
- **`env-repair`** — a broken app, three compiled vendor blobs, and damage that
  lands in installed Python packages *and* `/etc/appconf/settings.ini`. No single
  `cp` covers it.

Success is checked by us, never by the agent's own report. LLM runs vary, so
every figure is a median over repeated runs with the spread shown beside it.

### What the first runs taught

A capable agent routes around needing rewind whenever the state is small enough
to copy and the danger is legible enough to simulate. On `ledger-migration` the
agent decoded the "opaque" payloads, copied the ledger to `/root`, built a
simulation harness in `/tmp/sim`, tried all three migrations against the copy,
and then applied the right one — zero rewinds, and the checkpoint it did take
went unused.

That is good engineering by the agent, and it sharpens the claim rather than
weakening it: snapshots earn their place when the state is too large or too
diffuse to hand-copy, not when a file will do.

## Non-goals

- **Not a speed claim.** Rewind is slower than rebuild for light environments.
  Anyone whose setup is scripted and takes under ~21s should just rebuild.
- **Not a benchmark of Solari.** The measurements exist to size the mechanism
  honestly, not to score the platform.
- **Not parallel exploration.** `applications/worldline` already branches
  competing plans and picks a winner. Hindsight is sequential: one agent that
  goes back and carries what it learned. Worldline has no LLM in it — it runs
  three hard-coded strategies and says so.
- **Not a general agent framework.** One loop, two tools, one task shape.

## Gotchas found while building

Recorded where they bit, per the cookbook's contributing rule.

- The `base` template has **no `python`** — only `/usr/bin/python3`. A check
  written as `python -c …` exits 127 and reads as a failed restore when nothing
  is wrong.
- `sandbox.close()` is a **coroutine** in the Python SDK. Calling it without
  `await` raises no error, just a `RuntimeWarning`, and the channel stays open.
- Snapshots outlive the VM that made them. Cleanup must delete both, or they
  accumulate silently and bill.
- `delete_snapshot` is refused while a snapshot has live children.
- `revert()` latency scales with how much state changed and is highly variable —
  budget for the tail, not the median.
