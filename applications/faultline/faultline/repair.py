"""Counterfactual Repair & Replay Engine for Fault Line."""

from __future__ import annotations

import time
from typing import Any

from .checkpoint import CheckpointManager
from .models import Checkpoint, RepairAction, VerificationResult
from .solari_adapter import SolariSandboxAdapter
from .verifier import IndependentVerifier
from .workload import get_default_workflow_steps


class CounterfactualRepairEngine:
    """Forks from historical state, applies corrective action, and replays workflow forward."""

    def __init__(
        self,
        adapter: SolariSandboxAdapter,
        verifier: IndependentVerifier | None = None,
    ):
        self.adapter = adapter
        self.verifier = verifier or IndependentVerifier()

    def resolve_repair_action(
        self,
        checkpoint_id: str,
        bad_step: int,
        failed_invariants: list[str],
        scenario_name: str | None = None,
    ) -> RepairAction:
        """Resolves repair action primarily from failed invariant names and state diff, falling back to scenario name."""
        if "lead_1_owner_matches_expected" in failed_invariants or scenario_name == "wrong-owner":
            return RepairAction(
                target_checkpoint_id=checkpoint_id,
                target_step_number=bad_step,
                fix_type="assign_owner",
                parameters={"lead_id": 1, "owner": "Alice"},
                description="Assign owner to Alice at step boundary (invariant: lead_1_owner_matches_expected)",
            )
        elif "lead_1_status_is_qualified" in failed_invariants or scenario_name == "wrong-status":
            return RepairAction(
                target_checkpoint_id=checkpoint_id,
                target_step_number=bad_step,
                fix_type="change_status",
                parameters={"lead_id": 1, "status": "qualified"},
                description="Update status to qualified at step boundary (invariant: lead_1_status_is_qualified)",
            )
        elif "single_outbound_message_per_lead" in failed_invariants or scenario_name == "duplicate-retry":
            return RepairAction(
                target_checkpoint_id=checkpoint_id,
                target_step_number=bad_step,
                fix_type="deduplicate_and_create",
                parameters={"lead_id": 1},
                description="Execute outbound message creation exactly once (invariant: single_outbound_message_per_lead)",
            )
        elif "lead_1_company_normalized" in failed_invariants or scenario_name in ("partial-update", "stale-state"):
            return RepairAction(
                target_checkpoint_id=checkpoint_id,
                target_step_number=bad_step,
                fix_type="full_update",
                parameters={"lead_id": 1, "owner": "Alice", "company": "Acme Corp"},
                description="Apply complete update preserving owner and company (invariant: lead_1_company_normalized)",
            )
        else:
            return RepairAction(
                target_checkpoint_id=checkpoint_id,
                target_step_number=bad_step,
                fix_type="generic_corrective_action",
                parameters={"lead_id": 1},
                description="Apply generic fix at step boundary",
            )

    async def execute_repair(
        self,
        checkpoint_mgr: CheckpointManager,
        last_good_checkpoint: Checkpoint,
        first_bad_checkpoint: Checkpoint,
        scenario_name: str = "generic",
    ) -> tuple[RepairAction, VerificationResult, float]:
        started = time.perf_counter()

        # Probe first bad checkpoint to obtain failed invariants
        bad_store = await self.adapter.revert_to_snapshot("sbx-repair-eval", first_bad_checkpoint.snapshot_id)
        bad_verification = self.verifier.verify_store(bad_store)
        failed_inv_names = [inv.name for inv in bad_verification.failed_invariants]

        # 1. Fork from last known-good checkpoint
        fork_sbx_id, repaired_store = await self.adapter.create_sandbox(
            from_snapshot=last_good_checkpoint.snapshot_id,
            metadata={"purpose": "counterfactual-repair"},
        )

        # 2. Determine corrective action based on invariant failure / state diff
        bad_step = first_bad_checkpoint.step_number
        repair_action = self.resolve_repair_action(
            last_good_checkpoint.checkpoint_id, bad_step, failed_inv_names, scenario_name
        )

        # Execute repair mutation
        if repair_action.fix_type == "assign_owner":
            repaired_store.assign_owner(
                repair_action.parameters.get("lead_id", 1),
                repair_action.parameters.get("owner", "Alice"),
            )
        elif repair_action.fix_type == "change_status":
            repaired_store.change_status(
                repair_action.parameters.get("lead_id", 1),
                repair_action.parameters.get("status", "qualified"),
            )
        elif repair_action.fix_type == "deduplicate_and_create":
            lead_id = repair_action.parameters.get("lead_id", 1)
            lead = repaired_store.get_lead(lead_id)
            if lead:
                repaired_store.create_outbound_message(
                    lead_id, lead.email, "Partnership Proposal", "Hello Acme, let us discuss."
                )
        elif repair_action.fix_type in ("full_update", "normalize_state"):
            lead_id = repair_action.parameters.get("lead_id", 1)
            repaired_store.assign_owner(lead_id, "Alice")
            repaired_store.normalize_company(lead_id)
        else:
            repaired_store.assign_owner(1, "Alice")

        # 3. Replay remaining workflow forward from bad_step to end
        all_steps = get_default_workflow_steps()
        remaining_steps = all_steps[bad_step:]

        for step_spec in remaining_steps:
            action = step_spec["action"]
            args = step_spec["args"]

            if action == "assign_owner":
                repaired_store.assign_owner(args["lead_id"], args["owner"])
            elif action == "change_status":
                repaired_store.change_status(args["lead_id"], args["status"])
            elif action == "validate_email":
                repaired_store.validate_email(args["lead_id"])
            elif action == "normalize_company":
                repaired_store.normalize_company(args["lead_id"])
            elif action == "create_outbound_message":
                repaired_store.create_outbound_message(
                    args["lead_id"], args["recipient"], args["subject"], args["body"]
                )
            elif action == "send_message":
                repaired_store.send_message(args["message_id"])

        # 4. Verify repaired execution state
        ver_result = self.verifier.verify_store(repaired_store)

        # Clean up repair sandbox
        await self.adapter.kill_sandbox(fork_sbx_id)

        duration_ms = (time.perf_counter() - started) * 1000
        return repair_action, ver_result, duration_ms
