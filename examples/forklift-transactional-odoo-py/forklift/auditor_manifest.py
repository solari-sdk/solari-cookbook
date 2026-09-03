"""Deterministic fingerprints for the host-supplied auditor bundle and runtime."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
from pathlib import Path


AUDITOR_FILES = (
    "__init__.py",
    "auditor_manifest.py",
    "domain.py",
    "oracle.py",
    "odoo_sql.py",
    "remote_runner.py",
)


def canonical_digest(payload: object) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def auditor_bundle_digest(source_dir: Path) -> str:
    return canonical_digest(
        {
            name: hashlib.sha256((source_dir / name).read_bytes()).hexdigest()
            for name in AUDITOR_FILES
        }
    )


def auditor_runtime_digest(postgres_server_version: str) -> str:
    return canonical_digest(
        {
            "postgres_server_version": postgres_server_version,
            "psycopg": importlib.metadata.version("psycopg"),
            "python_implementation": platform.python_implementation(),
            "python_version": platform.python_version(),
        }
    )
