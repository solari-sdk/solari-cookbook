"""Benchmark aggregation. LLM runs vary, so a single number is never enough."""

from __future__ import annotations

import unittest

from hindsight.bench import RunResult, summarise


def _run(arm: str, *, solved: bool = True, turns: int = 5, cost: float = 0.2) -> RunResult:
    return RunResult(
        task="ledger-migration",
        arm=arm,
        solved=solved,
        turns=turns,
        tool_calls=turns * 2,
        input_tokens=1000,
        output_tokens=100,
        cost=cost,
        rewinds=0,
        seconds=10.0,
        error=None,
    )


class SummariseTests(unittest.TestCase):
    def test_reports_the_median_not_the_best_run(self) -> None:
        runs = [
            _run("hindsight", cost=0.10),
            _run("hindsight", cost=0.20),
            _run("hindsight", cost=0.90),
        ]

        summary = summarise(runs)["hindsight"]

        self.assertAlmostEqual(summary.median_cost, 0.20)

    def test_reports_the_spread_so_variance_is_visible(self) -> None:
        runs = [_run("none", cost=0.10), _run("none", cost=0.90)]

        summary = summarise(runs)["none"]

        self.assertAlmostEqual(summary.min_cost, 0.10)
        self.assertAlmostEqual(summary.max_cost, 0.90)

    def test_success_rate_counts_only_independently_verified_solves(self) -> None:
        runs = [
            _run("rebuild", solved=True),
            _run("rebuild", solved=False),
            _run("rebuild", solved=True),
            _run("rebuild", solved=False),
        ]

        summary = summarise(runs)["rebuild"]

        self.assertEqual(summary.solved, 2)
        self.assertEqual(summary.n, 4)
        self.assertAlmostEqual(summary.success_rate, 0.5)

    def test_arms_are_summarised_independently(self) -> None:
        runs = [_run("none", turns=9), _run("hindsight", turns=3)]

        summary = summarise(runs)

        self.assertEqual(summary["none"].median_turns, 9)
        self.assertEqual(summary["hindsight"].median_turns, 3)

    def test_a_failed_run_still_counts_toward_cost(self) -> None:
        # Otherwise an arm that fails expensively looks cheap.
        runs = [_run("none", solved=False, cost=0.5)]

        self.assertAlmostEqual(summarise(runs)["none"].median_cost, 0.5)


if __name__ == "__main__":
    unittest.main()
