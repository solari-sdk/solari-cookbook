"""The Solari adapter — the only module in Hindsight that talks to the SDK."""

from __future__ import annotations

import asyncio
from typing import Any

from hindsight.runner import ExecResult

BASE_URL = "https://api.getsolari.com"


class SolariRunner:
    """Runs the agent's environment in one Solari sandbox.

    Restores in place with `revert()`, which keeps the sandbox id stable and so
    needs no second concurrency slot — the free plan allows exactly one.
    """

    def __init__(
        self,
        *,
        client: Any,
        template: str = "base",
        timeout_ms: int = 10 * 60_000,
        settle_seconds: float = 1.0,
    ) -> None:
        self._client = client
        self._template = template
        self._timeout_ms = timeout_ms
        self._settle_seconds = settle_seconds
        self._sandbox: Any | None = None
        self.last_strategy: str | None = None
        self.last_fallback_reason: str | None = None
        self._snapshots: list[str] = []

    @property
    def sandbox_id(self) -> str:
        return self._require().sandboxId

    def _require(self) -> Any:
        if self._sandbox is None:
            raise RuntimeError("runner was not started")
        return self._sandbox

    async def start(self) -> None:
        self._sandbox = await self._client.create(
            template=self._template, timeout_ms=self._timeout_ms
        )
        await self._sandbox.connect()

    async def checkpoint(self, label: str) -> str:
        snapshot_id = await self._require().snapshot(label)
        self._snapshots.append(snapshot_id)
        return snapshot_id

    async def exec(self, command: str) -> ExecResult:
        """Run a shell line in the guest.

        `commands.run` takes argv, not a shell string — `run("a && b")` looks
        for a binary named `a && b`. Everything goes through `sh -c`.
        """
        result = await self._require().commands.run("sh", args=["-c", command])
        return ExecResult(
            exit_code=result.exitCode,
            stdout=result.stdout,
            stderr=result.stderr,
        )

    async def restore(self, snapshot_id: str) -> None:
        sandbox = self._require()
        try:
            await sandbox.revert(snapshot_id)
        except Exception as exc:  # noqa: BLE001 - any refusal falls back to fork
            # Worldline recorded `Not revertable` from this gateway on
            # 2026-09-01. Our probes on 2026-09-08 reverted cleanly, so the
            # behavior moves; forking always works, so never depend on revert.
            self.last_fallback_reason = f"{type(exc).__name__}: {exc}"
            await self._fork_from(snapshot_id)
            return
        # Reverting RAM puts the control channel back to its checkpoint-era
        # state; it has to be re-established before the next call lands.
        await asyncio.sleep(self._settle_seconds)
        await sandbox.reconnect()
        self.last_strategy = "revert"

    async def _fork_from(self, snapshot_id: str) -> None:
        """Replace the sandbox with a fresh one booted from the snapshot.

        Costs a full create, and the sandbox id changes — but the free plan
        allows one concurrent VM, so the old one must die before the new one
        is asked for.
        """
        old = self._require()
        await self._client.kill(old.sandboxId)
        await old.close()
        self._sandbox = await self._client.create(
            template=self._template,
            from_snapshot=snapshot_id,
            timeout_ms=self._timeout_ms,
        )
        await self._sandbox.connect()
        self.last_strategy = "fork"

    async def cleanup(self) -> list[str]:
        """Best-effort teardown. Returns what went wrong rather than raising.

        Snapshots survive the VM that made them, so a run that kills only the
        sandbox keeps billing for storage until someone notices.
        """
        errors: list[str] = []
        for snapshot_id in self._snapshots:
            try:
                await self._client.delete_snapshot(snapshot_id)
            except Exception as exc:  # noqa: BLE001 - cleanup stays best-effort
                errors.append(f"delete_snapshot {snapshot_id}: {type(exc).__name__}: {exc}")
        self._snapshots.clear()

        if self._sandbox is not None:
            try:
                await self._client.kill(self._sandbox.sandboxId)
                await self._sandbox.close()
            except Exception as exc:  # noqa: BLE001 - cleanup stays best-effort
                errors.append(f"kill: {type(exc).__name__}: {exc}")
            self._sandbox = None
        return errors
