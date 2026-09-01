from __future__ import annotations

import os
from dataclasses import dataclass
from hashlib import sha256

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, stable_id, utc_now


@dataclass
class BrowserCapture:
    acquisition: AcquisitionEnvelope
    title: str
    html: str
    screenshot: bytes
    session_id: str


async def capture_url(url: str) -> BrowserCapture:
    api_key = os.getenv("SOLARI_API_KEY")
    if not api_key:
        raise RuntimeError("SOLARI_API_KEY is required for live browser capture")

    from solari_browser import Solari

    started = utc_now()
    acquisition_id = stable_id("solari-browser", url, started.isoformat())
    solari = Solari(api_key=api_key)
    browser = await solari.launch()
    try:
        page = await browser.new_page()
        response = await page.goto(url, wait_until="networkidle")
        html = await page.content()
        screenshot = await page.screenshot(full_page=True)
        title = await page.title()
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
            },
        )
        return BrowserCapture(
            acquisition=acquisition,
            title=title,
            html=html,
            screenshot=screenshot,
            session_id=browser.id,
        )
    finally:
        await browser.close()
