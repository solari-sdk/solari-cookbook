from __future__ import annotations

import unittest
from dataclasses import replace
from decimal import Decimal

from forklift.faults import DEVELOPMENT_SCHEDULES
from scripts.bootstrap_solari_canonical import _load_case
from scripts.run_solari_clean_gui_trial import (
    CASE_PATH,
    FULL_MILESTONES,
    _expected_acceptance,
    _expected_milestones,
    _worker_fault_controls,
)


def schedule(schedule_id: str):
    return next(item for item in DEVELOPMENT_SCHEDULES if item.schedule_id == schedule_id)


class TrialProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.case = _load_case(CASE_PATH)

    def test_full_paid_case_requires_every_milestone(self) -> None:
        self.assertEqual(_expected_milestones(self.case), FULL_MILESTONES)

    def test_zero_receipt_stops_after_confirmed_purchase_order(self) -> None:
        zero = replace(self.case, received_qty=Decimal("0"))
        self.assertEqual(_expected_milestones(zero), FULL_MILESTONES[:3])

    def test_wrong_price_changes_only_untrusted_worker_input(self) -> None:
        overrides, duplicates = _worker_fault_controls(
            schedule("wrong-unit-price"), self.case
        )
        self.assertEqual(overrides, {"unit_price": "12.36"})
        self.assertEqual(duplicates, [])
        self.assertEqual(self.case.unit_price, Decimal("12.35"))

    def test_wrong_quantity_uses_ordered_quantity(self) -> None:
        overrides, _ = _worker_fault_controls(
            schedule("wrong-received-quantity"), self.case
        )
        self.assertEqual(overrides, {"received_qty": "10"})

    def test_precommitted_acceptance_expectations(self) -> None:
        self.assertIs(_expected_acceptance(schedule("clean")), True)
        self.assertIs(_expected_acceptance(schedule("timeout-before-payment")), True)
        self.assertIs(_expected_acceptance(schedule("kill-after-receipt")), False)
        self.assertIs(_expected_acceptance(schedule("wrong-unit-price")), False)
        self.assertIsNone(_expected_acceptance(schedule("duplicate-payment")))


if __name__ == "__main__":
    unittest.main()
