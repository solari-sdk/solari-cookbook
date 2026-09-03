from __future__ import annotations

import unittest

from forklift.odoo_sql import _unexpected_census_ids


class CensusTests(unittest.TestCase):
    def test_empty_duplicate_purchase_order_cannot_disappear_in_joins(self) -> None:
        result = _unexpected_census_ids(
            {"purchase.order": (101, 102)},
            {"purchase.order": (101,)},
        )
        self.assertEqual(result, ("purchase.order:102:evidence-rows=0",))

    def test_duplicate_detail_rows_are_rejected(self) -> None:
        result = _unexpected_census_ids(
            {"account.move:in_invoice": (301,)},
            {"account.move:in_invoice": (301, 301)},
        )
        self.assertEqual(
            result,
            ("account.move:in_invoice:301:evidence-rows=2",),
        )


if __name__ == "__main__":
    unittest.main()
