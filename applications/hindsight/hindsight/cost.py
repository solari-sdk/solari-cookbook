"""Token cost estimates.

Rates are Claude Opus 5 list price and are kept in one place because they move.
Everything here is an estimate, not a bill.
"""

from __future__ import annotations

INPUT_PER_MTOK = 5.00
OUTPUT_PER_MTOK = 25.00


def estimate_cost(input_tokens: int, output_tokens: int) -> float:
    return (
        input_tokens / 1_000_000 * INPUT_PER_MTOK
        + output_tokens / 1_000_000 * OUTPUT_PER_MTOK
    )
