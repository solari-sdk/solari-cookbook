"""Checkpoint Manager & Lineage Store for Fault Line."""

from __future__ import annotations

from typing import Any

from .models import Checkpoint
from .workload import CRMWorkloadStore


class CheckpointManager:
    """Manages checkpoints, canonical state hashing, and execution lineage."""

    def __init__(self, run_id: str):
        self.run_id = run_id
        self.checkpoints: list[Checkpoint] = []
        self._by_id: dict[str, Checkpoint] = {}

    def create_checkpoint(
        self,
        step_number: int,
        action_name: str,
        action_input: dict[str, Any],
        action_output: dict[str, Any],
        snapshot_id: str,
        store: CRMWorkloadStore,
    ) -> Checkpoint:
        state_digest = store.compute_state_digest()
        parent_id = self.checkpoints[-1].checkpoint_id if self.checkpoints else None

        chk = Checkpoint(
            run_id=self.run_id,
            step_number=step_number,
            action_name=action_name,
            action_input=action_input,
            action_output=action_output,
            snapshot_id=snapshot_id,
            state_digest=state_digest,
            parent_checkpoint_id=parent_id,
        )

        self.checkpoints.append(chk)
        self._by_id[chk.checkpoint_id] = chk
        return chk

    def get_checkpoint(self, checkpoint_id: str) -> Checkpoint:
        if checkpoint_id not in self._by_id:
            raise KeyError(f"Checkpoint not found: {checkpoint_id}")
        return self._by_id[checkpoint_id]

    def get_by_step(self, step_number: int) -> Checkpoint | None:
        for chk in self.checkpoints:
            if chk.step_number == step_number:
                return chk
        return None

    def export_lineage(self) -> list[dict[str, Any]]:
        return [chk.to_dict() for chk in self.checkpoints]
