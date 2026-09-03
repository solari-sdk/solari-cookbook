from __future__ import annotations

import copy
import unittest
from dataclasses import replace
from decimal import Decimal

from forklift.domain import (
    BillEvidence,
    EvidenceBundle,
    JournalEntryEvidence,
    PaymentEvidence,
    PickingEvidence,
    PurchaseCase,
    PurchaseOrderEvidence,
)
from forklift.oracle import evaluate, expected_check_codes, safely_evaluate


def D(value: str) -> Decimal:
    return Decimal(value)


CASE = PurchaseCase(
    case_id="FORKLIFT-CASE-017",
    supplier_ref="SUP-ACME-04",
    sku="BEARING-6204",
    ordered_qty=D("10"),
    received_qty=D("6"),
    unit_price=D("12.35"),
    tax_rate=D("0.075"),
    currency="USD",
    currency_rounding=D("0.01"),
    bill_reference="ACME-INV-88017",
    payment_journal="FORKLIFT-BANK",
)


def valid_evidence(case: PurchaseCase = CASE) -> EvidenceBundle:
    po = PurchaseOrderEvidence(
        object_id=101,
        case_id=case.case_id,
        state="purchase",
        supplier_ref=case.supplier_ref,
        currency=case.currency,
        sku=case.sku,
        ordered_qty=case.ordered_qty,
        unit_price=case.unit_price,
        tax_rate=case.tax_rate,
    )
    bill = BillEvidence(
        object_id=301,
        purchase_order_id=po.object_id,
        state="posted",
        supplier_ref=case.supplier_ref,
        currency=case.currency,
        reference=case.bill_reference,
        sku=case.sku,
        billed_qty=case.received_qty,
        untaxed=case.expected_untaxed,
        tax=case.expected_tax,
        total=case.expected_total,
        payment_state="paid",
        residual=D("0"),
    )
    return EvidenceBundle(
        purchase_orders=(po,),
        pickings=(
            PickingEvidence(201, po.object_id, "done", case.sku, case.received_qty),
            PickingEvidence(202, po.object_id, "assigned", case.sku, D("0")),
        ),
        bills=(bill,),
        journal_entries=(
            JournalEntryEvidence(
                object_id=bill.object_id,
                source_object_id=bill.object_id,
                state="posted",
                debit=case.expected_total,
                credit=case.expected_total,
                payable_amount=case.expected_total,
                tax_amount=case.expected_tax,
            ),
            JournalEntryEvidence(
                object_id=402,
                source_object_id=501,
                state="posted",
                debit=case.expected_total,
                credit=case.expected_total,
                payable_amount=D("0"),
                tax_amount=D("0"),
            ),
        ),
        payments=(
            PaymentEvidence(
                object_id=501,
                bill_id=bill.object_id,
                state="paid",
                supplier_ref=case.supplier_ref,
                currency=case.currency,
                journal=case.payment_journal,
                amount=case.expected_total,
                reconciled=True,
            ),
        ),
    )


