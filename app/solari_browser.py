from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from hashlib import sha256
from typing import Literal

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, stable_id, utc_now

BrowserFailureKind = Literal["configuration", "timeout", "launch", "navigation", "capture", "unknown"]


class BrowserCaptureError(RuntimeError):
    def __init__(self, kind: BrowserFailureKind, message: str, *, attempt: int, cause_type: str | None = None):
        super().__init__(message)
        self.kind = kind
        self.attempt = attempt
        self.cause_type = cause_type

    def public_dict(self) -> dict[str, object]:
        return {"kind": self.kind, "message": str(self), "attempt": self.attempt, "cause_type": self.cause_type}


@dataclass(slots=True)
class BrowserCapture:
    acquisition: AcquisitionEnvelope
    title: str
    html: str
    screenshot: bytes
    session_id: str


def _failure_kind(exc: Exception, stage: str) -> BrowserFailureKind:
    if isinstance(exc, asyncio.TimeoutError):
        return "timeout"
    if stage == "launch":
        return "launch"
    if stage == "navigation":
        return "navigation"
    if stage == "capture":
        return "capture"
    return "unknown"


async def _capture_once(url: str, api_key: str, *, timeout_seconds: float, attempt: int) -> BrowserCapture:
    from solari_browser import Solari

    started = utc_now()
    acquisition_id = stable_id("solari-browser", url, started.isoformat(), attempt)
    browser = None
    stage = "launch"
    try:
        solari = Solari(api_key=api_key)
        browser = await asyncio.wait_for(solari.launch(), timeout=timeout_seconds)
        stage = "navigation"
        page = await asyncio.wait_for(browser.new_page(), timeout=timeout_seconds)
        response = await asyncio.wait_for(page.goto(url, wait_until="networkidle"), timeout=timeout_seconds)
        stage = "capture"
        html, screenshot, title = await asyncio.wait_for(
            asyncio.gather(page.content(), page.screenshot(full_page=True), page.title()),
            timeout=timeout_seconds,
        )
        final_url = page.url
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id="solari-browser",
            method=AcquisitionMethod.BROWSER,
            requested_url=url,
            final_url=final_url,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=response.status if response else None,
            content_type="text/html",
            content_sha256=sha256(html.encode("utf-8")).hexdigest(),
            metadata={
                "session_id": browser.id,
                "title": title,
                "screenshot_bytes": len(screenshot),
                "attempt": attempt,
                "timeout_seconds": timeout_seconds,
            },
        )
        return BrowserCapture(acquisition=acquisition, title=title, html=html, screenshot=screenshot, session_id=browser.id)
    except Exception as exc:
        kind = _failure_kind(exc, stage)
        raise BrowserCaptureError(kind, f"browser {stage} failed", attempt=attempt, cause_type=type(exc).__name__) from exc
    finally:
        if browser is not None:
            try:
                await asyncio.wait_for(browser.close(), timeout=min(timeout_seconds, 15.0))
            except Exception:
                # Cleanup failure must not conceal the acquisition failure/success path.
                # Remote resource-leak checks remain a separate operational concern.
                pass


async def capture_url(
    url: str,
    *,
    timeout_seconds: float = 60.0,
    max_attempts: int = 3,
    base_delay_seconds: float = 0.5,
) -> BrowserCapture:
    """Capture a public URL with bounded retries, stage-aware failures and cleanup."""
    api_key = os.getenv("SOLARI_API_KEY")
    if not api_key:
        raise BrowserCaptureError("configuration", "SOLARI_API_KEY is required for live browser capture", attempt=0)
    if not url.startswith("https://"):
        raise ValueError("browser capture requires an HTTPS URL")
    if not 1 <= max_attempts <= 5:
        raise ValueError("max_attempts must be between 1 and 5")
    if not 1.0 <= timeout_seconds <= 300.0:
        raise ValueError("timeout_seconds must be between 1 and 300")
    if not 0 <= base_delay_seconds <= 10:
        raise ValueError("base_delay_seconds must be between 0 and 10")

    last_error: BrowserCaptureError | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await _capture_once(url, api_key, timeout_seconds=timeout_seconds, attempt=attempt)
        except BrowserCaptureError as exc:
            last_error = exc
            if attempt >= max_attempts:
                break
            await asyncio.sleep(min(base_delay_seconds * (2 ** (attempt - 1)), 10.0))
    assert last_error is not None
    raise last_error
