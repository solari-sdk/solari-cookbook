from datetime import datetime, timedelta, timezone

from app.contracts import EventRecord, GeoPoint
from app.correlation import correlate_events, title_similarity


def event(identifier: str, source: str, minute: int, lon: float, title: str = "M5 earthquake near Sample City") -> EventRecord:
    return EventRecord(
        id=identifier,
        source_id=source,
        source_record_id=identifier,
        category="earthquake",
        title=title,
        observed_at=datetime(2026, 9, 1, 0, minute, tzinfo=timezone.utc),
        location=GeoPoint(latitude=10, longitude=lon),
    )


def test_title_similarity_is_deterministic() -> None:
    assert title_similarity("Earthquake near Sample City", "Earthquake at Sample City") > 0.5


def test_cross_source_candidates_preserve_explanation() -> None:
    events = [event("a", "source-a", 0, 20), event("b", "source-b", 2, 20.05)]
    candidates = correlate_events(events, max_time_seconds=600, max_distance_km=20, min_score=0.5)
    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.left_event_id == "a"
    assert candidate.right_event_id == "b"
    assert candidate.distance_km is not None and candidate.distance_km < 20
    assert any(reason.startswith("time=") for reason in candidate.reasons)
    assert any(reason.startswith("location=") for reason in candidate.reasons)


def test_same_source_and_distant_events_are_not_correlated() -> None:
    assert correlate_events([event("a", "same", 0, 20), event("b", "same", 1, 20.01)]) == []
    assert correlate_events([event("a", "one", 0, 20), event("b", "two", 1, 60)], max_distance_km=10) == []
