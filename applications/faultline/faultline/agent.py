"""Agent execution runner for Fault Line."""

from __future__ import annotations

import time
from typing import Any

from .checkpoint import CheckpointManager
from .fault_injection import FaultScenario, apply_fault_if_triggered
from .models import RunRecord
from .solari_adapter import SolariSandboxAdapter
from .verifier import IndependentVerifier
from .workload import get_default_workflow_steps


class DeterministicAgent:
    """Deterministic agent executing multi-step CRM workloads."""

    def __init__(self, adapter: SolariSandboxAdapter):
        self.adapter = adapter
        self.verifier = IndependentVerifier()

    async def run_workload(
        self, run_id: str, scenario: FaultScenario | None = None
    ) -> RunRecord:
        started = time.perf_counter()

        # 1. Create base sandbox
        sandbox_id, store = await self.adapter.create_sandbox(
            template="base", metadata={"run_id": run_id, "purpose": "agent-run"}
        )

        checkpoint_mgr = CheckpointManager(run_id)
        workflow_steps = get_default_workflow_steps()

        # Step 0: Initial state snapshot
        snap_0 = await self.adapter.create_snapshot(sandbox_id, store, f"{run_id}-step-00")
        checkpoint_mgr.create_checkpoint(
            step_number=0,
            action_name="initial_state",
            action_input={},
            action_output={"status": "initialized"},
            snapshot_id=snap_0,
            store=store,
        )

        # Execute 24 workflow steps
        for step_idx, step_spec in enumerate(workflow_steps, start=1):
            action_name = step_spec["action"]
            args = step_spec["args"]

            # Check if fault scenario triggers on this step
            eff_action, eff_args, fault_output = apply_fault_if_triggered(
                step_idx, action_name, args, store, scenario
            )

            if not fault_output:
                # Normal execution
                if eff_action == "create_lead":
                    lead = store.create_lead(**eff_args)
                    output = {"lead": lead.to_dict()}
                elif eff_action == "normalize_company":
                    lead = store.normalize_company(**eff_args)
                    output = {"lead": lead.to_dict()}
                elif eff_action == "assign_owner":
                    lead = store.assign_owner(**eff_args)
                    output = {"lead": lead.to_dict()}
                elif eff_action == "validate_email":
                    lead = store.validate_email(**eff_args)
                    output = {"lead": lead.to_dict()}
                elif eff_action == "change_status":
                    lead = store.change_status(**eff_args)
                    output = {"lead": lead.to_dict()}
                elif eff_action == "create_outbound_message":
                    msg = store.create_outbound_message(**eff_args)
                    output = {"message": msg.to_dict()}
                elif eff_action == "send_message":
                    msg = store.send_message(**eff_args)
                    output = {"message": msg.to_dict()}
                else:
                    output = {"status": "executed"}
            else:
                output = fault_output

            # Take snapshot after step
            snap_id = await self.adapter.create_snapshot(
                sandbox_id, store, f"{run_id}-step-{step_idx:02d}"
            )
            checkpoint_mgr.create_checkpoint(
                step_number=step_idx,
                action_name=eff_action,
                action_input=eff_args,
                action_output=output,
                snapshot_id=snap_id,
                store=store,
            )

        # Run independent verifier on final state
        verification = self.verifier.verify_store(store)
        duration_ms = (time.perf_counter() - started) * 1000

        return RunRecord(
            run_id=run_id,
            scenario_name=scenario.name if scenario else "normal",
            agent_status="DONE",
            verifier_status="PASSED" if verification.passed else "FAILED",
            total_steps=len(workflow_steps),
            checkpoint_count=len(checkpoint_mgr.checkpoints),
            duration_ms=duration_ms,
            created_at=time.time(),
            checkpoints=checkpoint_mgr.checkpoints,
            verification=verification,
            backend_name=self.adapter.backend_name,
        )


class OptionalLLMAgent:
    """Base class for pluggable LLM-backed agent runners."""

    def __init__(self, model_name: str = "gemini-flash"):
        self.model_name = model_name

    async def run_workload(self, run_id: str) -> RunRecord:
        raise NotImplementedError("OptionalLLMAgent requires live LLM API credentials.")
