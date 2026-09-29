"""End-to-end recovery test demonstrating FAIL -> LOCALIZE -> REPAIR -> REPLAY -> PASS."""

import unittest
import asyncio
from faultline.agent import DeterministicAgent
from faultline.checkpoint import CheckpointManager
from faultline.fault_injection import get_fault_scenario
from faultline.localization import FaultLocalizer
from faultline.repair import CounterfactualRepairEngine
from faultline.solari_adapter import SolariSandboxAdapter


class TestRepairReplay(unittest.TestCase):
    def test_end_to_end_recovery_flow(self):
        asyncio.run(self._test_recovery_flow_async())

    async def _test_recovery_flow_async(self):
        adapter = SolariSandboxAdapter()
        agent = DeterministicAgent(adapter)
        scenario = get_fault_scenario("wrong-owner")

        # 1. RUN workload (Fails at verifier)
        run_rec = await agent.run_workload("recovery-run", scenario)
        self.assertEqual(run_rec.verifier_status, "FAILED")

        # 2. LOCALIZE first bad checkpoint
        chk_mgr = CheckpointManager("recovery-run")
        chk_mgr.checkpoints = run_rec.checkpoints
        for chk in run_rec.checkpoints:
            chk_mgr._by_id[chk.checkpoint_id] = chk

        localizer = FaultLocalizer(adapter)
        loc_res = await localizer.binary_search(chk_mgr, "sbx-rec")
        bad_step = loc_res.first_invalid_step
        self.assertEqual(bad_step, 17)

        # 3. REPAIR & REPLAY
        chk_good = chk_mgr.get_by_step(bad_step - 1)
        chk_bad = chk_mgr.get_by_step(bad_step)

        repair_engine = CounterfactualRepairEngine(adapter)
        act, v_res, _ = await repair_engine.execute_repair(
            chk_mgr, chk_good, chk_bad, scenario.name
        )

        # 4. VERIFY repaired state PASS ✓
        self.assertTrue(v_res.passed)
        self.assertEqual(len(v_res.failed_invariants), 0)

        await adapter.cleanup_all()


if __name__ == "__main__":
    unittest.main()
