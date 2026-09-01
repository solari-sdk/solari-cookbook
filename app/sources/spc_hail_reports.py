from __future__ import annotations

import csv
import io
import time
from datetime import date, datetime, time as clock_time, timedelta, timezone
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
    id="spc-hail-reports",
    name="NOAA Storm Prediction Center preliminary hail reports",
    category="storm-observation",
    authoritative_url="https://www.spc.noaa.gov/climo/reports/today.html",
    method=AcquisitionMethod.FEED,
    poll_interval_seconds=300,
    license_note="Public NOAA/NWS Storm Prediction Center preliminary storm-report data. Preserve NOAA/SPC attribution. Reports are preliminary observations, not warnings, forecasts, finalized Storm Data, or proof of damage at a specific property.",
    capabilities=["events", "geospatial", "public-feed", "storm-observation", "hail", "deterministic-normalization"],
    depends_on=[],
)

DEFAULT_URL = "https://www.spc.noaa.gov/climo/reports/today_hail.csv"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_RECORDS = 10_000
REQUIRED_COLUMNS = {"Time", "Size", "Location", "County", "State", "Lat", "Lon", "Comments"}


def convective_day_start(now: datetime) -> date:
    """Return the SPC convective-day start date (1200 UTC through 1159 UTC next day)."""
    current = now.astimezone(timezone.utc)
    return current.date() if current.hour >= 12 else current.date() - timedelta(days=1)


def _report_datetime(day_start: date, hhmm: str) -> datetime | None:
    value = str(hhmm or "").strip().zfill(4)
    if len(value) != 4 or not value.isdigit():
        return None
    hour = int(value[:2])
    minute = int(value[2:])
    if hour > 23 or minute > 59:
        return None
    calendar_date = day_start + timedelta(days=1 if hour < 12 else 0)
    return datetime.combine(calendar_date, clock_time(hour=hour, minute=minute), tzinfo=timezone.utc)


def _number(value: str) -> float | None:
    clean = str(value or "").strip()
    if not clean or clean.upper() == "UNK":
        return None
    try:
        return float(clean)
    except ValueError:
        return None


def parse_hail_csv(text: str) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise ValueError("SPC hail CSV has no header")
    fieldnames = {str(item).strip() for item in reader.fieldnames if item is not None}
    missing = REQUIRED_COLUMNS - fieldnames
    if missing:
        raise ValueError(f"SPC hail CSV missing required columns: {', '.join(sorted(missing))}")
    rows: list[dict[str, str]] = []
    for row in reader:
        normalized = {str(key).strip(): str(value or "").strip() for key, value in row.items() if key is not None}
        if not any(normalized.values()):
            continue
        rows.append(normalized)
        if len(rows) > MAX_RECORDS:
            raise ValueError(f"SPC hail CSV exceeds {MAX_RECORDS} records")
    return rows


def normalize(rows: list[dict[str, str]], acquisition: AcquisitionEnvelope, day_start: date) -> list[EventRecord]:
    events: list[EventRecord] = []
    for index, row in enumerate(rows):
        observed_at = _report_datetime(day_start, row.get("Time", ""))
        latitude = _number(row.get("Lat", ""))
        longitude = _number(row.get("Lon", ""))
        if observed_at is None or latitude is None or longitude is None:
            continue
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            continue
        size_hundredths = _number(row.get("Size", ""))
        location = row.get("Location", "").strip()
        county = row.get("County", "").strip()
        state = row.get("State", "").strip()
        comments = row.get("Comments", "").strip()
        record_id = stable_id(
            SOURCE.id,
            day_start.isoformat(),
            row.get("Time", ""),
            f"{latitude:.4f}",
            f"{longitude:.4f}",
            row.get("Size", ""),
            location,
            county,
            state,
            comments,
        )
        title_location = ", ".join(item for item in (location, state) if item) or "reported location"
        size_inches = size_hundredths / 100.0 if size_hundredths is not None else None
        events.append(EventRecord(
            id=record_id,
            source_id=SOURCE.id,
            source_record_id=record_id,
            category="storm-observation-hail",
            title=f"SPC preliminary hail report — {title_location}",
            summary=comments or "Preliminary hail report aggregated by the NOAA Storm Prediction Center.",
            observed_at=observed_at,
            location=GeoPoint(latitude=latitude, longitude=longitude, precision="SPC preliminary report coordinate; two-decimal-degree source precision"),
            severity=None,
            quality_score=1.0,
            properties={
                "report_time_utc": row.get("Time") or None,
                "convective_day_start": day_start.isoformat(),
                "hail_size_hundredths_inch": size_hundredths,
                "hail_size_inches": size_inches,
                "location_text": location or None,
                "county": county or None,
                "state": state or None,
                "comments": comments or None,
                "preliminary": True,
                "warning_or_forecast": False,
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition.id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"today_hail.csv.records[{index}]",
                note="Observed in NOAA/SPC's preliminary daily hail-report CSV. SPC reports are organized by 1200-1159 UTC convective day; this record must not be treated as a warning, forecast, finalized Storm Data record, or proof of property damage.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    day_start = convective_day_start(started)
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"Accept": "text/csv,text/plain", "User-Agent": "solari-osint-operations-center/0.13"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed public NOAA/SPC HTTPS endpoint
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("SPC hail-report response exceeds 4 MiB safety limit")
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=DEFAULT_URL,
            final_url=getattr(response, "url", DEFAULT_URL) or DEFAULT_URL,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw), "convective_day_start": day_start.isoformat(), "preliminary": True},
        )
    parser_started = time.perf_counter()
    rows = parse_hail_csv(raw.decode("utf-8-sig", errors="strict"))
    events = normalize(rows, acquisition, day_start)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": len(rows),
        "records_accepted": len(events),
        "records_rejected": len(rows) - len(events),
    })
    return acquisition, events
