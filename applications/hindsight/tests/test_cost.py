"""Cost accounting. Estimates only: the rate table moves."""

from __future__ import annotations

import unittest

from hindsight.cost import INPUT_PER_MTOK, OUTPUT_PER_MTOK, estimate_cost


class CostTests(unittest.TestCase):
    def test_a_million_input_tokens_costs_the_input_rate(self) -> None:
        self.assertAlmostEqual(estimate_cost(1_000_000, 0), INPUT_PER_MTOK)

    def test_a_million_output_tokens_costs_the_output_rate(self) -> None:
        self.assertAlmostEqual(estimate_cost(0, 1_000_000), OUTPUT_PER_MTOK)

    def test_output_tokens_cost_more_than_input_tokens(self) -> None:
        self.assertGreater(estimate_cost(0, 1000), estimate_cost(1000, 0))
