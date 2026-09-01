from __future__ import annotations

import csv
import io
import os
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, GeoPoint, SourceDescriptor, stable_id, utc_now

SOURCE = SourceDescriptor(
    id="nasa-firms-fires",
    name="NASA FIRMS active fire detections",
    category="wildfire",
    authoritative_url="https://firms.modaps.eosdis.nasa.gov/api/area/",
    method=AcquisitionMethod.API,
    poll_interval_seconds=900,
    license_note="NASA FIRMS public fire data; a free FIRMS MAP_KEY is required for the Area API. Follow current NASA/FIRMS attribution and use guidance.",
    capabilities=["events", "geospatial", "csv", "requires-provider-key", "deterministic-normalization"],
    depends_on=[],
)

API_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
ALLOWED_SOURCES = {
    "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "VIIRS_SNPP_NRT",
    "MODIS_NRT", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_SP", "VIIRS_SNPP_SP", "MODIS_SP",
}
MAX_RESPONSE_BYTES = 15 * 1024 * 1024


def _area(value: str) -> str:
    parts = [item.strip() for item in value.split(",")]
    if len(parts) != 4:
        raise ValueError("FIRMS area must be west,south,east,north")
    west, south, east, north = (float(item) for item in parts)
    if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= 90 and -90 <= north <= 90):
        raise ValueError("FIRMS area coordinates are out of range")
    if west >= east or south >= north:
        raise ValueError("FIRMS area must have west < east and south < north")
    return ",".join(f"{number:g}" for number in (west, south, east, north))


def _observed(row: dict[str, str]) -> datetime:
    date_value = (row.get("acq_date") or "").strip()
    time_value = (row.get("acq_time") or "").strip().zfill(4)
    if not date_value or len(time_value) != 4 or not time_value.isdigit():
        raise ValueError("FIRMS row is missing acquisition date/time")
    return datetime.strptime(f"{date_value} {time_value}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)


def _quality(value: str | None) -> float:
    if value is None:
        return 0.8
    clean = value.strip().lower()
    named = {"h": 0.95, "high": 0.95, "n": 0.8, "nominal": 0.8, "l": 0.6, "low": 0.6}
    if clean in named:
        return named[clean]
    try:
        number = float(clean)
    except ValueError:
        return 0.8
    return max(0.0, min(1.0, number / 100.0 if number > 1 else number))


def normalize(rows: list[dict[str, str]], acquisition_id: str) -> list[EventRecord]:
    events: list[EventRecord] = []
    for index, row in enumerate(rows):
        try:
            latitude = float(row.get("latitude", ""))
            longitude = float(row.get("longitude", ""))
            observed_at = _observed(row)
        except (TypeError, ValueError):
            continue
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            continue
        satellite = (row.get("satellite") or "unknown").strip()
        instrument = (row.get("instrument") or "unknown").strip()
        record_id = stable_id(
            SOURCE.id,
            f"{latitude:.5f}", f"{longitude:.5f}", observed_at.isoformat(), satellite, instrument,
        )
        frp_raw = row.get("frp")
        try:
            frp = float(frp_raw) if frp_raw not in (None, "") else None
        except ValueError:
            frp = None
        confidence = row.get("confidence")
        events.append(EventRecord(
            id=record_id,
            source_id=SOURCE.id,
            source_record_id=record_id,
            category="active-fire-detection",
            title=f"FIRMS active fire detection — {satellite}/{instrument}",
            summary="Satellite-derived active fire/hotspot detection; not by itself a confirmed wildfire perimeter.",
            observed_at=observed_at,
            location=GeoPoint(latitude=latitude, longitude=longitude, precision="FIRMS detection centroid"),
            severity=None,
            quality_score=_quality(confidence),
            properties={
                "satellite": satellite,
                "instrument": instrument,
                "confidence": confidence,
                "frp_mw": frp,
                "daynight": row.get("daynight"),
                "scan": row.get("scan"),
                "track": row.get("track"),
                "brightness": row.get("brightness") or row.get("bright_ti4"),
                "brightness_secondary": row.get("bright_t31") or row.get("bright_ti5"),
                "version": row.get("version"),
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"csv.rows[{index}]",
                note="Observed in NASA FIRMS Area API CSV output; detection semantics are preserved without inferring a wildfire perimeter.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 30) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    map_key = os.getenv("FIRMS_MAP_KEY", "").strip()
    area_value = os.getenv("FIRMS_AREA_COORDINATES", "").strip()
    source = os.getenv("FIRMS_SOURCE", "VIIRS_NOAA21_NRT").strip().upper()
    try:
        day_range = int(os.getenv("FIRMS_DAY_RANGE", "1"))
    except ValueError as exc:
        raise RuntimeError("FIRMS_DAY_RANGE must be an integer from 1 to 5") from exc
    if not map_key:
        raise RuntimeError("FIRMS_MAP_KEY is required for NASA FIRMS Area API collection")
    if not area_value:
        raise RuntimeError("FIRMS_AREA_COORDINATES is required; use west,south,east,north to bound collection")
    if source not in ALLOWED_SOURCES:
        raise RuntimeError("FIRMS_SOURCE is not in the supported public-source allowlist")
    if not 1 <= day_range <= 5:
        raise RuntimeError("FIRMS_DAY_RANGE must be between 1 and 5")
    area = _area(area_value)
    url = f"{API_BASE}/{quote(map_key, safe='')}/{source}/{area}/{day_range}"
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat(), source, area, day_range)
    request = Request(url, headers={"Accept": "text/csv", "User-Agent": "solari-osint-operations-center/0.13"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed NASA FIRMS HTTPS host and validated path components
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("NASA FIRMS response exceeds 15 MiB safety limit")
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=f"{API_BASE}/<redacted-map-key>/{source}/{area}/{day_range}",
            final_url=None,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw), "source": source, "area": area, "day_range": day_range},
        )
    parser_started = time.perf_counter()
    text = raw.decode("utf-8-sig", errors="replace")
    rows = [dict(row) for row in csv.DictReader(io.StringIO(text))]
    events = normalize(rows, acquisition.id)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": len(rows),
        "records_accepted": len(events),
        "records_rejected": max(0, len(rows) - len(events)),
    })
    return acquisition, events
