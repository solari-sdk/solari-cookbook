"""Continue frozen held-out positions with capped pre-mutation retries."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from scripts.run_solari_clean_gui_trial import _run


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = PROJECT_ROOT / "artifacts" / "development"
CASE_DIR = ARTIFACT_DIR / "held-out-cases"
SOURCE_PLAN = ARTIFACT_DIR / "held-out-plan.json"
SOURCE_REPORT = ARTIFACT_DIR / "held-out-run-report.json"
PLAN_PATH = ARTIFACT_DIR / "held-out-continuation-plan.json"
REPORT_PATH = ARTIFACT_DIR / "held-out-continuation-report.json"
TRIAL_DIR = ARTIFACT_DIR / "gui-trials"
MAX_ATTEMPTS = 3


def _canonical_digest(payload: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def freeze_continuation() -> dict[str, object]:
    source = json.loads(SOURCE_PLAN.read_text(encoding="utf-8"))
    source_body = {key: value for key, value in source.items() if key != "plan_digest"}
    if _canonical_digest(source_body) != source["plan_digest"]:
        raise ValueError("source held-out plan digest mismatch")
    report = json.loads(SOURCE_REPORT.read_text(encoding="utf-8"))
    if report.get("plan_digest") != source["plan_digest"]:
        raise ValueError("source run report is bound to another plan")
    completed = report.get("results", [])
    if [row.get("exit_code") for row in completed[:3]] != [0, 0, 0]:
        raise ValueError("positions 1-3 are not proven successful")
    if len(completed) != 4 or completed[3].get("exit_code") != 1:
        raise ValueError("source run did not stop at position 4")

    body: dict[str, object] = {
        "continuation_version": "forklift-development-held-out-continuation-v0",
        "parent_plan_digest": source["plan_digest"],
        "prior_successful_positions": [1, 2, 3],
        "retry_policy": {
            "fresh_canonical_branch_each_attempt": True,
            "max_attempts_per_position": MAX_ATTEMPTS,
            "retry_only_if_business_mutation_observed_is_false": True,
            "retain_every_attempt_artifact": True,
        },
        "trials": [
            {"position": position, **row}
            for position, row in enumerate(source["trials"][3:], start=4)
        ],
    }
    return {**body, "plan_digest": _canonical_digest(body)}


def retryable_pre_mutation_failure(payload: dict[str, object]) -> bool:
    return (
        payload.get("trial") == "failed"
        and payload.get("business_mutation_observed") is False
        and not payload.get("fault_triggered")
    )


def _new_attempt_artifact(before: set[Path]) -> Path:
    after = set(TRIAL_DIR.glob("*.json"))
    created = after - before
    if len(created) != 1:
        raise RuntimeError(f"expected one new attempt artifact, got {len(created)}")
    return created.pop()


async def execute(plan: dict[str, object]) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for row in plan["trials"]:
        position_result: dict[str, object] = {
            "case_digest": row["case_digest"],
            "position": row["position"],
            "schedule": row["schedule"],
            "attempts": [],
        }
        for attempt in range(1, MAX_ATTEMPTS + 1):
            before = set(TRIAL_DIR.glob("*.json"))
            code = await _run(
                schedule_id=row["schedule"],
                case_path=CASE_DIR / row["case_file"],
                keep_accepted=False,
            )
            artifact = _new_attempt_artifact(before)
            payload = json.loads(artifact.read_text(encoding="utf-8"))
            retryable = retryable_pre_mutation_failure(payload)
            position_result["attempts"].append(
                {
                    "artifact": artifact.name,
                    "artifact_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                    "attempt": attempt,
                    "exit_code": code,
                    "retryable_pre_mutation_failure": retryable,
                }
            )
            if code == 0:
                position_result["completed"] = True
                break
            if not retryable or attempt == MAX_ATTEMPTS:
                position_result["completed"] = False
                break
            await asyncio.sleep(10)
        results.append(position_result)
        if position_result.get("completed") is not True:
            break
    return results


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.write_bytes((json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    plan = freeze_continuation()
    _write_json(PLAN_PATH, plan)
    if not args.execute:
        print(
            json.dumps(
                {
                    "execute": False,
                    "plan_digest": plan["plan_digest"],
                    "positions": [row["position"] for row in plan["trials"]],
                    "retry_cap": MAX_ATTEMPTS,
                },
                sort_keys=True,
            )
        )
        return 0

    results = asyncio.run(execute(plan))
    completed = len(results) == len(plan["trials"]) and all(
        row.get("completed") is True for row in results
    )
    report: dict[str, object] = {
        "completed": completed,
        "plan_digest": plan["plan_digest"],
        "results": results,
    }
    _write_json(REPORT_PATH, report)
    print(json.dumps(report, sort_keys=True))
    return 0 if completed else 1


if __name__ == "__main__":
    raise SystemExit(main())
