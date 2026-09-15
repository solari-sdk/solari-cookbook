# Solari sandbox provider for the OpenAI Agents SDK

Run an OpenAI Agents SDK **`SandboxAgent`** inside a **Solari Cloud-Hypervisor microVM** —
model-directed work (shell, files, dependency installs, exposed ports, resumable state)
executes on Solari infrastructure instead of a local/Docker sandbox.

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
| `create(snapshot, manifest, options)` | `SandboxClient.create(template, cpu, mem_mb, …)` + warm restore (~0.8s) → `connect()` |
| `SandboxSession.exec(*cmd)` | `sandbox.commands.run("sh", ["-lc", …])` (control-WS `cmd.run`) |
| `read` / `write` | `sandbox.files.read` / `files.write` (`fs.read` / `fs.write`) |
| `resolve_exposed_port(port)` | `sandbox.preview_url(port)` (Solari port-preview) |
| `persist_workspace` / `hydrate_workspace` | tar over `exec` + `files` (SDK snapshot convention) |
| **`resume(state)` — reattach, else hydrate** | **`connect(id)` + `resume()`; Solari keeps the microVM paused-warm with cross-host S3 recovery** |
| `serialize/deserialize_session_state` | JSON of `{sandbox_id, base_url, template, cpu, mem_mb, …}` |
| `delete(session)` | `pause()` when `pause_on_exit`, else `kill()` |

The default capabilities (Shell + Filesystem + Compaction) are provided by the SDK;
`SolariSandboxClientOptions.pause_on_exit=True` keeps the microVM warm so a later
`Runner.run(..., session=...)` resumes the *same* backend VM.

### Differentiator: real resumable state
The SDK's `resume` contract is "reattach to the same backend sandbox; if it's gone,
hydrate a replacement from the snapshot." Solari does the first path natively —
pause/resume with **cross-host S3 recovery** — rather than only reconstructing a
workspace tar. Long-horizon agents keep their exact machine state across runs.

## Status

- ✅ Implements every abstract method of `BaseSandboxClient` / `BaseSandboxSession`
  (verified: zero unimplemented abstract methods).
- ✅ Session-state JSON round-trips through the SDK's serialize/deserialize path.
- ✅ Mock-backed tests for the exec / health-check / port-preview mapping
  (`tests/test_session_mock.py`).
- ⏳ Full end-to-end run requires `OPENAI_API_KEY` + `SOLARI_API_KEY` + network.
- ⏳ PTY (`supports_pty`) not yet implemented (optional capability).

## Path to becoming an officially integrated provider

OpenAI's April 2026 Agents SDK update ships hosted sandbox providers as optional
extras under `agents.extensions.sandbox.<provider>`, selectable via
`pip install openai-agents[<provider>]`. To make Solari official (the 8th provider):

1. Land this client in `agents/extensions/sandbox/solari/` upstream (PR to
   `openai/openai-agents-python`), matching the Blaxel/E2B module shape.
2. Add the `solari` optional-dependency extra + docs provider-list entry.
3. Add PTY support and a provider conformance/integration test.
4. Engage OpenAI's partnerships for listing + the vetting they applied to the
   existing seven.

This repo is the working reference for steps 1–3.
