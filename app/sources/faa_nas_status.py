from __future__ import annotations

import time
from email.utils import parsedate_to_datetime
from hashlib import sha256
from typing import Any
from urllib.request import Request, urlopen

from defusedxml import ElementTree

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
    id="faa-nas-airport-status",
    name="FAA National Airspace System airport status",
    category="airport-operational-status",
    authoritative_url="https://nasstatus.faa.gov/",
    method=AcquisitionMethod.API,
    poll_interval_seconds=300,
    license_note="Public FAA NAS Status airport-event data; preserve FAA attribution and source event wording.",
    capabilities=["events", "public-api", "aviation", "operational-status", "deterministic-normalization"],
    depends_on=[],
)

DEFAULT_URL = "https://nasstatus.faa.gov/api/airport-status-information"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def _text(node: Any, name: str) -> str | None:
    child = node.find(name)
    if child is None or child.text is None:
        return None
    value = child.text.strip()
    return value or None


def normalize(raw: bytes, acquisition_id: str) -> list[EventRecord]:
    root = ElementTree.fromstring(raw)
    if root.tag != "AIRPORT_STATUS_INFORMATION":
        raise ValueError("FAA NAS response root is not AIRPORT_STATUS_INFORMATION")
    update_text = _text(root, "Update_Time")
    if not update_text:
        raise ValueError("FAA NAS response is missing Update_Time")
    observed_at = parsedate_to_datetime(update_text)
    if observed_at.tzinfo is None:
        raise ValueError("FAA NAS Update_Time is missing timezone information")

    events: list[EventRecord] = []
    for delay_type_index, delay_type in enumerate(root.findall("Delay_type")):
        event_type = _text(delay_type, "Name") or "Airport operational event"
        for node in delay_type.iter():
            airport = _text(node, "ARPT")
            if not airport:
                continue
            properties = {
                key: value
                for key, value in {
                    "event_type": event_type,
                    "airport": airport,
                    "reason": _text(node, "Reason"),
                    "start": _text(node, "Start"),
                    "reopen": _text(node, "Reopen"),
                    "average_delay": _text(node, "Avg"),
                    "maximum_delay": _text(node, "Max"),
                }.items()
                if value is not None
            }
            source_record_id = stable_id(
                event_type,
                airport,
                properties.get("reason"),
                properties.get("start"),
                properties.get("reopen"),
                properties.get("average_delay"),
                properties.get("maximum_delay"),
            )
            summary_parts = [
                value
                for value in (
                    properties.get("reason"),
                    f"Average: {properties['average_delay']}" if properties.get("average_delay") else None,
                    f"Maximum: {properties['maximum_delay']}" if properties.get("maximum_delay") else None,
                )
                if value
            ]
            events.append(
                EventRecord(
                    id=stable_id(SOURCE.id, source_record_id),
                    source_id=SOURCE.id,
                    source_record_id=source_record_id,
                    category="airport-operational-status",
                    title=f"{event_type} — {airport}",
                    summary="; ".join(summary_parts)[:2000] or None,
                    observed_at=observed_at,
                    quality_score=1.0,
                    properties=properties,
                    evidence=[
                        EvidenceReference(
                            acquisition_id=acquisition_id,
                            field="*",
                            kind=EvidenceKind.OBSERVED,
                            source_path=f"Delay_type[{delay_type_index}]/{node.tag}[ARPT={airport}]",
                            note="Observed in the FAA NAS Status machine-readable airport-status response.",
                        )
                    ],
                )
            )
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"User-Agent": "solari-osint-operations-center/0.12", "Accept": "application/xml,text/xml"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed HTTPS FAA source
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("FAA NAS status response exceeds 2 MiB safety limit")
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
            metadata={"response_bytes": len(raw)},
        )
    parser_started = time.perf_counter()
    events = normalize(raw, acquisition_id)
    acquisition.metadata.update(
        {
            "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
            "records_received": len(events),
            "records_accepted": len(events),
            "records_rejected": 0,
        }
    )
    return acquisition, events
