"""Create the untouched final seed, cases, code hashes, budget, and plan."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import secrets
import sys
from pathlib import Path

from forklift.faults import DEVELOPMENT_SCHEDULES
from scripts.materialize_held_out_cases import materialize
from scripts.run_solari_clean_gui_trial import REMOTE_BROWSER_DISTRIBUTIONS


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SEALED_ROOT = PROJECT_ROOT / "artifacts" / "sealed" / "final-v2"
CASE_DIR = SEALED_ROOT / "cases"
CUSTODY_DIR = SEALED_ROOT / ".custody"
PROTOCOL_PATH = SEALED_ROOT / "protocol.json"
CANONICAL_STATE = PROJECT_ROOT / "artifacts" / "development" / "solari-canonical.json"
PROMOTION_CLOSURE = PROJECT_ROOT / "artifacts" / "development" / "promotion-closure.json"

SCHEDULES = (
    ("clean", True, ()),
    ("clean", True, ()),
    ("clean", True, ()),
    ("wrong-unit-price", False, ("po-unit_price",)),
    ("kill-after-receipt", False, ("bill-count",)),
    ("duplicate-payment", True, ()),
)

FROZEN_CODE_FILES = (
    "requirements.txt",
    "forklift/__init__.py",
    "forklift/case_generation.py",
    "forklift/domain.py",
    "forklift/faults.py",
    "forklift/gui_worker.py",
    "forklift/odoo_sql.py",
    "forklift/oracle.py",
    "forklift/orchestrator.py",
    "forklift/promotion.py",
    "forklift/receipts.py",
    "forklift/remote_oracle.py",
    "forklift/remote_runner.py",
    "forklift/solari_adapter.py",
    "scripts/bootstrap_solari_canonical.py",
    "scripts/check_solari_auth.py",
    "scripts/materialize_held_out_cases.py",
    "scripts/run_solari_clean_gui_trial.py",
    "scripts/run_final_campaign.py",
    "scripts/freeze_final_protocol.py",
)

FROZEN_DISTRIBUTIONS = (
    "anyio",
    "certifi",
    "h11",
    "httpcore",
    "httpx",
    "idna",
    "psycopg",
    "psycopg-binary",
    "sniffio",
    "solari-core",
    "solari-desktop",
    "solari-sandbox",
    "typing-extensions",
    "tzdata",
    "websockets",
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_digest(payload: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def main() -> int:
    if SEALED_ROOT.exists() and any(SEALED_ROOT.iterdir()):
        print(json.dumps({"frozen": False, "reason": "sealed_directory_not_empty"}))
        return 2
    canonical = json.loads(CANONICAL_STATE.read_text(encoding="utf-8"))
    closure = json.loads(PROMOTION_CLOSURE.read_text(encoding="utf-8"))
    if closure.get("closure") != "passed" or not closure.get("post_promotion_reaudit_accepted"):
        print(json.dumps({"frozen": False, "reason": "promotion_closure_missing"}))
        return 2

    seed = secrets.token_urlsafe(48)
    CUSTODY_DIR.mkdir(parents=True, exist_ok=True)
    (CUSTODY_DIR / "seed.txt").write_bytes(seed.encode("utf-8"))
    manifest = materialize(
        seed=seed,
        count=6,
        namespace="sealed-final-v2",
        output_dir=CASE_DIR,
    )
    schedules = {item.schedule_id: item for item in DEVELOPMENT_SCHEDULES}
    trials: list[dict[str, object]] = []
    for position, (case_row, specification) in enumerate(
        zip(manifest["cases"], SCHEDULES, strict=True), start=1
    ):
        schedule_id, expected_acceptance, required_failed_codes = specification
        trials.append(
            {
                "case_digest": case_row["case_digest"],
                "case_file": case_row["file"],
                "case_file_sha256": sha256(CASE_DIR / case_row["file"]),
                "expected_acceptance": expected_acceptance,
                "fault_schedule_digest": schedules[schedule_id].digest(),
                "position": position,
                "receipt_mode": case_row["receipt_mode"],
                "required_failed_codes": list(required_failed_codes),
                "schedule": schedule_id,
            }
        )

    code_hashes = {name: sha256(PROJECT_ROOT / name) for name in FROZEN_CODE_FILES}
    body: dict[str, object] = {
        "canonical": {
            "database_sha256": canonical["database_sha256"],
            "runtime_sha256": canonical["runtime_sha256"],
            "snapshot_id": canonical["canonical_snapshot_id"],
            "template_id": canonical["canonical_template_id"],
        },
        "claim": (
            "Across the six frozen final case/schedule positions, zero oracle-invalid "
            "candidate snapshots are selected; clean and explicitly idempotent positions "
            "meet their precommitted liveness outcomes."
        ),
        "code_hashes": code_hashes,
        "evidence_boundary": {
            "excluded": [
                "external bank transfers",
                "email delivery",
                "third-party SaaS side effects",
                "facts absent from oracle v1",
            ],
            "included": [
                "Odoo/PostgreSQL root filesystem snapshot",
                "visible browser worker and milestone log",
                "case and fault digests",
                "fresh restored read-only oracle verdict",
                "snapshot lineage and receipt bindings",
            ],
        },
        "hard_gates": {
            "all_six_positions_complete": True,
            "any_missing_oracle_is_failure": True,
            "false_acceptances": 0,
            "post_mutation_retry_allowed": False,
        },
        "manifest_digest": manifest["manifest_digest"],
        "manifest_sha256": sha256(CASE_DIR / "manifest.json"),
        "oracle_version": "forklift-oracle-v1",
        "promotion_closure_sha256": sha256(PROMOTION_CLOSURE),
        "protocol_version": "forklift-sealed-final-v2",
        "resource_cap": {
            "additional_dollars": 0,
            "max_attempts_per_position": 3,
            "max_total_attempts": 18,
            "no_plan_change_or_top_up": True,
            "peak_desktops": 1,
            "peak_sandboxes": 2,
            "starter_subscription_only": True,
        },
        "retry_policy": {
            "fresh_canonical_branch": True,
            "only_before_business_mutation": True,
            "retain_every_attempt": True,
        },
        "runtime": {
            "distributions": {
                name: importlib.metadata.version(name)
                for name in FROZEN_DISTRIBUTIONS
            },
            "managed_boundary": (
                "Solari's stock visible-desktop base image and control plane are "
                "provider-managed; the exact Chrome version is captured per attempt."
            ),
            "python_version": sys.version.split()[0],
            "remote_browser_distributions": REMOTE_BROWSER_DISTRIBUTIONS,
        },
        "seed_sha256": manifest["seed_sha256"],
        "trials": trials,
    }
    protocol = {**body, "protocol_digest": canonical_digest(body)}
    SEALED_ROOT.mkdir(parents=True, exist_ok=True)
    PROTOCOL_PATH.write_bytes(
        (json.dumps(protocol, indent=2, sort_keys=True) + "\n").encode("utf-8")
    )
    print(
        json.dumps(
            {
                "frozen": True,
                "max_total_attempts": 18,
                "protocol_digest": protocol["protocol_digest"],
                "seed_sha256": protocol["seed_sha256"],
                "trial_count": 6,
                "zero_additional_spend": True,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
