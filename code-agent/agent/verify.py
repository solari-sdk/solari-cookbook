"""Independent post-run check on the model's `finish` claim.

Mirrors qa-agent's is_solved(): re-checks the outcome from OUTSIDE the
sandbox, using our own code, not the model's self-report. If the model
says a service is live at some URL, we fetch that URL ourselves - same
principle as the cookbook's own port-preview example fetching its server
"from here, outside the VM" to prove it's really public.
"""

from __future__ import annotations

import time
import urllib.error
import urllib.request


def verify_service(url: str, expected_contains: str, attempts: int = 10, delay: float = 1.5) -> dict:
    if not url:
        return {"checked": False}

    last_error = None
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                body = resp.read().decode("utf-8", "replace")
                contains_expected = (expected_contains in body) if expected_contains else None
                return {
                    "checked": True,
                    "reachable": True,
                    "status": resp.status,
                    "contains_expected": contains_expected,
                    "body_snippet": body[:300],
                }
        except urllib.error.HTTPError as e:
            # A real HTTP error response still proves the service is up and
            # answering - just not with 2xx. Record it, don't retry forever.
            last_error = f"HTTP {e.code}"
            body = e.read().decode("utf-8", "replace") if e.fp else ""
            contains_expected = (expected_contains in body) if expected_contains else None
            return {
                "checked": True,
                "reachable": True,
                "status": e.code,
                "contains_expected": contains_expected,
                "body_snippet": body[:300],
            }
        except Exception as e:
            last_error = str(e)
            time.sleep(delay)

    return {"checked": True, "reachable": False, "error": last_error}
