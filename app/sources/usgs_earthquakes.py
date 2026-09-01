from __future__ import annotations

import json
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from urllib.request import Request, urlopen

from app.contracts import (
    AcquisitionEnvelope,
    AcquisitionMethod,
    EventRecord,
    EvidenceKind,
    EvidenceReference,
    GeoPoint,
    SourceDescriptor,
    stable_id,
    utc_now,
)

SOURCE = SourceDescriptor(
    id="usgs-earthquakes",
    name="USGS Earthquake Hazards Program",
    category="earthquake",
    authoritative_url="https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php",
    method=AcquisitionMethod.FEED,
    poll_interval_seconds=300,
    license_note="Public U.S. government earthquake feed; see USGS terms and attribution guidance.",
)

DEFAULT_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"


def fetch(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, dict[str, Any]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_FEED, headers={"User-Agent": "solari-osint-operations-center/0.1"})

    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed HTTPS public source
            payload = response.read()
            final_url = response.geturl()
            status = getattr(response, "status", 200)
            content_type = response.headers.get("Content-Type")
        completed = utc_now()
        envelope = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=DEFAULT_FEED,
            final_url=final_url,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=status,
            content_type=content_type,
            content_sha256=sha256(payload).hexdigest(),
        )
        return envelope, json.loads(payload)
    except Exception as exc:
        completed = utc_now()
        envelope = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=DEFAULT_FEED,
            started_at=started,
            completed_at=completed,
            status="failure",
            error_type=_classify_error(exc),
            error_message=str(exc)[:500],
        )
        raise RuntimeError(envelope.model_dump_json()) from exc


def normalize(payload: dict[str, Any], acquisition_id: str) -> list[EventRecord]:
    records: list[EventRecord] = []
    for feature in payload.get("features", []):
        properties = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        source_record_id = str(feature.get("id") or stable_id(properties.get("time"), coordinates))

        observed_at = _millis_to_datetime(properties.get("time"))
        updated_at = _millis_to_datetime(properties.get("updated")) if properties.get("updated") else None
        location = None
        if len(coordinates) >= 2:
            location = GeoPoint(latitude=float(coordinates[1]), longitude=float(coordinates[0]), precision="USGS epicenter")

        magnitude = properties.get("mag")
        place = properties.get("place") or "Earthquake"
        severity = _severity_from_magnitude(magnitude)

        record = EventRecord(
            id=stable_id(SOURCE.id, source_record_id),
            source_id=SOURCE.id,
            source_record_id=source_record_id,
            category="earthquake",
            title=f"M{magnitude} — {place}" if magnitude is not None else place,
            summary=properties.get("type"),
            observed_at=observed_at,
            updated_at=updated_at,
            location=location,
            severity=severity,
            quality_score=1.0,
            properties={
                "magnitude": magnitude,
                "depth_km": coordinates[2] if len(coordinates) >= 3 else None,
                "felt_reports": properties.get("felt"),
                "alert": properties.get("alert"),
                "tsunami": bool(properties.get("tsunami")),
                "detail_url": properties.get("url"),
            },
            evidence=[
                EvidenceReference(
                    acquisition_id=acquisition_id,
                    field="*",
                    kind=EvidenceKind.OBSERVED,
                    source_path=f"features[id={source_record_id}]",
                    note="Normalized deterministically from the USGS GeoJSON feature.",
                )
            ],
        )
        records.append(record)
    return records


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    acquisition, payload = fetch(timeout_seconds=timeout_seconds)
    return acquisition, normalize(payload, acquisition.id)


def _millis_to_datetime(value: Any) -> datetime:
    if value is None:
        return datetime.fromtimestamp(0, tz=timezone.utc)
    return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc)


def _severity_from_magnitude(magnitude: Any) -> str | None:
    if magnitude is None:
        return None
    mag = float(magnitude)
    if mag >= 7.0:
        return "extreme"
    if mag >= 6.0:
        return "severe"
    if mag >= 5.0:
        return "high"
    if mag >= 4.0:
        return "moderate"
    return "low"


def _classify_error(exc: Exception) -> str:
    text = type(exc).__name__.lower()
    if "timeout" in text:
        return "timeout"
    if "http" in text:
        return "http_error"
    if "url" in text or "connection" in text:
        return "network_error"
    return "unknown_error"
