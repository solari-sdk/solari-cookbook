from __future__ import annotations

import json
from pathlib import Path

from app.contracts import EventRecord
from app.storage import DB_PATH, list_events


def event_models(limit: int = 5000, *, path: Path = DB_PATH) -> list[EventRecord]:
    if limit < 1 or limit > 5000:
        raise ValueError("limit must be between 1 and 5000")
    output: list[EventRecord] = []
    for row in list_events(limit=limit, path=path):
        output.append(EventRecord(
            id=str(row["id"]),
            source_id=str(row["source_id"]),
            source_record_id=str(row["source_record_id"]),
            category=str(row["category"]),
            title=str(row["title"]),
            summary=row["summary"],
            observed_at=row["observed_at"],
            updated_at=row["updated_at"],
            location={
                "latitude": row["latitude"],
                "longitude": row["longitude"],
                "precision": row["geo_precision"],
            } if row["latitude"] is not None and row["longitude"] is not None else None,
            severity=row["severity"],
            quality_score=float(row["quality_score"]),
            properties=json.loads(str(row["properties_json"])),
            evidence=json.loads(str(row["evidence_json"])),
        ))
    return output
