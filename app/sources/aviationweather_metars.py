from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from urllib.parse import urlencode
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
    id="aviationweather-metars",
    name="AviationWeather.gov METAR observations",
    category="aviation-weather-observation",
    authoritative_url="https://aviationweather.gov/data/api/",
    method=AcquisitionMethod.API,
    poll_interval_seconds=3600,
    license_note="Public Aviation Weather Center Data API. Preserve AWC/NOAA/NWS attribution. METAR observations are operational weather data, not a flight-safety decision service in this demo.",
    capabilities=["events", "geospatial", "public-api", "aviation", "weather", "deterministic-normalization"],
    depends_on=[],
)

API_URL = "https://aviationweather.gov/api/data/metar"
DEFAULT_STATIONS = ("KMCI", "KSEA", "KJFK", "KLAX", "KORD")
MAX_STATIONS = 25
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_RECORDS = 400
STATION_RE = re.compile(r"^[A-Z0-9]{3,4}$")


def configured_stations(raw: str | None = None) -> list[str]:
    source = os.getenv("AWC_METAR_STATIONS", "") if raw is None else raw
    values = [item.strip().upper() for item in source.split(",") if item.strip()] if source.strip() else list(DEFAULT_STATIONS)
    values = list(dict.fromkeys(values))
    if not values or len(values) > MAX_STATIONS:
        raise RuntimeError(f"AWC_METAR_STATIONS must contain 1-{MAX_STATIONS} ICAO/station identifiers")
    if any(not STATION_RE.fullmatch(value) for value in values):
        raise RuntimeError("AWC_METAR_STATIONS contains an invalid station identifier")
    return values


def _datetime(value: Any) -> datetime | None:
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str) or not value.strip():
        return None
    clean = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(clean)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize(payload: list[dict[str, Any]], acquisition_id: str) -> list[EventRecord]:
    if len(payload) > MAX_RECORDS:
        raise ValueError(f"AviationWeather METAR response exceeds {MAX_RECORDS} records")
    events: list[EventRecord] = []
    for index, record in enumerate(payload):
        if not isinstance(record, dict):
            continue
        station = str(record.get("icaoId") or "").strip().upper()
        observed_at = _datetime(record.get("reportTime")) or _datetime(record.get("obsTime"))
        if not station or not STATION_RE.fullmatch(station) or observed_at is None:
            continue
        latitude = _number(record.get("lat"))
        longitude = _number(record.get("lon"))
        location = None
        if latitude is not None and longitude is not None and -90 <= latitude <= 90 and -180 <= longitude <= 180:
            location = GeoPoint(latitude=latitude, longitude=longitude, precision="AWC station coordinate")
        flight_category = str(record.get("fltCat") or "").strip().upper() or None
        raw_observation = str(record.get("rawOb") or "").strip() or None
        record_id = stable_id(SOURCE.id, station, observed_at.isoformat(), raw_observation or "")
        summary_parts = [part for part in [
            f"flight category {flight_category}" if flight_category else None,
            f"wind {record.get('wdir')}°/{record.get('wspd')} kt" if record.get("wspd") is not None else None,
            f"visibility {record.get('visib')} SM" if record.get("visib") is not None else None,
        ] if part]
        events.append(EventRecord(
            id=record_id,
            source_id=SOURCE.id,
            source_record_id=f"{station}:{observed_at.isoformat()}",
            category="aviation-weather-observation",
            title=f"METAR — {station}{f' — {record.get("name")}' if record.get('name') else ''}",
            summary="; ".join(summary_parts) if summary_parts else "Latest Aviation Weather Center METAR observation.",
            observed_at=observed_at,
            updated_at=_datetime(record.get("receiptTime")),
            location=location,
            severity=None,
            quality_score=1.0,
            properties={
                "station_id": station,
                "station_name": record.get("name"),
                "metar_type": record.get("metarType"),
                "raw_observation": raw_observation,
                "temperature_c": record.get("temp"),
                "dewpoint_c": record.get("dewp"),
                "wind_direction_deg": record.get("wdir"),
                "wind_speed_kt": record.get("wspd"),
                "wind_gust_kt": record.get("wgst"),
                "visibility_sm": record.get("visib"),
                "altimeter_hpa": record.get("altim"),
                "flight_category": flight_category,
                "clouds": record.get("clouds") if isinstance(record.get("clouds"), list) else [],
                "quality_control_field": record.get("qcField"),
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"metar[{index}]",
                note="Observed in the public Aviation Weather Center Data API. Flight category and weather values are retained from the provider; this demo does not infer airport closure, delay, or flight-safety status.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    stations = configured_stations()
    query = urlencode({"ids": ",".join(stations), "format": "json"})
    url = f"{API_URL}?{query}"
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat(), ",".join(stations))
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "solari-osint-operations-center/0.14"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed official AviationWeather.gov HTTPS endpoint and bounded query values
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("AviationWeather METAR response exceeds 2 MiB safety limit")
        completed = utc_now()
        status = getattr(response, "status", 200)
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=url,
            final_url=url,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=status,
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw), "station_count": len(stations), "provider_max_records": MAX_RECORDS},
        )
    parser_started = time.perf_counter()
    if acquisition.http_status == 204 or not raw.strip():
        payload: list[dict[str, Any]] = []
    else:
        decoded = json.loads(raw)
        if not isinstance(decoded, list):
            raise ValueError("AviationWeather METAR response must be a JSON array")
        payload = [item for item in decoded if isinstance(item, dict)]
    events = normalize(payload, acquisition.id)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": len(payload),
        "records_accepted": len(events),
        "records_rejected": max(0, len(payload) - len(events)),
    })
    return acquisition, events
