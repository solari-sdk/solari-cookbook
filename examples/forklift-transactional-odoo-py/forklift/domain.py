"""Frozen business contract and normalized read-only evidence.

All money and quantities are Decimal strings at process boundaries. Binary
floating-point values are intentionally rejected before they reach the oracle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP


def D(value: str | int | Decimal) -> Decimal:
    """Create a Decimal while refusing the silent ambiguity of float input."""

    if isinstance(value, float):
        raise TypeError("float evidence is forbidden; use an exact decimal string")
    return value if isinstance(value, Decimal) else Decimal(str(value))


@dataclass(frozen=True)
class PurchaseCase:
    case_id: str
    supplier_ref: str
    sku: str
    ordered_qty: Decimal
    received_qty: Decimal
    unit_price: Decimal
    tax_rate: Decimal
    currency: str
    currency_rounding: Decimal
    bill_reference: str
    payment_journal: str
    pay_when_billable: bool = True

    def __post_init__(self) -> None:
        for name in (
            "ordered_qty",
            "received_qty",
            "unit_price",
            "tax_rate",
            "currency_rounding",
        ):
            value = getattr(self, name)
            if not isinstance(value, Decimal):
                raise TypeError(f"{name} must be Decimal")
        if not self.case_id or not self.supplier_ref or not self.sku:
            raise ValueError("case_id, supplier_ref, and sku are required")
        if self.ordered_qty <= 0:
            raise ValueError("ordered_qty must be positive")
        if not Decimal("0") <= self.received_qty <= self.ordered_qty:
            raise ValueError("received_qty must be between zero and ordered_qty")
        if self.unit_price < 0 or self.tax_rate < 0:
            raise ValueError("price and tax rate cannot be negative")
        if self.currency_rounding <= 0:
            raise ValueError("currency_rounding must be positive")

    def money(self, value: Decimal) -> Decimal:
        return value.quantize(self.currency_rounding, rounding=ROUND_HALF_UP)

    @property
    def billable(self) -> bool:
        return self.received_qty > 0

    @property
    def expected_untaxed(self) -> Decimal:
        return self.money(self.received_qty * self.unit_price)

    @property
    def expected_tax(self) -> Decimal:
        return self.money(self.expected_untaxed * self.tax_rate)

    @property
    def expected_total(self) -> Decimal:
        return self.money(self.expected_untaxed + self.expected_tax)

    @property
    def payment_expected(self) -> bool:
        return self.billable and self.pay_when_billable


@dataclass(frozen=True)
class PurchaseOrderEvidence:
    object_id: int
    case_id: str
    state: str
    supplier_ref: str
    currency: str
    sku: str
    ordered_qty: Decimal
    unit_price: Decimal
    tax_rate: Decimal


@dataclass(frozen=True)
class PickingEvidence:
    object_id: int
    purchase_order_id: int
    state: str
    sku: str
    done_qty: Decimal
    direction: str = "incoming"


@dataclass(frozen=True)
class BillEvidence:
    object_id: int
    purchase_order_id: int
    state: str
    supplier_ref: str
    currency: str
    reference: str
    sku: str
    billed_qty: Decimal
    untaxed: Decimal
    tax: Decimal
    total: Decimal
    payment_state: str
    residual: Decimal


@dataclass(frozen=True)
class JournalEntryEvidence:
    object_id: int
    source_object_id: int
    state: str
    debit: Decimal
    credit: Decimal
    payable_amount: Decimal
    tax_amount: Decimal


@dataclass(frozen=True)
class PaymentEvidence:
    object_id: int
    bill_id: int
    state: str
    supplier_ref: str
    currency: str
    journal: str
    amount: Decimal
    reconciled: bool


@dataclass(frozen=True)
class EvidenceBundle:
    purchase_orders: tuple[PurchaseOrderEvidence, ...] = ()
    pickings: tuple[PickingEvidence, ...] = ()
    bills: tuple[BillEvidence, ...] = ()
    journal_entries: tuple[JournalEntryEvidence, ...] = ()
    payments: tuple[PaymentEvidence, ...] = ()
    unexpected_object_ids: tuple[str, ...] = ()
    query_errors: tuple[str, ...] = ()
    metadata: dict[str, str] = field(default_factory=dict)

