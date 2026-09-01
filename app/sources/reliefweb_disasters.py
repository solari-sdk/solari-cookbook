from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, SourceDescriptor, stable_id, utc_now

SOURCE = SourceDescriptor(
    id="reliefweb-disasters",
    name="ReliefWeb disasters",
    category="humanitarian-disaster",
    authoritative_url="https://apidoc.reliefweb.int/",
    method=AcquisitionMethod.API,
    poll_interval_seconds=1800,
    license_note="ReliefWeb read-only API. Current API access requires a pre-approved appname; attribute ReliefWeb and respect source/partner copyright and API terms.",
    capabilities=["events", "public-api", "requires-approved-appname", "humanitarian", "deterministic-normalization"],
    depends_on=[],
)

API_URL = "https://api.reliefweb.int/v2/disasters"
MAX_RESPONSE_BYTES = 5 * 1024 * 1024


def _datetime(value: Any) -> datetime | None:
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


def _names(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    output: list[str] = []
    for item in value:
        if isinstance(item, dict) and item.get("name"):
            output.append(str(item["name"]))
        elif isinstance(item, str):
            output.append(item)
    return output


def normalize(payload: dict[str, Any], acquisition_id: str) -> list[EventRecord]:
    data = payload.get("data")
    if not isinstance(data, list):
        raise ValueError("ReliefWeb response must contain a data array")
    events: list[EventRecord] = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        record_id = item.get("id")
        fields = item.get("fields")
        if record_id is None or not isinstance(fields, dict):
            continue
        name = str(fields.get("name") or f"ReliefWeb disaster {record_id}").strip()
        date_info = fields.get("date") if isinstance(fields.get("date"), dict) else {}
        observed_at = _datetime(date_info.get("created") or date_info.get("event") or date_info.get("changed"))
        if observed_at is None:
            continue
        updated_at = _datetime(date_info.get("changed"))
        status = str(fields.get("status") or "").strip() or None
        disaster_types = _names(fields.get("type"))
        countries = _names(fields.get("country"))
        primary_country = fields.get("primary_country") if isinstance(fields.get("primary_country"), dict) else {}
        events.append(EventRecord(
            id=stable_id(SOURCE.id, record_id),
            source_id=SOURCE.id,
            source_record_id=str(record_id),
            category="humanitarian-disaster",
            title=name[:500],
            summary=", ".join(disaster_types) if disaster_types else "ReliefWeb disaster record",
            observed_at=observed_at,
            updated_at=updated_at,
            severity=None,
            quality_score=1.0,
            properties={
                "status": status,
                "disaster_types": disaster_types,
                "countries": countries,
                "primary_country": primary_country.get("name"),
                "glide": fields.get("glide"),
                "reliefweb_url": item.get("href"),
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"data[{index}]",
                note="Observed in the ReliefWeb disasters API; partner-source copyright remains governed by ReliefWeb/source terms.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    appname = os.getenv("RELIEFWEB_APPNAME", "").strip()
    if not appname:
        raise RuntimeError("RELIEFWEB_APPNAME is required and must be pre-approved by ReliefWeb for API access")
    query = urlencode({"appname": appname, "limit": 100, "profile": "full", "sort[]": "date.changed:desc"})
    url = f"{API_URL}?{query}"
    safe_url = f"{API_URL}?appname=<redacted-approved-appname>&limit=100&profile=full&sort%5B%5D=date.changed%3Adesc"
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "solari-osint-operations-center/0.13"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed ReliefWeb HTTPS host; only appname is caller-configured
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("ReliefWeb response exceeds 5 MiB safety limit")
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=safe_url,
            final_url=None,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw), "limit": 100},
        )
    parser_started = time.perf_counter()
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("ReliefWeb response must be an object")
    events = normalize(payload, acquisition.id)
    received = len(payload.get("data", [])) if isinstance(payload.get("data"), list) else 0
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": received,
        "records_accepted": len(events),
        "records_rejected": max(0, received - len(events)),
    })
    return acquisition, events
