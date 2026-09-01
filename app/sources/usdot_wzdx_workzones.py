from __future__ import annotations

import ipaddress
import json
import os
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

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
    id="usdot-wzdx-workzones",
    name="USDOT-compatible WZDx public work-zone feed",
    category="road-work-zone",
    authoritative_url="https://www.transportation.gov/av/data/wzdx",
    method=AcquisitionMethod.FEED,
    poll_interval_seconds=300,
    license_note="WZDx is a public USDOT-origin specification; each configured producer feed retains its own attribution/terms. Configure only lawful public feeds and preserve producer/source metadata.",
    capabilities=["events", "geospatial", "public-feed", "transportation", "infrastructure", "work-zone", "configured-public-url", "deterministic-normalization"],
    depends_on=[],
)

MAX_RESPONSE_BYTES = 10 * 1024 * 1024
MAX_FEATURES = 5000
MAX_ALLOWED_HOSTS = 10


def _parse_datetime(value: Any) -> datetime | None:
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


def _allowed_hosts(raw: str) -> set[str]:
    hosts = {item.strip().lower().rstrip(".") for item in raw.split(",") if item.strip()}
    if not hosts:
        raise RuntimeError("WZDX_ALLOWED_HOSTS is required and must explicitly allow the configured public feed hostname")
    if len(hosts) > MAX_ALLOWED_HOSTS:
        raise RuntimeError(f"WZDX_ALLOWED_HOSTS is limited to {MAX_ALLOWED_HOSTS} exact hostnames")
    for host in hosts:
        if ":" in host or "/" in host or host == "localhost" or host.endswith(".localhost"):
            raise RuntimeError("WZDX_ALLOWED_HOSTS must contain exact public hostnames without ports or paths")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            continue
        if not address.is_global:
            raise RuntimeError("WZDX_ALLOWED_HOSTS must not contain non-public IP literals")
    return hosts


def _validated_url(value: str, allowed_hosts: set[str]) -> str:
    parsed = urlparse(value.strip())
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise RuntimeError("WZDX_FEED_URL must be a credential-free HTTPS URL on port 443")
    if host not in allowed_hosts:
        raise RuntimeError("WZDX_FEED_URL hostname is not present in WZDX_ALLOWED_HOSTS")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise RuntimeError("WZDX_FEED_URL must not use a non-public IP literal")
    return parsed.geturl()


class _AllowlistedRedirectHandler(HTTPRedirectHandler):
    def __init__(self, allowed_hosts: set[str]) -> None:
        super().__init__()
        self.allowed_hosts = allowed_hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        target = _validated_url(urljoin(req.full_url, newurl), self.allowed_hosts)
        return super().redirect_request(req, fp, code, msg, headers, target)


def _first_point(geometry: Any) -> tuple[float, float] | None:
    if not isinstance(geometry, dict):
        return None
    coordinates = geometry.get("coordinates")

    def walk(value: Any) -> tuple[float, float] | None:
        if isinstance(value, list) and len(value) >= 2 and all(isinstance(v, (int, float)) for v in value[:2]):
            longitude, latitude = float(value[0]), float(value[1])
            if -180 <= longitude <= 180 and -90 <= latitude <= 90:
                return longitude, latitude
            return None
        if isinstance(value, list):
            for child in value:
                found = walk(child)
                if found:
                    return found
        return None

    return walk(coordinates)


def normalize(payload: dict[str, Any], acquisition_id: str) -> list[EventRecord]:
    if payload.get("type") != "FeatureCollection":
        raise ValueError("WZDx response must be a GeoJSON FeatureCollection")
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError("WZDx response must contain a features array")
    if len(features) > MAX_FEATURES:
        raise ValueError(f"WZDx response exceeds {MAX_FEATURES} features")

    events: list[EventRecord] = []
    for index, feature in enumerate(features):
        if not isinstance(feature, dict):
            continue
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            continue
        core = properties.get("core_details") if isinstance(properties.get("core_details"), dict) else properties
        event_type = str(core.get("event_type") or "work-zone").strip().lower()
        if event_type not in {"work-zone", "detour"}:
            continue
        source_record_id = str(feature.get("id") or "").strip()
        update_date = _parse_datetime(core.get("update_date"))
        creation_date = _parse_datetime(core.get("creation_date"))
        start_date = _parse_datetime(properties.get("start_date"))
        observed_at = update_date or start_date or creation_date
        if observed_at is None:
            continue
        if not source_record_id:
            source_record_id = stable_id(core.get("data_source_id"), core.get("road_names"), event_type, observed_at.isoformat())

        first_point = _first_point(feature.get("geometry"))
        location = None
        if first_point:
            location = GeoPoint(
                latitude=first_point[1],
                longitude=first_point[0],
                precision="WZDx source geometry first coordinate; not a centroid or full-zone representation",
            )

        road_names = core.get("road_names") if isinstance(core.get("road_names"), list) else []
        name = str(core.get("name") or "").strip()
        road_label = ", ".join(str(item) for item in road_names[:3] if str(item).strip())
        title = name or (f"{event_type.replace('-', ' ').title()} — {road_label}" if road_label else event_type.replace("-", " ").title())
        geometry = feature.get("geometry") if isinstance(feature.get("geometry"), dict) else {}

        events.append(EventRecord(
            id=stable_id(SOURCE.id, source_record_id),
            source_id=SOURCE.id,
            source_record_id=source_record_id,
            category="road-work-zone",
            title=title,
            summary=str(core.get("description") or "").strip() or None,
            observed_at=observed_at,
            updated_at=update_date,
            location=location,
            severity=None,
            quality_score=1.0,
            properties={
                "event_type": event_type,
                "data_source_id": core.get("data_source_id"),
                "road_names": road_names,
                "direction": core.get("direction"),
                "creation_date": creation_date.isoformat() if creation_date else None,
                "update_date": update_date.isoformat() if update_date else None,
                "start_date": start_date.isoformat() if start_date else None,
                "end_date": _parse_datetime(properties.get("end_date")).isoformat() if _parse_datetime(properties.get("end_date")) else None,
                "vehicle_impact": properties.get("vehicle_impact"),
                "work_zone_type": properties.get("work_zone_type"),
                "geometry_type": geometry.get("type"),
                "geometry_preserved_in_raw_acquisition": True,
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"features[{index}]",
                note="Observed from a configured public WZDx road-event feature. Source geometry semantics are preserved; the displayed point is only the first source coordinate and no safety severity is inferred.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    allowed_hosts = _allowed_hosts(os.getenv("WZDX_ALLOWED_HOSTS", ""))
    url = _validated_url(os.getenv("WZDX_FEED_URL", ""), allowed_hosts)
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat(), url)
    request = Request(url, headers={"Accept": "application/geo+json, application/json", "User-Agent": "solari-osint-operations-center/0.13"})
    opener = build_opener(_AllowlistedRedirectHandler(allowed_hosts))
    with opener.open(request, timeout=timeout_seconds) as response:  # nosec B310 - HTTPS host is explicitly operator-allowlisted; redirects are revalidated
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("WZDx response exceeds 10 MiB safety limit")
        final_url = _validated_url(response.geturl(), allowed_hosts)
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=url,
            final_url=final_url,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw), "configured_host": urlparse(url).hostname},
        )
    parser_started = time.perf_counter()
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("WZDx response must be an object")
    events = normalize(payload, acquisition.id)
    received = len(payload.get("features", [])) if isinstance(payload.get("features"), list) else 0
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": received,
        "records_accepted": len(events),
        "records_rejected": max(0, received - len(events)),
    })
    return acquisition, events
