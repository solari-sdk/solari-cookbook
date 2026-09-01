from __future__ import annotations

import csv
import io
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
    id="airnow-daily-quality",
    name="EPA AirNow daily air-quality data",
    category="air-quality",
    authoritative_url="https://files.airnowtech.org/airnow/docs/DailyDataFactSheet.pdf",
    method=AcquisitionMethod.FEED,
    poll_interval_seconds=1800,
    license_note="Public AirNow daily data. AirNow observations are preliminary/not fully quality-assured like certified AQS data; preserve EPA/AirNow and reporting-agency attribution.",
    capabilities=["events", "geospatial", "public-feed", "air-quality", "environmental-sensors", "deterministic-normalization"],
    depends_on=[],
)

DEFAULT_URL = "https://files.airnowtech.org/airnow/today/daily_data_v2.dat"
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
MAX_RECORDS = 50_000
FIELD_COUNT = 13


def _number(value: str) -> float | None:
    clean = value.strip()
    if not clean or clean == "-999":
        return None
    try:
        return float(clean)
    except ValueError:
        return None


def _date(value: str) -> datetime | None:
    try:
        return datetime.strptime(value.strip(), "%m/%d/%y").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _severity(aqi: float | None) -> str | None:
    if aqi is None:
        return None
    if aqi <= 50:
        return "low"
    if aqi <= 100:
        return "moderate"
    if aqi <= 150:
        return "high"
    if aqi <= 200:
        return "severe"
    return "extreme"


def parse_daily_data(text: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for row in csv.reader(io.StringIO(text), delimiter="|"):
        if not row or all(not item.strip() for item in row):
            continue
        if len(row) < FIELD_COUNT:
            continue
        if row[0].strip().lower() in {"valid date", "date"}:
            continue
        rows.append(row[:FIELD_COUNT])
        if len(rows) > MAX_RECORDS:
            raise ValueError(f"AirNow daily-data response exceeds {MAX_RECORDS} records")
    return rows


def normalize(rows: list[list[str]], acquisition_id: str) -> list[EventRecord]:
    events: list[EventRecord] = []
    for index, row in enumerate(rows):
        observed_at = _date(row[0])
        site_id = row[1].strip()
        site_name = row[2].strip()
        parameter = row[3].strip()
        units = row[4].strip()
        value = _number(row[5])
        averaging_period = _number(row[6])
        data_source = row[7].strip()
        aqi = _number(row[8])
        aqi_category = _number(row[9])
        latitude = _number(row[10])
        longitude = _number(row[11])
        full_aqsid = row[12].strip()
        if observed_at is None or not site_id or not parameter:
            continue
        location = None
        if latitude is not None and longitude is not None and -90 <= latitude <= 90 and -180 <= longitude <= 180:
            location = GeoPoint(latitude=latitude, longitude=longitude, precision="AirNow monitor coordinates")
        record_id = stable_id(SOURCE.id, observed_at.date().isoformat(), full_aqsid or site_id, parameter, averaging_period)
        events.append(EventRecord(
            id=record_id,
            source_id=SOURCE.id,
            source_record_id=f"{observed_at.date().isoformat()}:{full_aqsid or site_id}:{parameter}:{averaging_period}",
            category="air-quality",
            title=f"AirNow {parameter} — {site_name or site_id}",
            summary=f"Daily AirNow value {value if value is not None else 'missing'} {units or ''}; AQI {int(aqi) if aqi is not None else 'unavailable'}.",
            observed_at=observed_at,
            location=location,
            severity=_severity(aqi),
            quality_score=0.9,
            properties={
                "valid_date": row[0].strip(),
                "time_precision": "day",
                "source_time_basis": "Local Standard Time daily aggregate; normalized timestamp uses 00:00 UTC only as a deterministic date anchor",
                "aqsid": site_id,
                "full_aqsid": full_aqsid or None,
                "site_name": site_name or None,
                "parameter_name": parameter,
                "reporting_units": units or None,
                "value": value,
                "averaging_period_hours": averaging_period,
                "data_source": data_source or None,
                "aqi": aqi,
                "aqi_category_code": aqi_category,
                "airnow_preliminary": True,
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"daily_data_v2.dat.rows[{index}]",
                note="Observed in the public AirNow daily-data file. AirNow data are preliminary; local-standard-time date semantics are retained and no exact observation time is invented.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 30) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"Accept": "text/plain", "User-Agent": "solari-osint-operations-center/0.13"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed public AirNow HTTPS data endpoint
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("AirNow daily-data response exceeds 10 MiB safety limit")
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
    rows = parse_daily_data(raw.decode("utf-8-sig", errors="replace"))
    events = normalize(rows, acquisition.id)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": len(rows),
        "records_accepted": len(events),
        "records_rejected": max(0, len(rows) - len(events)),
    })
    return acquisition, events
