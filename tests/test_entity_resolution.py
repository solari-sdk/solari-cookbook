from datetime import datetime, timedelta, timezone

from app.contracts import EntityRecord, RelationshipRecord
from app.entity_resolution import canonical_text, decayed_relationship_confidence, resolve_alias, suggest_entity_duplicates


def test_canonical_alias_resolution_and_duplicate_suggestions():
    entities = [
        EntityRecord(id="a", type="organization", label="Example  Labs", aliases=["EXAMPLE-LABS"]),
        EntityRecord(id="b", type="organization", label="Example-Labs", aliases=["Example Labs"]),
        EntityRecord(id="c", type="location", label="Example Labs"),
    ]
    assert canonical_text("  EXAMPLE—LABS ") == "example labs"
    assert [item.id for item in resolve_alias("example labs", entities)] == ["a", "b", "c"]
    suggestions = suggest_entity_duplicates(entities)
    assert len(suggestions) == 1
    assert {suggestions[0]["left_entity_id"], suggestions[0]["right_entity_id"]} == {"a", "b"}
    assert suggestions[0]["score"] >= 0.9


def test_relationship_confidence_decay_is_explicit_and_non_mutating():
    now = datetime(2026, 9, 1, tzinfo=timezone.utc)
    relationship = RelationshipRecord(
        id="r1", source_entity_id="a", target_entity_id="b", type="related",
        last_seen=now - timedelta(days=365), confidence=0.8,
    )
    result = decayed_relationship_confidence(relationship, now=now, half_life_days=365)
    assert result["effective_confidence"] == 0.4
    assert result["stale"] is True
    assert relationship.confidence == 0.8
