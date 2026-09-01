from __future__ import annotations

import json
from pathlib import Path

from app.contracts import EntityRecord, RelationshipRecord
from app.storage import DB_PATH, list_entities, list_relationships


def entity_models(limit: int = 5000, *, path: Path = DB_PATH) -> list[EntityRecord]:
    output=[]
    for row in list_entities(limit=limit, path=path):
        output.append(EntityRecord(
            id=str(row["id"]), type=str(row["type"]), label=str(row["label"]),
            aliases=json.loads(str(row["aliases_json"])), first_seen=row["first_seen"], last_seen=row["last_seen"],
            location={"latitude": row["latitude"], "longitude": row["longitude"], "precision": row["geo_precision"]} if row["latitude"] is not None and row["longitude"] is not None else None,
            confidence=float(row["confidence"]), properties=json.loads(str(row["properties_json"])), evidence=json.loads(str(row["evidence_json"])),
        ))
    return output


def relationship_models(limit: int = 5000, *, path: Path = DB_PATH) -> list[RelationshipRecord]:
    output=[]
    for row in list_relationships(limit=limit, path=path):
        output.append(RelationshipRecord(
            id=str(row["id"]), source_entity_id=str(row["source_entity_id"]), target_entity_id=str(row["target_entity_id"]),
            type=str(row["type"]), first_seen=row["first_seen"], last_seen=row["last_seen"], confidence=float(row["confidence"]),
            observed=bool(row["observed"]), properties=json.loads(str(row["properties_json"])), evidence=json.loads(str(row["evidence_json"])),
        ))
    return output
