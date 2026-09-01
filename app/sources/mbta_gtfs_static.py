from __future__ import annotations

import csv
import io
import time
import zipfile
from hashlib import sha256
from urllib.request import Request, urlopen

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
    id="mbta-gtfs-static",
    name="MBTA static GTFS schedule",
    category="transportation-schedule",
    authoritative_url="https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md",
    method=AcquisitionMethod.FEED,
    poll_interval_seconds=86400,
    license_note="Official public MBTA GTFS planned-service feed. Preserve MBTA attribution. This adapter describes scheduled service and must not be interpreted as real-time vehicle position, service performance, or an emergency alert.",
    capabilities=["events", "public-feed", "transportation", "gtfs", "scheduled-service", "deterministic-normalization"],
    depends_on=[],
)

DEFAULT_URL = "https://cdn.mbta.com/MBTA_GTFS.zip"
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 128
MAX_SELECTED_MEMBER_BYTES = 4 * 1024 * 1024
MAX_ROUTES = 2000
REQUIRED_MEMBERS = {"feed_info.txt", "routes.txt"}


def _safe_member_names(archive: zipfile.ZipFile) -> set[str]:
    infos = archive.infolist()
    if len(infos) > MAX_ARCHIVE_ENTRIES:
        raise ValueError(f"GTFS archive exceeds {MAX_ARCHIVE_ENTRIES} entries")
    names: set[str] = set()
    for info in infos:
        normalized = info.filename.replace("\\", "/")
        if normalized.startswith("/") or any(part == ".." for part in normalized.split("/")):
            raise ValueError("GTFS archive contains an unsafe member path")
        names.add(normalized)
    missing = REQUIRED_MEMBERS - names
    if missing:
        raise ValueError(f"GTFS archive is missing required member(s): {', '.join(sorted(missing))}")
    return names


def _read_csv_member(archive: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    info = archive.getinfo(name)
    if info.file_size > MAX_SELECTED_MEMBER_BYTES:
        raise ValueError(f"GTFS member {name} exceeds {MAX_SELECTED_MEMBER_BYTES} byte safety limit")
    raw = archive.read(info)
    if len(raw) != info.file_size:
        raise ValueError(f"GTFS member {name} size mismatch")
    text = raw.decode("utf-8-sig", errors="strict")
    return [dict(row) for row in csv.DictReader(io.StringIO(text))]


def parse_gtfs(raw: bytes) -> tuple[dict[str, str], list[dict[str, str]]]:
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("GTFS response exceeds 64 MiB safety limit")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            _safe_member_names(archive)
            feed_rows = _read_csv_member(archive, "feed_info.txt")
            route_rows = _read_csv_member(archive, "routes.txt")
    except zipfile.BadZipFile as exc:
        raise ValueError("GTFS response is not a valid ZIP archive") from exc
    if not feed_rows:
        raise ValueError("GTFS feed_info.txt contains no records")
    if len(route_rows) > MAX_ROUTES:
        raise ValueError(f"GTFS routes.txt exceeds {MAX_ROUTES} records")
    routes = [row for row in route_rows if str(row.get("route_id") or "").strip()]
    return feed_rows[0], routes


def normalize(
    feed_info: dict[str, str],
    routes: list[dict[str, str]],
    acquisition: AcquisitionEnvelope,
) -> list[EventRecord]:
    feed_version = str(feed_info.get("feed_version") or "").strip()
    feed_start = str(feed_info.get("feed_start_date") or "").strip()
    feed_end = str(feed_info.get("feed_end_date") or "").strip()
    version_key = feed_version or f"{feed_start}:{feed_end}" or acquisition.content_sha256
    events: list[EventRecord] = []
    for index, route in enumerate(routes):
        route_id = str(route.get("route_id") or "").strip()
        short_name = str(route.get("route_short_name") or "").strip()
        long_name = str(route.get("route_long_name") or "").strip()
        label = short_name or long_name or route_id
        description_parts = [item for item in (short_name, long_name) if item]
        events.append(EventRecord(
            id=stable_id(SOURCE.id, version_key, route_id),
            source_id=SOURCE.id,
            source_record_id=f"{version_key}:{route_id}",
            category="transportation-schedule-route",
            title=f"MBTA scheduled route — {label}",
            summary=" / ".join(description_parts) if description_parts else "Route present in the observed MBTA planned-service GTFS publication.",
            observed_at=acquisition.completed_at,
            severity=None,
            quality_score=1.0,
            properties={
                "route_id": route_id,
                "route_short_name": short_name or None,
                "route_long_name": long_name or None,
                "route_type": str(route.get("route_type") or "").strip() or None,
                "route_desc": str(route.get("route_desc") or "").strip() or None,
                "route_url": str(route.get("route_url") or "").strip() or None,
                "route_color": str(route.get("route_color") or "").strip() or None,
                "route_text_color": str(route.get("route_text_color") or "").strip() or None,
                "feed_version": feed_version or None,
                "feed_start_date": feed_start or None,
                "feed_end_date": feed_end or None,
                "schedule_only": True,
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition.id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"routes.txt.records[{index}]",
                note="Observed in the official MBTA static GTFS publication. This is planned service, not a real-time operational observation.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 30) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"Accept": "application/zip, application/octet-stream", "User-Agent": "solari-osint-operations-center/0.13"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed official MBTA HTTPS endpoint
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("GTFS response exceeds 64 MiB safety limit")
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
            metadata={"response_bytes": len(raw), "archive_format": "zip", "gtfs_mode": "static-planned-service"},
        )
    parser_started = time.perf_counter()
    feed_info, routes = parse_gtfs(raw)
    events = normalize(feed_info, routes, acquisition)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "feed_version": feed_info.get("feed_version") or None,
        "feed_start_date": feed_info.get("feed_start_date") or None,
        "feed_end_date": feed_info.get("feed_end_date") or None,
        "records_received": len(routes),
        "records_accepted": len(events),
        "records_rejected": 0,
    })
    return acquisition, events
