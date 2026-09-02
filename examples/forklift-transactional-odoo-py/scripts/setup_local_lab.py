"""Idempotently prepare the complete local Forklift crash challenge."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CANONICAL_DB = "forklift_clean"
VALID_DB = "forklift_oracle_fixture"
INTERRUPTED_DB = "forklift_interrupted_fixture"


def run(*args: str, input_text: str | None = None, capture: bool = False) -> str:
    result = subprocess.run(
        args,
        cwd=ROOT,
        input=input_text,
        text=True,
        check=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture and result.stdout else ""


def sql(database: str, statement: str) -> str:
    return run(
        "docker",
        "compose",
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "odoo",
        "-d",
        database,
        "-tAc",
        statement,
        capture=True,
    )


def database_exists(name: str) -> bool:
    return sql("postgres", f"SELECT 1 FROM pg_database WHERE datname='{name}'") == "1"


def odoo_shell(database: str, script_name: str) -> None:
    source = (ROOT / "lab" / script_name).read_text(encoding="utf-8")
    run(
        "docker",
        "compose",
        "run",
        "--rm",
        "-T",
        "web",
        "odoo",
        "shell",
        "-d",
        database,
        "--no-http",
        input_text=source,
    )


def initialize_canonical() -> None:
    if not database_exists(CANONICAL_DB):
        print("      Initializing Odoo 19 (first run is slow)...", flush=True)
        run(
            "docker",
            "compose",
            "run",
            "--rm",
            "web",
            "odoo",
            "-d",
            CANONICAL_DB,
            "-i",
            "purchase,stock,account,l10n_us",
            "--without-demo",
            "--stop-after-init",
        )
    installed = sql(
        CANONICAL_DB,
        "SELECT count(*) FROM ir_module_module "
        "WHERE name IN ('purchase','stock','account','l10n_us') AND state='installed'",
    )
    if installed != "4":
        raise RuntimeError("canonical database exists but required modules are not fully installed")

    master_count = sql(
        CANONICAL_DB,
        "SELECT (SELECT count(*) FROM res_partner WHERE ref='SUP-ACME-04') + "
        "(SELECT count(*) FROM account_tax WHERE name->>'en_US' LIKE 'Forklift Purchase Tax %')",
    )
    if master_count != "5":
        print("      Seeding synthetic master data...", flush=True)
        odoo_shell(CANONICAL_DB, "seed_master_data.py")
        master_count = sql(
            CANONICAL_DB,
            "SELECT (SELECT count(*) FROM res_partner WHERE ref='SUP-ACME-04') + "
            "(SELECT count(*) FROM account_tax WHERE name->>'en_US' LIKE 'Forklift Purchase Tax %')",
        )
    if master_count != "5":
        raise RuntimeError("canonical database has incomplete or ambiguous Forklift master data")

    business_count = sql(
        CANONICAL_DB,
        "SELECT (SELECT count(*) FROM purchase_order) + "
        "(SELECT count(*) FROM stock_picking) + "
        "(SELECT count(*) FROM account_move WHERE move_type='in_invoice') + "
        "(SELECT count(*) FROM account_payment)",
    )
    if business_count != "0":
        raise RuntimeError("canonical database is not clean; refusing to accept or overwrite it")


def clone_and_seed(database: str, case_id: str, script_name: str, label: str) -> None:
    if not database_exists(database):
        print(f"      Cloning clean database for {label}...", flush=True)
        run(
            "docker",
            "compose",
            "exec",
            "-T",
            "db",
            "createdb",
            "-U",
            "odoo",
            "-T",
            CANONICAL_DB,
            database,
        )
    case_count = sql(
        database,
        f"SELECT count(*) FROM purchase_order WHERE partner_ref='{case_id}'",
    )
    if case_count == "0":
        odoo_shell(database, script_name)
    elif case_count != "1":
        raise RuntimeError(f"{label} database has ambiguous case rows")


def main() -> None:
    print("Forklift local lab setup", flush=True)
    print("[1/5] Ensuring PostgreSQL is healthy...", flush=True)
    run("docker", "compose", "up", "-d", "db")
    print("[2/5] Ensuring the canonical Odoo database is clean...", flush=True)
    initialize_canonical()
    print("[3/5] Ensuring the positive control exists...", flush=True)
    clone_and_seed(
        VALID_DB,
        "FORKLIFT-FIXTURE-VALID-001",
        "seed_valid_fixture.py",
        "the positive control",
    )
    print("[4/5] Ensuring the interrupted control exists...", flush=True)
    clone_and_seed(
        INTERRUPTED_DB,
        "FORKLIFT-INTERRUPTED-001",
        "seed_interrupted_fixture.py",
        "the interrupted control",
    )
    print("[5/5] Running the live discriminator...", flush=True)
    run("docker", "compose", "up", "-d", "web")
    run(sys.executable, "-m", "scripts.compare_live_states")


if __name__ == "__main__":
    main()
