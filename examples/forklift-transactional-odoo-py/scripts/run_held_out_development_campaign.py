"""Freeze and optionally execute a balanced developmental held-out campaign."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from forklift.case_generation import case_digest, manifest_digest
from forklift.faults import DEVELOPMENT_SCHEDULES
from scripts.bootstrap_solari_canonical import _load_case
from scripts.run_solari_clean_gui_trial import _run


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASE_DIR = PROJECT_ROOT / "artifacts" / "development" / "held-out-cases"
DEFAULT_PLAN = PROJECT_ROOT / "artifacts" / "development" / "held-out-plan.json"
DEFAULT_REPORT = PROJECT_ROOT / "artifacts" / "development" / "held-out-run-report.json"

SCHEDULE_BY_POSITION = (
    "clean",                 # unseen zero liveness
    "clean",                 # unseen partial liveness
    "clean",                 # unseen full liveness
    "clean",                 # repeated unseen zero liveness
    "kill-after-receipt",    # unseen partial crash safety
    "wrong-unit-price",      # unseen full semantic-mutation safety
)


def freeze_plan(case_dir: Path) -> dict[str, object]:
    source = json.loads((case_dir / "manifest.json").read_text(encoding="utf-8"))
    if len(source["cases"]) != len(SCHEDULE_BY_POSITION):
        raise ValueError("held-out plan requires exactly six balanced cases")
    cases = tuple(_load_case(case_dir / row["file"]) for row in source["cases"])
    if manifest_digest(cases) != source["manifest_digest"]:
        raise ValueError("case manifest digest mismatch")

    schedules = {item.schedule_id: item for item in DEVELOPMENT_SCHEDULES}
    rows: list[dict[str, str]] = []
    for source_row, case, schedule_id in zip(
        source["cases"], cases, SCHEDULE_BY_POSITION, strict=True
    ):
        if case_digest(case) != source_row["case_digest"]:
            raise ValueError(f"case digest mismatch: {source_row['file']}")
        schedule = schedules[schedule_id]
        rows.append(
            {
                "case_digest": source_row["case_digest"],
                "case_file": source_row["file"],
                "fault_schedule_digest": schedule.digest(),
                "receipt_mode": source_row["receipt_mode"],
                "schedule": schedule_id,
            }
        )

    plan_body = {
        "case_manifest_digest": source["manifest_digest"],
        "plan_version": "forklift-development-held-out-v0",
        "trials": rows,
    }
    encoded = json.dumps(plan_body, sort_keys=True, separators=(",", ":"))
    return {
        **plan_body,
        "plan_digest": hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
    }


async def execute(plan: dict[str, object], case_dir: Path) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for index, row in enumerate(plan["trials"], start=1):
        code = await _run(
            schedule_id=row["schedule"],
            case_path=case_dir / row["case_file"],
            keep_accepted=False,
        )
        results.append(
            {
                "case_digest": row["case_digest"],
                "exit_code": code,
                "position": index,
                "schedule": row["schedule"],
            }
        )
        if code != 0:
            # Admission/UI/auditor failures are preserved by the trial runner.
            # Stop rather than adaptively retrying or consuming more capacity.
            break
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case-dir", type=Path, default=DEFAULT_CASE_DIR)
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()

    plan = freeze_plan(args.case_dir)
    args.plan.parent.mkdir(parents=True, exist_ok=True)
    args.plan.write_text(
        json.dumps(plan, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if not args.execute:
        print(
            json.dumps(
                {
                    "execute": False,
                    "plan_digest": plan["plan_digest"],
                    "trial_count": len(plan["trials"]),
                },
                sort_keys=True,
            )
        )
        return 0

    results = asyncio.run(execute(plan, args.case_dir))
    report = {
        "completed_positions": len(results),
        "plan_digest": plan["plan_digest"],
        "results": results,
        "stopped_early": len(results) != len(plan["trials"]),
    }
    DEFAULT_REPORT.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, sort_keys=True))
    return 0 if not report["stopped_early"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
