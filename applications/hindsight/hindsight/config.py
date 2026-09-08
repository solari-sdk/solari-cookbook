"""Credential loading and identifier redaction.

Keys are read in exactly one place and passed down explicitly. Nothing in the
package reads them from the environment at the point of use, so there is one
line to audit rather than many.
"""

from __future__ import annotations

import os
from pathlib import Path

BASE_URL = "https://api.getsolari.com"


def load_key(
    name: str,
    env_file: Path,
    *,
    environ: dict[str, str] | None = None,
) -> str:
    """Return the named key from the environment, else from `env_file`."""
    environ = os.environ if environ is None else environ
    value = environ.get(name)
    if value:
        return value

    if env_file.is_file():
        # utf-8-sig: a BOM from a Windows editor otherwise sticks to the first
        # key name and the lookup misses for no visible reason.
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, raw = line.partition("=")
            if key.strip() == name:
                candidate = raw.strip().strip("'\"")
                if candidate:
                    return candidate

    raise SystemExit(
        f"{name} is not set and was not found in {env_file}. "
        "Do not pass it on the command line."
    )


def redact(identifier: str, *, head: int = 8, tail: int = 4) -> str:
    """Shorten an id so evidence can be correlated but not replayed."""
    if len(identifier) <= head + tail + 1:
        return identifier
    return f"{identifier[:head]}…{identifier[-tail:]}"
