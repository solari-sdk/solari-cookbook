"""Unit tests for regression case store."""

import unittest
from pathlib import Path
from faultline.diff_engine import StateDiffEngine
from faultline.models import RegressionCase, RepairAction, VerificationResult
from faultline.regression import RegressionCaseStore
from faultline.workload import CRMWorkloadStore


class TestRegression(unittest.TestCase):
    def test_regression_case_save_and_load(self):
        tmp_path = Path(__file__).parent / "tmp_cases.json"
        if tmp_path.exists():
            tmp_path.unlink()

        store = RegressionCaseStore(store_path=tmp_path)

        store_good = CRMWorkloadStore(":memory:")
        store_good.create_lead("Acme", "a@acme.com", "Acme", "Alice", "new")
        store_bad = store_good.clone_to_memory()
        store_bad.assign_owner(1, "Bob")
        diff = StateDiffEngine.compare_stores("chk-1", "chk-2", store_good, store_bad)

        reg_case = RegressionCase(
            case_id="case-test-1",
            scenario="wrong-owner",
            original_run_id="FL-001",
            fault_boundary_step=17,
            last_good_checkpoint_id="chk-16",
            first_bad_checkpoint_id="chk-17",
            failed_invariants=["lead_1_owner_matches_expected"],
            state_diff=diff,
            repair_action=RepairAction("chk-16", 17, "assign_owner", {}, "Fix owner"),
            repaired_result=VerificationResult(True, [], []),
        )

        store.save_case(reg_case)
        loaded = store.get_case("case-test-1")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["scenario"], "wrong-owner")

        if tmp_path.exists():
            tmp_path.unlink()


if __name__ == "__main__":
    unittest.main()
