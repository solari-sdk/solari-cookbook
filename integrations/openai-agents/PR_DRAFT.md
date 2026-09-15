# Draft PR to `openai/openai-agents-python`

> Status: DRAFT for internal review — not yet opened. Presupposes porting the working
> provider from `solari-sdk/solari-cookbook` into the SDK's `agents/extensions/sandbox/solari/`
> layout (mechanical), which the checklist tracks.

## Title
`feat(sandbox): add Solari as a hosted sandbox provider`

## Description

### Summary
Adds **Solari** as a hosted sandbox provider for the Agents SDK sandbox harness, alongside
Blaxel/Cloudflare/Daytona/E2B/Modal/Runloop/Vercel. A `SolariSandboxClient` lets a
`SandboxAgent` run model-directed work inside a **Solari Cloud-Hypervisor microVM** — full
shell, filesystem, exposed ports, and resumable state.

```python
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig
from agents.extensions.sandbox.solari import SolariSandboxClient, SolariSandboxClientOptions

result = await Runner.run(
    agent,
    "Write fib.py, run it, show the output.",
    run_config=RunConfig(
        sandbox=SandboxRunConfig(
            client=SolariSandboxClient(),  # reads SOLARI_API_KEY
            options=SolariSandboxClientOptions(mem_mb=2048, pause_on_exit=True),
        ),
    ),
)
```

Install: `pip install "openai-agents[solari]"`.

### Motivation
Solari runs a stateless gateway → per-host **Cloud-Hypervisor microVMs restored from a
golden snapshot (~0.8s), kept warm**. That maps cleanly onto the sandbox harness's compute
plane and brings a **microVM-isolation** option (stronger isolation than a container,
without a cold-start penalty). Its snapshot mechanism gives a first-class implementation of
the `resume()` contract (below).

### What this adds
- `agents/extensions/sandbox/solari/` — `SolariSandboxClient(BaseSandboxClient)`,
  `SolariSandboxSession(BaseSandboxSession)`, `SolariSandboxSessionState`, options. Built on
  Solari's `solari-sandbox` Python SDK; the SDK import is lazy so the module registers
  without the extra installed.
- `solari` optional-dependency extra in `pyproject.toml`.
- Docs: a provider entry + a short guide page, mirroring the E2B/Blaxel pages.

### Interface conformance
| SDK contract | Solari |
|---|---|
| `create(snapshot, manifest, options)` | `SandboxClient.create(...)` → microVM restore → `connect()` |
| `SandboxSession.exec` | `commands.run("sh", ["-lc", …])` (control-WS `cmd.run`) |
| `read` / `write` | `files.read` / `files.write` |
| `resolve_exposed_port` | `preview_url(port)` |
| `persist_workspace` / `hydrate_workspace` | tar over `exec` + `files` (SDK convention) |
| **`resume(state)`** | **`connect(id)` + `resume()`** — full guest memory + device-state snapshot |
| `serialize/deserialize_session_state` | JSON of `{sandbox_id, base_url, template, cpu, mem_mb, …}` |
| `delete` | `pause()` (snapshot) when `pause_on_exit`, else `kill()` |
| PTY | `pty.create` / `pty.input` / `pty.kill` — interactive terminal, on by default |

**Resumable state (the differentiator):** Solari snapshots the microVM's full guest memory
and device state, so `resume()` reattaches to the same backend microVM with its exact
machine state — not a reconstructed workspace tar. Snapshots are self-describing and stored
durably, so a session can be recovered onto a different host when its original host is gone,
subject to a compatibility check against the host's base image and boot topology.

### Testing
- Unit/mock: session-state JSON round-trip through the SDK's serialize/deserialize path;
  exec / health-check / exposed-port mapping; PTY plumbing.
- Import/interface: verified against `openai-agents==0.22.2` — both classes have zero
  unimplemented abstract methods.
- **Live end-to-end**: a `SandboxAgent` (`gpt-5.6-sol`) created and ran a program on a real
  Solari microVM. A gated live conformance suite covers create/exec/files,
  `persist_workspace`+`hydrate_workspace`, exposed-port resolution, and a full
  pause→serialize→resume round-trip that preserved workspace state. Reference example and
  tests: `solari-sdk/solari-cookbook` → `integrations/openai-agents`.

### Checklist
- [x] `BaseSandboxClient` / `BaseSandboxSession` fully implemented
- [x] `solari` extra added
- [x] Unit/mock tests + gated live conformance test
- [x] PTY implemented + live-verified (interactive bash; `enable_pty` defaults True)
- [ ] Port module into `agents/extensions/sandbox/solari/` (currently in the cookbook)
- [ ] Docs page reviewed
- [ ] Solari maintainer listed as CODEOWNER for `extensions/sandbox/solari/`

> **PTY note:** interactive PTY is implemented, on by default, and live-verified (start
> `bash`, write stdin, read output). It passes `cmd` + argv to the guest `pty.create` over
> the control channel. Two minor, non-blocking guest-env notes: `HOME`/`USER`/`SHELL` are
> unset in the guest, and a bad cwd surfaces as a misleading exec error — both tracked in
> the Solari guest agent, neither affects this provider.
