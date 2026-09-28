"""Benchmark Runner for Fault Line."""

from __future__ import annotations

import json
import time
from pathlib import Path

from .agent import DeterministicAgent
from .fault_injection import SCENARIOS, get_fault_scenario
from .localization import FaultLocalizer
from .metrics import CostEngine
from .models import BenchmarkRunResult
from .repair import CounterfactualRepairEngine
from .solari_adapter import SolariSandboxAdapter


class BenchmarkRunner:
    """Runs automated benchmarks comparing Linear, Binary, Parallel, and Adaptive strategies."""

    def __init__(
        self,
        output_dir: Path | None = None,
        backend_override: str | None = None,
    ):
        if output_dir is None:
            output_dir = Path(__file__).parent.parent / "results"
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.backend_override = backend_override

    async def run_benchmark(
        self, scenarios: list[str] | None = None, seed: int = 42
    ) -> BenchmarkRunResult:
        if scenarios is None:
            scenarios = list(SCENARIOS.keys())

        experiment_id = f"exp-bench-{int(time.time())}"
        metrics_by_strategy: dict[str, dict] = {}
        cost_by_strategy: dict[str, dict] = {}

        strategies = ["Linear", "Binary", "Parallel", "Adaptive"]
        for strat in strategies:
            metrics_by_strategy[strat] = {
                "probes_count": 0,
                "localization_time_ms": 0.0,
                "forks_count": 0,
                "snapshots_count": 0,
                "verification_time_ms": 0.0,
                "runs_evaluated": 0,
            }

        for scenario_name in scenarios:
            scenario = get_fault_scenario(scenario_name)
            adapter = SolariSandboxAdapter(backend_override=self.backend_override)
            agent = DeterministicAgent(adapter)

            run_id = f"bench-{scenario_name}"
            run_rec = await agent.run_workload(run_id, scenario)

            # Re-create checkpoint manager from run record
            from .checkpoint import CheckpointManager
            chk_mgr = CheckpointManager(run_id)
            chk_mgr.checkpoints = run_rec.checkpoints
            for chk in run_rec.checkpoints:
                chk_mgr._by_id[chk.checkpoint_id] = chk

            localizer = FaultLocalizer(adapter)
            sbx_id = "sbx-bench-main"

            for strat in strategies:
                if strat == "Linear":
                    res = await localizer.linear_search(chk_mgr, sbx_id)
                elif strat == "Binary":
                    res = await localizer.binary_search(chk_mgr, sbx_id)
                elif strat == "Parallel":
                    res = await localizer.parallel_search(chk_mgr, sbx_id)
                else:
                    res = await localizer.adaptive_search(chk_mgr, sbx_id)

                m = metrics_by_strategy[strat]
                m["probes_count"] += res.probes_count
                m["localization_time_ms"] += res.localization_time_ms
                m["forks_count"] += res.forks_count
                m["snapshots_count"] += res.snapshots_count
                m["verification_time_ms"] += res.verification_time_ms
                m["runs_evaluated"] += 1

            await adapter.cleanup_all()

        # Average metrics across scenarios
        for strat in strategies:
            m = metrics_by_strategy[strat]
            n = m["runs_evaluated"] or 1
            m["probes_count"] = round(m["probes_count"] / n, 1)
            m["localization_time_ms"] = round(m["localization_time_ms"] / n, 2)
            m["forks_count"] = round(m["forks_count"] / n, 1)
            m["snapshots_count"] = round(m["snapshots_count"] / n, 1)
            m["verification_time_ms"] = round(m["verification_time_ms"] / n, 2)

            cost = CostEngine.calculate_cost(
                original_steps=24,
                snapshots_count=int(m["snapshots_count"]),
                forks_count=int(m["forks_count"]),
                probes_count=int(m["probes_count"]),
                replay_steps=8,
            )
            cost_by_strategy[strat] = cost.to_dict()

        bench_result = BenchmarkRunResult(
            experiment_id=experiment_id,
            scenario_name=f"all ({len(scenarios)} scenarios)",
            seed=seed,
            metrics_by_strategy=metrics_by_strategy,
            cost_by_strategy=cost_by_strategy,
            timestamp=time.time(),
        )

        out_path = self.output_dir / "benchmark.json"
        out_path.write_text(
            json.dumps(
                {
                    "experiment_id": experiment_id,
                    "seed": seed,
                    "scenarios": scenarios,
                    "metrics_by_strategy": metrics_by_strategy,
                    "cost_by_strategy": cost_by_strategy,
                    "timestamp": bench_result.timestamp,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        return bench_result
