from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.artifact_catalog import list_artifacts
from app.contracts import AcquisitionEnvelope, AcquisitionMethod
from app.main import app
from app.solari.sandbox import SandboxExecution
from app.solari_api import (
    BrowserCaptureInput,
    DesktopCaptureInput,
    SandboxGeospatialInput,
    browser_capture,
    desktop_capture,
    sandbox_geospatial,
)
from app.solari_browser import BrowserCapture
from app.solari_desktop import DesktopCapture
from app.solari_execution_store import list_solari_executions
from app.storage import list_acquisitions, list_events


def _acquisition(source_id: str, method: AcquisitionMethod, url: str) -> AcquisitionEnvelope:
    now = datetime.now(timezone.utc)
    return AcquisitionEnvelope(
        id=f"{source_id}-acq",
        source_id=source_id,
        method=method,
        requested_url=url,
        final_url=url,
        started_at=now,
        completed_at=now,
        status="success",
        content_type="text/html" if method == AcquisitionMethod.BROWSER else "image/png",
        content_sha256="a" * 64,
    )


def test_solari_live_routes_are_present_and_disabled_by_default(monkeypatch):
    monkeypatch.delenv("SOLARI_LIVE_API_ENABLED", raising=False)
    monkeypatch.delenv("SOLARI_API_KEY", raising=False)
    client = TestClient(app)
    response = client.post("/api/v1/solari/browser/capture", json={"url": "https://example.org/"})
    assert response.status_code == 503
    spec = client.get("/openapi.json").json()
    assert "/api/v1/solari/executions" in spec["paths"]
    assert "/api/v1/solari/sandbox/geospatial" in spec["paths"]
    assert "/api/v1/solari/desktop/capture" in spec["paths"]


@pytest.mark.asyncio
async def test_browser_capture_catalogs_html_screenshot_and_replay(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SOLARI_LIVE_API_ENABLED", "true")
    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    acquisition = _acquisition("solari-browser", AcquisitionMethod.BROWSER, "https://example.org/")

    async def fake_capture(*args, **kwargs):
        return BrowserCapture(acquisition=acquisition, title="Example", html="<html>public</html>", screenshot=b"png", session_id="browser-1", replay=b'{"rrweb":1}\n')

    monkeypatch.setattr("app.solari_api.capture_url", fake_capture)
    row = await browser_capture(BrowserCaptureInput(url="https://example.org/", recording=True))
    assert row["kind"] == "browser"
    assert len(row["artifact_sha256s"]) == 3
    assert len(list_artifacts()) == 3
    saved = list_acquisitions(10, "solari-browser")[0]
    assert "replay" in saved["metadata_json"]


@pytest.mark.asyncio
async def test_sandbox_output_is_cataloged_as_execution_artifact(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SOLARI_LIVE_API_ENABLED", "true")
    monkeypatch.setenv("SOLARI_API_KEY", "test-key")

    async def fake_run(code, timeout_ms=120000):
        assert "distance_km" in code
        return SandboxExecution(sandbox_id="sandbox-1", duration_ms=12.5, stdout=['{"total_distance_km":1.0}'], stderr=[], results=[], error=None)

    monkeypatch.setattr("app.solari_api.run_python", fake_run)
    row = await sandbox_geospatial(SandboxGeospatialInput(points=[{"latitude": 0, "longitude": 0}, {"latitude": 0, "longitude": 1}]))
    assert row["kind"] == "sandbox"
    assert len(row["artifact_sha256s"]) == 1
    assert list_artifacts()[0]["mime_type"] == "application/json"


@pytest.mark.asyncio
async def test_desktop_capture_catalogs_screenshot_and_normalizes_review_event(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SOLARI_LIVE_API_ENABLED", "true")
    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    acquisition = _acquisition("solari-desktop-public", AcquisitionMethod.DESKTOP, "https://example.org/")

    async def fake_capture(*args, **kwargs):
        return DesktopCapture(acquisition=acquisition, screenshot=b"desktop-png", session_id="desktop-1", ready=True)

    monkeypatch.setattr("app.solari_api.capture_public_url", fake_capture)
    row = await desktop_capture(DesktopCaptureInput(url="https://example.org/"))
    assert row["kind"] == "desktop"
    assert len(row["artifact_sha256s"]) == 1
    events = list_events(10, source_id="solari-desktop-public")
    assert len(events) == 1
    assert events[0]["category"] == "desktop_capture"
    assert "not automatically interpreted" in events[0]["summary"]
    assert len(list_solari_executions(kind="desktop")) == 1


@pytest.mark.asyncio
async def test_live_target_validation_rejects_local_addresses(monkeypatch):
    monkeypatch.setenv("SOLARI_LIVE_API_ENABLED", "true")
    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    with pytest.raises(HTTPException) as raised:
        await browser_capture(BrowserCaptureInput(url="https://127.0.0.1/private"))
    assert raised.value.status_code == 400
