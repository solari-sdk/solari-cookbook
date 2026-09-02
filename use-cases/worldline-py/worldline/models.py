"""Serializable domain objects for Worldline runs."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

BranchStatus = Literal["pass", "fail", "error"]
RunMode = Literal["fixture", "live"]


@dataclass(frozen=True)
class Check:
    id: str
    label: str
    expected: str
    actual: str
    passed: bool
    required: bool = True
    weight: int = 1


@dataclass(frozen=True)
class Candidate:
    id: str
    label: str
    hypothesis: str
    actions: tuple[str, ...]


@dataclass
class BranchResult:
    candidate_id: str
    label: str
    hypothesis: str
    status: BranchStatus
    duration_ms: int
    action_count: int
    checks: list[Check]
    score: float = 0.0
    screenshot: str | None = None
    artifact: str | None = None
    artifact_sha256: str | None = None
    error: str | None = None
    phase: Literal["explore", "commit"] = "explore"

    @property
    def required_checks_pass(self) -> bool:
        return all(check.passed for check in self.checks if check.required)


@dataclass(frozen=True)
class EnvironmentEvidence:
    provider: str
    mode: RunMode
    environment_id: str
    checkpoint_id: str
    base_sha256: str


@dataclass(frozen=True)
class CleanupEvidence:
    attempted: bool
    succeeded: bool
    detail: str


@dataclass
class RunResult:
    schema_version: str
    engine_version: str
    run_id: str
    created_at: str
    task: str
    task_detail: str
    environment: EnvironmentEvidence
    branches: list[BranchResult]
    winner_id: str | None
    commit: BranchResult | None
    cleanup: CleanupEvidence
    status: Literal["committed", "no-winner", "commit-failed", "error"]
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
