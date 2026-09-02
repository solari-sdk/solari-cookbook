"""Verify Solari credentials without printing credential-bearing data.

This is intentionally read-only.  It samples the sandbox and snapshot list
endpoints and reports only whether authentication succeeded and whether each
sample was empty.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from solari_sandbox import SandboxClient


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _load_local_env(path: Path) -> None:
    """Load missing variables from a simple local .env file."""

    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(name, value)


def _safe_status(exc: Exception) -> int | None:
    """Extract an HTTP status without rendering an exception or request."""

    direct = getattr(exc, "status_code", None)
    if isinstance(direct, int):
        return direct
    sdk_status = getattr(exc, "status", None)
    if isinstance(sdk_status, int):
        return sdk_status
    response = getattr(exc, "response", None)
    response_status = getattr(response, "status_code", None)
    return response_status if isinstance(response_status, int) else None


def _safe_code(exc: Exception) -> str | None:
    """Return only the gateway's stable machine code, never its message."""

    code = getattr(exc, "code", None)
    return code if isinstance(code, str) and code else None


async def _check() -> int:
    _load_local_env(PROJECT_ROOT / ".env")
    api_key = os.environ.get("SOLARI_API_KEY", "").strip()
    if not api_key:
        print(json.dumps({"authentication": "not_checked", "reason": "missing_key"}))
        return 2

    client = SandboxClient(
        api_key=api_key,
        base_url=os.environ.get("SOLARI_BASE_URL", "https://api.getsolari.com"),
        call_timeout_ms=30_000,
    )
    try:
        sandboxes = await client.list(limit=1)
        snapshots = await client.list_snapshots(limit=1)
    except Exception as exc:
        # Never print the exception message: an SDK may include request data.
        print(
            json.dumps(
                {
                    "authentication": "failed",
                    "error_type": type(exc).__name__,
                    "status_code": _safe_status(exc),
                },
                sort_keys=True,
            )
        )
        return 1
    finally:
        await client.aclose()

    print(
        json.dumps(
            {
                "authentication": "ok",
                "sandbox_sample_present": bool(sandboxes["sandboxes"]),
                "snapshot_sample_present": bool(snapshots),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_check()))
