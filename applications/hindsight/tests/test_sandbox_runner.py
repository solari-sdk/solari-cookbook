"""SolariRunner restore strategy: in-place revert, with a fork fallback.

The stubs below stand in for the Solari client. Their behavior mirrors what the
live gateway actually did in the Phase 0 probes: revert restores in place and
needs a reconnect afterwards, and a refusing gateway raises with "Not revertable".
"""

from __future__ import annotations

import asyncio
import unittest

from hindsight.sandbox import SolariRunner


class _StubCommands:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []

    async def run(self, cmd: str, args: list[str] | None = None):
        self.calls.append((cmd, args or []))
        return _StubResult()


class _StubResult:
    exitCode = 0
    stdout = "ok"
    stderr = ""


class StubSandbox:
    def __init__(self, sandbox_id: str, *, revert_error: str | None = None) -> None:
        self.sandboxId = sandbox_id
        self._revert_error = revert_error
        self.reverted: list[str] = []
        self.reconnects = 0
        self._snaps = 0
        self.commands = _StubCommands()
        self.closed = False

    async def connect(self) -> None:
        return None

    async def reconnect(self) -> None:
        self.reconnects += 1

    async def snapshot(self, label: str) -> str:
        self._snaps += 1
        return f"snap_{self.sandboxId}_{self._snaps}"

    async def revert(self, snapshot_id: str) -> None:
        if self._revert_error is not None:
            raise RuntimeError(self._revert_error)
        self.reverted.append(snapshot_id)

    async def close(self) -> None:
        self.closed = True


class StubClient:
    def __init__(self, *, revert_error: str | None = None) -> None:
        self._revert_error = revert_error
        self.created: list[dict] = []
        self.killed: list[str] = []
        self.deleted_snapshots: list[str] = []
        self._n = 0

    async def create(self, **kwargs) -> StubSandbox:
        self._n += 1
        self.created.append(kwargs)
        return StubSandbox(f"vm_{self._n}", revert_error=self._revert_error)

    async def kill(self, sandbox_id: str) -> None:
        self.killed.append(sandbox_id)

    async def delete_snapshot(self, snapshot_id: str) -> None:
        self.deleted_snapshots.append(snapshot_id)


class RestoreStrategyTests(unittest.TestCase):
    def test_in_place_revert_keeps_the_same_sandbox(self) -> None:
        async def scenario() -> tuple[SolariRunner, StubClient, str]:
            client = StubClient()
            runner = SolariRunner(client=client, settle_seconds=0)
            await runner.start()
            before = runner.sandbox_id

            await runner.restore("snap_a")
            return runner, client, before

        runner, client, before = asyncio.run(scenario())

        self.assertEqual(runner.sandbox_id, before)
        self.assertEqual(client.killed, [])
        self.assertEqual(runner.last_strategy, "revert")

    def test_falls_back_to_a_fork_when_the_gateway_refuses_revert(self) -> None:
        async def scenario() -> tuple[SolariRunner, StubClient, str]:
            client = StubClient(revert_error="Not revertable")
            runner = SolariRunner(client=client, settle_seconds=0)
            await runner.start()
            before = runner.sandbox_id

            await runner.restore("snap_a")
            return runner, client, before

        runner, client, before = asyncio.run(scenario())

        self.assertNotEqual(runner.sandbox_id, before)
        self.assertEqual(client.killed, [before])
        self.assertEqual(runner.last_strategy, "fork")
        self.assertEqual(client.created[-1]["from_snapshot"], "snap_a")


class CleanupTests(unittest.TestCase):
    def test_cleanup_deletes_every_snapshot_it_made_and_kills_the_vm(self) -> None:
        async def scenario() -> tuple[StubClient, str]:
            client = StubClient()
            runner = SolariRunner(client=client, settle_seconds=0)
            await runner.start()
            vm = runner.sandbox_id
            await runner.checkpoint("one")
            await runner.checkpoint("two")

            await runner.cleanup()
            return client, vm

        client, vm = asyncio.run(scenario())

        # Snapshots outlive the VM that made them, so both have to go.
        self.assertEqual(client.killed, [vm])
        self.assertEqual(len(client.deleted_snapshots), 2)


class ExecTests(unittest.TestCase):
    def test_exec_wraps_the_command_in_a_shell(self) -> None:
        async def scenario() -> tuple[StubSandbox, object]:
            client = StubClient()
            runner = SolariRunner(client=client, settle_seconds=0)
            await runner.start()
            result = await runner.exec("echo one && echo two")
            return runner._sandbox, result

        sandbox, result = asyncio.run(scenario())

        # Solari commands are argv, not a shell line: run("echo a && echo b")
        # would look for a binary with that entire string as its name.
        self.assertEqual(
            sandbox.commands.calls, [("sh", ["-c", "echo one && echo two"])]
        )
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.stdout, "ok")


if __name__ == "__main__":
    unittest.main()
