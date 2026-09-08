"""The checkpoint tree: what the agent can go back to, and how it got there."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Checkpoint:
    id: str
    snapshot_id: str
    label: str
    transcript_offset: int
    parent: str | None


class CheckpointTree:
    def __init__(self) -> None:
        self._checkpoints: list[Checkpoint] = []
        self._head: str | None = None

    @property
    def checkpoints(self) -> list[Checkpoint]:
        return list(self._checkpoints)

    def add(
        self, *, snapshot_id: str, label: str, transcript_offset: int
    ) -> Checkpoint:
        checkpoint = Checkpoint(
            id=f"cp_{len(self._checkpoints) + 1}",
            snapshot_id=snapshot_id,
            label=label,
            transcript_offset=transcript_offset,
            parent=self._head,
        )
        self._checkpoints.append(checkpoint)
        self._head = checkpoint.id
        return checkpoint

    def rewind_to(self, checkpoint_id: str) -> Checkpoint:
        """Move the head back, so the next checkpoint branches from here."""
        checkpoint = self.get(checkpoint_id)
        self._head = checkpoint.id
        return checkpoint

    def get(self, checkpoint_id: str) -> Checkpoint:
        for checkpoint in self._checkpoints:
            if checkpoint.id == checkpoint_id:
                return checkpoint
        raise KeyError(f"no such checkpoint: {checkpoint_id}")
