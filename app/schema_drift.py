from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True, slots=True)
class DriftReport:
    drift: bool
    missing_required: tuple[str, ...]
    unexpected_fields: tuple[str, ...]
    known_fields: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def detect_schema_drift(
    record: dict[str, Any],
    *,
    required_fields: Iterable[str],
    known_fields: Iterable[str],
    allow_additional: bool = False,
) -> DriftReport:
    required = set(required_fields)
    known = set(known_fields)
    keys = set(record)
    missing = tuple(sorted(required - keys))
    unexpected = tuple(sorted(keys - known)) if not allow_additional else ()
    return DriftReport(bool(missing or unexpected), missing, unexpected, tuple(sorted(known)))


def quarantine_record(
    record: dict[str, Any],
    report: DriftReport,
    *,
    source_id: str,
    root: Path,
) -> Path:
    if not report.drift:
        raise ValueError("only drifted records may be quarantined")
    if not source_id:
        raise ValueError("source_id is required")
    canonical = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = sha256(canonical).hexdigest()
    source_digest = sha256(source_id.encode("utf-8")).hexdigest()
    path = root / source_digest / f"{digest}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    envelope = {
        "source_id": source_id,
        "record_sha256": digest,
        "report": report.to_dict(),
        "record": record,
    }
    encoded = json.dumps(envelope, ensure_ascii=False, sort_keys=True, indent=2)
    if not path.exists():
        path.write_text(encoded, encoding="utf-8")
    return path
