# Hindsight

**An undo button for coding agents — and a measurement of whether they press it.**

Agent loops are forward-only. When an agent installs a broken dependency or
deletes the wrong thing, it cannot go back; it can only attempt repair, which
usually compounds the damage. Solari sandboxes can `snapshot()` and `revert()`,
so this gives the model two extra tools — `checkpoint` and `rewind` — and lets it
decide when to use them. A rewind restores the environment but keeps the memory
of what failed.

Then it measures whether that helps.

> Across 22 live agent runs, in 10 of which the model had `rewind` available,
> it used it **zero** times.

```bash
# See the evidence with no credentials at all:
cat applications/hindsight/proof/env-repair.jsonl
```

## The finding

Claude Opus 5, given a genuinely destructive environment, consistently finds the
non-destructive path instead of recovering from a mistake. Across three task
designs it:

- decoded "opaque" base64 payloads rather than running them blind
- copied the state to `/root` before touching it
- built a simulation harness in `/tmp/sim` and tried every option on the copy
- and, when a task offered three risky vendor fixers, diagnosed the fault and
  repaired it directly without running any of them

Every attempt to force a rewind was defeated by the model being more careful
than the scenario assumed. That is good engineering by the agent, and it is the
most useful thing this project found.

**The honest limitation, which matters more than the result:** every arm solved
every benchmark run, 18 for 18. Rewind can only help an agent that has already
failed, and no task here made Opus 5 fail. So this does *not* show that rewind
fails to help agents. It shows that a frontier model routes around needing it,
and that these tasks were too easy to test the mechanism.

## Measured

Three arms on `env-repair`, where damage spans installed Python packages *and*
`/etc`, so no single `cp` covers it. n=3 per arm, Claude Opus 5, verified by us
rather than by the agent's own report.

| arm | tools | solved | turns | tool calls | median cost | spread | rewinds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `none` | `run` | 3/3 | 11.0 | 17.0 | $0.482 | 0.399–0.938 | 0 |
| `rebuild` | `run`, `reset` | 3/3 | 11.0 | 15.0 | $0.350 | 0.314–0.742 | 0 |
| `hindsight` | `run`, `checkpoint`, `rewind` | 3/3 | 11.0 | 16.0 | $0.413 | 0.321–0.422 | 0 |

At n=3 those spreads overlap heavily and the medians on turns are identical.
The honest reading is that **no arm outperformed another**, not that any won.

Raw results: [`proof/env-repair.jsonl`](proof/env-repair.jsonl) — one JSON object
per run, so every number above can be recomputed without this code.

An earlier sweep on the second task was discarded rather than published: all
three arms shared one system prompt that named `checkpoint` and `rewind`, so the
arms without those tools were graded on instructions they could not follow. The
fix is arm-specific prompts, enforced by a test.

## Platform findings

Measured against the live gateway on 2026-09-08, free tier, `base` template.

| operation | result |
| --- | --- |
| cold create | ~2.2s |
| `snapshot()` | ~10.7s |
| `revert()` — min / **median** / max (n=8) | 9.5s / **23.4s** / 58.9s |
| rebuild (create 2.2s + real setup 6.5s) | **8.7s** |

**Rebuild beats rewind by ~2.7× at the median** for a light environment, and
revert's tail is 6.7× worse than its best case. Breakeven is roughly **21s of
setup**: below that, rebuild; above it, rewind starts paying.

**In-place `revert()` works, and restores correctly.** Verified by installing a
package, writing a file, destroying both, reverting, and confirming both
returned. This contradicts
[`applications/worldline`](../worldline)'s `DESIGN.md`, which records that on
2026-09-01 an immediate revert returned `Not revertable`. We could not reproduce
that failure a week later on the Sandbox client. Worldline's own revert path
targets the Desktop client, which its notes say was never live-verified, so this
may be a client difference rather than a gateway change — we did not establish
which.

## Run

```bash
cd applications/hindsight
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # then fill in both keys
```

On Windows PowerShell, activate with `.venv\Scripts\Activate.ps1`; the rest is
the same.

```bash
python -m hindsight run "create /tmp/hello.txt and verify it"   # one free-form task
python -m hindsight task env-repair                             # one benchmark task
python -m hindsight bench --task env-repair --n 3               # the full sweep
```

`bench` takes `--budget` (default $6) and stops early rather than overrunning it.
A sweep of 9 runs cost $4.38 in Claude Opus 5 tokens and a few cents of Solari.

This uses real sandboxes and real model calls; normal charges apply.

## Test

```bash
python -m unittest discover -s tests -v
```

50 tests, no network and no credentials required — the agent loop is driven by
canned responses and the sandbox by an in-memory fake.

## Evidence contract

- Every run records arm, task, whether it solved, turns, tool calls, tokens,
  cost, rewinds, and wall-clock.
- Success is checked by running the task's own verifier, never by asking the
  agent whether it succeeded.
- Results carry no session ids, no snapshot ids, and no credentials; a test
  asserts that.
- Cleanup deletes both the sandbox and every snapshot it created — snapshots
  outlive the VM that made them and bill until removed. Verified zero live
  sandboxes and zero snapshots after every sweep.

## Limits

- **Not a speed claim.** Rewind is slower than rebuild for light environments.
- **The mechanism is untested, not disproven.** No task induced a failure, so
  nothing here measures recovery.
- **n=3 per arm.** Enough to see that the arms overlap, not enough for a
  confident ranking.
- **One model.** Everything is Claude Opus 5 at `xhigh` effort.
- **Not parallel exploration.** [`worldline`](../worldline) already branches
  competing plans and picks a winner, and has no LLM in it by design. Hindsight
  is one agent that goes back and carries what it learned.

Architecture and design decisions: [`docs/architecture.md`](docs/architecture.md).

Built with Claude Code.
