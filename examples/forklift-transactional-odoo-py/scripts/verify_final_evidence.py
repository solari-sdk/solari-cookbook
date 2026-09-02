"""Verify the sealed final package without contacting Solari or opening a GUI."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path

from forklift.case_generation import case_digest, case_payload, generate_cases, manifest_digest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SEALED_ROOT = PROJECT_ROOT / "artifacts" / "sealed" / "final-v2"
PROTOCOL_PATH = SEALED_ROOT / "protocol.json"
REPORT_PATH = SEALED_ROOT / "final-report.json"
TRIAL_DIR = SEALED_ROOT / "trials"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_digest(payload: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def verify() -> dict[str, object]:
    protocol = json.loads(PROTOCOL_PATH.read_text(encoding="utf-8"))
    report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    body = {key: value for key, value in protocol.items() if key != "protocol_digest"}
    if canonical_digest(body) != protocol["protocol_digest"]:
        raise ValueError("protocol digest mismatch")
    if report["protocol_digest"] != protocol["protocol_digest"]:
        raise ValueError("report is bound to another protocol")

    for relative, expected in protocol["code_hashes"].items():
        if sha256(PROJECT_ROOT / relative) != expected:
            raise ValueError(f"frozen code drift: {relative}")
    runtime = protocol["runtime"]
    if sys.version.split()[0] != runtime["python_version"]:
        raise ValueError("Python version drift")
    for name, expected in runtime["distributions"].items():
        if importlib.metadata.version(name) != expected:
            raise ValueError(f"dependency drift: {name}")

    report_sha = sha256(REPORT_PATH)
    content_addressed = SEALED_ROOT / f"final-report-{report_sha[:12]}.json"
    if content_addressed.read_bytes() != REPORT_PATH.read_bytes():
        raise ValueError("content-addressed report differs")

    seed_path = SEALED_ROOT / "seed-reveal.txt"
    seed = seed_path.read_text(encoding="utf-8")
    if hashlib.sha256(seed.encode("utf-8")).hexdigest() != protocol["seed_sha256"]:
        raise ValueError("revealed seed does not match the frozen commitment")
    regenerated = generate_cases(seed=seed, count=6, namespace="sealed-final-v2")
    if manifest_digest(regenerated) != protocol["manifest_digest"]:
        raise ValueError("regenerated manifest digest mismatch")
    for case, trial in zip(regenerated, protocol["trials"], strict=True):
        case_path = SEALED_ROOT / "cases" / trial["case_file"]
        if case_digest(case) != trial["case_digest"]:
            raise ValueError(f"regenerated case digest mismatch at {trial['position']}")
        if sha256(case_path) != trial["case_file_sha256"]:
            raise ValueError(f"sealed case file hash mismatch at {trial['position']}")
        if json.loads(case_path.read_text(encoding="utf-8")) != case_payload(case):
            raise ValueError(f"sealed case payload mismatch at {trial['position']}")

    if len(report["results"]) != len(protocol["trials"]):
        raise ValueError("final position count mismatch")
    referenced: set[str] = set()
    false_acceptances = 0
    audited_positions = 0
    total_attempts = 0
    for result, trial in zip(report["results"], protocol["trials"], strict=True):
        if result["position"] != trial["position"] or result["schedule"] != trial["schedule"]:
            raise ValueError("report position does not match protocol")
        attempts = result["attempts"]
        total_attempts += len(attempts)
        if not attempts or len(attempts) > protocol["resource_cap"]["max_attempts_per_position"]:
            raise ValueError(f"attempt cap violated at {trial['position']}")
        for index, attempt in enumerate(attempts):
            artifact = TRIAL_DIR / attempt["artifact"]
            if artifact.name in referenced or sha256(artifact) != attempt["artifact_sha256"]:
                raise ValueError(f"attempt artifact binding failed at {trial['position']}")
            referenced.add(artifact.name)
            payload = json.loads(artifact.read_text(encoding="utf-8"))
            if index < len(attempts) - 1:
                retryable = (
                    payload.get("trial") == "failed"
                    and payload.get("business_mutation_observed") is False
                    and not payload.get("fault_triggered")
                )
                if not retryable or attempt["retryable_pre_mutation_failure"] is not True:
                    raise ValueError(f"illegal retry at {trial['position']}")
                continue

            checks = payload.get("oracle_checks")
            if not isinstance(checks, list) or not checks:
                raise ValueError(f"missing final oracle at {trial['position']}")
            oracle_accepted = all(check.get("passed") is True for check in checks)
            selected = payload.get("accepted") is True
            failed = set(payload.get("failed_codes", []))
            receipt = payload.get("receipt") or {}
            matches = (
                attempt["matches_precommitment"] is True
                and payload.get("protocol_passed") is True
                and oracle_accepted is trial["expected_acceptance"]
                and selected is trial["expected_acceptance"]
                and set(trial["required_failed_codes"]).issubset(failed)
                and receipt.get("case_digest") == trial["case_digest"]
                and receipt.get("fault_schedule_digest")
                == trial["fault_schedule_digest"]
            )
            if not matches or result.get("completed") is not True:
                raise ValueError(f"precommitment failed at {trial['position']}")
            false_acceptances += int(selected and not oracle_accepted)
            audited_positions += 1

    artifacts = {path.name for path in TRIAL_DIR.glob("*.json")}
    if artifacts != referenced:
        raise ValueError("unreported or missing final attempt artifact")
    passed = (
        audited_positions == 6
        and false_acceptances == 0
        and total_attempts <= protocol["resource_cap"]["max_total_attempts"]
    )
    if not passed or report["claim_passed"] is not True or report["false_acceptances"] != 0:
        raise ValueError("recomputed final hard gate failed")
    return {
        "audited_final_positions": audited_positions,
        "evidence": "VERIFIED",
        "false_acceptances": false_acceptances,
        "independence": "adversarial_verification_not_independent_replication",
        "protocol_digest": protocol["protocol_digest"],
        "report_sha256": report_sha,
        "seed_commitment_verified": True,
        "total_attempts_preserved": total_attempts,
    }


def main() -> int:
    try:
        payload = verify()
        code = 0
    except Exception as exc:
        payload = {"evidence": "FAILED", "error": f"{type(exc).__name__}: {exc}"}
        code = 1
    print(json.dumps(payload, indent=2, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
