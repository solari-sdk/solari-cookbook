"""Unit tests for FastAPI server endpoints in Fault Line."""

import unittest
import asyncio
import os
from fastapi import HTTPException
from fastapi.testclient import TestClient
from faultline.server import (
    app,
    RUN_STORE,
    CHECKPOINT_MGR_STORE,
    ADAPTER_STORE,
    get_run_diff,
    repair_run,
)
from faultline.agent import DeterministicAgent
from faultline.checkpoint import CheckpointManager
from faultline.solari_adapter import SolariSandboxAdapter

# Force offline backend for all server tests
os.environ["FAULTLINE_BACKEND"] = "offline"

client = TestClient(app)


class TestServerEndpoints(unittest.TestCase):
    def test_diff_and_repair_no_fault_boundary(self):
        asyncio.run(self._test_no_fault_boundary_async())

    async def _test_no_fault_boundary_async(self):
        adapter = SolariSandboxAdapter(backend_override="offline")
        agent = DeterministicAgent(adapter)

        # Run normal workload without fault scenario -> verifier passes, fault_boundary_step is None
        run_rec = await agent.run_workload("test-no-fault", scenario=None)
        self.assertIsNone(run_rec.fault_boundary_step)

        RUN_STORE["test-no-fault"] = run_rec
        ADAPTER_STORE["test-no-fault"] = adapter

        chk_mgr = CheckpointManager("test-no-fault")
        chk_mgr.checkpoints = run_rec.checkpoints
        for chk in run_rec.checkpoints:
            chk_mgr._by_id[chk.checkpoint_id] = chk
        CHECKPOINT_MGR_STORE["test-no-fault"] = chk_mgr

        # Attempt /api/diff when fault_boundary_step is None -> expect HTTPException 400
        with self.assertRaises(HTTPException) as ctx_diff:
            await get_run_diff("test-no-fault")
        self.assertEqual(ctx_diff.exception.status_code, 400)
        self.assertIn("No fault boundary step", ctx_diff.exception.detail)

        # Attempt /api/repair when fault_boundary_step is None -> expect HTTPException 400
        with self.assertRaises(HTTPException) as ctx_repair:
            await repair_run("test-no-fault")
        self.assertEqual(ctx_repair.exception.status_code, 400)
        self.assertIn("No fault boundary step", ctx_repair.exception.detail)

        await adapter.cleanup_all()

    def test_full_api_workflow(self):
        # 1. /api/run
        res_run = client.post("/api/run", json={"scenario": "wrong-owner"})
        self.assertEqual(res_run.status_code, 200)
        run_data = res_run.json()
        run_id = run_data["run_id"]
        self.assertEqual(run_data["verifier_status"], "FAILED")
        self.assertEqual(run_data["fault_boundary_step"], 17)

        # 2. /api/runs and /api/runs/{run_id}
        res_list = client.get("/api/runs")
        self.assertEqual(res_list.status_code, 200)
        self.assertGreaterEqual(len(res_list.json()), 1)

        res_get = client.get(f"/api/runs/{run_id}")
        self.assertEqual(res_get.status_code, 200)

        # 3. /api/diagnose/{run_id}
        res_diag = client.post(f"/api/diagnose/{run_id}", json={"strategy": "Binary"})
        self.assertEqual(res_diag.status_code, 200)
        diag_data = res_diag.json()
        self.assertIn("strategy_result", diag_data)

        # 4. /api/diff/{run_id}
        res_diff = client.get(f"/api/diff/{run_id}")
        self.assertEqual(res_diff.status_code, 200)
        diff_data = res_diff.json()
        self.assertIn("state_diff", diff_data)

        # 5. /api/repair/{run_id}
        res_repair = client.post(f"/api/repair/{run_id}")
        self.assertEqual(res_repair.status_code, 200)
        rep_data = res_repair.json()
        self.assertEqual(rep_data["verification_result"]["passed"], True)

        # 6. /api/cases
        res_cases = client.get("/api/cases")
        self.assertEqual(res_cases.status_code, 200)
        cases = res_cases.json()
        self.assertGreaterEqual(len(cases), 1)
        case_id = cases[0]["case_id"]

        # 7. /api/cases/replay/{case_id}
        res_replay = client.post(f"/api/cases/replay/{case_id}")
        self.assertEqual(res_replay.status_code, 200)


if __name__ == "__main__":
    unittest.main()
