from __future__ import annotations

import html
import re
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
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
    id="nhc-tropical-cyclones",
    name="NOAA National Hurricane Center Tropical Cyclone Products",
    category="tropical-cyclone",
    authoritative_url="https://www.nhc.noaa.gov/aboutrss.shtml",
    method=AcquisitionMethod.FEED,
    poll_interval_seconds=3600,
    license_note="Public NOAA/NWS National Hurricane Center RSS products; preserve NOAA/NHC attribution.",
    capabilities=["events", "public-feed", "rss", "deterministic-normalization"],
    depends_on=[],
)
DEFAULT_FEED = "https://www.nhc.noaa.gov/index-at.xml"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_TAG_RE = re.compile(r"<[^>]+>")


def _text(node: ET.Element, name: str) -> str:
    child = node.find(name)
    return (child.text or "").strip() if child is not None else ""


def _summary(value: str) -> str | None:
    if not value:
        return None
    clean = html.unescape(_TAG_RE.sub(" ", value))
    clean = " ".join(clean.split())
    return clean[:4000] or None


def normalize(raw_xml: bytes, acquisition_id: str) -> list[EventRecord]:
    """Normalize NHC basin RSS items into public-source event records.

    XML is bounded by the collector and active DTD/entity declarations are rejected
    before parsing. RSS descriptions remain inert text in the normalized model.
    """
    upper = raw_xml[:4096].upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise ValueError("NHC feed contains unsupported DTD/entity declarations")
    try:
        root = ET.fromstring(raw_xml)
    except ET.ParseError as exc:
        raise ValueError("invalid NHC RSS XML") from exc

    events: list[EventRecord] = []
    for index, item in enumerate(root.findall("./channel/item")):
        title = _text(item, "title")
        link = _text(item, "link")
        guid = _text(item, "guid")
        published = _text(item, "pubDate")
        description = _text(item, "description")
        if not title or not published:
            continue
        try:
            observed_at = parsedate_to_datetime(published)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid NHC RSS pubDate at item {index}") from exc
        if observed_at.tzinfo is None:
            observed_at = observed_at.replace(tzinfo=utc_now().tzinfo)
        record_id = guid or link or stable_id(title, published)
        events.append(EventRecord(
            id=stable_id(SOURCE.id, record_id),
            source_id=SOURCE.id,
            source_record_id=record_id,
            category="tropical-cyclone",
            title=title[:500],
            summary=_summary(description),
            observed_at=observed_at,
            quality_score=1.0,
            properties={"product_url": link or None, "guid": guid or None, "rss_pub_date": published},
            evidence=[EvidenceReference(
                acquisition_id=acquisition_id,
                field="*",
                kind=EvidenceKind.OBSERVED,
                source_path=f"rss/channel/item[{index + 1}]",
                note="Observed in NOAA/NHC public tropical cyclone RSS feed.",
            )],
        ))
    return events


def collect(timeout_seconds: int = 20) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
    started = utc_now()
    acquisition_id = stable_id(SOURCE.id, started.isoformat())
    request = Request(DEFAULT_FEED, headers={"Accept": "application/rss+xml, application/xml, text/xml", "User-Agent": "solari-osint-operations-center/0.10"})
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - fixed NOAA HTTPS public source
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("NHC RSS response exceeds 2 MiB safety limit")
        completed = utc_now()
        acquisition = AcquisitionEnvelope(
            id=acquisition_id,
            source_id=SOURCE.id,
            method=SOURCE.method,
            requested_url=DEFAULT_FEED,
            final_url=response.geturl(),
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=getattr(response, "status", 200),
            content_type=response.headers.get("Content-Type"),
            content_sha256=sha256(raw).hexdigest(),
            metadata={"response_bytes": len(raw), "basin": "Atlantic"},
        )
    parser_started = time.perf_counter()
    events = normalize(raw, acquisition_id)
    acquisition.metadata.update({
        "parser_duration_ms": (time.perf_counter() - parser_started) * 1000.0,
        "records_received": len(ET.fromstring(raw).findall("./channel/item")),
        "records_accepted": len(events),
        "records_rejected": 0,
    })
    return acquisition, events
