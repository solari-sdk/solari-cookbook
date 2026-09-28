"""Live Solari integration test skipped when SOLARI_API_KEY is not set."""

import os
import unittest
import asyncio
from faultline.solari_adapter import HAS_SOLARI_SDK, LiveSolariAdapter


class TestLiveSolariAdapter(unittest.TestCase):
    def test_live_solari_snapshot_and_fork(self):
        run_live = os.getenv("FAULTLINE_RUN_LIVE_TESTS") == "1"
        api_key = os.getenv("SOLARI_API_KEY")
        if not run_live or not api_key or not HAS_SOLARI_SDK:
            self.skipTest("FAULTLINE_RUN_LIVE_TESTS!=1, SOLARI_API_KEY not provided, or solari-sandbox SDK missing; skipping live test.")

        asyncio.run(self._test_live_flow_async(api_key))

    async def _test_live_flow_async(self, api_key: str):
        adapter = LiveSolariAdapter(api_key=api_key)
        self.assertEqual(adapter.backend_name, "Solari")
        self.assertTrue(adapter.is_live)

        # 1. Create live sandbox
        sbx_id, store = await adapter.create_sandbox(template="base")
        self.assertTrue(isinstance(sbx_id, str) and len(sbx_id) > 0)
        store.create_lead("Live Acme", "live@acme.com", "Acme Corp", "Alice", "qualified")

        # 2. Take live snapshot
        snapshot_id = await adapter.create_snapshot(sbx_id, store, "live-test-snap")
        self.assertTrue(isinstance(snapshot_id, str) and len(snapshot_id) > 0)

        # 3. Create live fork from snapshot
        fork_id, fork_store = await adapter.create_sandbox(from_snapshot=snapshot_id)
        self.assertTrue(isinstance(fork_id, str) and len(fork_id) > 0)
        leads = fork_store.get_all_leads()
        self.assertEqual(len(leads), 1)
        self.assertEqual(leads[0].company, "Acme Corp")

        # 4. Clean up resources
        await adapter.cleanup_all()


if __name__ == "__main__":
    unittest.main()
