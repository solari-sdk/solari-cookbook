"""In-memory Runner for tests: deterministic, no network, no credentials."""

from __future__ import annotations

from hindsight.runner import ExecResult


class FakeRunner:
    def __init__(self) -> None:
        self.restored: list[str] = []
        self._count = 0
        self.commands: list[str] = []
        self.responses: dict[str, ExecResult] = {}

    async def checkpoint(self, label: str) -> str:
        self._count += 1
        return f"snap_fake_{self._count}"

    async def restore(self, snapshot_id: str) -> None:
        self.restored.append(snapshot_id)

    async def exec(self, command: str) -> ExecResult:
        self.commands.append(command)
        return self.responses.get(
            command, ExecResult(exit_code=0, stdout="", stderr="")
        )
