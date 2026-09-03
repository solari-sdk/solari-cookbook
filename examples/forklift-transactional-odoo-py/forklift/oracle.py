"""Independent semantic acceptance oracle.

The oracle is intentionally boring and strict. It accumulates every failed
invariant, but any exception is converted into a rejection rather than an
"unknown" state that could accidentally pass.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Callable

from .domain import EvidenceBundle, PurchaseCase


ORACLE_VERSION = "forklift-oracle-v2"


@dataclass(frozen=True)
class Check:
    code: str
    passed: bool
    detail: str


@dataclass(frozen=True)
class OracleVerdict:
    accepted: bool
    checks: tuple[Check, ...]
    oracle_version: str = ORACLE_VERSION
    auditor_bundle_digest: str = ""
    auditor_runtime_digest: str = ""

    @property
    def failed_codes(self) -> tuple[str, ...]:
        return tuple(check.code for check in self.checks if not check.passed)

    def digest(self) -> str:
        payload = {
            "accepted": self.accepted,
            "auditor_bundle_digest": self.auditor_bundle_digest,
            "auditor_runtime_digest": self.auditor_runtime_digest,
            "checks": [
                {"code": check.code, "detail": check.detail, "passed": check.passed}
                for check in self.checks
            ],
            "oracle_version": self.oracle_version,
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()


def expected_check_codes(case: PurchaseCase) -> tuple[str, ...]:
    codes = [
        "query-clean",
        "no-unexpected-objects",
        "one-purchase-order",
        "po-case_id",
        "po-state",
        "po-supplier_ref",
        "po-currency",
        "po-sku",
        "po-ordered_qty",
        "po-unit_price",
        "po-tax_rate",
        "all-pickings-linked",
        "pickings-exist",
        "one-completed-receipt",
        "received-quantity",
        "incoming-correct-sku-only",
        "open-backorders-unmoved",
        "bill-count",
    ]
    if not case.billable:
        return tuple(codes + ["no-zero-receipt-journal", "no-zero-receipt-payment"])
    codes.extend(
        [
            "bill-purchase_order_id",
            "bill-state",
            "bill-supplier_ref",
            "bill-currency",
            "bill-reference",
            "bill-sku",
            "bill-billed_qty",
            "bill-untaxed",
            "bill-tax",
            "bill-total",
            "bill-payment_state",
            "bill-residual",
            "journal-entry-present",
            "journal-entries-posted",
            "journal-entries-balanced",
            "one-bill-journal-entry",
            "journal-payable",
            "journal-tax",
            "payment-count",
        ]
    )
    if case.payment_expected:
        codes.extend(
            [
                "payment-bill_id",
                "payment-state",
                "payment-supplier_ref",
                "payment-currency",
                "payment-journal",
                "payment-amount",
                "payment-reconciled",
            ]
        )
    return tuple(codes)


def evaluate(case: PurchaseCase, evidence: EvidenceBundle) -> OracleVerdict:
    checks: list[Check] = []

    def check(code: str, condition: bool, detail: str) -> None:
        checks.append(Check(code=code, passed=bool(condition), detail=detail))

    try:
        check("query-clean", not evidence.query_errors, repr(evidence.query_errors))
        check(
            "no-unexpected-objects",
            not evidence.unexpected_object_ids,
            repr(evidence.unexpected_object_ids),
        )

        check("one-purchase-order", len(evidence.purchase_orders) == 1, str(len(evidence.purchase_orders)))
        if len(evidence.purchase_orders) != 1:
            return _finish(checks)

        po = evidence.purchase_orders[0]
        expected_po = {
            "case_id": case.case_id,
            "state": "purchase",
            "supplier_ref": case.supplier_ref,
            "currency": case.currency,
            "sku": case.sku,
            "ordered_qty": case.ordered_qty,
            "unit_price": case.unit_price,
            "tax_rate": case.tax_rate,
        }
        for field_name, expected in expected_po.items():
            actual = getattr(po, field_name)
            check(f"po-{field_name}", actual == expected, f"expected={expected!r} actual={actual!r}")

        related_pickings = tuple(p for p in evidence.pickings if p.purchase_order_id == po.object_id)
        check("all-pickings-linked", len(related_pickings) == len(evidence.pickings), str(len(evidence.pickings)))
        check("pickings-exist", bool(related_pickings), str(len(related_pickings)))
        completed = tuple(p for p in related_pickings if p.state == "done")
        completed_qty = sum((p.done_qty for p in completed), Decimal("0"))
        check("one-completed-receipt", len(completed) == (1 if case.billable else 0), str(len(completed)))
        check("received-quantity", completed_qty == case.received_qty, f"expected={case.received_qty} actual={completed_qty}")
        check(
            "incoming-correct-sku-only",
            all(p.direction == "incoming" and p.sku == case.sku for p in related_pickings),
            repr(tuple((p.direction, p.sku) for p in related_pickings)),
        )
        check(
            "open-backorders-unmoved",
            all(p.done_qty == 0 for p in related_pickings if p.state != "done"),
            repr(tuple((p.state, p.done_qty) for p in related_pickings)),
        )

        expected_bill_count = 1 if case.billable else 0
        check("bill-count", len(evidence.bills) == expected_bill_count, str(len(evidence.bills)))
        if not case.billable:
            check("no-zero-receipt-journal", not evidence.journal_entries, str(len(evidence.journal_entries)))
            check("no-zero-receipt-payment", not evidence.payments, str(len(evidence.payments)))
            return _finish(checks)
        if len(evidence.bills) != 1:
            return _finish(checks)

        bill = evidence.bills[0]
        expected_bill = {
            "purchase_order_id": po.object_id,
            "state": "posted",
            "supplier_ref": case.supplier_ref,
            "currency": case.currency,
            "reference": case.bill_reference,
            "sku": case.sku,
            "billed_qty": case.received_qty,
            "untaxed": case.expected_untaxed,
            "tax": case.expected_tax,
            "total": case.expected_total,
            "payment_state": "paid" if case.payment_expected else "not_paid",
            "residual": Decimal("0") if case.payment_expected else case.expected_total,
        }
        for field_name, expected in expected_bill.items():
            actual = getattr(bill, field_name)
            check(f"bill-{field_name}", actual == expected, f"expected={expected!r} actual={actual!r}")

        check("journal-entry-present", bool(evidence.journal_entries), str(len(evidence.journal_entries)))
        check(
            "journal-entries-posted",
            all(entry.state == "posted" for entry in evidence.journal_entries),
            repr(tuple(entry.state for entry in evidence.journal_entries)),
        )
        check(
            "journal-entries-balanced",
            all(entry.debit == entry.credit for entry in evidence.journal_entries),
            repr(tuple((entry.debit, entry.credit) for entry in evidence.journal_entries)),
        )
        # A posted bill is itself an account.move, so its journal entry is
        # identified by the move's object_id.  source_object_id is polymorphic:
        # it is an account.move id for bills but an account.payment id for
        # payments.  Those independent sequences can legally collide.
        bill_entries = tuple(
            entry for entry in evidence.journal_entries
            if entry.object_id == bill.object_id
        )
        check("one-bill-journal-entry", len(bill_entries) == 1, str(len(bill_entries)))
        if len(bill_entries) == 1:
            entry = bill_entries[0]
            check("journal-payable", entry.payable_amount == case.expected_total, f"expected={case.expected_total} actual={entry.payable_amount}")
            check("journal-tax", entry.tax_amount == case.expected_tax, f"expected={case.expected_tax} actual={entry.tax_amount}")

        expected_payment_count = 1 if case.payment_expected else 0
        check("payment-count", len(evidence.payments) == expected_payment_count, str(len(evidence.payments)))
        if case.payment_expected and len(evidence.payments) == 1:
            payment = evidence.payments[0]
            expected_payment = {
                "bill_id": bill.object_id,
                "state": "paid",
                "supplier_ref": case.supplier_ref,
                "currency": case.currency,
                "journal": case.payment_journal,
                "amount": case.expected_total,
                "reconciled": True,
            }
            for field_name, expected in expected_payment.items():
                actual = getattr(payment, field_name)
                check(f"payment-{field_name}", actual == expected, f"expected={expected!r} actual={actual!r}")
    except Exception as exc:  # Fail closed on schema drift and query surprises.
        check("oracle-exception", False, f"{type(exc).__name__}: {exc}")

    return _finish(checks)


def safely_evaluate(
    case: PurchaseCase,
    evidence_loader: Callable[[], EvidenceBundle],
) -> OracleVerdict:
    """Load evidence without permitting a database/query failure to pass."""

    try:
        evidence = evidence_loader()
    except Exception as exc:
        return OracleVerdict(
            accepted=False,
            checks=(Check("evidence-load", False, f"{type(exc).__name__}: {exc}"),),
        )
    return evaluate(case, evidence)


def _finish(checks: list[Check]) -> OracleVerdict:
    frozen = tuple(checks)
    return OracleVerdict(accepted=bool(frozen) and all(check.passed for check in frozen), checks=frozen)
