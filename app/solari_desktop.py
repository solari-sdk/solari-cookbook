from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from hashlib import sha256
from urllib.parse import urlparse

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, stable_id, utc_now

BASE_URL = "https://api.getsolari.com"


@dataclass(slots=True)
class DesktopCapture:
    acquisition: AcquisitionEnvelope
    screenshot: bytes
    session_id: str
    ready: bool


async def capture_public_url(
    url: str,
    *,
    timeout_ms: int = 10 * 60_000,
    readiness_attempts: int = 30,
    settle_seconds: float = 3.0,
) -> DesktopCapture:
    """Exercise a screen-driven public-source workflow and retain screenshot evidence.

    The workflow deliberately performs explicit mouse/keyboard interaction in a local
    editor, then opens the caller-supplied HTTPS public URL in Chrome and captures the
    resulting desktop. No screenshot content is automatically interpreted as fact.
    """
    api_key = os.getenv("SOLARI_API_KEY")
    if not api_key:
        raise RuntimeError("SOLARI_API_KEY is required for live Solari Desktop execution")
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("desktop capture requires an HTTPS URL with a hostname")
    if not 30_000 <= timeout_ms <= 30 * 60_000:
        raise ValueError("timeout_ms must be between 30000 and 1800000")
    if not 1 <= readiness_attempts <= 60:
        raise ValueError("readiness_attempts must be between 1 and 60")
    if not 0 <= settle_seconds <= 15:
        raise ValueError("settle_seconds must be between 0 and 15")

    from solari_desktop import DesktopClient

    started = utc_now()
    acquisition_id = stable_id("solari-desktop-public", url, started.isoformat())
    session_id = ""
    desktop = None
    ready = False
    screenshot = b""
    async with DesktopClient(api_key=api_key, base_url=BASE_URL) as client:
        desktop = await client.create(template="default", resolution="1280x720", timeout_ms=timeout_ms)
        session_id = desktop.sessionId
        try:
            await desktop.connect()
            for _ in range(readiness_attempts):
                health = await desktop.health()
                if getattr(health, "ready", False):
                    ready = True
                    break
                await asyncio.sleep(1)
            if not ready:
                raise TimeoutError("Solari Desktop did not become ready within the bounded readiness window")

            # Exercise explicit computer-use mechanics against a local editor first.
            # The typed text contains only the public hostname and no credential/session data.
            await desktop.open("mousepad")
            if settle_seconds:
                await asyncio.sleep(min(settle_seconds, 2.0))
            await desktop.mouse.click(320, 300, humanize=True)
            await desktop.keyboard.type(f"Public-source visual capture: {parsed.hostname}")

            # The upstream desktop example documents exec(command, args=[...]) and the
            # default image includes Chrome. Launch the public target without shell expansion.
            await desktop.exec("google-chrome", args=["--new-window", url])
            if settle_seconds:
                await asyncio.sleep(settle_seconds)
            screenshot = await desktop.screenshot(format="png")
        finally:
            if desktop is not None:
                try:
                    await desktop.close()
                finally:
                    await client.destroy(session_id)

    completed = utc_now()
    acquisition = AcquisitionEnvelope(
        id=acquisition_id,
        source_id="solari-desktop-public",
        method=AcquisitionMethod.DESKTOP,
        requested_url=url,
        final_url=url,
        started_at=started,
        completed_at=completed,
        status="success",
        content_type="image/png",
        content_sha256=sha256(screenshot).hexdigest(),
        metadata={
            "session_id": session_id,
            "resolution": "1280x720",
            "screenshot_bytes": len(screenshot),
            "ready": ready,
            "workflow": "public-url-visual-capture",
            "interpretation_boundary": "screenshot retained as observed visual evidence; no screenshot content is automatically asserted as fact",
        },
    )
    return DesktopCapture(acquisition=acquisition, screenshot=screenshot, session_id=session_id, ready=ready)
