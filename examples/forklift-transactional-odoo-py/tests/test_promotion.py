from __future__ import annotations

import hashlib
import unittest
from dataclasses import replace

from forklift.oracle import Check, OracleVerdict
from forklift.promotion import CandidateResult, select_for_promotion
from forklift.receipts import ExecutionReceipt


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


CASE_DIGEST = digest("hidden-case")
SNAPSHOT = "snapshot-canonical-01"
CHILD_SNAPSHOT = "snapshot-candidate-01"


def accepted_candidate(candidate_id: str = "candidate-b") -> CandidateResult:
    verdict = OracleVerdict(accepted=True, checks=(Check("all", True, "ok"),))
    receipt = ExecutionReceipt(
        case_digest=CASE_DIGEST,
        canonical_snapshot_id=SNAPSHOT,
        candidate_snapshot_id=CHILD_SNAPSHOT,
        candidate_id=candidate_id,
        fault_schedule_digest=digest("faults"),
        action_log_digest=digest("actions"),
        oracle_version=verdict.oracle_version,
        accepted=True,
        failed_checks=(),
    )
    return CandidateResult(candidate_id, CHILD_SNAPSHOT, SNAPSHOT, verdict, receipt)


class PromotionTests(unittest.TestCase):
    def decide(self, *candidates: CandidateResult):
        return select_for_promotion(
            tuple(candidates),
            expected_case_digest=CASE_DIGEST,
            canonical_snapshot_id=SNAPSHOT,
        )

    def test_promotes_a_fully_bound_valid_candidate(self) -> None:
        self.assertEqual(self.decide(accepted_candidate()).promoted_candidate_id, "candidate-b")
        self.assertEqual(self.decide(accepted_candidate()).promoted_snapshot_id, CHILD_SNAPSHOT)

    def test_never_promotes_missing_evidence(self) -> None:
        candidate = CandidateResult("candidate-x", None, None, None, None)
        decision = self.decide(candidate)
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertEqual(
            decision.rejection_reasons["candidate-x"],
            (
                "missing-candidate-snapshot",
                "snapshot-lineage",
                "missing-verdict",
                "missing-receipt",
            ),
        )

    def test_never_promotes_oracle_rejection_even_with_accept_receipt(self) -> None:
        candidate = accepted_candidate()
        rejected = OracleVerdict(False, (Check("payment-count", False, "2"),))
        decision = self.decide(replace(candidate, verdict=rejected))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("oracle-rejected", decision.rejection_reasons[candidate.candidate_id])

    def test_never_promotes_stale_case_receipt(self) -> None:
        candidate = accepted_candidate()
        stale = replace(candidate.receipt, case_digest=digest("another-case"))
        decision = self.decide(replace(candidate, receipt=stale))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("case-binding", decision.rejection_reasons[candidate.candidate_id])

    def test_never_promotes_wrong_snapshot_receipt(self) -> None:
        candidate = accepted_candidate()
        stale = replace(candidate.receipt, canonical_snapshot_id="snapshot-old")
        decision = self.decide(replace(candidate, receipt=stale))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("snapshot-binding", decision.rejection_reasons[candidate.candidate_id])

    def test_never_promotes_unrelated_candidate_snapshot(self) -> None:
        candidate = accepted_candidate()
        unrelated = replace(candidate, snapshot_parent_id="snapshot-unrelated")
        decision = self.decide(unrelated)
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("snapshot-lineage", decision.rejection_reasons[candidate.candidate_id])

    def test_never_promotes_receipt_for_another_candidate_snapshot(self) -> None:
        candidate = accepted_candidate()
        stale = replace(candidate.receipt, candidate_snapshot_id="snapshot-other")
        decision = self.decide(replace(candidate, receipt=stale))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("candidate-snapshot-binding", decision.rejection_reasons[candidate.candidate_id])

    def test_never_promotes_receipt_from_another_candidate(self) -> None:
        candidate = accepted_candidate()
        stolen = replace(candidate.receipt, candidate_id="candidate-z")
        decision = self.decide(replace(candidate, receipt=stolen))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("candidate-binding", decision.rejection_reasons[candidate.candidate_id])

    def test_never_promotes_malformed_digest(self) -> None:
        candidate = accepted_candidate()
        malformed = replace(candidate.receipt, action_log_digest="not-a-digest")
        decision = self.decide(replace(candidate, receipt=malformed))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("action-digest-format", decision.rejection_reasons[candidate.candidate_id])

    def test_selects_deterministically_when_multiple_are_valid(self) -> None:
        candidate_z = accepted_candidate("candidate-z")
        candidate_a = accepted_candidate("candidate-a")
        candidate_a = replace(
            candidate_a,
            candidate_snapshot_id="snapshot-candidate-02",
            receipt=replace(candidate_a.receipt, candidate_snapshot_id="snapshot-candidate-02"),
        )
        decision = self.decide(candidate_z, candidate_a)
        self.assertEqual(decision.promoted_candidate_id, "candidate-a")

    def test_duplicate_candidate_ids_fail_closed(self) -> None:
        first = accepted_candidate("candidate-a")
        second = replace(
            accepted_candidate("candidate-a"),
            candidate_snapshot_id="snapshot-candidate-02",
            receipt=replace(
                accepted_candidate("candidate-a").receipt,
                candidate_snapshot_id="snapshot-candidate-02",
            ),
        )
        decision = self.decide(first, second)
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("duplicate-candidate-id", decision.rejection_reasons["candidate-a"])

    def test_duplicate_candidate_snapshots_fail_closed(self) -> None:
        decision = self.decide(accepted_candidate("candidate-a"), accepted_candidate("candidate-b"))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn(
            "duplicate-candidate-snapshot",
            decision.rejection_reasons["candidate-a"],
        )

    def test_empty_accepted_verdict_is_not_proof(self) -> None:
        candidate = accepted_candidate()
        empty = OracleVerdict(accepted=True, checks=())
        receipt = replace(candidate.receipt, oracle_version=empty.oracle_version)
        decision = self.decide(replace(candidate, verdict=empty, receipt=receipt))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("invalid-verdict-proof", decision.rejection_reasons[candidate.candidate_id])

    def test_receipt_failed_checks_must_exactly_bind_verdict(self) -> None:
        candidate = accepted_candidate()
        stale = replace(candidate.receipt, failed_checks=("old-check",))
        decision = self.decide(replace(candidate, receipt=stale))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn("failed-checks-binding", decision.rejection_reasons[candidate.candidate_id])

    def test_unexpected_oracle_version_fails_closed(self) -> None:
        candidate = accepted_candidate()
        future = OracleVerdict(
            accepted=True,
            checks=candidate.verdict.checks,
            oracle_version="unknown-oracle-v99",
        )
        receipt = replace(candidate.receipt, oracle_version=future.oracle_version)
        decision = self.decide(replace(candidate, verdict=future, receipt=receipt))
        self.assertIsNone(decision.promoted_candidate_id)
        self.assertIn(
            "unexpected-oracle-version",
            decision.rejection_reasons[candidate.candidate_id],
        )


if __name__ == "__main__":
    unittest.main()
