"""Promote one audited business snapshot, boot it, and re-audit the template."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path

from forklift.case_generation import case_digest
from forklift.oracle import ORACLE_VERSION
from forklift.remote_oracle import evaluate_in_auditor
from forklift.solari_adapter import SolariSandboxBranches
from scripts.bootstrap_solari_canonical import _load_case, _must, _safe_diagnostic
from scripts.check_solari_auth import _load_local_env, _safe_code, _safe_status


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TRIAL_PATH = PROJECT_ROOT / "artifacts" / "development" / "clean-gui-trial.json"
CASE_PATH = PROJECT_ROOT / "lab" / "valid_fixture_case.json"
OUTPUT_PATH = PROJECT_ROOT / "artifacts" / "development" / "promotion-closure.json"


async def _start_postgres(branch) -> None:
    await _must(
        branch,
        "sh",
        [
            "-lc",
            "pg_isready -q || pg_ctlcluster $(pg_lsclusters -h | awk 'NR==1 {print $1, $2}') start",
        ],
        timeout_ms=2 * 60 * 1000,
    )


async def _audit(branch, case):
    await branch.connect()
    await _start_postgres(branch)
    return await evaluate_in_auditor(
        branch,
        case,
        database_url="postgresql://odoo:odoo@127.0.0.1:5432/forklift_clean",
        timeout_ms=2 * 60 * 1000,
    )


async def _run() -> int:
    _load_local_env(PROJECT_ROOT / ".env")
    api_key = os.environ.get("SOLARI_API_KEY", "").strip()
    trial = json.loads(TRIAL_PATH.read_text(encoding="utf-8"))
    receipt = trial.get("receipt") or {}
    case = _load_case(CASE_PATH)
    candidate_snapshot_id = trial.get("candidate_snapshot_id")
    canonical_snapshot_id = receipt.get("canonical_snapshot_id")
    if (
        not api_key
        or trial.get("accepted") is not True
        or receipt.get("accepted") is not True
        or receipt.get("oracle_version") != ORACLE_VERSION
        or receipt.get("case_digest") != case_digest(case)
        or receipt.get("candidate_snapshot_id") != candidate_snapshot_id
        or not candidate_snapshot_id
        or not canonical_snapshot_id
    ):
        print(json.dumps({"closure": "not_run", "reason": "invalid_prerequisite"}))
        return 2

    base_url = os.environ.get("SOLARI_BASE_URL", "https://api.getsolari.com")
    pre_auditor = None
    promoted_boot = None
    payload: dict[str, object]
    phase = "verify-candidate-snapshot"
    async with SolariSandboxBranches(
        api_key=api_key,
        base_url=base_url,
        call_timeout_ms=5 * 60 * 1000,
    ) as backend:
        try:
            record = await backend.get_snapshot(candidate_snapshot_id)
            if (
                record.snapshot_id != candidate_snapshot_id
                or record.parent_id != canonical_snapshot_id
                or record.kind != "sandbox"
            ):
                raise RuntimeError("candidate snapshot identity, lineage, or kind mismatch")

            phase = "pre-promotion-reaudit"
            pre_auditor = await backend.fork(
                snapshot_id=candidate_snapshot_id,
                metadata={"forklift.role": "promotion-pre-auditor"},
            )
            before = await _audit(pre_auditor, case)
            if not before.accepted:
                raise RuntimeError(f"candidate re-audit rejected: {before.failed_codes!r}")
            await pre_auditor.kill()
            pre_auditor = None

            phase = "promote-exact-candidate"
            template_name = f"forklift-approved-development-{candidate_snapshot_id[-8:]}"
            template_id = await backend.promote_snapshot(
                candidate_snapshot_id,
                name=template_name,
            )
            if not template_id:
                raise RuntimeError("promotion returned no durable template id")

            phase = "boot-promoted-template"
            promoted_boot = await backend.create_golden(
                template=template_id,
                metadata={"forklift.role": "promoted-template-auditor"},
                timeout_ms=20 * 60 * 1000,
            )
            after = await _audit(promoted_boot, case)
            if not after.accepted:
                raise RuntimeError(f"promoted template audit rejected: {after.failed_codes!r}")
            if before.checks != after.checks:
                raise RuntimeError("promoted-template verdict differs from candidate verdict")

            result = {
                "candidate_snapshot_id": candidate_snapshot_id,
                "canonical_snapshot_id": canonical_snapshot_id,
                "case_digest": case_digest(case),
                "closure": "passed",
                "lineage_verified": True,
                "oracle_version": after.oracle_version,
                "post_promotion_checks": [asdict(check) for check in after.checks],
                "post_promotion_reaudit_accepted": True,
                "pre_promotion_reaudit_accepted": True,
                "template_id": template_id,
                "template_name": template_name,
            }
            encoded = (json.dumps(result, indent=2, sort_keys=True) + "\n").encode("utf-8")
            result["receipt_sha256"] = hashlib.sha256(encoded).hexdigest()
            OUTPUT_PATH.write_bytes(
                (json.dumps(result, indent=2, sort_keys=True) + "\n").encode("utf-8")
            )
            payload = {
                "closure": "passed",
                "lineage_verified": True,
                "post_promotion_reaudit_accepted": True,
                "pre_promotion_reaudit_accepted": True,
                "verdicts_identical": True,
            }
        except Exception as exc:
            payload = {
                "closure": "failed",
                "diagnostic_tail": _safe_diagnostic(exc),
                "error_code": _safe_code(exc),
                "error_type": type(exc).__name__,
                "phase": phase,
                "status_code": _safe_status(exc),
            }
        finally:
            if pre_auditor is not None:
                try:
                    await pre_auditor.kill()
                except Exception:
                    payload["pre_auditor_cleanup"] = "failed"
            if promoted_boot is not None:
                try:
                    await promoted_boot.kill()
                except Exception:
                    payload["promoted_boot_cleanup"] = "failed"

    print(json.dumps(payload, sort_keys=True))
    return 0 if payload.get("closure") == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
