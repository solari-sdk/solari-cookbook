"""Worldline orchestration and deterministic scoring."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Protocol
from uuid import uuid4

from . import __version__
from .models import (
    BranchResult,
    Candidate,
    CleanupEvidence,
    EnvironmentEvidence,
    RunResult,
)


class Runner(Protocol):
    async def prepare(self) -> EnvironmentEvidence: ...

    async def reset(self) -> None: ...

    async def execute(self, candidate: Candidate, *, phase: str) -> BranchResult: ...

    async def cleanup(self) -> CleanupEvidence: ...


def score_branch(branch: BranchResult) -> float:
    """Score evidence, never prose. A failed required check is ineligible."""
    if branch.status == "error" or not branch.required_checks_pass:
        return 0.0
    possible = sum(max(check.weight, 0) for check in branch.checks)
    earned = sum(max(check.weight, 0) for check in branch.checks if check.passed)
    evidence_score = 100.0 if possible == 0 else (earned / possible) * 100.0
    action_penalty = min(branch.action_count * 0.35, 8.0)
    duration_penalty = min(math.log1p(max(branch.duration_ms, 0) / 1000.0), 4.0)
    return round(max(evidence_score - action_penalty - duration_penalty, 0.0), 2)


def select_winner(branches: list[BranchResult]) -> BranchResult | None:
    eligible = [
        branch
        for branch in branches
        if branch.status == "pass" and branch.required_checks_pass and branch.score > 0
    ]
    if not eligible:
        return None
    return max(
        eligible,
        key=lambda branch: (branch.score, -branch.action_count, -branch.duration_ms),
    )


class WorldlineEngine:
    def __init__(self, runner: Runner, task: str, task_detail: str) -> None:
        self.runner = runner
        self.task = task
        self.task_detail = task_detail

    async def run(self, candidates: list[Candidate]) -> RunResult:
        run_id = f"wl_{uuid4().hex[:12]}"
        created_at = datetime.now(timezone.utc).isoformat()
        environment: EnvironmentEvidence | None = None
        branches: list[BranchResult] = []
        commit: BranchResult | None = None
        cleanup = CleanupEvidence(
            attempted=False, succeeded=False, detail="not attempted"
        )
        status: str = "error"
        winner: BranchResult | None = None

        try:
            environment = await self.runner.prepare()
            for candidate in candidates:
                await self.runner.reset()
                try:
                    branch = await self.runner.execute(candidate, phase="explore")
                except Exception as exc:  # noqa: BLE001 - isolate failed worldlines
                    branch = BranchResult(
                        candidate_id=candidate.id,
                        label=candidate.label,
                        hypothesis=candidate.hypothesis,
                        status="error",
                        duration_ms=0,
                        action_count=len(candidate.actions),
                        checks=[],
                        error=f"{type(exc).__name__}: {exc}",
                    )
                branch.score = score_branch(branch)
                branches.append(branch)

            winner = select_winner(branches)
            if winner is None:
                status = "no-winner"
            else:
                await self.runner.reset()
                selected = next(
                    candidate
                    for candidate in candidates
                    if candidate.id == winner.candidate_id
                )
                commit = await self.runner.execute(selected, phase="commit")
                commit.score = score_branch(commit)
                status = (
                    "committed"
                    if commit.status == "pass" and commit.required_checks_pass
                    else "commit-failed"
                )
        finally:
            cleanup = await self.runner.cleanup()

        if environment is None:
            environment = EnvironmentEvidence(
                provider="unknown",
                mode="fixture",
                environment_id="unavailable",
                checkpoint_id="unavailable",
                base_sha256="unavailable",
            )

        return RunResult(
            schema_version="1.0",
            engine_version=__version__,
            run_id=run_id,
            created_at=created_at,
            task=self.task,
            task_detail=self.task_detail,
            environment=environment,
            branches=branches,
            winner_id=winner.candidate_id if winner else None,
            commit=commit,
            cleanup=cleanup,
            status=status,  # type: ignore[arg-type]
            metadata={
                "selection": "required checks gate eligibility; score breaks ties",
                "candidate_count": len(candidates),
            },
        )
