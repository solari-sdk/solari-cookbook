from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.materialize_held_out_cases import materialize
from scripts.run_held_out_development_campaign import freeze_plan


class HeldOutPlanTests(unittest.TestCase):
    def test_freezes_schedule_and_case_digests_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            materialize(
                seed="plan-test-seed",
                count=6,
                namespace="plan-test",
                output_dir=root,
            )
            plan = freeze_plan(root)
            self.assertEqual(len(plan["trials"]), 6)
            self.assertEqual(
                [row["schedule"] for row in plan["trials"]],
                [
                    "clean",
                    "clean",
                    "clean",
                    "clean",
                    "kill-after-receipt",
                    "wrong-unit-price",
                ],
            )
            self.assertEqual(len(plan["plan_digest"]), 64)
            self.assertNotIn("plan-test-seed", json.dumps(plan))


if __name__ == "__main__":
    unittest.main()
