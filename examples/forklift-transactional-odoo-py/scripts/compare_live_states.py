"""One-command developmental proof against two real Odoo/PostgreSQL states."""

from __future__ import annotations

import os
from decimal import Decimal
from pathlib import Path
from urllib.parse import quote

from forklift.domain import PurchaseCase
from forklift.odoo_sql import load_case_evidence
from forklift.oracle import evaluate
from scripts.check_solari_auth import _load_local_env


ROOT = Path(__file__).resolve().parents[1]
_load_local_env(ROOT / ".env")
AUDITOR_PASSWORD = os.environ.get("FORKLIFT_AUDITOR_DB_PASSWORD", "").strip()
if len(AUDITOR_PASSWORD) < 20:
    raise RuntimeError("FORKLIFT_AUDITOR_DB_PASSWORD must contain at least 20 characters")


interrupted = PurchaseCase(
    case_id="FORKLIFT-INTERRUPTED-001",
    supplier_ref="SUP-ACME-04",
    sku="BEARING-6204",
    ordered_qty=Decimal("10"),
    received_qty=Decimal("6"),
    unit_price=Decimal("12.35"),
    tax_rate=Decimal("0.075"),
    currency="USD",
    currency_rounding=Decimal("0.01"),
    bill_reference="ACME-INTERRUPTED-001",
    payment_journal="FORKLIFT-BANK",
)
valid = PurchaseCase(
    case_id="FORKLIFT-FIXTURE-VALID-001",
    supplier_ref="SUP-ACME-04",
    sku="BEARING-6204",
    ordered_qty=Decimal("10"),
    received_qty=Decimal("10"),
    unit_price=Decimal("12.35"),
    tax_rate=Decimal("0.075"),
    currency="USD",
    currency_rounding=Decimal("0.01"),
    bill_reference="ACME-FIXTURE-001",
    payment_journal="FORKLIFT-BANK",
)


def verdict(case: PurchaseCase, database: str):
    password = quote(AUDITOR_PASSWORD, safe="")
    dsn = f"postgresql://forklift_auditor:{password}@127.0.0.1:5433/{database}"
    return evaluate(case, load_case_evidence(dsn, case))


broken_result = verdict(interrupted, "forklift_interrupted_fixture")
valid_result = verdict(valid, "forklift_oracle_fixture")

print("FORKLIFT - LIVE ODOO CRASH CHALLENGE")
print(
    "interrupted after receiving stock: "
    f"{'ACCEPT' if broken_result.accepted else 'REJECT'} "
    f"({', '.join(broken_result.failed_codes) or 'all checks passed'})"
)
print(
    "fully balanced purchase-to-pay:    "
    f"{'ACCEPT' if valid_result.accepted else 'REJECT'} "
    f"({', '.join(valid_result.failed_codes) or 'all checks passed'})"
)

passed = not broken_result.accepted and valid_result.accepted
print(
    "RESULT: "
    + (
        "PASS - broken state blocked; valid state accepted."
        if passed
        else "FAIL - the safety/liveness discriminator did not hold."
    )
)
raise SystemExit(0 if passed else 1)
