from __future__ import annotations

import time
from datetime import datetime, timezone
from hashlib import sha256
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
    id="ndbc-latest-observations",
    name="NOAA NDBC latest observations",
    category="marine-observation",
    authoritative_url="https://www.ndbc.noaa.gov/docs/ndbc_web_data_guide.pdf",
    method=AcquisitionMethod.FEED,
    poll_interval_seconds=300,
    license_note="Public NOAA National Data Buoy Center latest-observation data. Preserve NOAA/NDBC attribution; observations can be incomplete and are not a substitute for official marine warnings.",
    capabilities=["events", "geospatial", "public-feed", "marine", "environmental-sensors", "deterministic-normalization"],
    depends_on=[],
)

DEFAULT_URL = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_RECORDS = 5000
FIELDS = [
    "station", "latitude", "longitude", "year", "month", "day", "hour", "minute",
    "wind_direction_deg", "wind_speed_m_s", "wind_gust_m_s", "wave_height_m",
    "dominant_wave_period_s", "average_wave_period_s", "mean_wave_direction_deg",
    "pressure_hpa", "pressure_tendency_hpa", "air_temperature_c", "water_temperature_c",
    "dewpoint_c", "visibility_nmi", "tide_ft",
]
NUMERIC_FIELDS = set(FIELDS[1:3] + FIELDS[8:])


def _number(value: str) -> float | None:
    clean = value.strip()
    if not clean or clean.upper() == "MM":
        return None
    try:
        return float(clean)
    except ValueError:
        return None


def _observed(tokens: list[str]) -> datetime | None:
    try:
        return datetime(
            int(tokens[3]), int(tokens[4]), int(tokens[5]), int(tokens[6]), int(tokens[7]), tzinfo=timezone.utc
        )
    except (ValueError, IndexError):
        return None


def parse_latest_observations(text: str) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        tokens = line.split()
        if len(tokens) < len(FIELDS):
            continue
        tokens = tokens[:len(FIELDS)]
        observed_at = _observed(tokens)
        latitude = _number(tokens[1])
        longitude = _number(tokens[2])
        station = tokens[0].strip()
        if not station or observed_at is None or latitude is None or longitude is None:
            continue
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            continue
        item: dict[str, object] = {"station": station, "observed_at": observed_at, "latitude": latitude, "longitude": longitude}
        for index, field in enumerate(FIELDS[8:], start=8):
            item[field] = _number(tokens[index]) if field in NUMERIC_FIELDS else tokens[index]
        records.append(item)
        if len(records) > MAX_RECORDS:
            raise ValueError(f"NDBC latest-observation response exceeds {MAX_RECORDS} records")
    return records


def normalize(records: list[dict[str, object]], acquisition_id: str) -> list[EventRecord]:
    events: list[EventRecord] = []
    for index, record in enumerate(records):
        station = str(record["station"])
        observed_at = record["observed_at"]
        assert isinstance(observed_at, datetime)
        record_id = stable_id(SOURCE.id, station, observed_at.isoformat())
        observed_values = {key: value for key, value in record.items() if key not in {"station", "observed_at", "latitude", "longitude"} and value is not None}
        highlights: list[str] = []
        if record.get("wind_speed_m_s") is not None:
            highlights.append(f"wind {record['wind_speed_m_s']} m/s")
        if record.get("wave_height_m") is not None:
            highlights.append(f"wave {record['wave_height_m']} m")
        if record.get("water_temperature_c") is not None:
            highlights.append(f"water {record['water_temperature_c']} °C")
        events.append(EventRecord(
            id=record_id,
            source_id=SOURCE.id,
            source_record_id=f"{station}:{observed_at.isoformat()}",
            category="marine-observation",
            title=f"NDBC observation — {station}",
            summary="; ".join(highlights) if highlights else "Latest NOAA NDBC station observation.",
            observed_at=observed_at,
            location=GeoPoint(latitude=float(record["latitude"]), longitude=float(record["longitude"]), precision="NDBC station position"),
            severity=None,
            quality_score=1.0,
            properties={"station_id": station, **observed_values},
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"latest_obs.txt.records[{index}]",
                note="Observed in NOAA NDBC's latest-observations aggregate; missing values remain null and no hazard condition is inferred.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"Accept": "text/plain", "User-Agent": "solari-osint-operations-center/0.13"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed public NOAA/NDBC HTTPS endpoint
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("NDBC latest-observation response exceeds 2 MiB safety limit")
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=DEFAULT_URL,
            final_url=DEFAULT_URL,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw)},
        )
    parser_started = time.perf_counter()
    text = raw.decode("utf-8", errors="replace")
    records = parse_latest_observations(text)
    events = normalize(records, acquisition.id)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": len(records),
        "records_accepted": len(events),
        "records_rejected": 0,
    })
    return acquisition, events
