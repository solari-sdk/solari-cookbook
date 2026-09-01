from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
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
    id="usgs-volcano-elevated",
    name="USGS HANS elevated volcanoes",
    category="volcano-status",
    authoritative_url="https://volcanoes.usgs.gov/hans-public/api/volcano/default",
    method=AcquisitionMethod.API,
    poll_interval_seconds=900,
    license_note="Public USGS Hazard Notification System volcano-status data. Preserve USGS/observatory attribution and use official notices for authoritative interpretation.",
    capabilities=["events", "public-api", "volcano-status", "observatory-notices", "deterministic-normalization"],
    depends_on=[],
)

DEFAULT_URL = "https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_RECORDS = 1000


def _timestamp(item: dict[str, Any]) -> datetime | None:
    unix_value = item.get("sent_unixtime")
    try:
        if unix_value is not None:
            return datetime.fromtimestamp(int(unix_value), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        pass
    text = str(item.get("sent_utc") or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _severity(color_code: str | None, alert_level: str | None) -> str | None:
    color = (color_code or "").upper()
    alert = (alert_level or "").upper()
    if color == "RED" or alert == "WARNING":
        return "extreme"
    if color == "ORANGE" or alert == "WATCH":
        return "high"
    if color == "YELLOW" or alert == "ADVISORY":
        return "moderate"
    if color == "GREEN" or alert == "NORMAL":
        return "low"
    return None


def normalize(payload: list[dict[str, Any]], acquisition_id: str) -> list[EventRecord]:
    if not isinstance(payload, list):
        raise ValueError("USGS HANS elevated-volcano response must be an array")
    if len(payload) > MAX_RECORDS:
        raise ValueError(f"USGS HANS elevated-volcano response exceeds {MAX_RECORDS} records")
    events: list[EventRecord] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            continue
        vnum = str(item.get("vnum") or "").strip()
        volcano_name = str(item.get("volcano_name") or "").strip()
        notice_identifier = str(item.get("notice_identifier") or "").strip()
        observed_at = _timestamp(item)
        if not vnum or not volcano_name or observed_at is None:
            continue
        color_code = str(item.get("color_code") or "").strip().upper() or None
        alert_level = str(item.get("alert_level") or "").strip().upper() or None
        observatory = str(item.get("obs_fullname") or "").strip() or None
        record_id = stable_id(SOURCE.id, vnum, notice_identifier or observed_at.isoformat())
        events.append(EventRecord(
            id=record_id,
            source_id=SOURCE.id,
            source_record_id=f"{vnum}:{notice_identifier or observed_at.isoformat()}",
            category="volcano-status",
            title=f"{volcano_name} — {color_code or 'UNSPECIFIED'} / {alert_level or 'UNSPECIFIED'}",
            summary=f"USGS elevated-volcano status{f' from {observatory}' if observatory else ''}.",
            observed_at=observed_at,
            severity=_severity(color_code, alert_level),
            quality_score=1.0,
            properties={
                "volcano_name": volcano_name,
                "smithsonian_volcano_number": vnum,
                "observatory": observatory,
                "observatory_abbreviation": item.get("obs_abbr"),
                "color_code": color_code,
                "alert_level": alert_level,
                "notice_type_code": item.get("notice_type_cd"),
                "notice_identifier": notice_identifier or None,
                "notice_url": item.get("notice_url"),
                "notice_data_url": item.get("notice_data"),
                "location_not_in_elevated_status_response": True,
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"[{index}]",
                note="Observed in the public USGS HANS elevated-volcano API; no coordinates are inferred from volcano name or notice text.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"Accept": "application/json", "User-Agent": "solari-osint-operations-center/0.13"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed public USGS HTTPS endpoint
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("USGS HANS response exceeds 2 MiB safety limit")
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
    payload = json.loads(raw)
    if not isinstance(payload, list):
        raise ValueError("USGS HANS elevated-volcano response must be an array")
    events = normalize(payload, acquisition.id)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": len(payload),
        "records_accepted": len(events),
        "records_rejected": max(0, len(payload) - len(events)),
    })
    return acquisition, events
