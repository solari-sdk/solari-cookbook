from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Literal

from app.contracts import EntityRecord, RelationshipRecord, stable_id
from app.entity_resolution import suggest_entity_duplicates

ReviewDecision = Literal["accepted", "rejected"]


def auto_alias_relationships(
    entities: Iterable[EntityRecord],
    *,
    minimum_score: float = 0.9,
    hypothesis_label: str = "possible-same-entity",
) -> list[RelationshipRecord]:
    """Create reviewable, non-observed relationship hypotheses from alias rules."""
    suggestions = suggest_entity_duplicates(entities, minimum_score=minimum_score)
    now = datetime.now(timezone.utc)
    output: list[RelationshipRecord] = []
    for suggestion in suggestions:
        left = str(suggestion["left_entity_id"])
        right = str(suggestion["right_entity_id"])
        output.append(RelationshipRecord(
            id=stable_id("alias-correlation", *sorted((left, right))),
            source_entity_id=left,
            target_entity_id=right,
            type="possible_same_as",
            first_seen=now,
            last_seen=now,
            confidence=float(suggestion["score"]),
            observed=False,
            properties={
                "rule_id": "alias-correlation-v1",
                "review_status": "pending",
                "hypothesis_label": hypothesis_label,
                "reason": suggestion["reason"],
                "shared_aliases": list(suggestion["shared_aliases"]),
                "explanation": "Same-type entities share a canonical label or alias; no merge has occurred.",
            },
        ))
    return output


def review_inferred_relationship(
    relationship: RelationshipRecord,
    decision: ReviewDecision,
    *,
    note: str = "",
    reviewed_at: datetime | None = None,
) -> RelationshipRecord:
    if relationship.observed:
        raise ValueError("observed relationships are not inference-review candidates")
    if relationship.properties.get("review_status") not in {None, "pending", "accepted", "rejected"}:
        raise ValueError("unsupported relationship review state")
    reviewed_at = reviewed_at or datetime.now(timezone.utc)
    properties = dict(relationship.properties)
    properties.update({
        "review_status": decision,
        "review_note": note,
        "reviewed_at": reviewed_at.isoformat(),
    })
    return relationship.model_copy(update={"properties": properties, "last_seen": reviewed_at})


def label_relationship_hypothesis(relationship: RelationshipRecord, label: str) -> RelationshipRecord:
    if relationship.observed:
        raise ValueError("hypothesis labels apply only to inferred relationships")
    label = label.strip()
    if not label:
        raise ValueError("hypothesis label is required")
    properties = dict(relationship.properties)
    properties["hypothesis_label"] = label
    return relationship.model_copy(update={"properties": properties})
