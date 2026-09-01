from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from math import exp, log
from typing import Iterable

from app.contracts import EntityRecord, RelationshipRecord

_SPACE = re.compile(r"\s+")
_NON_WORD = re.compile(r"[^\w@.+:-]+", re.UNICODE)


def canonical_text(value: str) -> str:
    """Return a conservative, language-preserving canonical comparison form."""
    normalized = unicodedata.normalize("NFKC", value).casefold().strip()
    normalized = _NON_WORD.sub(" ", normalized)
    return _SPACE.sub(" ", normalized).strip()


def canonical_entity(entity: EntityRecord) -> dict[str, object]:
    aliases = sorted({canonical_text(value) for value in [entity.label, *entity.aliases] if canonical_text(value)})
    return {
        "id": entity.id,
        "type": canonical_text(entity.type),
        "canonical_label": canonical_text(entity.label),
        "canonical_aliases": aliases,
    }


def resolve_alias(query: str, entities: Iterable[EntityRecord]) -> list[EntityRecord]:
    needle = canonical_text(query)
    if not needle:
        return []
    matches = []
    for entity in entities:
        canonical = canonical_entity(entity)
        if needle in canonical["canonical_aliases"]:
            matches.append(entity)
    return sorted(matches, key=lambda item: (item.type, canonical_text(item.label), item.id))


def suggest_entity_duplicates(entities: Iterable[EntityRecord], *, minimum_score: float = 0.8) -> list[dict[str, object]]:
    """Return explainable duplicate candidates without merging anything.

    Suggestions are limited to entities of the same type. Exact canonical labels
    score 1.0; alias overlap scores 0.9. Location/properties are intentionally not
    used as hidden inference signals in this conservative baseline.
    """
    items = list(entities)
    suggestions: list[dict[str, object]] = []
    for index, left in enumerate(items):
        left_c = canonical_entity(left)
        left_aliases = set(left_c["canonical_aliases"])
        for right in items[index + 1:]:
            right_c = canonical_entity(right)
            if left_c["type"] != right_c["type"]:
                continue
            right_aliases = set(right_c["canonical_aliases"])
            shared = sorted(left_aliases & right_aliases)
            if not shared:
                continue
            exact = left_c["canonical_label"] == right_c["canonical_label"]
            score = 1.0 if exact else 0.9
            if score < minimum_score:
                continue
            suggestions.append({
                "left_entity_id": left.id,
                "right_entity_id": right.id,
                "score": score,
                "reason": "canonical-label-match" if exact else "alias-overlap",
                "shared_aliases": shared,
            })
    return sorted(suggestions, key=lambda item: (-float(item["score"]), str(item["left_entity_id"]), str(item["right_entity_id"])))


def decayed_relationship_confidence(
    relationship: RelationshipRecord,
    *,
    now: datetime | None = None,
    half_life_days: float = 365.0,
) -> dict[str, object]:
    """Apply an explicit age-based confidence decay without mutating evidence."""
    if half_life_days <= 0:
        raise ValueError("half_life_days must be positive")
    now = now or datetime.now(timezone.utc)
    seen = relationship.last_seen or relationship.first_seen
    if seen is None:
        return {"relationship_id": relationship.id, "base_confidence": relationship.confidence, "effective_confidence": relationship.confidence, "age_days": None, "stale": False}
    if seen.tzinfo is None:
        seen = seen.replace(tzinfo=timezone.utc)
    age_days = max(0.0, (now - seen).total_seconds() / 86400.0)
    factor = exp(-log(2.0) * age_days / half_life_days)
    effective = max(0.0, min(1.0, relationship.confidence * factor))
    return {
        "relationship_id": relationship.id,
        "base_confidence": relationship.confidence,
        "effective_confidence": effective,
        "age_days": age_days,
        "half_life_days": half_life_days,
        "stale": age_days >= half_life_days,
    }
