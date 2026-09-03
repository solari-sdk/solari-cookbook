from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.compare_matched_baseline import compare, screen_baseline_accepts


class MatchedBaselineTests(unittest.TestCase):
    def test_zero_exit_complete_worker_is_accepted_by_screen_baseline(self) -> None:
        trial = {
            "action_log": [
                {"sequence": 0, "milestone": "before_login"},
                {"sequence": 1, "milestone": "po_draft_saved"},
            ],
            "worker_exit_code": 0,
        }
        self.assertTrue(screen_baseline_accepts(trial))
        self.assertFalse(screen_baseline_accepts({**trial, "worker_exit_code": 1}))

    def test_detects_bad_state_the_worker_reported_complete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = {
                "accepted": False,
                "action_log": [{"sequence": 0, "milestone": "before_login"}],
                "failed_codes": ["po-unit_price"],
                "fault_schedule": {"schedule_id": "wrong-unit-price"},
                "oracle_checks": [{"code": "po-unit_price", "passed": False}],
                "worker_exit_code": 0,
            }
            (root / "bad.json").write_text(json.dumps(payload), encoding="utf-8")
            result = compare(root)
            self.assertEqual(result["counts"]["baseline_false_acceptances"], 1)
            self.assertEqual(result["counts"]["forklift_false_acceptances"], 0)


if __name__ == "__main__":
    unittest.main()