class OracleTests(unittest.TestCase):
    def assert_rejected(self, evidence: EvidenceBundle, code: str) -> None:
        verdict = evaluate(CASE, evidence)
        self.assertFalse(verdict.accepted)
        self.assertIn(code, verdict.failed_codes)

    def test_accepts_only_complete_valid_state(self) -> None:
        verdict = evaluate(CASE, valid_evidence())
        self.assertTrue(verdict.accepted, verdict.failed_codes)
        self.assertEqual(
            tuple(check.code for check in verdict.checks),
            expected_check_codes(CASE),
        )

    def test_accepts_bill_and_payment_ids_from_independent_colliding_sequences(self) -> None:
        evidence = valid_evidence()
        bill_id = evidence.bills[0].object_id
        colliding_payment = replace(evidence.payments[0], object_id=bill_id)
        colliding_payment_entry = replace(
            evidence.journal_entries[1],
            source_object_id=bill_id,
        )
        collision = replace(
            evidence,
            journal_entries=(evidence.journal_entries[0], colliding_payment_entry),
            payments=(colliding_payment,),
        )
        verdict = evaluate(CASE, collision)
        self.assertTrue(verdict.accepted, verdict.failed_codes)

    def test_rejects_duplicate_purchase_order(self) -> None:
        evidence = valid_evidence()
        self.assert_rejected(replace(evidence, purchase_orders=evidence.purchase_orders * 2), "one-purchase-order")

    def test_rejects_wrong_supplier(self) -> None:
        evidence = valid_evidence()
        wrong = replace(evidence.purchase_orders[0], supplier_ref="SUP-EVIL")
        self.assert_rejected(replace(evidence, purchase_orders=(wrong,)), "po-supplier_ref")

    def test_rejects_wrong_order_quantity(self) -> None:
        evidence = valid_evidence()
        wrong = replace(evidence.purchase_orders[0], ordered_qty=D("9"))
        self.assert_rejected(replace(evidence, purchase_orders=(wrong,)), "po-ordered_qty")

    def test_rejects_over_receipt(self) -> None:
        evidence = valid_evidence()
        wrong = replace(evidence.pickings[0], done_qty=D("10"))
        self.assert_rejected(replace(evidence, pickings=(wrong,) + evidence.pickings[1:]), "received-quantity")

    def test_rejects_duplicate_completed_receipt(self) -> None:
        evidence = valid_evidence()
        duplicate = replace(evidence.pickings[0], object_id=299)
        self.assert_rejected(replace(evidence, pickings=evidence.pickings + (duplicate,)), "one-completed-receipt")

    def test_rejects_draft_bill(self) -> None:
        evidence = valid_evidence()
        wrong = replace(evidence.bills[0], state="draft")
        self.assert_rejected(replace(evidence, bills=(wrong,)), "bill-state")

    def test_rejects_overbilling(self) -> None:
        evidence = valid_evidence()
        wrong = replace(evidence.bills[0], billed_qty=D("10"))
        self.assert_rejected(replace(evidence, bills=(wrong,)), "bill-billed_qty")

    def test_rejects_tax_rounding_error(self) -> None:
        evidence = valid_evidence()
        wrong = replace(evidence.bills[0], tax=evidence.bills[0].tax + D("0.01"))
        self.assert_rejected(replace(evidence, bills=(wrong,)), "bill-tax")

    def test_rejects_unbalanced_journal(self) -> None:
        evidence = valid_evidence()
        wrong = replace(evidence.journal_entries[0], credit=D("0"))
        self.assert_rejected(replace(evidence, journal_entries=(wrong,) + evidence.journal_entries[1:]), "journal-entries-balanced")

    def test_rejects_wrong_payment_amount(self) -> None:
        evidence = valid_evidence()
        wrong = replace(evidence.payments[0], amount=evidence.payments[0].amount - D("0.01"))
        self.assert_rejected(replace(evidence, payments=(wrong,)), "payment-amount")

    def test_rejects_duplicate_payment(self) -> None:
        evidence = valid_evidence()
        duplicate = replace(evidence.payments[0], object_id=599)
        self.assert_rejected(replace(evidence, payments=evidence.payments + (duplicate,)), "payment-count")

    def test_rejects_payment_to_wrong_vendor(self) -> None:
        evidence = valid_evidence()
        wrong = replace(evidence.payments[0], supplier_ref="SUP-EVIL")
        self.assert_rejected(replace(evidence, payments=(wrong,)), "payment-supplier_ref")

    def test_rejects_any_unexpected_case_object(self) -> None:
        evidence = replace(valid_evidence(), unexpected_object_ids=("account.payment:999",))
        self.assert_rejected(evidence, "no-unexpected-objects")

    def test_rejects_query_error(self) -> None:
        evidence = replace(valid_evidence(), query_errors=("column missing",))
        self.assert_rejected(evidence, "query-clean")

    def test_rejects_loader_exception(self) -> None:
        verdict = safely_evaluate(CASE, lambda: (_ for _ in ()).throw(RuntimeError("database unavailable")))
        self.assertFalse(verdict.accepted)
        self.assertEqual(verdict.failed_codes, ("evidence-load",))

    def test_zero_receipt_forbids_bill_and_payment(self) -> None:
        zero = replace(CASE, received_qty=D("0"))
        po = replace(valid_evidence().purchase_orders[0], ordered_qty=zero.ordered_qty)
        waiting = PickingEvidence(201, po.object_id, "assigned", zero.sku, D("0"))
        evidence = EvidenceBundle(purchase_orders=(po,), pickings=(waiting,))
        accepted = evaluate(zero, evidence)
        self.assertTrue(accepted.accepted)
        self.assertEqual(
            tuple(check.code for check in accepted.checks),
            expected_check_codes(zero),
        )
        contaminated = replace(evidence, payments=valid_evidence().payments)
        verdict = evaluate(zero, contaminated)
        self.assertFalse(verdict.accepted)
        self.assertIn("no-zero-receipt-payment", verdict.failed_codes)


if __name__ == "__main__":
    unittest.main()
