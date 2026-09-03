"""One-command verification of Forklift's developmental evidence chain."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from scripts.summarize_development_campaign import summarize


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LEDGER_PATH = PROJECT_ROOT.parents[2] / ".research" / "epistemic-ledger.jsonl"


def verify_ledger(path: Path) -> tuple[int, str]:
    previous = "0" * 64
    count = 0
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        record = json.loads(line)
        if record.get("previous_hash") != previous:
            raise ValueError(f"ledger previous-hash mismatch at line {line_number}")
        expected = record.pop("event_hash", None)
        actual = hashlib.sha256(
            json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        if expected != actual:
            raise ValueError(f"ledger event-hash mismatch at line {line_number}")
        previous = actual
        count += 1
    if count == 0:
        raise ValueError("ledger is empty")
    return count, previous


def main() -> int:
    try:
        ledger_events, ledger_head = verify_ledger(LEDGER_PATH)
        campaign = summarize()
        counts = campaign["counts"]
        useful = counts["valid_candidates"] > 0 and counts["safe_refusals"] > 0
        verified = campaign["hard_gate_passed"] and useful
        payload = {
            "audited_trials": counts["audited_trials"],
            "evidence": "VERIFIED" if verified else "FAILED",
            "false_acceptances": counts["false_acceptances"],
            "inconclusive_trials": counts["inconclusive_trials"],
            "ledger_events": ledger_events,
            "ledger_head": ledger_head,
            "safe_refusals": counts["safe_refusals"],
            "scope": "developmental_including_held_out_cases_not_final",
            "valid_candidates": counts["valid_candidates"],
        }
    except Exception as exc:
        payload = {
            "evidence": "FAILED",
            "error": f"{type(exc).__name__}: {exc}",
        }
        verified = False
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if verified else 1


if __name__ == "__main__":
    raise SystemExit(main())
