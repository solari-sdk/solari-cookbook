from __future__ import annotations

import json
from hashlib import sha256
from typing import Any
from urllib.request import Request, urlopen

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, SourceDescriptor, stable_id, utc_now

SOURCE = SourceDescriptor(
    id="swpc-alerts",
    name="NOAA Space Weather Prediction Center",
    category="space-weather",
    authoritative_url="https://services.swpc.noaa.gov/",
    method=AcquisitionMethod.API,
    poll_interval_seconds=300,
    license_note="Public NOAA space-weather products.",
)
DEFAULT_FEED = "https://services.swpc.noaa.gov/products/alerts.json"


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now(); acquisition_id = stable_id(SOURCE.id, started.isoformat())
    req = Request(DEFAULT_FEED, headers={"User-Agent": "solari-osint-operations-center/0.3"})
    with urlopen(req, timeout=timeout_seconds) as response:  # nosec B310 - fixed HTTPS public source
        raw = response.read(); payload: list[dict[str, Any]] = json.loads(raw); completed = utc_now()
        acquisition = AcquisitionEnvelope(id=acquisition_id, source_id=SOURCE.id, method=SOURCE.method, requested_url=DEFAULT_FEED, final_url=response.geturl(), started_at=started, completed_at=completed, status="success", http_status=getattr(response, "status", 200), content_type=response.headers.get("Content-Type"), content_sha256=sha256(raw).hexdigest())
    events: list[EventRecord] = []
    for item in payload:
        product_id = str(item.get("product_id") or stable_id(item.get("issue_datetime"), item.get("message")))
        issued = item.get("issue_datetime")
        if not issued:
            continue
        message = (item.get("message") or "").strip()
        title = message.splitlines()[0][:180] if message else f"Space weather product {product_id}"
        events.append(EventRecord(id=stable_id(SOURCE.id, product_id), source_id=SOURCE.id, source_record_id=product_id, category="space-weather", title=title, summary=message[:2000] or None, observed_at=issued, quality_score=1.0, properties={"product_id": product_id}, evidence=[EvidenceReference(acquisition_id=acquisition_id, field="*", kind=EvidenceKind.OBSERVED, source_path=f"product_id={product_id}", note="Observed in NOAA SWPC public alert product feed.")]))
    return acquisition, events
