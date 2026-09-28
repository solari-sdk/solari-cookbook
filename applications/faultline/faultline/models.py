"""Data models for Fault Line."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class Lead:
    id: int
    name: str
    email: str
    company: str
    owner: str
    status: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "company": self.company,
            "owner": self.owner,
            "status": self.status,
        }


@dataclass
class OutboundMessage:
    id: int
    lead_id: int
    recipient: str
    subject: str
    body: str
    status: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "recipient": self.recipient,
            "subject": self.subject,
            "body": self.body,
            "status": self.status,
        }


@dataclass
class ActionRecord:
    step_number: int
    action_name: str
    action_input: dict[str, Any]
    action_output: dict[str, Any]
    timestamp: float = field(default_factory=time.time)


@dataclass
class Checkpoint:
    run_id: str
    step_number: int
    action_name: str
    action_input: dict[str, Any]
    action_output: dict[str, Any]
    snapshot_id: str
    state_digest: str
    timestamp: float = field(default_factory=time.time)
    parent_checkpoint_id: str | None = None
    checkpoint_id: str = ""

    def __post_init__(self):
        if not self.checkpoint_id:
            self.checkpoint_id = f"chk-{self.run_id}-step-{self.step_number:02d}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "checkpoint_id": self.checkpoint_id,
            "run_id": self.run_id,
            "step_number": self.step_number,
            "action_name": self.action_name,
            "action_input": self.action_input,
            "action_output": self.action_output,
            "snapshot_id": self.snapshot_id,
            "state_digest": self.state_digest,
            "timestamp": self.timestamp,
            "parent_checkpoint_id": self.parent_checkpoint_id,
        }


@dataclass
class InvariantCheck:
    name: str
    passed: bool
    expected: Any
    actual: Any
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "expected": str(self.expected),
            "actual": str(self.actual),
            "message": self.message,
        }


@dataclass
class VerificationResult:
    passed: bool
    failed_invariants: list[InvariantCheck]
    all_invariants: list[InvariantCheck]

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "failed_invariants": [inv.to_dict() for inv in self.failed_invariants],
            "all_invariants": [inv.to_dict() for inv in self.all_invariants],
        }


@dataclass
class FieldChange:
    field_name: str
    old_value: Any
    new_value: Any

    def to_dict(self) -> dict[str, Any]:
        return {
            "field_name": self.field_name,
            "old_value": self.old_value,
            "new_value": self.new_value,
        }


@dataclass
class RecordDiff:
    record_type: str  # "Lead" or "OutboundMessage"
    record_id: int
    change_type: Literal["created", "deleted", "changed"]
    field_changes: list[FieldChange] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "record_type": self.record_type,
            "record_id": self.record_id,
            "change_type": self.change_type,
            "field_changes": [fc.to_dict() for fc in self.field_changes],
        }


@dataclass
class StateDiff:
    from_checkpoint_id: str
    to_checkpoint_id: str
    created_records: list[RecordDiff] = field(default_factory=list)
    deleted_records: list[RecordDiff] = field(default_factory=list)
    changed_records: list[RecordDiff] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "from_checkpoint_id": self.from_checkpoint_id,
            "to_checkpoint_id": self.to_checkpoint_id,
            "created_records": [r.to_dict() for r in self.created_records],
            "deleted_records": [r.to_dict() for r in self.deleted_records],
            "changed_records": [r.to_dict() for r in self.changed_records],
        }


@dataclass
class FaultScenario:
    name: str
    description: str
    trigger_step: int
    details: dict[str, Any]


@dataclass
class RepairAction:
    target_checkpoint_id: str
    target_step_number: int
    fix_type: str
    parameters: dict[str, Any]
    description: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_checkpoint_id": self.target_checkpoint_id,
            "target_step_number": self.target_step_number,
            "fix_type": self.fix_type,
            "parameters": self.parameters,
            "description": self.description,
        }


@dataclass
class ProbeRecord:
    probe_index: int
    checkpoint_id: str
    step_number: int
    state_digest: str
    is_valid: bool
    probe_latency_ms: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "probe_index": self.probe_index,
            "checkpoint_id": self.checkpoint_id,
            "step_number": self.step_number,
            "state_digest": self.state_digest,
            "is_valid": self.is_valid,
            "probe_latency_ms": round(self.probe_latency_ms, 2),
        }


@dataclass
class StrategyResult:
    strategy_name: str
    probes_count: int
    localization_time_ms: float
    forks_count: int
    snapshots_count: int
    replay_steps_count: int
    verification_time_ms: float
    total_time_ms: float
    first_invalid_step: int | None
    validated_causal_step: int | None
    probe_history: list[ProbeRecord] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "strategy_name": self.strategy_name,
            "probes_count": self.probes_count,
            "localization_time_ms": round(self.localization_time_ms, 2),
            "forks_count": self.forks_count,
            "snapshots_count": self.snapshots_count,
            "replay_steps_count": self.replay_steps_count,
            "verification_time_ms": round(self.verification_time_ms, 2),
            "total_time_ms": round(self.total_time_ms, 2),
            "first_invalid_step": self.first_invalid_step,
            "validated_causal_step": self.validated_causal_step,
            "probe_history": [p.to_dict() for p in self.probe_history],
        }


@dataclass
class TokenMetrics:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    token_status: Literal["MEASURED", "ESTIMATED", "UNAVAILABLE"] = "UNAVAILABLE"

    def to_dict(self) -> dict[str, Any]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "token_status": self.token_status,
        }


@dataclass
class CostBreakdown:
    original_execution_cost: float
    failure_diagnosis_cost: float
    counterfactual_replay_cost: float
    verification_cost: float
    total_recovery_cost: float
    recovery_overhead_pct: float
    cost_status: Literal["MEASURED", "ESTIMATED", "UNAVAILABLE"] = "ESTIMATED"

    def to_dict(self) -> dict[str, Any]:
        return {
            "original_execution_cost": round(self.original_execution_cost, 6),
            "failure_diagnosis_cost": round(self.failure_diagnosis_cost, 6),
            "counterfactual_replay_cost": round(self.counterfactual_replay_cost, 6),
            "verification_cost": round(self.verification_cost, 6),
            "total_recovery_cost": round(self.total_recovery_cost, 6),
            "recovery_overhead_pct": round(self.recovery_overhead_pct, 2),
            "cost_status": self.cost_status,
        }


@dataclass
class RegressionCase:
    case_id: str
    scenario: str
    original_run_id: str
    fault_boundary_step: int
    last_good_checkpoint_id: str
    first_bad_checkpoint_id: str
    failed_invariants: list[str]
    state_diff: StateDiff
    repair_action: RepairAction
    repaired_result: VerificationResult
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "scenario": self.scenario,
            "original_run_id": self.original_run_id,
            "fault_boundary_step": self.fault_boundary_step,
            "last_good_checkpoint_id": self.last_good_checkpoint_id,
            "first_bad_checkpoint_id": self.first_bad_checkpoint_id,
            "failed_invariants": self.failed_invariants,
            "state_diff": self.state_diff.to_dict(),
            "repair_action": self.repair_action.to_dict(),
            "repaired_result": self.repaired_result.to_dict(),
            "timestamp": self.timestamp,
        }


@dataclass
class RunRecord:
    run_id: str
    scenario_name: str
    agent_status: str
    verifier_status: str
    total_steps: int
    checkpoint_count: int
    duration_ms: float
    created_at: float
    checkpoints: list[Checkpoint]
    verification: VerificationResult
    backend_name: str = "Offline Simulator"
    fault_boundary_step: int | None = None
    causal_candidate_step: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "scenario_name": self.scenario_name,
            "agent_status": self.agent_status,
            "verifier_status": self.verifier_status,
            "total_steps": self.total_steps,
            "checkpoint_count": self.checkpoint_count,
            "duration_ms": round(self.duration_ms, 2),
            "created_at": self.created_at,
            "checkpoints": [chk.to_dict() for chk in self.checkpoints],
            "verification": self.verification.to_dict(),
            "backend_name": self.backend_name,
            "fault_boundary_step": self.fault_boundary_step,
            "causal_candidate_step": self.causal_candidate_step,
        }


@dataclass
class BenchmarkRunResult:
    experiment_id: str
    scenario_name: str
    seed: int
    metrics_by_strategy: dict[str, Any]
    cost_by_strategy: dict[str, Any]
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "experiment_id": self.experiment_id,
            "scenario_name": self.scenario_name,
            "seed": self.seed,
            "metrics_by_strategy": self.metrics_by_strategy,
            "cost_by_strategy": self.cost_by_strategy,
            "timestamp": self.timestamp,
        }
