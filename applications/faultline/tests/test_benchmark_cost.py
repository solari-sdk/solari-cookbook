"""Unit tests for benchmark runner and cost engine."""

import unittest
import asyncio
from faultline.benchmark import BenchmarkRunner
from faultline.metrics import CostEngine


class TestBenchmarkAndCost(unittest.TestCase):
    def test_cost_calculation(self):
        cost = CostEngine.calculate_cost(
            original_steps=24,
            snapshots_count=24,
            forks_count=2,
            probes_count=5,
            replay_steps=8,
        )
        self.assertGreater(cost.total_recovery_cost, 0.0)
        self.assertGreater(cost.recovery_overhead_pct, 0.0)
        self.assertEqual(cost.cost_status, "ESTIMATED")

    def test_benchmark_runner(self):
        asyncio.run(self._test_benchmark_runner_async())

    async def _test_benchmark_runner_async(self):
        runner = BenchmarkRunner(backend_override="offline")
        bench_res = await runner.run_benchmark(scenarios=["wrong-owner"])
        self.assertIn("Linear", bench_res.metrics_by_strategy)
        self.assertIn("Binary", bench_res.metrics_by_strategy)


if __name__ == "__main__":
    unittest.main()
