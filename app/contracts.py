from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from hashlib import sha256
from typing import Any, Literal

from pydantic import BaseModel, Field, HttpUrl


class AcquisitionMethod(str, Enum):
    API = "api"
    FEED = "feed"
    BROWSER = "browser"
    DESKTOP = "desktop"


class EvidenceKind(str, Enum):
    OBSERVED = "observed"
    TRANSFORMED = "transformed"
    INFERRED = "inferred"


class GeoPoint(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    precision: str | None = None


class SourceDescriptor(BaseModel):
    id: str
    name: str
    category: str
    authoritative_url: HttpUrl
    method: AcquisitionMethod
    poll_interval_seconds: int | None = Field(default=None, ge=1)
    license_note: str | None = None


class AcquisitionEnvelope(BaseModel):
    id: str
    source_id: str
    method: AcquisitionMethod
    requested_url: HttpUrl
    final_url: HttpUrl | None = None
    started_at: datetime
    completed_at: datetime
    status: Literal["success", "failure"]
    http_status: int | None = None
    content_type: str | None = None
    content_sha256: str | None = None
    error_type: str | None = None
    error_message: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvidenceReference(BaseModel):
    acquisition_id: str
    field: str
    kind: EvidenceKind
    source_path: str | None = None
    note: str | None = None


class EventRecord(BaseModel):
    id: str
    source_id: str
    source_record_id: str
    category: str
    title: str
    summary: str | None = None
    observed_at: datetime
    updated_at: datetime | None = None
    location: GeoPoint | None = None
    severity: str | None = None
    quality_score: float = Field(default=1.0, ge=0.0, le=1.0)
    properties: dict[str, Any] = Field(default_factory=dict)
    evidence: list[EvidenceReference] = Field(default_factory=list)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def stable_id(*parts: object) -> str:
    canonical = "|".join(str(part) for part in parts)
    return sha256(canonical.encode("utf-8")).hexdigest()
