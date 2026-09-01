from __future__ import annotations

import ipaddress
import json
import os
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.artifact_catalog import catalog_bytes, link_artifact
from app.contracts import EvidenceKind, EvidenceReference, EventRecord, stable_id, utc_now
from app.solari.sandbox import build_geospatial_enrichment_program, run_python
from app.solari_browser import BrowserCaptureError, capture_url
from app.solari_desktop import capture_public_url
from app.solari_execution_store import get_solari_execution, list_solari_executions, record_solari_execution
from app.storage import save_acquisition, save_events

router = APIRouter(prefix="/api/v1/solari", tags=["solari"])


class BrowserCaptureInput(BaseModel):
    url: str = Field(min_length=10, max_length=2048)
    recording: bool = False
    timeout_seconds: float = Field(default=60.0, ge=1.0, le=300.0)


class SandboxPoint(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class SandboxGeospatialInput(BaseModel):
    points: list[SandboxPoint] = Field(min_length=2, max_length=1000)
    timeout_ms: int = Field(default=120_000, ge=30_000, le=300_000)


class DesktopCaptureInput(BaseModel):
    url: str = Field(min_length=10, max_length=2048)
    timeout_ms: int = Field(default=10 * 60_000, ge=30_000, le=30 * 60_000)


def _live_gate() -> None:
    if os.getenv("SOLARI_LIVE_API_ENABLED", "").strip().lower() not in {"1", "true", "yes", "on"}:
        raise HTTPException(503, "live Solari execution endpoints are disabled; set SOLARI_LIVE_API_ENABLED=true explicitly")
    if not os.getenv("SOLARI_API_KEY"):
        raise HTTPException(503, "SOLARI_API_KEY is not configured")


def _public_https_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(400, "target must be a credential-free HTTPS URL")
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname == "localhost" or hostname.endswith(".localhost") or hostname.endswith(".local"):
        raise HTTPException(400, "local targets are not allowed")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast or address.is_unspecified):
        raise HTTPException(400, "private or non-routable address targets are not allowed")
    return value


def _artifact(data: bytes, *, name: str, mime_type: str, source: str) -> str:
    item = catalog_bytes(data, original_name=name, mime_type=mime_type, source=source)
    return str(item["sha256"])


def _link_all(digests: list[str], object_type: str, object_id: str, relation: str) -> None:
    for digest in digests:
        link_artifact(digest, object_type, object_id, relation=relation)


@router.get("/executions")
def executions(kind: str | None = None, limit: int = Query(100, ge=1, le=1000)) -> list[dict[str, object]]:
    if kind not in {None, "browser", "sandbox", "desktop"}:
        raise HTTPException(400, "kind must be browser, sandbox, or desktop")
    return list_solari_executions(kind=kind, limit=limit)  # type: ignore[arg-type]


@router.get("/executions/{execution_id}")
def execution(execution_id: str) -> dict[str, object]:
    try:
        return get_solari_execution(execution_id)
    except KeyError as exc:
        raise HTTPException(404, "Solari execution not found") from exc


@router.post("/browser/capture")
async def browser_capture(body: BrowserCaptureInput) -> dict[str, object]:
    _live_gate()
    url = _public_https_url(body.url)
    outer_started = utc_now()
    try:
        capture = await capture_url(url, timeout_seconds=body.timeout_seconds, recording=body.recording)
        acquisition = capture.acquisition
        artifacts = [
            _artifact(capture.html.encode("utf-8"), name=f"{acquisition.id}.html", mime_type="text/html", source="solari-browser"),
            _artifact(capture.screenshot, name=f"{acquisition.id}.png", mime_type="image/png", source="solari-browser"),
        ]
        artifact_roles = {"html": artifacts[0], "screenshot": artifacts[1]}
        if capture.replay is not None:
            replay_digest = _artifact(capture.replay, name=f"{acquisition.id}.rrweb.ndjson", mime_type="application/x-ndjson", source="solari-browser")
            artifacts.append(replay_digest)
            artifact_roles["replay"] = replay_digest
        acquisition.metadata["artifact_sha256s"] = artifact_roles
        save_acquisition(acquisition)
        _link_all(artifacts, "acquisition", acquisition.id, "capture")
        execution_id = stable_id("solari-execution", "browser", acquisition.id)
        row = record_solari_execution(
            "browser",
            "success",
            started_at=acquisition.started_at,
            completed_at=acquisition.completed_at,
            target=url,
            session_id=capture.session_id,
            summary={"title": capture.title, "recording_requested": body.recording, "replay_available": capture.replay is not None, "acquisition_id": acquisition.id},
            artifact_sha256s=artifacts,
            execution_id=execution_id,
        )
        _link_all(artifacts, "execution", execution_id, "output")
        return row
    except (BrowserCaptureError, ValueError) as exc:
        completed = utc_now()
        execution_id = stable_id("solari-execution", "browser", outer_started.isoformat(), url)
        record_solari_execution(
            "browser",
            "failure",
            started_at=outer_started,
            completed_at=completed,
            target=url,
            error_type=type(exc).__name__,
            error_message=str(exc),
            execution_id=execution_id,
        )
        raise HTTPException(502, {"message": "Solari Browser capture failed", "execution_id": execution_id, "error_type": type(exc).__name__}) from exc


