from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import summarize_development_campaign as campaign


class CampaignSummaryTests(unittest.TestCase):
    def write_trial(self, root: Path, name: str, payload: dict) -> None:
        (root / name).write_text(json.dumps(payload), encoding="utf-8")

    def test_recomputes_zero_false_acceptances_and_excludes_inconclusive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_trial(
                root,
                "valid.json",
                {
                    "accepted": True,
                    "oracle_checks": [{"passed": True}],
                    "failed_codes": [],
                    "protocol_passed": True,
                    "fault_schedule": {"schedule_id": "clean"},
                },
            )
            self.write_trial(
                root,
                "refused.json",
                {
                    "accepted": False,
                    "oracle_checks": [{"passed": False}],
                    "failed_codes": ["bill-count"],
                    "protocol_passed": True,
                    "fault_schedule": {"schedule_id": "kill-after-receipt"},
                },
            )
            self.write_trial(root, "unknown.json", {"accepted": False})
            with patch.object(campaign, "TRIAL_DIR", root):
                result = campaign.summarize()
            self.assertEqual(
                result["counts"],
                {
                    "audited_trials": 2,
                    "false_acceptances": 0,
                    "inconclusive_trials": 1,
                    "safe_refusals": 1,
                    "trial_artifacts": 3,
                    "valid_candidates": 1,
                },
            )
            self.assertTrue(result["hard_gate_passed"])

    def test_detects_selected_oracle_rejection_as_false_acceptance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_trial(
                root,
                "bad.json",
                {
                    "accepted": True,
                    "oracle_checks": [{"passed": False}],
                    "failed_codes": ["payment-count"],
                    "protocol_passed": False,
                    "fault_schedule": {"schedule_id": "bad"},
                },
            )
            with patch.object(campaign, "TRIAL_DIR", root):
                result = campaign.summarize()
            self.assertEqual(result["counts"]["false_acceptances"], 1)
            self.assertFalse(result["hard_gate_passed"])


if __name__ == "__main__":
    unittest.main()
