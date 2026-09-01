from __future__ import annotations

import json
import os
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
    id="usgs-water-latest",
    name="USGS Water Data latest continuous observations",
    category="water-observation",
    authoritative_url="https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous",
    method=AcquisitionMethod.API,
    poll_interval_seconds=900,
    license_note="Public USGS Water Data API. Latest continuous values may be provisional; preserve USGS attribution and approval/qualifier metadata.",
    capabilities=["events", "geospatial", "public-api", "hydrology", "river-gauge", "deterministic-normalization"],
    depends_on=[],
)

API_URL = "https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items"
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
MAX_SITES = 25
MAX_PARAMETERS = 10
MAX_FEATURES = 5000
DEFAULT_PARAMETERS = ["00060", "00065"]  # discharge and gage height where available


def _configured_ids(raw: str, *, prefix: str = "USGS-") -> list[str]:
    values: list[str] = []
    for item in raw.split(","):
        clean = item.strip().upper()
        if not clean:
            continue
        if clean.startswith(prefix):
            clean = clean[len(prefix):]
        if not clean.isdigit() or not 8 <= len(clean) <= 15:
            raise RuntimeError("USGS_WATER_SITE_IDS must contain 8-15 digit USGS site numbers")
        value = f"{prefix}{clean}"
        if value not in values:
            values.append(value)
    if not values:
        raise RuntimeError("USGS_WATER_SITE_IDS is required for bounded latest-water collection")
    if len(values) > MAX_SITES:
        raise RuntimeError(f"USGS_WATER_SITE_IDS is limited to {MAX_SITES} sites per run")
    return values


def _parameter_codes(raw: str) -> list[str]:
    values = [item.strip() for item in raw.split(",") if item.strip()] if raw.strip() else list(DEFAULT_PARAMETERS)
    if len(values) > MAX_PARAMETERS or any(len(value) != 5 or not value.isdigit() for value in values):
        raise RuntimeError(f"USGS_WATER_PARAMETER_CODES must contain at most {MAX_PARAMETERS} five-digit parameter codes")
    return list(dict.fromkeys(values))


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


def _value(value: Any) -> float | str | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        clean = str(value).strip()
        return clean or None


def normalize(payload: dict[str, Any], acquisition_id: str) -> list[EventRecord]:
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError("USGS latest-continuous response must contain a features array")
    if len(features) > MAX_FEATURES:
        raise ValueError(f"USGS latest-continuous response exceeds {MAX_FEATURES} features")
    events: list[EventRecord] = []
    for index, feature in enumerate(features):
        if not isinstance(feature, dict):
            continue
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            continue
        site_id = str(properties.get("monitoring_location_id") or "").strip()
        parameter_code = str(properties.get("parameter_code") or "").strip()
        observed_at = _datetime(properties.get("time"))
        if not site_id or not parameter_code or observed_at is None:
            continue
        geometry = feature.get("geometry") if isinstance(feature.get("geometry"), dict) else {}
        coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
        location = None
        if len(coordinates) >= 2:
            try:
                longitude, latitude = float(coordinates[0]), float(coordinates[1])
                if -180 <= longitude <= 180 and -90 <= latitude <= 90:
                    location = GeoPoint(latitude=latitude, longitude=longitude, precision="USGS monitoring-location point")
            except (TypeError, ValueError):
                pass
        raw_value = _value(properties.get("value"))
        unit = properties.get("unit_of_measure")
        approval = properties.get("approval_status") or properties.get("approvals_status")
        feature_id = str(feature.get("id") or "").strip()
        record_id = stable_id(SOURCE.id, feature_id or site_id, parameter_code, observed_at.isoformat())
        events.append(EventRecord(
            id=record_id,
            source_id=SOURCE.id,
            source_record_id=feature_id or f"{site_id}:{parameter_code}:{observed_at.isoformat()}",
            category="water-observation",
            title=f"USGS water observation — {site_id} / {parameter_code}",
            summary=f"Latest continuous value: {raw_value if raw_value is not None else 'missing'}{f' {unit}' if unit else ''}.",
            observed_at=observed_at,
            updated_at=_datetime(properties.get("last_modified")),
            location=location,
            severity=None,
            quality_score=1.0,
            properties={
                "monitoring_location_id": site_id,
                "parameter_code": parameter_code,
                "value": raw_value,
                "unit_of_measure": unit,
                "approval_status": approval,
                "qualifier": properties.get("qualifier"),
                "timeseries_id": properties.get("timeseries_id") or properties.get("time_series_id"),
                "provisional_data_possible": True,
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"features[{index}]",
                note="Observed in the modern USGS Water Data latest-continuous API; approval and qualifier metadata are preserved and no flood severity is inferred from a raw gauge value.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    sites = _configured_ids(os.getenv("USGS_WATER_SITE_IDS", ""))
    parameters = _parameter_codes(os.getenv("USGS_WATER_PARAMETER_CODES", ""))
    query = urlencode({
        "f": "json",
        "monitoring_location_id": ",".join(sites),
        "parameter_code": ",".join(parameters),
        "limit": MAX_FEATURES,
    })
    url = f"{API_URL}?{query}"
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat(), ",".join(sites), ",".join(parameters))
    headers = {"Accept": "application/geo+json, application/json", "User-Agent": "solari-osint-operations-center/0.13"}
    api_key = os.getenv("USGS_WATER_API_KEY", "").strip()
    if api_key:
        headers["X-Api-Key"] = api_key
    request = Request(url, headers=headers)
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed modern USGS HTTPS host; validated bounded query values
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("USGS latest-continuous response exceeds 5 MiB safety limit")
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=url,
            final_url=url,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={
                "response_bytes": len(raw),
                "site_count": len(sites),
                "parameter_codes": parameters,
                "optional_api_key_used": bool(api_key),
                "rate_limit_remaining": response.headers.get("X-RateLimit-Remaining"),
            },
        )
    parser_started = time.perf_counter()
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("USGS latest-continuous response must be an object")
    events = normalize(payload, acquisition.id)
    received = len(payload.get("features", [])) if isinstance(payload.get("features"), list) else 0
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": received,
        "records_accepted": len(events),
        "records_rejected": max(0, received - len(events)),
    })
    return acquisition, events
