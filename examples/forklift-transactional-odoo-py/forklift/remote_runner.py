"""Trusted auditor entry point uploaded after a candidate snapshot is sealed."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, replace
from decimal import Decimal
from pathlib import Path

from .auditor_manifest import auditor_bundle_digest, auditor_runtime_digest
from .domain import PurchaseCase
from .odoo_sql import load_case_evidence
from .oracle import evaluate


def _case_from_json(path: str) -> PurchaseCase:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    for name in (
        "ordered_qty",
        "received_qty",
        "unit_price",
        "tax_rate",
        "currency_rounding",
    ):
        raw[name] = Decimal(raw[name])
    return PurchaseCase(**raw)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: remote_runner.py CASE_JSON DATABASE_URL")
    case = _case_from_json(sys.argv[1])
    evidence = load_case_evidence(sys.argv[2], case)
    verdict = evaluate(case, evidence)
    verdict = replace(
        verdict,
        auditor_bundle_digest=auditor_bundle_digest(Path(__file__).resolve().parent),
        auditor_runtime_digest=auditor_runtime_digest(
            evidence.metadata.get("postgres_server_version", "unknown")
        ),
    )
    payload = {
        "accepted": verdict.accepted,
        "auditor_bundle_digest": verdict.auditor_bundle_digest,
        "auditor_runtime_digest": verdict.auditor_runtime_digest,
        "oracle_version": verdict.oracle_version,
        "checks": [asdict(check) for check in verdict.checks],
    }
    print("FORKLIFT_VERDICT=" + json.dumps(payload, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
