# Rewind — an agent that can undo

Working project doc for the Pinetree Research / Solari intern application.

**Status:** design proposed, not yet approved. Spike complete. No code written.

---

## 1. The brief

From the hiring post (Pinetree Research, $300K annualized SWE intern):

1. Fork `solari-sdk/solari-cookbook`
2. **Build a real use case with Solari** (browsers, sandboxes, and/or desktops)
3. Publish on a public GitHub account
4. Post it on LinkedIn or X, tagging `@harrychow_` and `@getsolari`

Review process: they review every build that tags them, schedule interviews for
ones they like, and hire on the spot for the right fit. Using AI to build it is
explicitly encouraged.

Selection reality: many submissions, each reviewed in minutes. The scarce
resource is **how fast a reviewer recognises that this matters**.

---

## 2. What we're building

**A coding agent that can rewind its own environment.**

Every agent loop shipping today is forward-only. When an agent installs a broken
dependency, deletes the wrong file, or corrupts its environment, it cannot undo.
It can only attempt repair — and repair usually compounds the damage. The
industry workaround is to tear the environment down and rebuild from scratch,
which costs a full sandbox lifecycle (8.2s on Solari's own published figure) plus
however long the real setup takes — an `npm install` and build is minutes.

That cost is *why* agents don't backtrack. It isn't a modelling limitation; it's
an infrastructure one.

Solari's `snapshot()` / `revert()` collapses that cost, and **the cookbook has no
example of it**. All nine existing examples ignore the most powerful capability
in the SDK.

### The core design decision

`rewind()` restores the VM but **keeps the agent's memory of the failure**.

This is the thesis and the interesting engineering. A naive implementation
rewinds VM state and leaves the model holding 40 messages describing a branch
that no longer exists — the agent gets confused, or repeats the mistake it just
undid. So a checkpoint must track both VM state *and* conversation position, and
a rewind restores the world while injecting a synthetic note:

> You rewound to checkpoint `dep-install-clean`. The branch you abandoned failed
> because `lxml==4.9.0` requires libxml2 headers that aren't in this image.

The agent loses the damage and keeps the lesson. Two trees — the snapshot tree
and the message-history tree — kept deliberately out of sync, on purpose.

### Tools exposed to the model

```
checkpoint(label)  -> checkpoint_id     save a known-good state
rewind(id, reason) -> None              restore the world, keep the lesson
```

The LLM decides when to call them. That makes this an agent *architecture*, not
an SDK wrapper.

---

## 3. Verified API surface

Everything here was read from the **shipped packages**, not the docs.
Verified against `@solarisdk/core@0.1.3` and `solari-core` / `solari-sandbox@0.2.1`.

### The primitives

```
sandbox.snapshot(name?) -> snapshot_id     POST /sandboxes/:id/snapshots
sandbox.revert(snapshot_id)                POST /sandboxes/:id/revert
sandbox.pause() / sandbox.resume()         POST /sandboxes/:id/pause|resume
client.create(from_snapshot="snap_...")    boot a NEW sandbox from a snapshot
```

Snapshot admin: `list_snapshots`, `get_snapshot`, `delete_snapshot`,
`promote_snapshot(id, name)` -> reusable `tpl_...` template.

Python and TypeScript have full parity. Python additionally ships
`SyncSandboxClient` for a synchronous API.

### The four findings that make this work

**1. State includes RAM, not just disk.** `pause()` is documented in-source as
"snapshot RAM+disk, free the slot." Running processes are in scope.

**2. `snapshot()` is non-disruptive.** Verbatim: *"Checkpoint this RUNNING
session; it keeps running."* You checkpoint without pausing the agent.

**3. `revert()` restores in place — the sandbox id stays stable.** Verbatim:
*"Restore this session in place from a snapshot (id stays stable)."* It does
**not** allocate a second sandbox. Two consequences:

- the whole project fits inside **one** concurrent sandbox, so the free tier is enough
- the control channel and tool wiring survive a rewind, so `rewind()` is a
  genuinely small implementation rather than a teardown-and-rewire dance

**4. Snapshots form a tree natively.** `SnapshotView.parent: str | None`. Solari
already models branch lineage, so the exploration tree comes for free.

### Useful supporting surface

- **First-class git in the guest**: `clone`, `status`, `add`, `commit`, `push`,
  `pull`, `checkout`, `branches`, `log` — typed, no shelling out. A coding agent
  is clearly the intended workload.
- `metrics()` — live resource stats; the measurement layer for free.
- `files.watch()`, `run_code()` + `create_code_context()`, `preview_url()`,
  signed upload/download URLs.
- Create knobs: `cpu`, `mem_mb`, `disk_gb`, `envs`, `metadata`, `timeout_ms`,
  `lifecycle={"onTimeout": "pause", "autoResume": True}`.

### Traps — verified, avoid these

- **Volumes are not safe to build on.** The TS source states the gateway volume
  routes "may be a 501 stub today." Nothing load-bearing on volumes.
- `delete_snapshot` is **refused if the snapshot has live children** — matters
  when pruning a branch tree.
- `snapshot()` / `revert()` raise `RuntimeError("snapshot requires a
  client-created handle")` on a hand-constructed handle.
- Commands are **not shell-interpreted** — argv goes in `args`, or run `sh -c`.
- `kill()` destroys the VM; `close()` only drops the local channel.
- `timeout_ms` is a **rolling idle window**, not a hard deadline.

---

## 4. Why the free tier is enough

| Plan | Price | Credits/mo | Sandbox concurrency | Max session |
|---|---|---|---|---|
| **Free** | $0 | $3 | **1** | 1 hour |
| Starter | $20/mo | $20 | 2 | — |
| Professional | $200/mo | $200 | 10 | — |

Sandbox rate: **$0.0525 / vCPU-hour** + **$0.0165 / GB-hour**.

A 1 vCPU / 2 GB sandbox costs `0.0525 + (2 x 0.0165)` = **$0.0855/hour**, so the
free tier's $3 buys roughly **35 sandbox-hours per month**. That is far more than
this project needs.

The 1-sandbox concurrency cap does not bind, because `revert()` is in-place.
Parallel branching via `from_snapshot` would need more slots — that becomes the
"how this scales" section of the writeup rather than a dependency.

**Live constraint to design around:** the free tier caps a session at 1 hour. An
agent run must finish inside that, or use `pause()`/`resume()` to extend.
Whether pause/resume resets the ceiling is **unverified**.

### Getting a key

1. Sign in at **console.getsolari.com**
2. Open the **API Keys** tab and create a key
3. Copy it immediately — the console shows it exactly once
4. Format is `slr_live_...`; export as `SOLARI_API_KEY`

Anyone holding the key can run sessions and read every profile on the account.
Rotate from the console if it leaks. Keep it out of commits — the repo's
`.gitignore` already covers `.env`.

---

## 5. Proposed architecture

Python (matches primary stack; `solari-sandbox` ships a sync client).

```
rewind/
  session.py      RewindSandbox - wraps Solari Sandbox, owns the checkpoint tree
  tree.py         checkpoint tree: id, parent, label, transcript offset, timing
  tools.py        checkpoint/rewind as LLM tool definitions
  agent.py        the loop: model -> tool call -> execute -> observe
  metrics.py      timing + cost accounting per run
bench/
  tasks/          task set where forward-only agents fail
  run.py          A/B harness: rewind on vs off
```

**`RewindSandbox`** is the only component touching Solari. It holds one sandbox,
maps checkpoint ids to `snap_...` ids, and records the transcript offset at each
checkpoint so a rewind knows how much conversation the failed branch spans.

**Boundary discipline:** the agent loop never sees a Solari type. It sees
`checkpoint()` and `rewind()`. That keeps the interesting part testable without
an API key, and makes the library reusable against any snapshot-capable backend.

### Benchmark

Tasks are chosen so that a wrong turn is genuinely unrecoverable — otherwise
rewind proves nothing:

- **Dependency resolution** — find the version combination that makes the suite
  pass, where a bad install poisons the environment for later attempts
- **Destructive migration** — run a schema migration, verify, rewind if wrong
- **Risky refactor** — attempt it, run tests, rewind if the result is worse
- **Genuine mistake recovery** — agent deletes something it needed, recovers

Measured, rewind on vs. off: task success rate, wall-clock, tokens, dollar cost.

Plus the foundational number the argument rests on:
**`revert()` latency vs. full environment rebuild.**

---

## 6. Deliverables

1. `rewind/` — the library, one-line to adopt
2. `bench/` — task suite, A/B harness, results committed as raw data
3. README with the **finding in the first screen**, not the architecture
4. **Upstream PR to `solari-cookbook`**: `examples/sandbox-checkpoint-rewind-py/`
   — the snapshot/revert example the cookbook is missing, written in house style
   with the footguns commented where they bite
5. The post — leads with the finding, one sharp technical detail in the thread

---

## 7. Open questions

Needs a key to resolve. None of them change the architecture.

- **Real `revert()` latency.** The headline number. Changes the framing from
  "200ms rewind vs. 45s rebuild" to something more modest, but not the design.
- Do live processes actually survive a revert? RAM+disk implies yes; confirm.
- Does the control channel need an explicit `reconnect()` after revert?
- Free-tier snapshot storage limits and retention.
- Does `pause()`/`resume()` extend past the 1-hour session ceiling?

---

## 8. Why this one

- **Uses the primitive with zero example code.** Nobody else's submission will
  touch `snapshot`/`revert`, because nobody reading the cookbook knows it exists.
- **Targets Solari's actual customers.** AI coding agents are who they sell to;
  the built-in guest git API shows they know it.
- **Makes their infrastructure the reason the agent works.** The finding is a
  capability unlock attributable to Solari, not a benchmark of Solari.
- **The upstream PR is nearly certain to land** — it fills a real gap in the
  repo, in the format the contributing section explicitly asks for.
- **Runs on the free tier**, so there's no dependency on anyone's goodwill.
