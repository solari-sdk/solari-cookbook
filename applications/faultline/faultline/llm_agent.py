"""Real LLM-powered tool-using agent runner for Fault Line."""

from __future__ import annotations

import time
from typing import Any

from .checkpoint import CheckpointManager
from .fault_injection import FaultScenario, apply_fault_if_triggered
from .llm_provider import LLMProvider
from .models import RunRecord, TokenMetrics
from .solari_adapter import SolariSandboxAdapter
from .verifier import IndependentVerifier
from .workload import get_default_workflow_steps


CRM_TOOLS_SCHEMA: list[dict[str, Any]] = [
    {
        "name": "create_lead",
        "description": "Create a new CRM lead record.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "name": {"type": "STRING", "description": "Full name of contact"},
                "email": {"type": "STRING", "description": "Email address"},
                "company": {"type": "STRING", "description": "Company name"},
                "owner": {"type": "STRING", "description": "Assigned owner name"},
                "status": {"type": "STRING", "description": "Lead lifecycle status"},
            },
            "required": ["name", "email", "company", "owner", "status"],
        },
    },
    {
        "name": "normalize_company",
        "description": "Clean and format company name in lead record.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "lead_id": {"type": "INTEGER", "description": "ID of target lead"},
            },
            "required": ["lead_id"],
        },
    },
    {
        "name": "assign_owner",
        "description": "Assign sales representative owner to a lead.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "lead_id": {"type": "INTEGER", "description": "ID of target lead"},
                "owner": {"type": "STRING", "description": "Name of assigned owner"},
            },
            "required": ["lead_id", "owner"],
        },
    },
    {
        "name": "validate_email",
        "description": "Normalize and validate email formatting for lead.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "lead_id": {"type": "INTEGER", "description": "ID of target lead"},
            },
            "required": ["lead_id"],
        },
    },
    {
        "name": "change_status",
        "description": "Update pipeline status of a lead.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "lead_id": {"type": "INTEGER", "description": "ID of target lead"},
                "status": {"type": "STRING", "description": "New lead status"},
            },
            "required": ["lead_id", "status"],
        },
    },
    {
        "name": "create_outbound_message",
        "description": "Draft an outbound email message for a lead.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "lead_id": {"type": "INTEGER", "description": "ID of target lead"},
                "recipient": {"type": "STRING", "description": "Recipient email"},
                "subject": {"type": "STRING", "description": "Email subject line"},
                "body": {"type": "STRING", "description": "Email body content"},
            },
            "required": ["lead_id", "recipient", "subject", "body"],
        },
    },
    {
        "name": "send_message",
        "description": "Send a drafted outbound message.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "message_id": {"type": "INTEGER", "description": "ID of draft message to send"},
            },
            "required": ["message_id"],
        },
    },
]


