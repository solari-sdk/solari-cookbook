"""Fail-closed promotion policy for disposable VM branches."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

from .oracle import ORACLE_VERSION, OracleVerdict
from .receipts import ExecutionReceipt

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class CandidateResult:
    candidate_id: str
    candidate_snapshot_id: str | None
    snapshot_parent_id: str | None
    verdict: OracleVerdict | None
    receipt: ExecutionReceipt | None
    audit_error: str | None = None


@dataclass(frozen=True)
class PromotionDecision:
    promoted_candidate_id: str | None
    promoted_snapshot_id: str | None
    rejection_reasons: dict[str, tuple[str, ...]]


def select_for_promotion(
    candidates: tuple[CandidateResult, ...],
    *,
    expected_case_digest: str,
    canonical_snapshot_id: str,
    expected_check_codes: tuple[str, ...],
    expected_auditor_bundle_digest: str,
    expected_auditor_runtime_digest: str,
    expected_oracle_version: str = ORACLE_VERSION,
) -> PromotionDecision:
    """Select at most one proven candidate; uncertainty always means no."""

    rejected: dict[str, tuple[str, ...]] = {}
    eligible: list[str] = []
    candidate_id_counts = Counter(candidate.candidate_id for candidate in candidates)
    snapshot_id_counts = Counter(
        candidate.candidate_snapshot_id
        for candidate in candidates
        if candidate.candidate_snapshot_id is not None
    )

    for candidate in candidates:
        reasons: list[str] = []
        verdict = candidate.verdict
        receipt = candidate.receipt

        if candidate_id_counts[candidate.candidate_id] != 1:
            reasons.append("duplicate-candidate-id")
        if candidate.candidate_snapshot_id is None:
            reasons.append("missing-candidate-snapshot")
        elif snapshot_id_counts[candidate.candidate_snapshot_id] != 1:
            reasons.append("duplicate-candidate-snapshot")
        if candidate.snapshot_parent_id != canonical_snapshot_id:
            reasons.append("snapshot-lineage")

        if verdict is None:
            reasons.append("missing-verdict")
        elif not verdict.accepted:
            reasons.append("oracle-rejected")
        elif not verdict.checks or any(not check.passed for check in verdict.checks):
            reasons.append("invalid-verdict-proof")
        elif tuple(check.code for check in verdict.checks) != expected_check_codes:
            reasons.append("unexpected-check-schema")
        if verdict is not None and verdict.oracle_version != expected_oracle_version:
            reasons.append("unexpected-oracle-version")
        if (
            verdict is not None
            and verdict.auditor_bundle_digest != expected_auditor_bundle_digest
        ):
            reasons.append("unexpected-auditor-bundle")
        if (
            verdict is not None
            and verdict.auditor_runtime_digest != expected_auditor_runtime_digest
        ):
            reasons.append("unexpected-auditor-runtime")

        if receipt is None:
            reasons.append("missing-receipt")
        else:
            if receipt.candidate_id != candidate.candidate_id:
                reasons.append("candidate-binding")
            if receipt.case_digest != expected_case_digest:
                reasons.append("case-binding")
            if receipt.canonical_snapshot_id != canonical_snapshot_id:
                reasons.append("snapshot-binding")
            if receipt.candidate_snapshot_id != candidate.candidate_snapshot_id:
                reasons.append("candidate-snapshot-binding")
            if verdict is not None and receipt.oracle_version != verdict.oracle_version:
                reasons.append("oracle-version-binding")
            if receipt.oracle_version != expected_oracle_version:
                reasons.append("receipt-oracle-version")
            if verdict is not None and receipt.accepted != verdict.accepted:
                reasons.append("verdict-binding")
            if verdict is not None and receipt.failed_checks != verdict.failed_codes:
                reasons.append("failed-checks-binding")
            if (
                verdict is not None
                and receipt.auditor_bundle_digest != verdict.auditor_bundle_digest
            ):
                reasons.append("auditor-bundle-binding")
            if (
                verdict is not None
                and receipt.auditor_runtime_digest != verdict.auditor_runtime_digest
            ):
                reasons.append("auditor-runtime-binding")
            if verdict is not None and receipt.verdict_digest != verdict.digest():
                reasons.append("verdict-digest-binding")
            if receipt.failed_checks:
                reasons.append("receipt-has-failures")
            if not receipt.accepted:
                reasons.append("receipt-rejected")
            for name, digest in (
                ("case-digest-format", receipt.case_digest),
                ("fault-digest-format", receipt.fault_schedule_digest),
                ("action-digest-format", receipt.action_log_digest),
                ("auditor-bundle-digest-format", receipt.auditor_bundle_digest),
                ("auditor-runtime-digest-format", receipt.auditor_runtime_digest),
                ("verdict-digest-format", receipt.verdict_digest),
            ):
                if SHA256_RE.fullmatch(digest) is None:
                    reasons.append(name)

        if reasons:
            rejected[candidate.candidate_id] = tuple(dict.fromkeys(reasons))
        else:
            eligible.append(candidate.candidate_id)

    # Deterministic choice makes retries auditable. No eligibility means the
    # canonical snapshot remains authoritative and nothing is promoted.
    promoted = min(eligible) if eligible else None
    promoted_snapshot = None
    if promoted is not None:
        promoted_snapshot = next(
            candidate.candidate_snapshot_id
            for candidate in candidates
            if candidate.candidate_id == promoted
        )
    return PromotionDecision(
        promoted_candidate_id=promoted,
        promoted_snapshot_id=promoted_snapshot,
        rejection_reasons=rejected,
    )
