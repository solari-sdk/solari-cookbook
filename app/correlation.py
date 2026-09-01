from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from itertools import combinations

from app.contracts import EventRecord
from app.geospatial import distance_km

_TOKEN = re.compile(r"[a-z0-9]+")
_STOP = {"a", "an", "and", "at", "for", "in", "of", "on", "the", "to"}


@dataclass(frozen=True, slots=True)
class CorrelationCandidate:
    left_event_id: str
    right_event_id: str
    score: float
    reasons: tuple[str, ...]
    time_delta_seconds: float
    distance_km: float | None
    title_similarity: float

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def _tokens(value: str) -> set[str]:
    return {token for token in _TOKEN.findall(value.lower()) if token not in _STOP}


def title_similarity(left: str, right: str) -> float:
    a, b = _tokens(left), _tokens(right)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def correlate_events(
    events: list[EventRecord], *, max_time_seconds: int = 3600,
    max_distance_km: float = 100.0, min_score: float = 0.6,
) -> list[CorrelationCandidate]:
    """Return explainable cross-source similarity candidates without auto-merging records.

    A candidate is only considered across different source IDs and matching event
    categories. Time, location, and title similarity are scored independently so
    analysts can see exactly why two records were suggested as related.
    """
    if max_time_seconds <= 0:
        raise ValueError("max_time_seconds must be positive")
    if max_distance_km <= 0:
        raise ValueError("max_distance_km must be positive")
    if not 0 <= min_score <= 1:
        raise ValueError("min_score must be between 0 and 1")

    output: list[CorrelationCandidate] = []
    for left, right in combinations(events, 2):
        if left.source_id == right.source_id or left.category != right.category:
            continue
        delta = abs((_aware(left.observed_at) - _aware(right.observed_at)).total_seconds())
        if delta > max_time_seconds:
            continue

        components: list[tuple[str, float]] = []
        time_score = max(0.0, 1.0 - delta / max_time_seconds)
        components.append(("time", time_score))

        similarity = title_similarity(left.title, right.title)
        components.append(("title", similarity))

        separation: float | None = None
        if left.location and right.location:
            separation = distance_km(left.location, right.location)
            if separation > max_distance_km:
                continue
            components.append(("location", max(0.0, 1.0 - separation / max_distance_km)))

        score = sum(value for _, value in components) / len(components)
        if score < min_score:
            continue
        reasons = tuple(f"{name}={value:.3f}" for name, value in components)
        output.append(CorrelationCandidate(
            left_event_id=left.id,
            right_event_id=right.id,
            score=round(score, 6),
            reasons=reasons,
            time_delta_seconds=delta,
            distance_km=round(separation, 6) if separation is not None else None,
            title_similarity=round(similarity, 6),
        ))
    return sorted(output, key=lambda item: (-item.score, item.left_event_id, item.right_event_id))
