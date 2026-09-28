"""Fault Injection engine for Fault Line."""

from __future__ import annotations

from typing import Any

from .models import FaultScenario
from .workload import CRMWorkloadStore


SCENARIOS: dict[str, FaultScenario] = {
    "wrong-owner": FaultScenario(
        name="wrong-owner",
        description="Agent assigns lead to wrong owner (Bob instead of Alice)",
        trigger_step=17,
        details={"target_lead_id": 1, "expected_owner": "Alice", "injected_owner": "Bob"},
    ),
    "wrong-status": FaultScenario(
        name="wrong-status",
        description="Agent updates status to 'contacted' instead of 'qualified'",
        trigger_step=17,
        details={"target_lead_id": 1, "expected_status": "qualified", "injected_status": "contacted"},
    ),
    "duplicate-retry": FaultScenario(
        name="duplicate-retry",
        description="Agent accidentally executes outbound message creation twice",
        trigger_step=17,
        details={"target_lead_id": 1, "duplicate_count": 2},
    ),
    "partial-update": FaultScenario(
        name="partial-update",
        description="Agent updates owner but wipes company field to empty string",
        trigger_step=17,
        details={"target_lead_id": 1, "injected_company": ""},
    ),
    "stale-state": FaultScenario(
        name="stale-state",
        description="Agent overwrites normalized state with stale un-normalized company text",
        trigger_step=17,
        details={"target_lead_id": 1, "stale_company": "  acme corp  "},
    ),
}


def get_fault_scenario(name: str) -> FaultScenario:
    if name not in SCENARIOS:
        raise ValueError(f"Unknown fault scenario: {name}. Available: {list(SCENARIOS.keys())}")
    return SCENARIOS[name]


def apply_fault_if_triggered(
    step_number: int,
    action_name: str,
    args: dict[str, Any],
    store: CRMWorkloadStore,
    scenario: FaultScenario | None,
) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """Applies fault injection if current step matches scenario trigger step."""
    if scenario is None or step_number != scenario.trigger_step:
        return action_name, args, {}

    if scenario.name == "wrong-owner":
        # Override owner to Bob
        injected_args = dict(args)
        injected_args["owner"] = scenario.details["injected_owner"]
        lead = store.assign_owner(injected_args.get("lead_id", 1), injected_args["owner"])
        return "assign_owner", injected_args, {"fault": "wrong_owner_injected", "lead": lead.to_dict()}

    elif scenario.name == "wrong-status":
        injected_args = dict(args)
        injected_args["status"] = scenario.details["injected_status"]
        lead = store.change_status(injected_args.get("lead_id", 1), injected_args["status"])
        return "change_status", injected_args, {"fault": "wrong_status_injected", "lead": lead.to_dict()}

    elif scenario.name == "duplicate-retry":
        # Create message twice
        lead_id = scenario.details["target_lead_id"]
        lead = store.get_lead(lead_id)
        msg1 = store.create_outbound_message(lead_id, lead.email, "Duplicate 1", "Body 1")
        msg2 = store.create_outbound_message(lead_id, lead.email, "Duplicate 2", "Body 2")
        return "create_outbound_message", args, {
            "fault": "duplicate_retry_injected",
            "messages": [msg1.to_dict(), msg2.to_dict()],
        }

    elif scenario.name == "partial-update":
        injected_args = dict(args)
        lead_id = injected_args.get("lead_id", 1)
        store.assign_owner(lead_id, "Alice")
        store.update_lead(lead_id, company="")
        return "partial_update", injected_args, {
            "fault": "partial_update_injected",
            "lead": store.get_lead(lead_id).to_dict(),
        }

    elif scenario.name == "stale-state":
        injected_args = dict(args)
        lead_id = injected_args.get("lead_id", 1)
        store.update_lead(lead_id, company=scenario.details["stale_company"])
        return "write_stale_state", injected_args, {
            "fault": "stale_state_injected",
            "lead": store.get_lead(lead_id).to_dict(),
        }

    return action_name, args, {}
