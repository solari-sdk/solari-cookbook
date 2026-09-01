from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from urllib.request import Request, urlopen

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, SourceDescriptor, stable_id, utc_now

SOURCE = SourceDescriptor(
    id="fema-disaster-declarations",
    name="OpenFEMA Disaster Declarations Summaries",
    category="disaster-declaration",
    authoritative_url="https://www.fema.gov/about/openfema/disaster-declarations-summaries",
    method=AcquisitionMethod.API,
    poll_interval_seconds=1200,
    license_note="Public OpenFEMA government dataset; preserve FEMA attribution and current OpenFEMA terms/citation guidance.",
    capabilities=["events", "public-api", "government", "deterministic-normalization"],
    depends_on=[],
)
DEFAULT_URL = "https://www.fema.gov/api/open/v1/DisasterDeclarationsSummaries?$orderby=declarationDate%20desc&$top=100"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def _datetime(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("OpenFEMA declaration is missing a declaration timestamp")
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def normalize(payload: dict[str, Any], acquisition_id: str) -> list[EventRecord]:
    rows = payload.get("DisasterDeclarationsSummaries")
    if not isinstance(rows, list):
        raise ValueError("OpenFEMA response is missing DisasterDeclarationsSummaries")
    events: list[EventRecord] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        declaration_number = row.get("disasterNumber")
        title = str(row.get("declarationTitle") or row.get("title") or "FEMA disaster declaration").strip()
        state = str(row.get("state") or "").strip()
        area = str(row.get("designatedArea") or row.get("declaredCountyArea") or "").strip()
        record_id = str(row.get("id") or row.get("hash") or stable_id(declaration_number, state, area, row.get("declarationDate")))
        observed_at = _datetime(row.get("declarationDate") or row.get("incidentBeginDate"))
        last_refresh = row.get("lastRefresh")
        updated_at = _datetime(last_refresh) if last_refresh else None
        location_text = ", ".join(part for part in (area, state) if part)
        display_title = f"{title} — {location_text}" if location_text else title
        events.append(EventRecord(
            id=stable_id(SOURCE.id, record_id),
            source_id=SOURCE.id,
            source_record_id=record_id,
            category="disaster-declaration",
            title=display_title[:500],
            summary=str(row.get("incidentType") or row.get("declarationType") or "Federal disaster declaration"),
            observed_at=observed_at,
            updated_at=updated_at,
            quality_score=1.0,
            properties={
                "disaster_number": declaration_number,
                "state": state or None,
                "designated_area": area or None,
                "incident_type": row.get("incidentType"),
                "declaration_type": row.get("declarationType"),
                "incident_begin_date": row.get("incidentBeginDate"),
                "incident_end_date": row.get("incidentEndDate"),
                "fema_programs": {
                    "individual_assistance": row.get("individualAssistanceProgram"),
                    "individual_households": row.get("ihProgramDeclared"),
                    "public_assistance": row.get("paProgramDeclared"),
                    "hazard_mitigation": row.get("hmProgramDeclared"),
                },
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"DisasterDeclarationsSummaries[{index}]",
                note="Observed in the public OpenFEMA disaster declaration dataset.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"Accept": "application/json", "User-Agent": "solari-osint-operations-center/0.12"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed OpenFEMA HTTPS public source
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("OpenFEMA response exceeds 4 MiB safety limit")
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
    payload = json.loads(raw)
    events = normalize(payload, acquisition_id)
    received = len(payload.get("DisasterDeclarationsSummaries", [])) if isinstance(payload, dict) else 0
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": received,
        "records_accepted": len(events),
        "records_rejected": max(0, received - len(events)),
    })
    return acquisition, events
