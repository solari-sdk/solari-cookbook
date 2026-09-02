# dlq-sandboxed-replay

A pre-flight check for [DLQ Inspector](https://github.com/HalxDocs/dlqctl)'s
replay/recovery workflow, built on [Solari](https://getsolari.com) sandboxes.

## The problem

DLQ Inspector already classifies dead-lettered messages before touching
production — `REPLAYABLE`, `REQUIRES_FIX`, `DO_NOT_REPLAY`, `INVESTIGATE` — but
that classification is a guess based on metadata (error type, retry count,
schema checks). It never actually finds out whether replaying the message
would work. For a payment webhook, guessing wrong means either a wasted
replay attempt or — worse — a duplicate side effect on a real transaction.

## What this does

Instead of guessing, it runs the exact consumer handler against the exact
payload that dead-lettered, inside an isolated Solari sandbox — a
hardware-isolated microVM that boots from a snapshot in about a second. The
handler executes untouched and untrusted, with no access to the operator's
machine or the production environment. The result (exit code, stdout,
stderr) becomes a concrete, evidence-based decision instead of a heuristic
one.

```
$ export SOLARI_API_KEY=slr_live_...
$ go run . -payload testdata/payload.json -handler testdata/handler.py
{
  "message_id": "msg_9f2c1a7b",
  "sandbox_id": "sbx_...",
  "exit_code": 1,
  "stderr": "handler failed: AttributeError: 'NoneType' object has no attribute 'split'\n",
  "decision": "REQUIRES_FIX",
  "reason": "handler reproduced a failure deterministically; replaying against production would fail the same way"
}
```

The bundled example is a real bug shape: a payment webhook dead-lettered
because a customer record had a `null` `plan_id`, and the handler assumed it
was always set. Run it against the unpatched handler and it reproduces the
original crash — telling you, before you touch the live queue, that a blind
replay would fail again. Patch the handler (or the payload) and it reports
`REPLAYABLE`.

## How it fits DLQ Inspector

This is designed to slot into DLQ Inspector's Recovery Engine as the
`Executor`'s pre-check step:

```
Inspect -> Analyze -> Classify -> Plan -> Validate -> [Sandboxed Dry-Run] -> Recover -> Audit
```

The JSON report's `decision` field uses DLQ Inspector's own classifier
vocabulary, so `dlqctl`'s Planner can consume it directly instead of
re-implementing a heuristic.

## Solari usage

- `client.Create(ctx, solari.CreateOptions{Template: "base"})` — one
  microVM per replay attempt, so failures (including a handler that hangs
  or misbehaves) never affect the operator's own environment.
- `sb.Files.Write` — pushes the handler source and the dead-lettered
  payload into the sandbox as-is; nothing about the handler is trusted or
  parsed ahead of time.
- `sb.Commands.Run` — executes the handler and captures exit code,
  stdout, and stderr for the decision.
- `sb.Kill` — always torn down via `defer`, whether the run succeeded,
  failed, or the request timed out.
- Typed errors (`*solari.AuthError`, `*solari.ConcurrencyLimitError`,
  `*solari.NoCapacityError`) are matched explicitly so a caller — or
  `dlqctl` itself — knows whether a failure is worth retrying.

## Run it

```
git clone https://github.com/solari-sdk/solari-cookbook.git
cd solari-cookbook/examples/dlq-sandboxed-replay-go
export SOLARI_API_KEY=slr_live_...
go run . -payload testdata/payload.json -handler testdata/handler.py
```

Requires Go 1.23+. No other setup — the handler and payload are plain
files, the sandbox provisions Python at runtime.

`solari-sandbox-go` is vendored under `internal/vendor/` (MIT license
included) so the example matches the cookbook's own promise — clone and
run in under a minute, no external module resolution required. Once the
SDK has a tagged release on a public proxy, swap the `replace` directive
in `go.mod` for a normal versioned `require`.

## Author

Built by [Kamsy (HalxDocs)](https://halxdocs.com) — backend engineer working
in Go and TypeScript, and the author of DLQ Inspector, the CLI this example
extends.
