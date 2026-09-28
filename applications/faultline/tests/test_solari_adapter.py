"""Integration tests for Solari Sandbox adapter."""

import unittest
import asyncio
from faultline.solari_adapter import SolariSandboxAdapter


class TestSolariAdapter(unittest.TestCase):
    def test_snapshot_fork_flow(self):
        asyncio.run(self._test_snapshot_fork_flow_async())

    async def _test_snapshot_fork_flow_async(self):
        adapter = SolariSandboxAdapter(backend_override="offline")

        # 1. Create sandbox & store state
        sbx_id, store = await adapter.create_sandbox(template="base")
        store.create_lead("Acme", "a@acme.com", "Acme Corp", "Alice", "new")

        # 2. Take snapshot
        snap_id = await adapter.create_snapshot(sbx_id, store, "base-snap")
        self.assertIn("snap-base-snap-", snap_id)

        # 3. Fork sandbox from snapshot
        fork_id, fork_store = await adapter.create_sandbox(from_snapshot=snap_id)
        leads = fork_store.get_all_leads()
        self.assertEqual(len(leads), 1)
        self.assertEqual(leads[0].company, "Acme Corp")

        # 4. Cleanup
        await adapter.cleanup_all()


if __name__ == "__main__":
    unittest.main()
