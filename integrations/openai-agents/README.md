# Solari sandbox provider for the OpenAI Agents SDK

Run an OpenAI Agents SDK **`SandboxAgent`** inside a **Solari Cloud-Hypervisor microVM** —
model-directed work (shell, filesystem, exposed ports, resumable state) executes on
Solari infrastructure instead of a local/Docker sandbox.

This implements the Agents SDK's `BaseSandboxClient` / `BaseSandboxSession` contract
(the same interface the officially integrated providers — Blaxel, Cloudflare, Daytona,
E2B, Modal, Runloop, Vercel — implement) on top of the `solari-sandbox` Python SDK.

## Install

```bash
pip install "openai-agents"      # Agents SDK (>=0.22, ships the sandbox harness)
pip install solari-sandbox       # Solari Python SDK
pip install -e .                 # this provider
export OPENAI_API_KEY="sk-..."
export SOLARI_API_KEY="slr_live_..."
```

## Use

```python
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig
from solari_agents_sandbox import SolariSandboxClient, SolariSandboxClientOptions

agent = SandboxAgent(
    name="Sandbox engineer",
    model="gpt-5.6-sol",
    instructions="Work in the sandbox; verify with a command and report what you ran.",
)

result = await Runner.run(
    agent,
    "Write fib.py, run it, show the output.",
    run_config=RunConfig(
        sandbox=SandboxRunConfig(
            client=SolariSandboxClient(),                      # reads SOLARI_API_KEY
            options=SolariSandboxClientOptions(mem_mb=2048, pause_on_exit=True),
        ),
    ),
)
print(result.final_output)
```

A runnable version is in [`examples/coding_agent.py`](examples/coding_agent.py).

## How it maps

| Agents SDK contract | Solari (`solari-sandbox` / gateway) |
|---|---|
| `create(snapshot, manifest, options)` | `SandboxClient.create(template, cpu, mem_mb, …)` + microVM restore (~0.8s) → `connect()` |
| `SandboxSession.exec(*cmd)` | `commands.run("sh", ["-lc", …])` (control-WS `cmd.run`) |
| `read` / `write` | `files.read` / `files.write` (`fs.read` / `fs.write`) |
| `resolve_exposed_port(port)` | `preview_url(port)` (Solari port-preview) |
| `persist_workspace` / `hydrate_workspace` | tar over `exec` + `files` (SDK snapshot convention) |
| **`resume(state)` — reattach, else hydrate** | **`connect(id)` + `resume()` — see below** |
| `serialize/deserialize_session_state` | JSON of `{sandbox_id, base_url, template, cpu, mem_mb, …}` |
| `delete(session)` | `pause()` (snapshot) when `pause_on_exit`, else `kill()` |
| PTY (`pty_exec_start` / `pty_write_stdin`) | `pty.create` / `pty.input` / `pty.kill` — implemented, opt-in (see PTY below) |

### Resumable state
Solari snapshots the microVM's **full guest memory and device state**, so `resume()`
reattaches to the same backend microVM with its **exact machine state** — not a
reconstructed workspace tar. Snapshots are self-describing and stored durably, so a
session can be recovered onto a **different host** when its original host is gone,
subject to a compatibility check against the host's base image and boot topology.
(`pause_on_exit=True` uses this snapshot/hibernate path; it is distinct from Solari's
same-host warm-park, which the Agents SDK does not expose.)

### PTY
The full PTY contract is implemented, but `SolariSandboxClientOptions.enable_pty`
defaults to **False**: on the currently deployed guest golden, `pty.create` cannot exec
binaries in the guest rootfs (an absolute path that `commands.run` resolves still
ENOENTs) — a guest-agent defect tracked separately. The Shell capability (which the
SandboxAgent uses by default) runs over `exec`, not PTY, so this does not affect normal
coding-agent use. Set `enable_pty=True` on a golden where the guest PTY exec is fixed.

## Status (validated)
- ✅ Implements every abstract method of `BaseSandboxClient` / `BaseSandboxSession`
  (verified against `openai-agents==0.22.2`: zero unimplemented abstract methods).
- ✅ Session-state JSON round-trips through the SDK's serialize/deserialize path.
- ✅ Unit/mock tests: exec / health-check / port-preview mapping + PTY plumbing
  (`tests/test_session_mock.py`).
- ✅ **Live conformance** (`tests/test_conformance_live.py`, gated on `SOLARI_API_KEY`):
  create/start, exec, file write+read, `persist_workspace`+`hydrate_workspace`,
  exposed-port resolution, and — with `SOLARI_TEST_RESUME=1` — a full
  pause→serialize→resume round-trip that preserved workspace state. Also verified
  end-to-end: a `SandboxAgent` (`gpt-5.6-sol`) wrote and ran a program on a live Solari
  microVM.
- ⏳ PTY runtime-enabled once the guest-agent pty exec is fixed (plumbing done, gated).

## Path to becoming an officially integrated provider
OpenAI's April 2026 Agents SDK ships hosted providers as optional extras under
`agents.extensions.sandbox.<provider>` (`pip install openai-agents[<provider>]`). To make
Solari official (the 8th provider):

1. Land this client in `agents/extensions/sandbox/solari/` upstream (PR to
   `openai/openai-agents-python`), matching the Blaxel/E2B module shape.
2. Add the `solari` optional-dependency extra + docs provider-list entry.
3. Enable PTY once the guest fix lands; keep the conformance test in the SDK suite.
4. Engage OpenAI's partnerships for listing + the vetting applied to the existing seven.

This repo is the working, live-tested reference for steps 1–3. See [`PR_DRAFT.md`](PR_DRAFT.md).
