"""Canonical, tamper-evident execution receipts (not an identity system)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass

from .oracle import OracleVerdict


@dataclass(frozen=True)
class ExecutionReceipt:
    case_digest: str
    canonical_snapshot_id: str
    candidate_snapshot_id: str
    candidate_id: str
    fault_schedule_digest: str
    action_log_digest: str
    oracle_version: str
    accepted: bool
    failed_checks: tuple[str, ...]

    def canonical_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))

    def digest(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


def receipt_from_verdict(
    *,
    case_digest: str,
    canonical_snapshot_id: str,
    candidate_snapshot_id: str,
    candidate_id: str,
    fault_schedule_digest: str,
    action_log_digest: str,
    verdict: OracleVerdict,
) -> ExecutionReceipt:
    return ExecutionReceipt(
        case_digest=case_digest,
        canonical_snapshot_id=canonical_snapshot_id,
        candidate_snapshot_id=candidate_snapshot_id,
        candidate_id=candidate_id,
        fault_schedule_digest=fault_schedule_digest,
        action_log_digest=action_log_digest,
        oracle_version=verdict.oracle_version,
        accepted=verdict.accepted,
        failed_checks=verdict.failed_codes,
    )
