from datetime import datetime, timezone

from app.conflicts import field_conflicts, preferred_field_value
from app.contracts import EventRecord, EvidenceKind, EvidenceReference


def _event(event_id: str, source_id: str, title: str, quality: float):
    return EventRecord(
        id=event_id, source_id=source_id, source_record_id=event_id, category="test", title=title,
        observed_at=datetime(2026, 9, 1, tzinfo=timezone.utc), quality_score=quality,
        evidence=[EvidenceReference(acquisition_id=f"acq-{event_id}", field="title", kind=EvidenceKind.OBSERVED, source_path="$.title")],
    )


def test_field_conflict_preserves_candidates_and_flags_authoritative_disagreement():
    events = [_event("a", "source-a", "Alpha", 0.9), _event("b", "source-b", "Bravo", 1.0)]
    conflicts = field_conflicts(events, fields=["title"], source_reliability={"source-a": 0.9, "source-b": 0.95})
    assert conflicts[0]["field"] == "title"
    assert conflicts[0]["authoritative_conflict"] is True
    assert {item["value"] for item in conflicts[0]["candidates"]} == {"Alpha", "Bravo"}
    assert all(item["evidence"] for item in conflicts[0]["candidates"])


def test_preferred_value_uses_explicit_score_without_destroying_alternatives():
    events = [_event("a", "source-a", "Alpha", 1.0), _event("b", "source-b", "Bravo", 0.8)]
    result = preferred_field_value(events, "title", source_reliability={"source-a": 0.7, "source-b": 1.0})
    assert result is not None
    assert result["preferred"]["value"] == "Bravo"
    assert result["alternatives"][0]["value"] == "Alpha"
    assert result["destructive_merge"] is False
