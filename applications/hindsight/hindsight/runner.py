"""The seam between the agent and whatever actually holds the state."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str


class Runner(Protocol):
    """A backend that can checkpoint and restore an environment.

    Keeping this a Protocol is what lets the interesting logic be tested with
    no API key and no spend, and what lets the Solari adapter choose between
    in-place revert and fork-from-snapshot without the agent noticing.
    """

    async def checkpoint(self, label: str) -> str: ...

    async def restore(self, snapshot_id: str) -> None: ...

    async def exec(self, command: str) -> ExecResult: ...