@router.post("/sandbox/geospatial")
async def sandbox_geospatial(body: SandboxGeospatialInput) -> dict[str, object]:
    _live_gate()
    started = utc_now()
    execution_id = stable_id("solari-execution", "sandbox", started.isoformat())
    try:
        program = build_geospatial_enrichment_program([point.model_dump() for point in body.points])
        result = await run_python(program, timeout_ms=body.timeout_ms)
        completed = utc_now()
        transcript = {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "results": result.results,
            "error": result.error,
            "duration_ms": result.duration_ms,
            "operation": "bounded-geospatial-enrichment",
        }
        digest = _artifact(json.dumps(transcript, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8"), name=f"{execution_id}.json", mime_type="application/json", source="solari-sandbox")
        status = "failure" if result.error else "success"
        row = record_solari_execution(
            "sandbox",
            status,
            started_at=started,
            completed_at=completed,
            session_id=result.sandbox_id,
            summary={"operation": "bounded-geospatial-enrichment", "point_count": len(body.points), "duration_ms": result.duration_ms},
            artifact_sha256s=[digest],
            error_type="SandboxExecutionError" if result.error else None,
            error_message=result.error,
            execution_id=execution_id,
        )
        link_artifact(digest, "execution", execution_id, relation="transcript")
        return row
    except Exception as exc:
        completed = utc_now()
        record_solari_execution("sandbox", "failure", started_at=started, completed_at=completed, error_type=type(exc).__name__, error_message=str(exc), execution_id=execution_id)
        raise HTTPException(502, {"message": "Solari Sandbox execution failed", "execution_id": execution_id, "error_type": type(exc).__name__}) from exc


@router.post("/desktop/capture")
async def desktop_capture(body: DesktopCaptureInput) -> dict[str, object]:
    _live_gate()
    url = _public_https_url(body.url)
    started = utc_now()
    execution_id = stable_id("solari-execution", "desktop", started.isoformat(), url)
    try:
        capture = await capture_public_url(url, timeout_ms=body.timeout_ms)
        acquisition = capture.acquisition
        screenshot_digest = _artifact(capture.screenshot, name=f"{acquisition.id}.png", mime_type="image/png", source="solari-desktop")
        acquisition.metadata["artifact_sha256s"] = {"screenshot": screenshot_digest}
        save_acquisition(acquisition)
        link_artifact(screenshot_digest, "acquisition", acquisition.id, relation="screenshot")
        hostname = urlparse(url).hostname or "public target"
        event = EventRecord(
            id=stable_id("solari-desktop-capture", acquisition.id),
            source_id=acquisition.source_id,
            source_record_id=acquisition.id,
            category="desktop_capture",
            title=f"Desktop visual capture — {hostname}",
            summary="Screen-driven capture retained for analyst review; visual content is not automatically interpreted as fact.",
            observed_at=acquisition.completed_at,
            quality_score=1.0,
            properties={"target_url": url, "screenshot_sha256": screenshot_digest, "session_id": capture.session_id},
            evidence=[EvidenceReference(acquisition_id=acquisition.id, field="*", kind=EvidenceKind.OBSERVED, note="Observed screenshot artifact from a bounded Solari Desktop public-URL workflow; analyst review required for visual interpretation.")],
        )
        save_events([event])
        link_artifact(screenshot_digest, "event", event.id, relation="visual-evidence")
        row = record_solari_execution(
            "desktop",
            "success",
            started_at=acquisition.started_at,
            completed_at=acquisition.completed_at,
            target=url,
            session_id=capture.session_id,
            summary={"workflow": "public-url-visual-capture", "acquisition_id": acquisition.id, "event_id": event.id, "ready": capture.ready},
            artifact_sha256s=[screenshot_digest],
            execution_id=execution_id,
        )
        link_artifact(screenshot_digest, "execution", execution_id, relation="screenshot")
        return row
    except Exception as exc:
        completed = utc_now()
        record_solari_execution("desktop", "failure", started_at=started, completed_at=completed, target=url, error_type=type(exc).__name__, error_message=str(exc), execution_id=execution_id)
        raise HTTPException(502, {"message": "Solari Desktop capture failed", "execution_id": execution_id, "error_type": type(exc).__name__}) from exc
