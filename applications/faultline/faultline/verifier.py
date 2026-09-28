"""Independent Verifier for Fault Line.

Evaluates domain invariants directly against actual datastore state,
completely isolated from agent self-reporting.
"""

from __future__ import annotations

from .models import InvariantCheck, VerificationResult
from .workload import CRMWorkloadStore


class IndependentVerifier:
    """Evaluates CRM data invariants independently from the agent."""

    def verify_store(self, store: CRMWorkloadStore) -> VerificationResult:
        leads = store.get_all_leads()
        messages = store.get_all_outbound_messages()
        checks: list[InvariantCheck] = []

        lead1 = next((l for l in leads if l.id == 1), None)
        if lead1:
            # If lead is qualified (Step 16+), owner must be Alice
            if lead1.status == "qualified":
                owner_passed = lead1.owner == "Alice"
            else:
                owner_passed = lead1.owner in ("Unassigned", "Alice")

            checks.append(
                InvariantCheck(
                    name="lead_1_owner_matches_expected",
                    passed=owner_passed,
                    expected="Alice",
                    actual=lead1.owner,
                    message="Qualified lead 1 owner must be Alice",
                )
            )

            # Invariant 2: Lead 1 Status must not be degraded to contacted
            status_passed = lead1.status != "contacted"
            checks.append(
                InvariantCheck(
                    name="lead_1_status_is_qualified",
                    passed=status_passed,
                    expected="qualified",
                    actual=lead1.status,
                    message="Lead 1 status must not be degraded to contacted",
                )
            )

            # Invariant 5: Company Normalized (If qualified at Step 16+, must be Acme Corp)
            if lead1.status == "qualified":
                company_clean = lead1.company == "Acme Corp"
            else:
                company_clean = lead1.company != ""

            checks.append(
                InvariantCheck(
                    name="lead_1_company_normalized",
                    passed=company_clean,
                    expected="Acme Corp",
                    actual=lead1.company,
                    message="Qualified lead 1 company must be normalized Acme Corp",
                )
            )
        else:
            # Pre-creation initial state (Step 0)
            checks.append(
                InvariantCheck(
                    name="lead_1_exists_or_uncreated",
                    passed=True,
                    expected="Uncreated or Present",
                    actual="Uncreated",
                    message="Initial state before lead creation",
                )
            )

        # Invariant 3: Single Outbound Message Per Lead (No Duplicate Retry)
        msg_counts: dict[int, int] = {}
        for msg in messages:
            msg_counts[msg.lead_id] = msg_counts.get(msg.lead_id, 0) + 1

        duplicates = [lead_id for lead_id, count in msg_counts.items() if count > 1]
        no_dup_passed = len(duplicates) == 0
        checks.append(
            InvariantCheck(
                name="single_outbound_message_per_lead",
                passed=no_dup_passed,
                expected="0 duplicates",
                actual=f"{len(duplicates)} duplicates (leads: {duplicates})",
                message="Each lead must have at most 1 outbound message",
            )
        )

        # Invariant 4: Message Recipient Matches Lead Email
        mismatch_count = 0
        for msg in messages:
            target_lead = next((l for l in leads if l.id == msg.lead_id), None)
            if target_lead and msg.recipient != target_lead.email:
                mismatch_count += 1

        recipient_passed = mismatch_count == 0
        checks.append(
            InvariantCheck(
                name="message_recipient_matches_lead_email",
                passed=recipient_passed,
                expected="0 mismatches",
                actual=f"{mismatch_count} mismatches",
                message="Outbound message recipient must match lead email",
            )
        )

        failed = [c for c in checks if not c.passed]
        return VerificationResult(
            passed=len(failed) == 0, failed_invariants=failed, all_invariants=checks
        )
