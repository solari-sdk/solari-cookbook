"""Metrics and Cost Analysis Engine for Fault Line."""

from __future__ import annotations

from .models import CostBreakdown, TokenMetrics


class CostEngine:
    """Calculates recovery cost breakdown, overhead percentage, and token metrics."""

    SOLARI_SNAPSHOT_UNIT_COST = 0.0001   # Estimated $ per snapshot
    SOLARI_FORK_UNIT_COST = 0.0002       # Estimated $ per fork
    SOLARI_STEP_EXEC_UNIT_COST = 0.00005  # Estimated $ per step execution

    @classmethod
    def calculate_cost(
        cls,
        original_steps: int,
        snapshots_count: int,
        forks_count: int,
        probes_count: int,
        replay_steps: int,
    ) -> CostBreakdown:
        original_execution_cost = original_steps * cls.SOLARI_STEP_EXEC_UNIT_COST

        failure_diagnosis_cost = (
            (snapshots_count * cls.SOLARI_SNAPSHOT_UNIT_COST)
            + (probes_count * cls.SOLARI_STEP_EXEC_UNIT_COST)
        )

        counterfactual_replay_cost = (
            (forks_count * cls.SOLARI_FORK_UNIT_COST)
            + (replay_steps * cls.SOLARI_STEP_EXEC_UNIT_COST)
        )

        verification_cost = 0.00002 * probes_count

        total_recovery_cost = (
            original_execution_cost
            + failure_diagnosis_cost
            + counterfactual_replay_cost
            + verification_cost
        )

        recovery_overhead = (
            failure_diagnosis_cost + counterfactual_replay_cost + verification_cost
        )

        recovery_overhead_pct = (
            (recovery_overhead / original_execution_cost * 100)
            if original_execution_cost > 0
            else 0.0
        )

        return CostBreakdown(
            original_execution_cost=original_execution_cost,
            failure_diagnosis_cost=failure_diagnosis_cost,
            counterfactual_replay_cost=counterfactual_replay_cost,
            verification_cost=verification_cost,
            total_recovery_cost=total_recovery_cost,
            recovery_overhead_pct=recovery_overhead_pct,
            cost_status="ESTIMATED",
        )

    @classmethod
    def get_deterministic_tokens(cls) -> TokenMetrics:
        """Returns honest token metrics for offline deterministic agent."""
        return TokenMetrics(
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
            token_status="UNAVAILABLE",
        )
