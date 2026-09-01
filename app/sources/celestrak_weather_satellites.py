from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from urllib.request import Request, urlopen

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, SourceDescriptor, stable_id, utc_now

SOURCE = SourceDescriptor(
    id="celestrak-weather-satellites",
    name="CelesTrak Weather Satellite GP Data",
    category="satellite-orbit",
    authoritative_url="https://celestrak.org/NORAD/documentation/gp-data-formats.php",
    method=AcquisitionMethod.API,
    poll_interval_seconds=7200,
    license_note="Public CelesTrak GP data. Follow the current CelesTrak usage policy: request only needed groups and no more than once per data update (currently two hours).",
    capabilities=["events", "public-api", "orbital-data", "json", "deterministic-normalization"],
    depends_on=[],
)
DEFAULT_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=WEATHER&FORMAT=JSON"
MAX_RESPONSE_BYTES = 3 * 1024 * 1024
MAX_OBJECTS = 2000


def _epoch(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("CelesTrak object is missing EPOCH")
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def normalize(payload: list[dict[str, Any]], acquisition_id: str) -> list[EventRecord]:
    if len(payload) > MAX_OBJECTS:
        raise ValueError("CelesTrak response exceeds object safety limit")
    events: list[EventRecord] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            continue
        catalog = item.get("NORAD_CAT_ID")
        epoch_raw = item.get("EPOCH")
        name = str(item.get("OBJECT_NAME") or "").strip()
        if catalog is None or not epoch_raw or not name:
            continue
        observed_at = _epoch(epoch_raw)
        record_id = f"{catalog}:{observed_at.isoformat()}"
        events.append(EventRecord(
            id=stable_id(SOURCE.id, record_id),
            source_id=SOURCE.id,
            source_record_id=record_id,
            category="satellite-orbit",
            title=f"{name} orbital elements",
            summary="Public general perturbations orbital element snapshot for a weather-satellite group object.",
            observed_at=observed_at,
            quality_score=1.0,
            properties={
                "object_name": name,
                "object_id": item.get("OBJECT_ID"),
                "norad_catalog_id": catalog,
                "classification_type": item.get("CLASSIFICATION_TYPE"),
                "mean_motion": item.get("MEAN_MOTION"),
                "eccentricity": item.get("ECCENTRICITY"),
                "inclination_deg": item.get("INCLINATION"),
                "ra_of_asc_node_deg": item.get("RA_OF_ASC_NODE"),
                "arg_of_pericenter_deg": item.get("ARG_OF_PERICENTER"),
                "mean_anomaly_deg": item.get("MEAN_ANOMALY"),
                "ephemeris_type": item.get("EPHEMERIS_TYPE"),
                "element_set_no": item.get("ELEMENT_SET_NO"),
                "rev_at_epoch": item.get("REV_AT_EPOCH"),
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"[{index}]",
                note="Observed in the public CelesTrak WEATHER GP JSON group.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"Accept": "application/json", "User-Agent": "solari-osint-operations-center/0.12"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed public CelesTrak HTTPS query
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("CelesTrak response exceeds 3 MiB safety limit")
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
            metadata={"response_bytes": len(raw), "group": "WEATHER", "minimum_refresh_seconds": 7200},
        )
    parser_started = time.perf_counter()
    payload = json.loads(raw)
    if not isinstance(payload, list):
        raise ValueError("CelesTrak GP JSON response must be an array")
    events = normalize(payload, acquisition_id)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": len(payload),
        "records_accepted": len(events),
        "records_rejected": max(0, len(payload) - len(events)),
    })
    return acquisition, events
