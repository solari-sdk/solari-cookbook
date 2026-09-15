"""Mock-backed tests for the Solari sandbox session mapping.

These exercise the RPC mapping (exec, health check, port preview) without a
live microVM. Run with the Agents SDK + Solari SDK importable:

    PYTHONPATH=.. python -m pytest tests/ -q      # or run this file directly
"""
import asyncio
import uuid
from dataclasses import dataclass

from agents.sandbox.manifest import Manifest
from agents.sandbox.snapshot import resolve_snapshot

from solari_agents_sandbox.sandbox import SolariSandboxSession, SolariSandboxSessionState


@dataclass
class _FakeResult:
    exitCode: int
    stdout: str
    stderr: str


class _FakeCommands:
    def __init__(self):
        self.calls = []

    async def run(self, cmd, *, args=None, cwd=None, env=None, timeout_ms=None, background=False):
        self.calls.append((cmd, args, cwd, timeout_ms))
        if cmd == "true":
            return _FakeResult(0, "", "")
        return _FakeResult(0, f"ran:{cmd} {' '.join(args or [])}", "")


class _FakeSandbox:
    def __init__(self):
        self.commands = _FakeCommands()
        self.id = "sbx_fake"

    async def preview_url(self, port):
        return {"url": f"https://p-{port}.getsolari.com", "token": "tok9"}


def _session():
    sid = uuid.uuid4()
    state = SolariSandboxSessionState(
        session_id=sid,
        manifest=Manifest(root="/workspace"),
        snapshot=resolve_snapshot(None, str(sid)),
        sandbox_id="sbx_fake",
    )
    return SolariSandboxSession(state=state, sandbox=_FakeSandbox(), solari_client=None)


def test_exec_maps_to_commands_run():
    sess = _session()
    r = asyncio.run(sess.exec("echo hi", shell=True))
    assert r.exit_code == 0
    cmd, args, _, _ = sess._sandbox.commands.calls[-1]
    assert cmd == "sh" and args[0] == "-lc"


def test_running_health_check():
    assert asyncio.run(_session().running()) is True


def test_resolve_exposed_port_parses_preview():
    ep = asyncio.run(_session()._resolve_exposed_port(3000))
    assert ep.host == "p-3000.getsolari.com" and ep.tls and ep.query == "token=tok9"


if __name__ == "__main__":
    test_exec_maps_to_commands_run()
    test_running_health_check()
    test_resolve_exposed_port_parses_preview()
    print("ok")


# --- PTY plumbing (mock; proves pty_exec_start/pty_write_stdin wiring without a
#     live guest, since the deployed golden's pty.create exec is broken) --------

class _FakePty:
    """Fake Solari pty handle: replays scripted output to the on_data callback."""

    def __init__(self):
        self._cb = None
        self.written = []
        self.killed = False

    def on_data(self, cb):
        self._cb = cb

    async def write(self, data):
        self.written.append(data)
        # echo the written command back like a real terminal would
        if self._cb:
            self._cb(("out:" + data).encode())

    async def resize(self, cols, rows):
        pass

    async def kill(self):
        self.killed = True


class _FakePtyFactory:
    def __init__(self):
        self.last = None

    async def create(self, *, cols, rows, cmd=None, cwd=None, env=None):
        self.last = _FakePty()
        # emit a startup banner
        if self.last._cb is None:
            # on_data registered after create in the adapter; banner comes on first drain
            pass
        return self.last


class _FakeSandboxWithPty(_FakeSandbox):
    def __init__(self):
        super().__init__()
        self.pty = _FakePtyFactory()


def _pty_session():
    sid = uuid.uuid4()
    state = SolariSandboxSessionState(
        session_id=sid,
        manifest=Manifest(root="/workspace"),
        snapshot=resolve_snapshot(None, str(sid)),
        sandbox_id="sbx_fake",
        enable_pty=True,
    )
    return SolariSandboxSession(state=state, sandbox=_FakeSandboxWithPty(), solari_client=None)


def test_supports_pty_gated_by_option():
    # default off
    assert _session().supports_pty() is False
    # on when enabled
    assert _pty_session().supports_pty() is True


def test_pty_exec_start_and_write_roundtrip():
    # one event loop for the whole session (Events/Locks are loop-bound)
    async def run():
        sess = _pty_session()
        upd = await sess.pty_exec_start("bash", tty=True, yield_time_s=0.25)
        assert upd.process_id is not None
        upd2 = await sess.pty_write_stdin(
            session_id=upd.process_id, chars="echo hi\n", yield_time_s=0.25
        )
        assert b"out:echo hi\n" in upd2.output
        await sess.pty_terminate_all()
    asyncio.run(run())
