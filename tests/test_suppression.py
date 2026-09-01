from app.suppression import SuppressionRule, correlation_suppression, filter_unsuppressed


def candidate(left="e1", right="e2", left_source="a", right_source="b"):
    return {"left_event_id": left, "right_event_id": right, "left_source_id": left_source, "right_source_id": right_source, "left_category": "weather", "right_category": "weather"}


def test_suppression_is_order_independent_and_explainable():
    rule = SuppressionRule("r1", "event-pair", "e2", "e1", "known duplicate pair")
    decision = correlation_suppression(candidate(), [rule])
    assert decision["suppressed"] is True
    assert decision["matches"][0]["reason"] == "known duplicate pair"
    assert decision["candidate"]["left_event_id"] == "e1"


def test_filter_preserves_suppressed_candidates_for_review():
    rule = SuppressionRule("sources", "source-pair", "a", "b", "redundant feeds")
    result = filter_unsuppressed([candidate(), candidate("e3", "e4", "a", "c")], [rule])
    assert len(result["kept"]) == 1
    assert len(result["suppressed"]) == 1
