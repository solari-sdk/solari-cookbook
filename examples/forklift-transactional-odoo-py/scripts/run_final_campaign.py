"""Execute the immutable final protocol exactly once and reveal its seed."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path

from scripts.run_solari_clean_gui_trial import _run


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SEALED_ROOT = PROJECT_ROOT / "artifacts" / "sealed" / "final-v2"
PROTOCOL_PATH = SEALED_ROOT / "protocol.json"
CASE_DIR = SEALED_ROOT / "cases"
TRIAL_DIR = SEALED_ROOT / "trials"
REPORT_PATH = SEALED_ROOT / "final-report.json"
CUSTODY_SEED = SEALED_ROOT / ".custody" / "seed.txt"
SEED_REVEAL = SEALED_ROOT / "seed-reveal.txt"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_digest(payload: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def retryable_pre_mutation_failure(payload: dict[str, object]) -> bool:
    return (
        payload.get("trial") == "failed"
        and payload.get("business_mutation_observed") is False
        and not payload.get("fault_triggered")
    )


def verify_protocol(protocol: dict[str, object]) -> None:
    body = {key: value for key, value in protocol.items() if key != "protocol_digest"}
    if canonical_digest(body) != protocol.get("protocol_digest"):
        raise ValueError("final protocol digest mismatch")
    for relative, expected in protocol["code_hashes"].items():
        if sha256(PROJECT_ROOT / relative) != expected:
            raise ValueError(f"frozen code drift: {relative}")
    runtime = protocol["runtime"]
    if sys.version.split()[0] != runtime["python_version"]:
        raise ValueError("frozen Python version drift")
    for distribution, expected in runtime["distributions"].items():
        if importlib.metadata.version(distribution) != expected:
            raise ValueError(f"frozen dependency drift: {distribution}")
    if sha256(SEALED_ROOT / "cases" / "manifest.json") != protocol["manifest_sha256"]:
        raise ValueError("sealed case manifest drift")
    for trial in protocol["trials"]:
        if sha256(CASE_DIR / trial["case_file"]) != trial["case_file_sha256"]:
            raise ValueError(f"sealed case drift at position {trial['position']}")
    seed = CUSTODY_SEED.read_text(encoding="utf-8")
    if hashlib.sha256(seed.encode("utf-8")).hexdigest() != protocol["seed_sha256"]:
        raise ValueError("custody seed digest mismatch")


def attempt_matches_expected(payload: dict[str, object], trial: dict[str, object]) -> bool:
    checks = payload.get("oracle_checks")
    if not isinstance(checks, list) or not checks:
        return False
    oracle_accepted = all(check.get("passed") is True for check in checks)
    selected = payload.get("accepted") is True
    required = set(trial.get("required_failed_codes", []))
    failed = set(payload.get("failed_codes", []))
    return (
        payload.get("protocol_passed") is True
        and oracle_accepted is trial["expected_acceptance"]
        and selected is trial["expected_acceptance"]
        and required.issubset(failed)
        and (payload.get("receipt") or {}).get("case_digest") == trial["case_digest"]
        and (payload.get("receipt") or {}).get("fault_schedule_digest")
        == trial["fault_schedule_digest"]
    )


def _new_artifact(before: set[Path]) -> Path:
    created = set(TRIAL_DIR.glob("*.json")) - before
    if len(created) != 1:
        raise RuntimeError(f"expected one final attempt artifact, got {len(created)}")
    return created.pop()


async def execute(protocol: dict[str, object]) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    max_attempts = protocol["resource_cap"]["max_attempts_per_position"]
    for trial in protocol["trials"]:
        position: dict[str, object] = {
            "attempts": [],
            "case_digest": trial["case_digest"],
            "expected_acceptance": trial["expected_acceptance"],
            "position": trial["position"],
            "schedule": trial["schedule"],
        }
        for attempt_number in range(1, max_attempts + 1):
            verify_protocol(protocol)
            before = set(TRIAL_DIR.glob("*.json"))
            code = await _run(
                schedule_id=trial["schedule"],
                case_path=CASE_DIR / trial["case_file"],
                keep_accepted=False,
                result_dir=TRIAL_DIR,
            )
            artifact = _new_artifact(before)
            payload = json.loads(artifact.read_text(encoding="utf-8"))
            matches = code == 0 and attempt_matches_expected(payload, trial)
            retryable = retryable_pre_mutation_failure(payload)
            position["attempts"].append(
                {
                    "artifact": artifact.name,
                    "artifact_sha256": sha256(artifact),
                    "attempt": attempt_number,
                    "exit_code": code,
                    "matches_precommitment": matches,
                    "retryable_pre_mutation_failure": retryable,
                }
            )
            if matches:
                position["completed"] = True
                break
            if not retryable or attempt_number == max_attempts:
                position["completed"] = False
                break
            await asyncio.sleep(10)
        results.append(position)
        if position.get("completed") is not True:
            break
    return results


def _write_exact(path: Path, payload: dict[str, object]) -> bytes:
    encoded = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    path.write_bytes(encoded)
    return encoded


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    protocol = json.loads(PROTOCOL_PATH.read_text(encoding="utf-8"))
    verify_protocol(protocol)
    if not args.execute:
        print(
            json.dumps(
                {
                    "execute": False,
                    "protocol_digest": protocol["protocol_digest"],
                    "trial_count": len(protocol["trials"]),
                    "verified": True,
                },
                sort_keys=True,
            )
        )
        return 0
    if REPORT_PATH.exists() or SEED_REVEAL.exists() or (TRIAL_DIR.exists() and any(TRIAL_DIR.iterdir())):
        print(json.dumps({"executed": False, "reason": "sealed_evidence_not_empty"}))
        return 2

    TRIAL_DIR.mkdir(parents=True, exist_ok=True)
    results = asyncio.run(execute(protocol))
    completed = len(results) == len(protocol["trials"]) and all(
        row.get("completed") is True for row in results
    )
    artifacts = sorted(TRIAL_DIR.glob("*.json"))
    audited = []
    false_acceptances = 0
    for path in artifacts:
        payload = json.loads(path.read_text(encoding="utf-8"))
        checks = payload.get("oracle_checks")
        if isinstance(checks, list) and checks:
            oracle_accepted = all(check.get("passed") is True for check in checks)
            false_acceptances += int(payload.get("accepted") is True and not oracle_accepted)
            audited.append(path.name)
    passed = completed and false_acceptances == 0 and len(audited) == 6
    report: dict[str, object] = {
        "audited_final_positions": len(audited),
        "claim_passed": passed,
        "false_acceptances": false_acceptances,
        "protocol_digest": protocol["protocol_digest"],
        "results": results,
        "seed_revealed": True,
    }
    seed = CUSTODY_SEED.read_text(encoding="utf-8")
    SEED_REVEAL.write_bytes(seed.encode("utf-8"))
    encoded = _write_exact(REPORT_PATH, report)
    report_digest = hashlib.sha256(encoded).hexdigest()
    content_path = SEALED_ROOT / f"final-report-{report_digest[:12]}.json"
    content_path.write_bytes(encoded)
    print(
        json.dumps(
            {
                "audited_final_positions": len(audited),
                "claim_passed": passed,
                "false_acceptances": false_acceptances,
                "report_sha256": report_digest,
                "seed_revealed": True,
            },
            sort_keys=True,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
