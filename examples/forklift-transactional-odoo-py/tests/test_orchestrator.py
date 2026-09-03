from __future__ import annotations

import hashlib
import unittest

from forklift.oracle import Check, OracleVerdict
from forklift.orchestrator import audit_sealed_candidate, promote_eligible_snapshot
from forklift.solari_adapter import SnapshotRecord


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


BUNDLE_DIGEST = digest("auditor-bundle")
RUNTIME_DIGEST = digest("auditor-runtime")


def valid_verdict() -> OracleVerdict:
    return OracleVerdict(
        True,
        (Check("all", True, "ok"),),
        auditor_bundle_digest=BUNDLE_DIGEST,
        auditor_runtime_digest=RUNTIME_DIGEST,
    )


class FakeBranch:
    def __init__(self, branch_id: str, snapshot_id: str = "snap-candidate") -> None:
        self.id = branch_id
        self.snapshot_id = snapshot_id
        self.connected = False
        self.killed = False

    async def connect(self) -> None:
        self.connected = True

    async def snapshot(self, name: str | None = None) -> str:
        return self.snapshot_id

    async def kill(self) -> None:
        self.killed = True


class FakeBackend:
    def __init__(
        self,
        parent: str = "snap-canonical",
        snapshot_id: str = "snap-candidate",
        kind: str = "desktop",
    ) -> None:
        self.parent = parent
        self.snapshot_id = snapshot_id
        self.kind = kind
        self.auditor = FakeBranch("auditor")
        self.forked_from: list[str] = []
        self.promoted: list[str] = []

    async def fork(self, *, snapshot_id: str, metadata: dict[str, str], **_kwargs: object):
        self.forked_from.append(snapshot_id)
        return self.auditor

    async def get_snapshot(self, snapshot_id: str) -> SnapshotRecord:
        return SnapshotRecord(self.snapshot_id, self.parent, self.kind, "default")

    async def promote_snapshot(self, snapshot_id: str, *, name: str) -> str:
        self.promoted.append(snapshot_id)
        return "tpl-approved"


