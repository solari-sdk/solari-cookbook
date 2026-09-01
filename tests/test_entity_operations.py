from datetime import datetime, timezone

import pytest

from app.contracts import EntityRecord
from app.entity_operations import merge_entities, split_entity


def test_merge_and_split_preserve_audit_history():
    now = datetime(2026, 9, 1, tzinfo=timezone.utc)
    left = EntityRecord(id="a", type="organization", label="Example Labs", aliases=["Example"], confidence=0.7)
    right = EntityRecord(id="b", type="organization", label="Example-Labs", aliases=["Example"], confidence=0.9)
    merged, audit = merge_entities([right, left], reason="Reviewed alias collision", canonical_label="Example Labs", at=now)
    assert merged.properties["merge_lineage"] == ["a", "b"]
    assert merged.confidence == 0.9
    assert audit.action == "merge"
    assert audit.source_entity_ids == ("a", "b")
    assert audit.before[0]["id"] == "a"

    parts, split_audit = split_entity(merged, [{"id": "a2", "label": "Example Labs North"}, {"id": "b2", "label": "Example Labs South"}], reason="Distinct public records", at=now)
    assert {item.properties["split_from"] for item in parts} == {merged.id}
    assert split_audit.action == "split"
    assert split_audit.result_entity_ids == ("a2", "b2")
    assert len(split_audit.after) == 2


def test_merge_rejects_cross_type_entities():
    with pytest.raises(ValueError):
        merge_entities([EntityRecord(id="a", type="organization", label="A"), EntityRecord(id="b", type="location", label="B")], reason="invalid")
