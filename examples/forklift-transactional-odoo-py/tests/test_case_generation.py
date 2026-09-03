from __future__ import annotations

import unittest

from forklift.case_generation import (
    TAX_RATES,
    case_digest,
    generate_cases,
    manifest_digest,
)


class CaseGenerationTests(unittest.TestCase):
    def test_same_seed_is_exactly_reproducible(self) -> None:
        first = generate_cases(seed="alpha", count=12, namespace="dev")
        second = generate_cases(seed="alpha", count=12, namespace="dev")
        self.assertEqual(first, second)
        self.assertEqual(manifest_digest(first), manifest_digest(second))

    def test_different_seed_changes_manifest(self) -> None:
        first = generate_cases(seed="alpha", count=12, namespace="dev")
        second = generate_cases(seed="beta", count=12, namespace="dev")
        self.assertNotEqual(manifest_digest(first), manifest_digest(second))

    def test_balances_zero_partial_and_full_receipts(self) -> None:
        cases = generate_cases(seed="alpha", count=12, namespace="dev")
        self.assertTrue(any(case.received_qty == 0 for case in cases))
        self.assertTrue(any(0 < case.received_qty < case.ordered_qty for case in cases))
        self.assertTrue(any(case.received_qty == case.ordered_qty for case in cases))

    def test_uses_only_preseeded_tax_rates(self) -> None:
        cases = generate_cases(seed="alpha", count=30, namespace="dev")
        self.assertTrue(set(case.tax_rate for case in cases).issubset(set(TAX_RATES)))
        self.assertEqual(set(case.tax_rate for case in cases), set(TAX_RATES))

    def test_case_and_manifest_digests_are_sha256(self) -> None:
        cases = generate_cases(seed="alpha", count=3, namespace="dev")
        self.assertEqual(len(case_digest(cases[0])), 64)
        self.assertEqual(len(manifest_digest(cases)), 64)

    def test_rejects_invalid_generator_parameters(self) -> None:
        with self.assertRaises(ValueError):
            generate_cases(seed="", count=1, namespace="dev")
        with self.assertRaises(ValueError):
            generate_cases(seed="alpha", count=0, namespace="dev")
        with self.assertRaises(ValueError):
            generate_cases(seed="alpha", count=1, namespace="not valid")


if __name__ == "__main__":
    unittest.main()
