from __future__ import annotations

import unittest

from scripts.run_held_out_continuation import retryable_pre_mutation_failure


class HeldOutContinuationTests(unittest.TestCase):
    def test_retries_only_recorded_pre_mutation_failures(self) -> None:
        self.assertTrue(
            retryable_pre_mutation_failure(
                {
                    "trial": "failed",
                    "business_mutation_observed": False,
                    "fault_triggered": [],
                }
            )
        )
        self.assertFalse(
            retryable_pre_mutation_failure(
                {
                    "trial": "failed",
                    "business_mutation_observed": True,
                    "fault_triggered": [],
                }
            )
        )
        self.assertFalse(
            retryable_pre_mutation_failure(
                {
                    "trial": "failed",
                    "business_mutation_observed": False,
                    "fault_triggered": ["kill_worker@receipt_validated"],
                }
            )
        )
        self.assertFalse(
            retryable_pre_mutation_failure(
                {
                    "trial": "completed",
                    "business_mutation_observed": False,
                    "fault_triggered": [],
                }
            )
        )


if __name__ == "__main__":
    unittest.main()
