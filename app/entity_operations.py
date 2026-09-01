from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Iterable

from app.contracts import EntityRecord, stable_id


@dataclass(frozen=True, slots=True)
class EntityAuditEntry:
    action: str
    at: str
    source_entity_ids: tuple[str, ...]
    result_entity_ids: tuple[str, ...]
    reason: str
    before: tuple[dict[str, object], ...]
    after: tuple[dict[str, object], ...]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _moment_min(values):
    items = [value for value in values if value is not None]
    return min(items) if items else None


def _moment_max(values):
    items = [value for value in values if value is not None]
    return max(items) if items else None


def merge_entities(
    entities: Iterable[EntityRecord],
    *,
    reason: str,
    canonical_label: str | None = None,
    merged_id: str | None = None,
    at: datetime | None = None,
) -> tuple[EntityRecord, EntityAuditEntry]:
    items = list(entities)
    if len(items) < 2:
        raise ValueError("merge requires at least two entities")
    if len({item.type for item in items}) != 1:
        raise ValueError("only entities of the same type may be merged")
    reason = reason.strip()
    if not reason:
        raise ValueError("merge reason is required")
    at = at or datetime.now(timezone.utc)
    ordered = sorted(items, key=lambda item: item.id)
    label = (canonical_label or ordered[0].label).strip()
    if not label:
        raise ValueError("canonical label is required")
    aliases = sorted({value for item in ordered for value in [item.label, *item.aliases] if value and value != label})
    result_id = merged_id or stable_id("entity-merge", *(item.id for item in ordered), label)
    properties = dict(ordered[0].properties)
    properties["merge_lineage"] = [item.id for item in ordered]
    properties["merge_reason"] = reason
    merged = EntityRecord(
        id=result_id,
        type=ordered[0].type,
        label=label,
        aliases=aliases,
        first_seen=_moment_min(item.first_seen for item in ordered),
        last_seen=_moment_max(item.last_seen for item in ordered),
        location=next((item.location for item in ordered if item.location is not None), None),
        confidence=max(item.confidence for item in ordered),
        properties=properties,
        evidence=[evidence for item in ordered for evidence in item.evidence],
    )
    audit = EntityAuditEntry(
        action="merge",
        at=at.isoformat(),
        source_entity_ids=tuple(item.id for item in ordered),
        result_entity_ids=(merged.id,),
        reason=reason,
        before=tuple(item.model_dump(mode="json") for item in ordered),
        after=(merged.model_dump(mode="json"),),
    )
    return merged, audit


def split_entity(
    entity: EntityRecord,
    parts: Iterable[dict[str, object]],
    *,
    reason: str,
    at: datetime | None = None,
) -> tuple[list[EntityRecord], EntityAuditEntry]:
    specs = list(parts)
    if len(specs) < 2:
        raise ValueError("split requires at least two result entities")
    reason = reason.strip()
    if not reason:
        raise ValueError("split reason is required")
    at = at or datetime.now(timezone.utc)
    output: list[EntityRecord] = []
    for index, spec in enumerate(specs):
        label = str(spec.get("label") or "").strip()
        if not label:
            raise ValueError("every split result requires a label")
        result_id = str(spec.get("id") or stable_id("entity-split", entity.id, index, label))
        properties = dict(entity.properties)
        properties.update(dict(spec.get("properties") or {}))
        properties["split_from"] = entity.id
        properties["split_reason"] = reason
        output.append(EntityRecord(
            id=result_id,
            type=str(spec.get("type") or entity.type),
            label=label,
            aliases=list(spec.get("aliases") or []),
            first_seen=entity.first_seen,
            last_seen=entity.last_seen,
            location=spec.get("location") or entity.location,
            confidence=float(spec.get("confidence", entity.confidence)),
            properties=properties,
            evidence=list(entity.evidence),
        ))
    audit = EntityAuditEntry(
        action="split",
        at=at.isoformat(),
        source_entity_ids=(entity.id,),
        result_entity_ids=tuple(item.id for item in output),
        reason=reason,
        before=(entity.model_dump(mode="json"),),
        after=tuple(item.model_dump(mode="json") for item in output),
    )
    return output, audit
