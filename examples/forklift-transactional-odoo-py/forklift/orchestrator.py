"""Snapshot-seal, independent-audit, and durable-promotion protocol."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Protocol

from .oracle import OracleVerdict
from .promotion import CandidateResult, PromotionDecision, select_for_promotion
from .receipts import receipt_from_verdict
from .solari_adapter import SnapshotRecord


class Branch(Protocol):
    id: str

    async def connect(self) -> None: ...

    async def snapshot(self, name: str | None = None) -> str: ...

    async def kill(self) -> None: ...


class BranchBackend(Protocol):
    async def fork(
        self,
        *,
        snapshot_id: str,
        metadata: dict[str, str],
        cpu: int = 4,
        mem_mb: int = 8192,
        timeout_ms: int = 15 * 60 * 1000,
    ) -> Branch: ...

    async def get_snapshot(self, snapshot_id: str) -> SnapshotRecord: ...

    async def promote_snapshot(self, snapshot_id: str, *, name: str) -> str: ...


OracleRunner = Callable[[Branch], Awaitable[OracleVerdict]]


@dataclass(frozen=True)
class DurablePromotion:
    decision: PromotionDecision
    template_id: str | None
    error: str | None = None


async def audit_sealed_candidate(
    *,
    backend: BranchBackend,
    candidate: Branch,
    canonical_snapshot_id: str,
    case_digest: str,
    fault_schedule_digest: str,
    action_log_digest: str,
    oracle: OracleRunner,
    expected_snapshot_kind: str = "desktop",
) -> CandidateResult:
    """Audit a fork of an immutable snapshot, never the still-changing worker.

    This ordering removes the promotion race: the exact snapshot inspected by
    the oracle is the snapshot later eligible for durable promotion.
    """

    candidate_snapshot_id: str | None = None
    parent_id: str | None = None
    verdict: OracleVerdict | None = None
    receipt = None
    auditor: Branch | None = None
    audit_error: str | None = None

    try:
        candidate_snapshot_id = await candidate.snapshot(
            f"forklift-candidate-{candidate.id}"
        )
        snapshot = await backend.get_snapshot(candidate_snapshot_id)
        if snapshot.snapshot_id != candidate_snapshot_id:
            raise RuntimeError("snapshot lookup returned a different snapshot id")
        if snapshot.kind != expected_snapshot_kind:
            raise RuntimeError(
                f"candidate snapshot kind is {snapshot.kind}, expected {expected_snapshot_kind}"
            )
        parent_id = snapshot.parent_id

        auditor = await backend.fork(
            snapshot_id=candidate_snapshot_id,
            metadata={
                "forklift.role": "auditor",
                "forklift.candidate": candidate.id,
            },
        )
        await auditor.connect()
        verdict = await oracle(auditor)
        receipt = receipt_from_verdict(
            case_digest=case_digest,
            canonical_snapshot_id=canonical_snapshot_id,
            candidate_snapshot_id=candidate_snapshot_id,
            candidate_id=candidate.id,
            fault_schedule_digest=fault_schedule_digest,
            action_log_digest=action_log_digest,
            verdict=verdict,
        )
    except Exception as exc:
        # An unavailable snapshot, lineage record, auditor, query, or receipt is
        # uncertainty.  The promotion selector treats every such gap as NO.
        audit_error = f"{type(exc).__name__}: {exc}"
    finally:
        if auditor is not None:
            try:
                await auditor.kill()
            except Exception:
                pass

    return CandidateResult(
        candidate_id=candidate.id,
        candidate_snapshot_id=candidate_snapshot_id,
        snapshot_parent_id=parent_id,
        verdict=verdict,
        receipt=receipt,
        audit_error=audit_error,
    )


async def promote_eligible_snapshot(
    *,
    backend: BranchBackend,
    candidates: tuple[CandidateResult, ...],
    expected_case_digest: str,
    canonical_snapshot_id: str,
    expected_check_codes: tuple[str, ...],
    expected_auditor_bundle_digest: str,
    expected_auditor_runtime_digest: str,
    template_name: str,
) -> DurablePromotion:
    """Make the selected immutable snapshot durable, or report no promotion."""

    decision = select_for_promotion(
        candidates,
        expected_case_digest=expected_case_digest,
        canonical_snapshot_id=canonical_snapshot_id,
        expected_check_codes=expected_check_codes,
        expected_auditor_bundle_digest=expected_auditor_bundle_digest,
        expected_auditor_runtime_digest=expected_auditor_runtime_digest,
    )
    if decision.promoted_snapshot_id is None:
        return DurablePromotion(decision=decision, template_id=None)

    try:
        template_id = await backend.promote_snapshot(
            decision.promoted_snapshot_id,
            name=template_name,
        )
    except Exception as exc:
        return DurablePromotion(
            decision=decision,
            template_id=None,
            error=f"{type(exc).__name__}: {exc}",
        )
    return DurablePromotion(decision=decision, template_id=template_id)
