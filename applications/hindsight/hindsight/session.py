"""Binds a Runner, a checkpoint tree, and the transcript into one rewindable unit."""

from __future__ import annotations

from hindsight.runner import ExecResult, Runner
from hindsight.tree import Checkpoint, CheckpointTree


class Session:
    def __init__(self, *, runner: Runner, reset_command: str | None = None) -> None:
        self._runner = runner
        self._reset_command = reset_command
        self.tree = CheckpointTree()
        self.transcript: list[dict] = []
        # Bumped on every rewind. The agent loop watches this to notice
        # that history was rewritten under it mid-turn.
        self.revision = 0

    def append(self, message: dict) -> None:
        self.transcript.append(message)

    async def exec(self, command: str) -> ExecResult:
        return await self._runner.exec(command)

    async def reset(self) -> ExecResult:
        """Rebuild the workspace from scratch, keeping the whole transcript.

        This is the baseline an agent without checkpoints has to fall back on:
        the world goes back, the memory of the failed attempt does not.
        """
        if self._reset_command is None:
            raise RuntimeError("this session has no reset command")
        return await self._runner.exec(self._reset_command)

    async def checkpoint(self, label: str) -> Checkpoint:
        snapshot_id = await self._runner.checkpoint(label)
        return self.tree.add(
            snapshot_id=snapshot_id,
            label=label,
            transcript_offset=len(self.transcript),
        )

    async def rewind(self, checkpoint_id: str, *, reason: str) -> Checkpoint:
        checkpoint = self.tree.get(checkpoint_id)
        await self._runner.restore(checkpoint.snapshot_id)
        del self.transcript[checkpoint.transcript_offset :]
        self._drop_unanswered_tool_calls()
        self.tree.rewind_to(checkpoint.id)
        self.revision += 1
        # An operator message is the right channel for this, and it keeps the
        # cached prefix intact. It cannot be messages[0] though, so an empty
        # transcript falls back to a plain user turn.
        self.append(
            {
                "role": "system" if self.transcript else "user",
                "content": (
                    f"You rewound to checkpoint '{checkpoint.label}'. The branch you "
                    f"abandoned failed because {reason}. The environment is back to "
                    f"that state — do not repeat that approach."
                ),
            }
        )
        return checkpoint

    def _drop_unanswered_tool_calls(self) -> None:
        """Remove trailing tool_use blocks whose tool_result was truncated away.

        A checkpoint is taken from inside a tool call, so its offset can land
        just after the assistant turn that requested it. Truncating there would
        leave a tool_use with no matching tool_result, which the API rejects.
        """
        while self.transcript and _has_tool_use(self.transcript[-1]):
            self.transcript.pop()


def _has_tool_use(message: dict) -> bool:
    content = message.get("content")
    if not isinstance(content, list):
        return False
    return any(getattr(block, "type", None) == "tool_use" for block in content)