class OrchestratorTests(unittest.IsolatedAsyncioTestCase):
    async def test_oracle_reads_a_fork_of_the_exact_candidate_snapshot(self) -> None:
        backend = FakeBackend()
        candidate = FakeBranch("worker-a")

        async def oracle(branch: FakeBranch) -> OracleVerdict:
            self.assertIs(branch, backend.auditor)
            self.assertTrue(branch.connected)
            return valid_verdict()

        result = await audit_sealed_candidate(
            backend=backend,
            candidate=candidate,
            canonical_snapshot_id="snap-canonical",
            case_digest=digest("case"),
            fault_schedule_digest=digest("fault"),
            action_log_digest=digest("actions"),
            oracle=oracle,
        )

        self.assertEqual(backend.forked_from, ["snap-candidate"])
        self.assertEqual(result.candidate_snapshot_id, "snap-candidate")
        self.assertEqual(result.receipt.candidate_snapshot_id, "snap-candidate")
        self.assertTrue(backend.auditor.killed)

    async def test_oracle_exception_fails_closed(self) -> None:
        backend = FakeBackend()

        async def broken_oracle(_branch: FakeBranch) -> OracleVerdict:
            raise RuntimeError("query failed")

        result = await audit_sealed_candidate(
            backend=backend,
            candidate=FakeBranch("worker-a"),
            canonical_snapshot_id="snap-canonical",
            case_digest=digest("case"),
            fault_schedule_digest=digest("fault"),
            action_log_digest=digest("actions"),
            oracle=broken_oracle,
        )
        self.assertIsNone(result.verdict)
        self.assertIsNone(result.receipt)
        self.assertEqual(result.audit_error, "RuntimeError: query failed")
        self.assertTrue(backend.auditor.killed)

    async def test_only_eligible_snapshot_is_promoted(self) -> None:
        backend = FakeBackend()

        async def oracle(_branch: FakeBranch) -> OracleVerdict:
            return valid_verdict()

        candidate = await audit_sealed_candidate(
            backend=backend,
            candidate=FakeBranch("worker-a"),
            canonical_snapshot_id="snap-canonical",
            case_digest=digest("case"),
            fault_schedule_digest=digest("fault"),
            action_log_digest=digest("actions"),
            oracle=oracle,
        )
        outcome = await promote_eligible_snapshot(
            backend=backend,
            candidates=(candidate,),
            expected_case_digest=digest("case"),
            canonical_snapshot_id="snap-canonical",
            expected_check_codes=("all",),
            expected_auditor_bundle_digest=BUNDLE_DIGEST,
            expected_auditor_runtime_digest=RUNTIME_DIGEST,
            template_name="forklift-approved",
        )
        self.assertEqual(outcome.template_id, "tpl-approved")
        self.assertEqual(backend.promoted, ["snap-candidate"])

    async def test_unrelated_snapshot_is_never_promoted(self) -> None:
        backend = FakeBackend(parent="snap-somewhere-else")

        async def oracle(_branch: FakeBranch) -> OracleVerdict:
            return valid_verdict()

        candidate = await audit_sealed_candidate(
            backend=backend,
            candidate=FakeBranch("worker-a"),
            canonical_snapshot_id="snap-canonical",
            case_digest=digest("case"),
            fault_schedule_digest=digest("fault"),
            action_log_digest=digest("actions"),
            oracle=oracle,
        )
        outcome = await promote_eligible_snapshot(
            backend=backend,
            candidates=(candidate,),
            expected_case_digest=digest("case"),
            canonical_snapshot_id="snap-canonical",
            expected_check_codes=("all",),
            expected_auditor_bundle_digest=BUNDLE_DIGEST,
            expected_auditor_runtime_digest=RUNTIME_DIGEST,
            template_name="forklift-approved",
        )
        self.assertIsNone(outcome.template_id)
        self.assertEqual(backend.promoted, [])

    async def test_snapshot_lookup_id_mismatch_fails_closed(self) -> None:
        backend = FakeBackend(snapshot_id="snap-other")

        async def oracle(_branch: FakeBranch) -> OracleVerdict:
            return valid_verdict()

        result = await audit_sealed_candidate(
            backend=backend,
            candidate=FakeBranch("worker-a"),
            canonical_snapshot_id="snap-canonical",
            case_digest=digest("case"),
            fault_schedule_digest=digest("fault"),
            action_log_digest=digest("actions"),
            oracle=oracle,
        )
        self.assertIsNone(result.verdict)
        self.assertIsNone(result.receipt)
        self.assertEqual(backend.forked_from, [])

    async def test_non_desktop_snapshot_fails_closed(self) -> None:
        backend = FakeBackend(kind="sandbox")

        async def oracle(_branch: FakeBranch) -> OracleVerdict:
            return valid_verdict()

        result = await audit_sealed_candidate(
            backend=backend,
            candidate=FakeBranch("worker-a"),
            canonical_snapshot_id="snap-canonical",
            case_digest=digest("case"),
            fault_schedule_digest=digest("fault"),
            action_log_digest=digest("actions"),
            oracle=oracle,
        )
        self.assertIsNone(result.verdict)
        self.assertIsNone(result.receipt)
        self.assertEqual(backend.forked_from, [])

    async def test_sandbox_state_snapshot_is_allowed_only_when_explicit(self) -> None:
        backend = FakeBackend(kind="sandbox")

        async def oracle(_branch: FakeBranch) -> OracleVerdict:
            return valid_verdict()

        result = await audit_sealed_candidate(
            backend=backend,
            candidate=FakeBranch("worker-a"),
            canonical_snapshot_id="snap-canonical",
            case_digest=digest("case"),
            fault_schedule_digest=digest("fault"),
            action_log_digest=digest("actions"),
            oracle=oracle,
            expected_snapshot_kind="sandbox",
        )
        self.assertIsNotNone(result.receipt)
        self.assertEqual(backend.forked_from, ["snap-candidate"])


if __name__ == "__main__":
    unittest.main()
