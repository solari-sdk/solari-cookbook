"""Deterministic ledger task and artifact verifier."""

from __future__ import annotations

import csv
import hashlib
import io

from .models import Candidate, Check

BASE_LEDGER = """vendor,amount,status,cost_center
Acme Cloud,100,pending,infra
Pinetree Travel,250,pending,research
Northstar Data,250,pending,data
"""

EXPECTED_LEDGER = """vendor,amount,status,cost_center
Acme Cloud,100,pending,infra
Pinetree Travel,275,approved,research
Northstar Data,250,pending,data
"""

TASK = "Approve the Pinetree Travel expense"
TASK_DETAIL = (
    "Change Pinetree Travel from 250/pending to 275/approved. Preserve every "
    "other row, field, header, and row order."
)


def candidates() -> list[Candidate]:
    return [
        Candidate(
            id="global-replace",
            label="Global replace",
            hypothesis="Replace every 250, then approve the target row.",
            actions=(
                "focus editor",
                "replace 250 with 275 globally",
                "approve target",
                "save",
            ),
        ),
        Candidate(
            id="collateral-edit",
            label="Targeted but lossy",
            hypothesis="Rewrite the target row manually while preserving the rest by sight.",
            actions=("focus editor", "select target row", "rewrite row", "save"),
        ),
        Candidate(
            id="surgical-update",
            label="Surgical update",
            hypothesis="Change only the target amount and status, preserving all invariants.",
            actions=(
                "focus editor",
                "locate exact vendor",
                "edit amount",
                "edit status",
                "save",
            ),
        ),
    ]


def candidate_ledger(candidate_id: str) -> str:
    variants = {
        "global-replace": """vendor,amount,status,cost_center
Acme Cloud,100,pending,infra
Pinetree Travel,275,approved,research
Northstar Data,275,pending,data
""",
        "collateral-edit": """vendor,amount,status,cost_center
Acme Cloud,100,pending,infra
Pinetree Travel,275,approved,research
Northstar Data,250,pending,
""",
        "surgical-update": EXPECTED_LEDGER,
    }
    try:
        return variants[candidate_id]
    except KeyError as exc:
        raise ValueError(f"unknown ledger candidate: {candidate_id}") from exc


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_ledger(value: str) -> tuple[list[str], list[dict[str, str]]]:
    stream = io.StringIO(value)
    reader = csv.DictReader(stream)
    if reader.fieldnames is None:
        return [], []
    return list(reader.fieldnames), list(reader)


def verify_ledger(value: str) -> list[Check]:
    headers, rows = parse_ledger(value)
    by_vendor = {row.get("vendor", ""): row for row in rows}
    target = by_vendor.get("Pinetree Travel", {})
    acme = by_vendor.get("Acme Cloud", {})
    northstar = by_vendor.get("Northstar Data", {})

    checks = [
        Check(
            id="headers",
            label="Schema preserved",
            expected="vendor, amount, status, cost_center",
            actual=", ".join(headers) if headers else "missing",
            passed=headers == ["vendor", "amount", "status", "cost_center"],
            weight=3,
        ),
        Check(
            id="row-count",
            label="Exactly three expense rows",
            expected="3",
            actual=str(len(rows)),
            passed=len(rows) == 3,
            weight=3,
        ),
        Check(
            id="target-amount",
            label="Target amount updated",
            expected="275",
            actual=target.get("amount", "missing"),
            passed=target.get("amount") == "275",
            weight=5,
        ),
        Check(
            id="target-status",
            label="Target approved",
            expected="approved",
            actual=target.get("status", "missing"),
            passed=target.get("status") == "approved",
            weight=5,
        ),
        Check(
            id="acme-unchanged",
            label="Acme row unchanged",
            expected="100 / pending / infra",
            actual=" / ".join(
                acme.get(key, "missing") for key in ("amount", "status", "cost_center")
            ),
            passed=acme
            == {
                "vendor": "Acme Cloud",
                "amount": "100",
                "status": "pending",
                "cost_center": "infra",
            },
            weight=4,
        ),
        Check(
            id="northstar-unchanged",
            label="Northstar row unchanged",
            expected="250 / pending / data",
            actual=" / ".join(
                northstar.get(key, "missing")
                for key in ("amount", "status", "cost_center")
            ),
            passed=northstar
            == {
                "vendor": "Northstar Data",
                "amount": "250",
                "status": "pending",
                "cost_center": "data",
            },
            weight=4,
        ),
        Check(
            id="exact-artifact",
            label="No hidden collateral changes",
            expected=sha256_text(EXPECTED_LEDGER)[:12],
            actual=sha256_text(value)[:12],
            passed=value == EXPECTED_LEDGER,
            weight=6,
        ),
    ]
    return checks
