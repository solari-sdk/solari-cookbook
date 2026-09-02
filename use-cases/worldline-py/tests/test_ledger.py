import unittest

from worldline.ledger import EXPECTED_LEDGER, candidate_ledger, verify_ledger


class LedgerTests(unittest.TestCase):
    def test_exact_update_passes_every_check(self) -> None:
        checks = verify_ledger(EXPECTED_LEDGER)
        self.assertTrue(all(check.passed for check in checks))

    def test_global_replace_detects_collateral_change(self) -> None:
        checks = {
            check.id: check
            for check in verify_ledger(candidate_ledger("global-replace"))
        }
        self.assertFalse(checks["northstar-unchanged"].passed)
        self.assertFalse(checks["exact-artifact"].passed)

    def test_lossy_edit_detects_missing_cost_center(self) -> None:
        checks = {
            check.id: check
            for check in verify_ledger(candidate_ledger("collateral-edit"))
        }
        self.assertFalse(checks["northstar-unchanged"].passed)


if __name__ == "__main__":
    unittest.main()
