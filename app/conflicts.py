from __future__ import annotations

from typing import Any, Iterable

from app.contracts import EventRecord

DEFAULT_FIELDS = ("title", "summary", "severity", "observed_at", "updated_at", "location")


def _value(event: EventRecord, field: str) -> Any:
    value = getattr(event, field)
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def field_conflicts(
    events: Iterable[EventRecord],
    *,
    fields: Iterable[str] = DEFAULT_FIELDS,
    source_reliability: dict[str, float] | None = None,
    authoritative_threshold: float = 0.8,
) -> list[dict[str, object]]:
    """Describe disagreements while preserving every source value and provenance."""
    items = list(events)
    reliability = source_reliability or {}
    output: list[dict[str, object]] = []
    for field in fields:
        candidates = []
        distinct: list[Any] = []
        for event in items:
            value = _value(event, field)
            if value is None:
                continue
            if value not in distinct:
                distinct.append(value)
            candidates.append({
                "event_id": event.id,
                "source_id": event.source_id,
                "value": value,
                "quality_score": event.quality_score,
                "source_reliability": reliability.get(event.source_id),
                "evidence": [reference.model_dump(mode="json") for reference in event.evidence if reference.field in {"*", field}],
            })
        if len(distinct) <= 1:
            continue
        authoritative_sources = {
            str(candidate["source_id"])
            for candidate in candidates
            if candidate["source_reliability"] is not None and float(candidate["source_reliability"]) >= authoritative_threshold
        }
        authoritative_values = {
            repr(candidate["value"])
            for candidate in candidates
            if str(candidate["source_id"]) in authoritative_sources
        }
        output.append({
            "field": field,
            "conflict": True,
            "authoritative_conflict": len(authoritative_values) > 1,
            "candidates": candidates,
        })
    return output


def preferred_field_value(
    events: Iterable[EventRecord],
    field: str,
    *,
    source_reliability: dict[str, float] | None = None,
) -> dict[str, object] | None:
    """Choose a deterministic preferred display value while retaining alternatives.

    The score is explicit: source reliability (default 0.5) multiplied by the
    record quality score. This is presentation guidance, never a destructive merge.
    """
    reliability = source_reliability or {}
    candidates: list[dict[str, object]] = []
    for event in events:
        value = _value(event, field)
        if value is None:
            continue
        source_score = max(0.0, min(1.0, float(reliability.get(event.source_id, 0.5))))
        score = source_score * event.quality_score
        candidates.append({
            "event_id": event.id,
            "source_id": event.source_id,
            "value": value,
            "score": score,
            "source_reliability": source_score,
            "quality_score": event.quality_score,
            "evidence": [reference.model_dump(mode="json") for reference in event.evidence if reference.field in {"*", field}],
        })
    if not candidates:
        return None
    candidates.sort(key=lambda item: (-float(item["score"]), str(item["source_id"]), str(item["event_id"])))
    return {"field": field, "preferred": candidates[0], "alternatives": candidates[1:], "destructive_merge": False}
