from __future__ import annotations

import csv
import io
import time
from hashlib import sha256
from urllib.request import Request, urlopen

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, SourceDescriptor, stable_id, utc_now

SOURCE = SourceDescriptor(
    id="ofac-sdn",
    name="OFAC Specially Designated Nationals List",
    category="sanctions-listing",
    authoritative_url="https://ofac.treasury.gov/sanctions-list-service",
    method=AcquisitionMethod.FEED,
    poll_interval_seconds=3600,
    license_note="Official U.S. Treasury OFAC sanctions-list data. Use as a reference dataset and follow current OFAC guidance; a listing is not an independent identity-resolution conclusion.",
    capabilities=["entities", "public-feed", "sanctions", "csv", "deterministic-normalization"],
    depends_on=[],
)

DEFAULT_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV"
MAX_RESPONSE_BYTES = 25 * 1024 * 1024


def _value(value: str | None) -> str | None:
    if value is None:
        return None
    clean = value.strip()
    return None if clean in {"", "-0-"} else clean


def normalize(rows: list[list[str]], acquisition_id: str, observed_at) -> list[EventRecord]:
    events: list[EventRecord] = []
    for index, row in enumerate(rows):
        if len(row) < 4:
            continue
        ent_num = _value(row[0])
        name = _value(row[1])
        if not ent_num or not name or ent_num.lower() in {"ent_num", "ent num"}:
            continue
        sdn_type = _value(row[2])
        program = _value(row[3])
        title = _value(row[4]) if len(row) > 4 else None
        call_sign = _value(row[5]) if len(row) > 5 else None
        vessel_type = _value(row[6]) if len(row) > 6 else None
        tonnage = _value(row[7]) if len(row) > 7 else None
        grt = _value(row[8]) if len(row) > 8 else None
        vessel_flag = _value(row[9]) if len(row) > 9 else None
        vessel_owner = _value(row[10]) if len(row) > 10 else None
        remarks = _value(row[11]) if len(row) > 11 else None
        events.append(EventRecord(
            id=stable_id(SOURCE.id, ent_num),
            source_id=SOURCE.id,
            source_record_id=ent_num,
            category="sanctions-listing",
            title=f"OFAC SDN — {name}"[:500],
            summary=f"Official OFAC SDN list entry{f' ({sdn_type})' if sdn_type else ''}.",
            observed_at=observed_at,
            severity=None,
            quality_score=1.0,
            properties={
                "name": name,
                "sdn_type": sdn_type,
                "program": program,
                "title": title,
                "call_sign": call_sign,
                "vessel_type": vessel_type,
                "tonnage": tonnage,
                "gross_registered_tonnage": grt,
                "vessel_flag": vessel_flag,
                "vessel_owner": vessel_owner,
                "remarks": remarks,
                "identity_resolution_required": True,
            },
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"SDN.CSV.rows[{index}]",
                note="Observed in the official OFAC SDN CSV. Matching a separate person/entity to this listing requires independent identity resolution.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 30) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_URL, headers={"Accept": "text/csv", "User-Agent": "solari-osint-operations-center/0.13"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed official OFAC HTTPS source
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("OFAC SDN response exceeds 25 MiB safety limit")
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=DEFAULT_URL,
            final_url=None,
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw), "redirect_target_intentionally_not_persisted": True},
        )
    parser_started = time.perf_counter()
    text = raw.decode("utf-8-sig", errors="replace")
    rows = list(csv.reader(io.StringIO(text)))
    events = normalize(rows, acquisition.id, completed)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": len(rows),
        "records_accepted": len(events),
        "records_rejected": max(0, len(rows) - len(events)),
    })
    return acquisition, events
