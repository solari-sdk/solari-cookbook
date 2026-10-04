"""Browser stage for the single CSV-export recipe."""

from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path

from solari_browser import Solari

from .models import (
    ArtifactRecord,
    BrowserResult,
    CleanupRecord,
    RunSpec,
    redact_identifier,
    utc_now,
)


async def run_browser(
    spec: RunSpec,
    *,
    api_key: str,
    bundle_dir: Path,
    cleanup: list[CleanupRecord],
) -> tuple[BrowserResult, ArtifactRecord | None]:
    browser_dir = bundle_dir / "browser"
    artifact_dir = bundle_dir / "artifacts" / "original"
    browser_dir.mkdir(parents=True, exist_ok=True)
    artifact_dir.mkdir(parents=True, exist_ok=True)

    solari = Solari(api_key=api_key)
    browser = None
    cleanup_record: CleanupRecord | None = None
    try:
        browser = await solari.launch(profile_id=spec.profile_id)
        cleanup_record = CleanupRecord(
            resource_type="browser",
            resource_id=redact_identifier(browser.id) or "unavailable",
        )
        cleanup.append(cleanup_record)

        if spec.profile_id and isinstance(browser.session.storage_state, dict):
            context = await browser.new_context(storage_state=browser.session.storage_state)
            page = await context.new_page()
        else:
            page = await browser.new_page()

        response = await page.goto(spec.target_url, wait_until="domcontentloaded")
        title = await page.title()
        body = await page.locator("body").inner_text(timeout=10_000)
        correct_page = (
            title.strip() == spec.page_assertion.title.strip()
            and spec.page_assertion.contains_text in body
        )
        await page.screenshot(path=str(browser_dir / "before-export.png"), full_page=True)
        if not correct_page:
            return (
                BrowserResult(
                    correct_page=False,
                    download_completed=False,
                    http_status=response.status if response else None,
                    title=title,
                    matched_text=spec.page_assertion.contains_text,
                    filename=None,
                    mime_type=None,
                    byte_length=None,
                    sha256=None,
                    timestamp=utc_now(),
                ),
                None,
            )

        async with page.expect_download(timeout=30_000) as download_info:
            await page.locator("#export").click()
        download = await download_info.value
        filename = Path(download.suggested_filename or "export.csv").name
        canonical_path = artifact_dir / "export.csv"
        await download.save_as(canonical_path)
        await page.screenshot(path=str(browser_dir / "after-export.png"), full_page=True)

        content = canonical_path.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        artifact = ArtifactRecord.create(filename, canonical_path, content, digest)
        result = BrowserResult(
            correct_page=True,
            download_completed=True,
            http_status=response.status if response else None,
            title=title,
            matched_text=spec.page_assertion.contains_text,
            filename=filename,
            mime_type=mimetypes.guess_type(filename)[0],
            byte_length=len(content),
            sha256=digest,
            timestamp=utc_now(),
        )
        return result, artifact
    finally:
        if browser is not None and cleanup_record is not None:
            cleanup_record.cleanup_attempted = True
            try:
                await browser.close()
                cleanup_record.cleanup_succeeded = True
            except Exception as exc:  # noqa: BLE001 - cleanup evidence must survive
                cleanup_record.cleanup_error = f"{type(exc).__name__}: {exc}"
        await solari.close()
