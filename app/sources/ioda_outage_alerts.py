from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
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
    SourceDescriptor,
    stable_id,
    utc_now,
)

SOURCE = SourceDescriptor(
    id="ioda-outage-alerts",
    name="Georgia Tech IODA Outage Alerts",
    category="internet-health",
    authoritative_url="https://api.ioda.inetintel.cc.gatech.edu/v2/",
    method=AcquisitionMethod.API,
    poll_interval_seconds=900,
    license_note="Public Georgia Tech Internet Intelligence Lab IODA API; retain attribution and treat alerts as measurement/detector signals, not proof of cause or impact.",
    capabilities=["events", "internet-health", "public-api", "detector-alerts", "country-entities"],
    depends_on=[],
)

ALERTS_ENDPOINT = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts"
WINDOW_HOURS = 6
MAX_ALERTS = 300
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def _window(now: datetime | None = None) -> tuple[datetime, datetime]:
    until = now or utc_now()
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    until = until.astimezone(timezone.utc)
    return until - timedelta(hours=WINDOW_HOURS), until


def _request_url(now: datetime | None = None) -> tuple[str, datetime, datetime]:
    start, until = _window(now)
    query = urlencode(
        {
            "from": int(start.timestamp()),
            "until": int(until.timestamp()),
            "entityType": "country",
            "limit": MAX_ALERTS,
        }
    )
    return f"{ALERTS_ENDPOINT}?{query}", start, until


def fetch(timeout_seconds: int = 20, *, now: datetime | None = None) -> tuple[AcquisitionEnvelope, dict[str, Any]]:
    requested_url, start, until = _request_url(now)
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(
        requested_url,
        headers={
            "Accept": "application/json",
            "User-Agent": "solari-osint-operations-center/0.1",
        },
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed HTTPS public source
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise ValueError("IODA response exceeds 2 MiB safety limit")
            final_url = response.geturl()
            status = getattr(response, "status", 200)
            content_type = response.headers.get("Content-Type")
        completed = utc_now()
        document = json.loads(payload)
        if not isinstance(document, dict):
            raise ValueError("IODA response envelope must be a JSON object")
        envelope = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=requested_url,
            final_url=final_url,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=status,
            content_type=content_type,
            content_sha256=sha256(payload).hexdigest(),
            metadata={
                "response_bytes": len(payload),
                "window_start": start.isoformat(),
                "window_end": until.isoformat(),
                "entity_type": "country",
                "limit": MAX_ALERTS,
            },
        )
        return envelope, document
    except Exception as exc:
        raise RuntimeError(
            AcquisitionEnvelope(
                id=acquisition_id,
                source_id=SOURCE.id,
                method=SOURCE.method,
                requested_url=requested_url,
                started_at=started,
                completed_at=utc_now(),
                status="failure",
                error_type=_classify_error(exc),
                error_message=str(exc)[:500],
            ).model_dump_json()
        ) from exc


def _rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("data", [])
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        for key in ("alerts", "items", "results"):
            value = data.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def normalize(payload: dict[str, Any], acquisition_id: str) -> list[EventRecord]:
    events: list[EventRecord] = []
    for item in _rows(payload):
        entity = item.get("entity") or {}
        if not isinstance(entity, dict):
            continue
        entity_type = str(entity.get("type") or item.get("entityType") or "").lower()
        country_code = str(entity.get("code") or item.get("entityCode") or "").upper()
        country_name = str(entity.get("name") or country_code or "Unknown country")
        datasource = str(item.get("datasource") or "unknown")
        level = str(item.get("level") or "").lower()
        timestamp = item.get("time")
        if entity_type != "country" or not country_code or timestamp is None or level in {"", "normal"}:
            continue
        try:
            observed_at = datetime.fromtimestamp(float(timestamp), tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            continue
        value = _number(item.get("value"))
        history_value = _number(item.get("historyValue"))
        ratio = value / history_value if value is not None and history_value not in (None, 0) else None
        source_record_id = stable_id(country_code, datasource, int(float(timestamp)), level)
        severity = "high" if level == "critical" else "moderate" if level == "warning" else "low"
        events.append(
            EventRecord(
                id=stable_id(SOURCE.id, source_record_id),
                source_id=SOURCE.id,
                source_record_id=source_record_id,
                category="internet-reachability-alert",
                title=f"IODA connectivity alert — {country_name} — {datasource}",
                summary="IODA detector alert for a country-level connectivity signal; this measurement does not establish cause, intent, or real-world impact.",
                observed_at=observed_at,
                severity=severity,
                quality_score=0.85,
                properties={
                    "country_code": country_code,
                    "country_name": country_name,
                    "datasource": datasource,
                    "alert_level": level,
                    "condition": item.get("condition"),
                    "value": value,
                    "history_value": history_value,
                    "value_to_history_ratio": ratio,
                    "entity_attrs": entity.get("attrs") if isinstance(entity.get("attrs"), dict) else {},
                    "interpretation": "detector_signal_only_no_cause_or_impact_inference",
                },
                evidence=[
                    EvidenceReference(
                        acquisition_id=acquisition_id,
                        field="*",
                        kind=EvidenceKind.OBSERVED,
                        source_path=f"data[country={country_code},datasource={datasource},time={int(float(timestamp))}]",
                        note="Normalized from an IODA outage-alert detector record. Alert level and signal values are provider observations; no outage cause or consequence is inferred.",
                    )
                ],
            )
        )
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    acquisition, payload = fetch(timeout_seconds=timeout_seconds)
    parser_started = time.perf_counter()
    rows = _rows(payload)
    events = normalize(payload, acquisition.id)
    acquisition.metadata.update(
        {
            "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
            "records_received": len(rows),
            "records_accepted": len(events),
            "records_rejected": max(0, len(rows) - len(events)),
        }
    )
    return acquisition, events


def _number(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _classify_error(exc: Exception) -> str:
    text = type(exc).__name__.lower()
    if "timeout" in text:
        return "timeout"
    if "http" in text:
        return "http_error"
    if "url" in text or "connection" in text:
        return "network_error"
    if isinstance(exc, (ValueError, json.JSONDecodeError)):
        return "validation_error"
    return "unknown_error"
