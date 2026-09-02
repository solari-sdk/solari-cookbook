"""Freeze the verified local canonical Odoo database as a portable dump."""

from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = PROJECT_ROOT / "artifacts" / "development"
DUMP_PATH = ARTIFACT_DIR / "forklift_clean.dump"
MANIFEST_PATH = ARTIFACT_DIR / "forklift_clean.dump.manifest.json"
CONTAINER = "forklift-db-1"
REMOTE_DUMP = "/tmp/forklift_clean.dump"


def _run(*args: str, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=True,
        text=True,
        capture_output=capture,
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    counts = _run(
        "docker",
        "exec",
        CONTAINER,
        "psql",
        "-U",
        "odoo",
        "-d",
        "forklift_clean",
        "-Atc",
        "SELECT (SELECT count(*) FROM purchase_order),"
        "(SELECT count(*) FROM stock_picking),"
        "(SELECT count(*) FROM account_move WHERE move_type='in_invoice'),"
        "(SELECT count(*) FROM account_payment),"
        "(SELECT count(*) FROM res_partner WHERE ref='SUP-ACME-04'),"
        "(SELECT count(*) FROM product_product WHERE default_code='BEARING-6204')",
        capture=True,
    ).stdout.strip()
    if counts != "0|0|0|0|1|1":
        raise RuntimeError(f"local canonical database failed freeze guard: {counts}")

    version = _run(
        "docker",
        "exec",
        CONTAINER,
        "psql",
        "-U",
        "odoo",
        "-d",
        "forklift_clean",
        "-Atc",
        "SHOW server_version",
        capture=True,
    ).stdout.strip()

    try:
        _run(
            "docker",
            "exec",
            CONTAINER,
            "pg_dump",
            "-U",
            "odoo",
            "--format=custom",
            "--no-owner",
            "--file",
            REMOTE_DUMP,
            "forklift_clean",
        )
        _run("docker", "cp", f"{CONTAINER}:{REMOTE_DUMP}", str(DUMP_PATH))
    finally:
        subprocess.run(
            ["docker", "exec", CONTAINER, "rm", "-f", REMOTE_DUMP],
            check=False,
        )

    manifest = {
        "bytes": DUMP_PATH.stat().st_size,
        "canonical_counts": counts,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "database": "forklift_clean",
        "postgresql_version": version,
        "sha256": _sha256(DUMP_PATH),
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
