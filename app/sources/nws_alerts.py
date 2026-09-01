from __future__ import annotations

import json
from hashlib import sha256
from typing import Any
from urllib.request import Request, urlopen

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, SourceDescriptor, stable_id, utc_now

SOURCE = SourceDescriptor(
    id="nws-alerts",
    name="National Weather Service Alerts",
    category="weather-alert",
    authoritative_url="https://api.weather.gov/alerts",
    method=AcquisitionMethod.API,
    poll_interval_seconds=300,
    license_note="Public U.S. government weather alert API.",
)
DEFAULT_FEED = "https://api.weather.gov/alerts/active"


def fetch(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, dict[str, Any]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_FEED, headers={"User-Agent": "solari-osint-operations-center/0.3 (public engineering demo)", "Accept": "application/geo+json"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed HTTPS public source
        payload = response.read()
        completed = utc_now()
        envelope = AcquisitionEnvelope(
            id=acquisition_id, source_id=SOURCE.id, method=SOURCE.method,
            requested_url=DEFAULT_FEED, final_url=response.geturl(), started_at=started,
            completed_at=completed, status="success", http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"), content_sha256=sha256(payload).hexdigest(),
        )
    return envelope, json.loads(payload)


def normalize(payload: dict[str, Any], acquisition_id: str) -> list[EventRecord]:
    records: list[EventRecord] = []
    for feature in payload.get("features", []):
        p = feature.get("properties") or {}
        record_id = str(p.get("id") or feature.get("id") or stable_id(p.get("event"), p.get("sent"), p.get("areaDesc")))
        sent = p.get("sent") or p.get("effective") or p.get("onset")
        if not sent:
            continue
        records.append(EventRecord(
            id=stable_id(SOURCE.id, record_id), source_id=SOURCE.id, source_record_id=record_id,
            category="weather-alert", title=p.get("headline") or p.get("event") or "Weather alert",
            summary=p.get("description"), observed_at=sent, updated_at=p.get("ends") or p.get("expires"),
            severity=(p.get("severity") or "unknown").lower(), quality_score=1.0,
            properties={"event": p.get("event"), "area": p.get("areaDesc"), "urgency": p.get("urgency"), "certainty": p.get("certainty"), "instruction": p.get("instruction"), "sender": p.get("senderName")},
            evidence=[EvidenceReference(acquisition_id=acquisition_id, field="*", kind=EvidenceKind.OBSERVED, source_path=f"features[id={record_id}]", note="Normalized deterministically from NWS CAP/GeoJSON alert data.")],
        ))
    return records


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    acquisition, payload = fetch(timeout_seconds)
    return acquisition, normalize(payload, acquisition.id)