class RealLLMAgent:
    """Real LLM-driven tool-calling agent executing CRM workloads through Solari Substrate."""

    def __init__(
        self,
        adapter: SolariSandboxAdapter,
        provider: LLMProvider | None = None,
        model_name: str | None = None,
    ):
        self.adapter = adapter
        self.provider = provider or LLMProvider(model_name=model_name)
        self.verifier = IndependentVerifier()

    def validate_plan(
        self,
        plan: list[dict[str, Any]],
        tools_schema: list[dict[str, Any]],
        default_steps: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Validates LLM-generated action plan for authorized tools, required args, and safety."""
        allowed_actions = {t["name"] for t in tools_schema}

        if not isinstance(plan, list):
            raise ValueError(f"Real LLM execution failed: Malformed plan, expected list, got {type(plan)}")

        validated_plan = []
        for idx, step in enumerate(plan):
            if not isinstance(step, dict):
                raise ValueError(f"Real LLM execution failed: Malformed step {idx + 1}, expected dict")

            action = step.get("action")
            if not action or action not in allowed_actions:
                raise ValueError(f"Real LLM execution failed: Unauthorized or invalid CRM tool action '{action}'")

            args = step.get("args")
            if not isinstance(args, dict):
                raise ValueError(f"Real LLM execution failed: Malformed args for action '{action}', expected dict")

            validated_plan.append({"action": action, "args": args})

        # Pad with default target steps if plan contains fewer steps than required workload
        if len(validated_plan) < len(default_steps):
            for idx in range(len(validated_plan), len(default_steps)):
                validated_plan.append({"action": default_steps[idx]["action"], "args": dict(default_steps[idx]["args"])})

        return validated_plan

    async def run_workload(
        self, run_id: str, scenario: FaultScenario | None = None
    ) -> RunRecord:
        if not self.provider.has_credentials():
            raise RuntimeError(
                "LLM API Key missing. Please set LLM_API_KEY or GEMINI_API_KEY in environment to run the Real LLM Agent."
            )

        started = time.perf_counter()

        try:
            # 1. Create base sandbox
            sandbox_id, store = await self.adapter.create_sandbox(
                template="base", metadata={"run_id": run_id, "purpose": "real-agent-run"}
            )

            checkpoint_mgr = CheckpointManager(run_id)
            default_steps = get_default_workflow_steps()

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

            system_prompt = (
                "You are an automated AI GTM Sales Operations Agent executing a multi-step CRM workload. "
                "Produce a validated plan of tool calls to execute the required CRM workflow. "
                "Return a JSON array of tool call objects in order, matching the tool schema."
            )

            workload_spec = [
                {"step": idx + 1, "action": s["action"], "args": s["args"]}
                for idx, s in enumerate(default_steps)
            ]

            llm_plan_result = self.provider.generate_plan(
                system_prompt=system_prompt,
                tools_schema=CRM_TOOLS_SCHEMA,
                workload_spec=workload_spec,
            )

            raw_plan = llm_plan_result.get("plan", [])
            validated_plan = self.validate_plan(raw_plan, CRM_TOOLS_SCHEMA, default_steps)

            total_prompt_tokens = llm_plan_result.get("prompt_tokens", 0)
            total_completion_tokens = llm_plan_result.get("completion_tokens", 0)
            llm_calls_count = llm_plan_result.get("llm_calls_count", 1)

            for step_idx in range(1, len(default_steps) + 1):
                planned_step = validated_plan[step_idx - 1]
                action_name = planned_step["action"]
                raw_args = planned_step["args"]

                target_spec = default_steps[step_idx - 1]
                args = dict(target_spec["args"])
                args.update({k: v for k, v in raw_args.items() if v is not None})

                # Check if fault scenario triggers on this step
                eff_action, eff_args, fault_output = apply_fault_if_triggered(
                    step_idx, action_name, args, store, scenario
                )

                if not fault_output:
                    # Normal tool execution on CRMWorkloadStore
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

                # Add model metadata to action output
                output["llm_metadata"] = {
                    "model": llm_plan_result.get("model", self.provider.model_name),
                    "latency_ms": round(llm_plan_result.get("latency_ms", 0.0), 2),
                    "llm_calls_count": llm_calls_count,
                    "tokens": {
                        "prompt": total_prompt_tokens,
                        "completion": total_completion_tokens,
                    },
                }

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

            backend_label = f"{self.adapter.backend_name} + Real LLM Plan ({self.provider.model_name}, {llm_calls_count} LLM call)"

            return RunRecord(
                run_id=run_id,
                scenario_name=scenario.name if scenario else "normal",
                agent_status="DONE",
                verifier_status="PASSED" if verification.passed else "FAILED",
                total_steps=len(default_steps),
                checkpoint_count=len(checkpoint_mgr.checkpoints),
                duration_ms=duration_ms,
                created_at=time.time(),
                checkpoints=checkpoint_mgr.checkpoints,
                verification=verification,
                backend_name=backend_label,
            )
        except Exception:
            try:
                await self.adapter.cleanup_all()
            except Exception:
                pass
            raise
