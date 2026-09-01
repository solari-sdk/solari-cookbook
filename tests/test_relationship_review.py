from datetime import datetime, timezone

import pytest

from app.contracts import EntityRecord, RelationshipRecord
from app.relationship_review import auto_alias_relationships, label_relationship_hypothesis, review_inferred_relationship


def test_alias_rule_creates_explainable_reviewable_inference():
    entities = [
        EntityRecord(id="a", type="organization", label="Example Labs", aliases=["Example-Labs"]),
        EntityRecord(id="b", type="organization", label="Example-Labs", aliases=["Example Labs"]),
    ]
    relationships = auto_alias_relationships(entities)
    assert len(relationships) == 1
    relationship = relationships[0]
    assert relationship.observed is False
    assert relationship.type == "possible_same_as"
    assert relationship.properties["review_status"] == "pending"
    assert relationship.properties["rule_id"] == "alias-correlation-v1"
    assert relationship.properties["explanation"]

    accepted = review_inferred_relationship(relationship, "accepted", note="Reviewed public evidence", reviewed_at=datetime(2026, 9, 1, tzinfo=timezone.utc))
    assert accepted.properties["review_status"] == "accepted"
    assert accepted.observed is False
    relabeled = label_relationship_hypothesis(accepted, "alternate-hypothesis")
    assert relabeled.properties["hypothesis_label"] == "alternate-hypothesis"


def test_observed_relationship_cannot_be_reclassified_as_inference_review():
    observed = RelationshipRecord(id="r", source_entity_id="a", target_entity_id="b", type="observed", observed=True)
    with pytest.raises(ValueError):
        review_inferred_relationship(observed, "rejected")
    with pytest.raises(ValueError):
        label_relationship_hypothesis(observed, "hypothesis")
