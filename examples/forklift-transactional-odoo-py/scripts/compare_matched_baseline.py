"""Compare Forklift with the matched worker/self-report acceptance baseline."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TRIAL_DIR = PROJECT_ROOT / "artifacts" / "development" / "gui-trials"
OUTPUT_DIR = PROJECT_ROOT / "artifacts" / "development"


def screen_baseline_accepts(trial: dict[str, object]) -> bool:
    actions = trial.get("action_log")
    if not isinstance(actions, list) or not actions:
        return False
    sequences = [action.get("sequence") for action in actions]
    if sequences != list(range(len(actions))):
        return False
    # The host releases a zero-exit worker only after its completion marker.
    return trial.get("worker_exit_code") == 0


def compare(trial_dir: Path = TRIAL_DIR) -> dict[str, object]:
    rows: list[dict[str, object]] = []
    for path in sorted(trial_dir.glob("*.json")):
        trial = json.loads(path.read_text(encoding="utf-8"))
        checks = trial.get("oracle_checks")
        if not isinstance(checks, list) or not checks:
            continue
        oracle_accepted = all(check.get("passed") is True for check in checks)
        baseline_accepted = screen_baseline_accepts(trial)
        forklift_accepted = trial.get("accepted") is True
        rows.append(
            {
                "baseline_accepted": baseline_accepted,
                "baseline_false_acceptance": baseline_accepted and not oracle_accepted,
                "failed_codes": trial.get("failed_codes", []),
                "file": path.name,
                "forklift_accepted": forklift_accepted,
                "forklift_false_acceptance": forklift_accepted and not oracle_accepted,
                "oracle_accepted": oracle_accepted,
                "schedule": (trial.get("fault_schedule") or {}).get("schedule_id"),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    return {
        "baseline_contract": (
            "Same visible worker and case; accept when its ordered milestone log "
            "is complete and it exits zero after the host sees the completion marker."
        ),
        "counts": {
            "audited_matched_trials": len(rows),
            "baseline_false_acceptances": sum(
                bool(row["baseline_false_acceptance"]) for row in rows
            ),
            "forklift_false_acceptances": sum(
                bool(row["forklift_false_acceptance"]) for row in rows
            ),
        },
        "rows": rows,
        "version": "forklift-matched-baseline-v0",
    }


def main() -> int:
    result = compare()
    encoded = (json.dumps(result, indent=2, sort_keys=True) + "\n").encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    path = OUTPUT_DIR / f"matched-baseline-summary-{digest[:12]}.json"
    path.write_bytes(encoded)
    payload = {
        **result["counts"],
        "artifact": path.name,
        "sha256": digest,
    }
    print(json.dumps(payload, sort_keys=True))
    return 0 if result["counts"]["forklift_false_acceptances"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
