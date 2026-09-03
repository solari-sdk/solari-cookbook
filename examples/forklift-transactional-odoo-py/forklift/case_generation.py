"""Deterministic, seed-held-out purchase cases for repeated trials."""

from __future__ import annotations

import hashlib
import json
import random
from decimal import Decimal

from .domain import PurchaseCase


ORDERED = (
    Decimal("1"),
    Decimal("3.5"),
    Decimal("10"),
    Decimal("12.75"),
    Decimal("100"),
)
UNIT_PRICES = (
    Decimal("0.01"),
    Decimal("0.05"),
    Decimal("1.99"),
    Decimal("12.35"),
    Decimal("999.99"),
)
TAX_RATES = (
    Decimal("0"),
    Decimal("0.055"),
    Decimal("0.075"),
    Decimal("0.19"),
)


def case_payload(case: PurchaseCase) -> dict[str, str | bool]:
    """Canonical JSON-safe representation used by receipts and manifests."""

    return {
        "case_id": case.case_id,
        "supplier_ref": case.supplier_ref,
        "sku": case.sku,
        "ordered_qty": str(case.ordered_qty),
        "received_qty": str(case.received_qty),
        "unit_price": str(case.unit_price),
        "tax_rate": str(case.tax_rate),
        "currency": case.currency,
        "currency_rounding": str(case.currency_rounding),
        "bill_reference": case.bill_reference,
        "payment_journal": case.payment_journal,
        "pay_when_billable": case.pay_when_billable,
    }


def case_digest(case: PurchaseCase) -> str:
    encoded = json.dumps(case_payload(case), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def manifest_digest(cases: tuple[PurchaseCase, ...]) -> str:
    encoded = json.dumps(
        [case_payload(case) for case in cases],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def generate_cases(*, seed: str, count: int, namespace: str) -> tuple[PurchaseCase, ...]:
    """Generate balanced cases without embedding the sealed seed in the repo."""

    if not seed:
        raise ValueError("seed cannot be blank")
    if count < 1:
        raise ValueError("count must be positive")
    if not namespace or not namespace.replace("-", "").isalnum():
        raise ValueError("namespace must contain only letters, digits, and hyphens")

    seed_digest = hashlib.sha256(seed.encode("utf-8")).digest()
    rng = random.Random(int.from_bytes(seed_digest, "big"))
    received_modes = ["zero", "partial", "full"]
    cases: list[PurchaseCase] = []

    for index in range(count):
        ordered = ORDERED[(index + rng.randrange(len(ORDERED))) % len(ORDERED)]
        price = UNIT_PRICES[(index + rng.randrange(len(UNIT_PRICES))) % len(UNIT_PRICES)]
        tax_rate = TAX_RATES[(index + rng.randrange(len(TAX_RATES))) % len(TAX_RATES)]
        mode = received_modes[index % len(received_modes)]

        if mode == "zero":
            received = Decimal("0")
        elif mode == "full":
            received = ordered
        else:
            # The exact half can be awkward for fractional UoM values. Quantize
            # to 0.01 and force a legal strict interior point.
            received = (ordered / Decimal("2")).quantize(Decimal("0.01"))
            if received <= 0:
                received = Decimal("0.01")
            if received >= ordered:
                received = ordered - Decimal("0.01")

        opaque = hashlib.sha256(
            f"{seed}\0{namespace}\0{index}".encode("utf-8")
        ).hexdigest()[:10].upper()
        case_id = f"FORKLIFT-{namespace.upper()}-{index + 1:03d}-{opaque}"
        cases.append(
            PurchaseCase(
                case_id=case_id,
                supplier_ref="SUP-ACME-04",
                sku="BEARING-6204",
                ordered_qty=ordered,
                received_qty=received,
                unit_price=price,
                tax_rate=tax_rate,
                currency="USD",
                currency_rounding=Decimal("0.01"),
                bill_reference=f"ACME-{namespace.upper()}-{index + 1:03d}-{opaque}",
                payment_journal="FORKLIFT-BANK",
            )
        )
    return tuple(cases)

