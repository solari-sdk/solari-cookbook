from __future__ import annotations

import time
from datetime import datetime, timezone
from hashlib import sha256
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

from app.contracts import (
    AcquisitionEnvelope,
    AcquisitionMethod,
    EventRecord,
    EvidenceKind,
    EvidenceReference,
    SourceDescriptor,
    stable_id,
    utc_now,
)

SOURCE = SourceDescriptor(
    id="uscg-port-status",
    name="U.S. Coast Guard Navigation Center port status",
    category="port-operational-status",
    authoritative_url="https://navcen.uscg.gov/port-status",
    method=AcquisitionMethod.FEED,
    poll_interval_seconds=1800,
    license_note="Public U.S. Coast Guard Navigation Center port-status data; preserve USCG attribution and source wording.",
    capabilities=["events", "public-web", "maritime", "port-status", "deterministic-normalization"],
    depends_on=[],
)

KNOWN_ZONES = frozenset(
    {
        "BOSTON", "CHARLESTON", "COLUMBIA RIVER", "CORPUS CHRISTI", "DELAWARE BAY", "DETROIT",
        "DULUTH", "EASTERN GREAT LAKES", "GUAM", "HONOLULU", "HOUMA", "HOUSTON-GALVESTON",
        "JACKSONVILLE", "KEY WEST", "LAKE MICHIGAN", "LONG ISLAND SOUND", "LOS ANGELES-LONG BEACH",
        "LOWER MISSISSIPPI RIVER (MEMPHIS)", "MARYLAND-NCR", "MIAMI", "MOBILE", "NEW ORLEANS",
        "NEW YORK", "NORTH CAROLINA", "NORTHERN GREAT LAKES", "NORTHERN NEW ENGLAND (PORTLAND, MAINE)",
        "OHIO VALLEY", "PITTSBURGH", "PORT ARTHUR AND LAKE CHARLES", "PRINCE WILLIAM SOUND (VALDEZ)",
        "SAN DIEGO", "SAN FRANCISCO", "SAN JUAN", "SAVANNAH", "SEAK - SOUTHEAST ALASKA (JUNEAU)",
        "SEATTLE (PUGET SOUND)", "SOUTHEASTERN NEW ENGLAND (PROVIDENCE)", "ST. PETERSBURG",
        "UPPER MISSISSIPPI RIVER (ST. LOUIS)", "VIRGINIA", "WESTERN ALASKA (ANCHORAGE)",
    }
)
DEFAULT_ZONE = "SAN JUAN"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_RECORDS = 500


def endpoint(zone: str) -> str:
    normalized = zone.strip().upper()
    if normalized not in KNOWN_ZONES:
        raise ValueError("unsupported USCG port-status zone")
    return f"https://navcen.uscg.gov/port-status?{urlencode({'zone': normalized})}"


def _date(value: str, fallback: datetime) -> tuple[datetime, str]:
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc), "source-date-only"
    except (TypeError, ValueError):
        return fallback, "acquisition-time-fallback"


def normalize(raw: bytes, acquisition_id: str, *, zone: str, acquired_at: datetime) -> list[EventRecord]:
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("USCG port status response exceeds 2 MiB safety limit")
    soup = BeautifulSoup(raw, "html.parser")
    table = None
    headers: list[str] = []
    for candidate in soup.find_all("table"):
        candidate_headers = [cell.get_text(" ", strip=True) for cell in candidate.find_all("th")]
        lowered = {header.lower() for header in candidate_headers}
        if {"port", "status"}.issubset(lowered):
            table = candidate
            headers = candidate_headers
            break
    if table is None:
        raise ValueError("USCG port status page does not contain a Port/Status table")

    events: list[EventRecord] = []
    for row_index, row in enumerate(table.find_all("tr")):
        cells = [cell.get_text(" ", strip=True) for cell in row.find_all("td")]
        if not cells:
            continue
        values = {headers[index].strip().lower(): value for index, value in enumerate(cells) if index < len(headers)}
        port = values.get("port", "").strip()
        status = values.get("status", "").strip()
        if not port or not status:
            continue
        comments = values.get("comments", "").strip() or None
        condition = values.get("condition", "").strip() or None
        last_changed = values.get("last changed", "").strip() or None
        observed_at, time_basis = _date(last_changed or "", acquired_at)
        source_record_id = stable_id(zone, port, status, condition, comments, last_changed)
        properties = {
            "zone": zone,
            "port": port,
            "status": status,
            "time_basis": time_basis,
            **({"condition": condition} if condition else {}),
            **({"comments": comments} if comments else {}),
            **({"last_changed": last_changed} if last_changed else {}),
        }
        events.append(
            EventRecord(
                id=stable_id(SOURCE.id, source_record_id),
                source_id=SOURCE.id,
                source_record_id=source_record_id,
                category="port-operational-status",
                title=f"{port} — {status}",
                summary="; ".join(part for part in (condition, comments) if part) or None,
                observed_at=observed_at,
                quality_score=1.0,
                properties=properties,
                evidence=[
                    EvidenceReference(
                        acquisition_id=acquisition_id,
                        field="*",
                        kind=EvidenceKind.OBSERVED,
                        source_path=f"port-status table row {row_index}",
                        note="Observed in the selected U.S. Coast Guard Navigation Center port-status table.",
                    )
                ],
            )
        )
        if len(events) >= MAX_RECORDS:
            break
    return events


def collect(zone: str = DEFAULT_ZONE, timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    zone = zone.strip().upper()
    url = endpoint(zone)
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, zone, started.isoformat())
    request = Request(url, headers={"User-Agent": "solari-osint-operations-center/0.12", "Accept": "text/html"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - bounded official HTTPS source
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("USCG port status response exceeds 2 MiB safety limit")
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=url,
            final_url=response.geturl(),
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw), "zone": zone},
        )
    parser_started = time.perf_counter()
    events = normalize(raw, acquisition_id, zone=zone, acquired_at=completed)
    acquisition.metadata.update(
        {
            "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
            "records_received": len(events),
            "records_accepted": len(events),
            "records_rejected": 0,
        }
    )
    return acquisition, events
