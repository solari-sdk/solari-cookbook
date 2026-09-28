"""Unit tests for fault localization strategies."""

import unittest
import asyncio
from faultline.agent import DeterministicAgent
from faultline.checkpoint import CheckpointManager
from faultline.fault_injection import get_fault_scenario
from faultline.localization import FaultLocalizer
from faultline.solari_adapter import SolariSandboxAdapter


class TestFaultLocalization(unittest.TestCase):
    def test_search_strategies(self):
        asyncio.run(self._test_search_strategies_async())

    async def _test_search_strategies_async(self):
        adapter = SolariSandboxAdapter()
        agent = DeterministicAgent(adapter)
        scenario = get_fault_scenario("wrong-owner")

        run_rec = await agent.run_workload("test-loc-run", scenario)
        chk_mgr = CheckpointManager("test-loc-run")
        chk_mgr.checkpoints = run_rec.checkpoints
        for chk in run_rec.checkpoints:
            chk_mgr._by_id[chk.checkpoint_id] = chk

        localizer = FaultLocalizer(adapter)

        # 1. Linear Search
        linear_res = await localizer.linear_search(chk_mgr, "sbx-test")
        self.assertEqual(linear_res.first_invalid_step, 17)

        # 2. Binary Search
        binary_res = await localizer.binary_search(chk_mgr, "sbx-test")
        self.assertEqual(binary_res.first_invalid_step, 17)
        self.assertLessEqual(binary_res.probes_count, linear_res.probes_count)

        # 3. Parallel Search
        parallel_res = await localizer.parallel_search(chk_mgr, "sbx-test")
        self.assertEqual(parallel_res.first_invalid_step, 17)

        # 4. Adaptive Search
        adaptive_res = await localizer.adaptive_search(chk_mgr, "sbx-test")
        self.assertEqual(adaptive_res.first_invalid_step, 17)

        await adapter.cleanup_all()


if __name__ == "__main__":
    unittest.main()
