"""Recompute the developmental GUI campaign summary from raw trial artifacts."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TRIAL_DIR = PROJECT_ROOT / "artifacts" / "development" / "gui-trials"
SUMMARY_PATH = PROJECT_ROOT / "artifacts" / "development" / "gui-campaign-summary.json"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize() -> dict[str, object]:
    rows: list[dict[str, object]] = []
    for path in sorted(TRIAL_DIR.glob("*.json")):
        trial = json.loads(path.read_text(encoding="utf-8"))
        checks = trial.get("oracle_checks")
        audited = isinstance(checks, list) and bool(checks)
        oracle_accepted = (
            audited
            and all(check.get("passed") is True for check in checks)
        )
        selected = trial.get("accepted") is True
        rows.append(
            {
                "accepted_by_oracle": oracle_accepted if audited else None,
                "audited": audited,
                "failed_codes": trial.get("failed_codes", []),
                "false_acceptance": bool(audited and selected and not oracle_accepted),
                "file": path.name,
                "protocol_passed": trial.get("protocol_passed") is True,
                "schedule": (
                    (trial.get("fault_schedule") or {}).get("schedule_id")
                    or trial.get("schedule")
                ),
                "selected": selected,
                "sha256": _sha256(path),
            }
        )

    audited_rows = [row for row in rows if row["audited"]]
    false_acceptances = sum(bool(row["false_acceptance"]) for row in rows)
    valid_candidates = sum(
        bool(row["accepted_by_oracle"] and row["selected"])
        for row in audited_rows
    )
    safe_refusals = sum(
        bool(row["accepted_by_oracle"] is False and row["selected"] is False)
        for row in audited_rows
    )
    inconclusive = sum(not bool(row["audited"]) for row in rows)
    return {
        "claim_scope": (
            "Developmental fixed-fixture trials only; not a sealed hidden-seed "
            "campaign or independent replication."
        ),
        "counts": {
            "audited_trials": len(audited_rows),
            "false_acceptances": false_acceptances,
            "inconclusive_trials": inconclusive,
            "safe_refusals": safe_refusals,
            "trial_artifacts": len(rows),
            "valid_candidates": valid_candidates,
        },
        "hard_gate_passed": false_acceptances == 0,
        "rows": rows,
        "summary_version": "forklift-development-campaign-v0",
    }


def main() -> int:
    summary = summarize()
    SUMMARY_PATH.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    versioned_path = SUMMARY_PATH.with_name(
        f"{SUMMARY_PATH.stem}-{digest[:12]}{SUMMARY_PATH.suffix}"
    )
    raw = encoded.encode("utf-8")
    SUMMARY_PATH.write_bytes(raw)
    # Write exact bytes so the content-address in the filename is portable
    # across Windows and POSIX newline conventions.
    versioned_path.write_bytes(raw)
    print(
        json.dumps(
            {
                **summary["counts"],
                "summary_sha256": digest,
                "versioned_artifact": versioned_path.name,
            },
            sort_keys=True,
        )
    )
    return 0 if summary["hard_gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
