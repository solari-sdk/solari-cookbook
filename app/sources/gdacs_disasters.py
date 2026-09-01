from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from urllib.request import Request, urlopen

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, SourceDescriptor, stable_id, utc_now

SOURCE = SourceDescriptor(
    id="gdacs-disasters",
    name="Global Disaster Alert and Coordination System",
    category="disaster-alert",
    authoritative_url="https://www.gdacs.org/gdacsapi/swagger/index.html",
    method=AcquisitionMethod.API,
    poll_interval_seconds=360,
    license_note="Public GDACS API. Attribute data to Global Disaster Alert and Coordination System, GDACS, and follow the current GDACS terms/disclaimer.",
    capabilities=["events", "public-api", "geojson", "multi-hazard", "deterministic-normalization"],
    depends_on=[],
)
DEFAULT_URL = "https://www.gdacs.org/gdacsapi/api/Events/geteventlist/EVENTS4APP"
MAX_RESPONSE_BYTES = 5 * 1024 * 1024

_HAZARDS = {
    "EQ": "earthquake",
    "TC": "tropical-cyclone",
    "FL": "flood",
    "VO": "volcano",
    "DR": "drought",
    "WF": "wildfire",
    "TS": "tsunami",
}
_ALERT_SEVERITY = {"green": "low", "orange": "high", "red": "extreme"}


def _datetime(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("GDACS event is missing a timestamp")
    clean = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(clean)
    except ValueError:
        # Some historical GDACS responses use a space separator with no timezone.
        parsed = datetime.strptime(value.strip(), "%Y-%m-%d %H:%M:%S")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _point(feature: dict[str, Any]) -> tuple[float | None, float | None]:
    geometry = feature.get("geometry")
    if not isinstance(geometry, dict) or geometry.get("type") != "Point":
        return None, None
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        return None, None
    try:
        longitude, latitude = float(coordinates[0]), float(coordinates[1])
    except (TypeError, ValueError):
        return None, None
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        return None, None
    return latitude, longitude


def normalize(payload: dict[str, Any], acquisition_id: str) -> list[EventRecord]:
    if payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
        raise ValueError("GDACS response must be a GeoJSON FeatureCollection")
    events: list[EventRecord] = []
    for index, feature in enumerate(payload["features"]):
        if not isinstance(feature, dict):
            continue
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            continue
        event_id = properties.get("eventid")
        event_type = str(properties.get("eventtype") or "").upper()
        observed_raw = properties.get("fromdate") or properties.get("datetime")
        if event_id is None or not event_type or not observed_raw:
            continue
        episode_id = properties.get("episodeid")
        record_id = f"{event_type}:{event_id}:{episode_id if episode_id is not None else 'event'}"
        observed_at = _datetime(observed_raw)
        updated_raw = properties.get("todate") or properties.get("datetime")
        updated_at = _datetime(updated_raw) if updated_raw else None
        latitude, longitude = _point(feature)
        alert_level = str(properties.get("alertlevel") or "").strip()
        severity_data = properties.get("severitydata") if isinstance(properties.get("severitydata"), dict) else {}
        title = str(properties.get("name") or properties.get("eventname") or f"GDACS {event_type} event {event_id}").strip()
        country = properties.get("country")
        report_url = None
        url_data = properties.get("url")
        if isinstance(url_data, dict):
            report_url = url_data.get("report") or url_data.get("details")
        events.append(EventRecord(
            id=stable_id(SOURCE.id, record_id),
            source_id=SOURCE.id,
            source_record_id=record_id,
            category=_HAZARDS.get(event_type, "disaster-alert"),
            title=title[:500],
            summary=str(severity_data.get("severitytext") or alert_level or "GDACS disaster event"),
            observed_at=observed_at,
            updated_at=updated_at,
            latitude=latitude,
            longitude=longitude,
            severity=_ALERT_SEVERITY.get(alert_level.lower()),
            quality_score=1.0,
            properties={
                "event_id": event_id,
                "episode_id": episode_id,
                "event_type": event_type,
                "alert_level": alert_level or None,
                "alert_score": properties.get("alertscore"),
                "country": country,
                "iso3": properties.get("iso3"),
                "affected_countries": properties.get("affectedcountries") if isinstance(properties.get("affectedcountries"), list) else [],
                "is_current": properties.get("iscurrent"),
                "severity_value": severity_data.get("severity"),
                "severity_text": severity_data.get("severitytext"),
                "report_url": report_url,
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"features[{index}]",
                note="Observed in the public GDACS GeoJSON event API.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"Accept": "application/geo+json, application/json", "User-Agent": "solari-osint-operations-center/0.12"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed GDACS HTTPS public API
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("GDACS response exceeds 5 MiB safety limit")
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=DEFAULT_URL,
            final_url=response.geturl(),
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw)},
        )
    parser_started = time.perf_counter()
    payload = json.loads(raw)
    events = normalize(payload, acquisition_id)
    received = len(payload.get("features", [])) if isinstance(payload, dict) and isinstance(payload.get("features"), list) else 0
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": received,
        "records_accepted": len(events),
        "records_rejected": max(0, received - len(events)),
    })
    return acquisition, events
