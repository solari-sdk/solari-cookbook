"""Fault injection tests verifying all 5 fault scenarios produce expected failures."""

import unittest
import asyncio
from faultline.agent import DeterministicAgent
from faultline.fault_injection import SCENARIOS, get_fault_scenario
from faultline.solari_adapter import SolariSandboxAdapter


class TestFaultInjection(unittest.TestCase):
    def test_all_scenarios_produce_failures(self):
        for scenario_name in SCENARIOS.keys():
            with self.subTest(scenario=scenario_name):
                asyncio.run(self._assert_scenario_fails(scenario_name))

    async def _assert_scenario_fails(self, scenario_name: str):
        adapter = SolariSandboxAdapter()
        agent = DeterministicAgent(adapter)
        scenario = get_fault_scenario(scenario_name)

        run_rec = await agent.run_workload(f"test-{scenario_name}", scenario)
        self.assertEqual(run_rec.verifier_status, "FAILED")
        self.assertFalse(run_rec.verification.passed)
        self.assertGreater(len(run_rec.verification.failed_invariants), 0)
        await adapter.cleanup_all()


if __name__ == "__main__":
    unittest.main()
