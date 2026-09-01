from datetime import datetime, timezone

from app.contracts import EventRecord, EvidenceKind, EvidenceReference, GeoPoint
from app.entities import derive_graph


def test_graph_projection_is_deterministic_and_evidence_backed() -> None:
    event = EventRecord(
        id="event-1",
        source_id="fixture-source",
        source_record_id="source-1",
        category="test",
        title="Fixture",
        observed_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
        location=GeoPoint(latitude=10, longitude=20, precision="fixture"),
        evidence=[EvidenceReference(acquisition_id="acq-1", field="*", kind=EvidenceKind.OBSERVED)],
    )
    entities, relationships = derive_graph([event])
    assert {entity.type for entity in entities} == {"event", "source", "location"}
    assert {relationship.type for relationship in relationships} == {"reported_by", "occurred_at"}
    assert all(relationship.observed for relationship in relationships)
    assert all(relationship.evidence for relationship in relationships)
    entities_again, relationships_again = derive_graph([event])
    assert [item.id for item in entities] == [item.id for item in entities_again]
    assert [item.id for item in relationships] == [item.id for item in relationships_again]
