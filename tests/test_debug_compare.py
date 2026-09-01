from app.debug_compare import compare_raw_normalized


def test_raw_normalized_comparison_preserves_values_and_missing_state():
    raw={"properties":{"title":"Source title","magnitude":4.2}}
    normalized={"title":"Normalized title","properties":{"magnitude":4.2}}
    rows=compare_raw_normalized(raw,normalized,{"title":"properties.title","properties.magnitude":"properties.magnitude","summary":"properties.summary"})
    by_field={row["normalized_field"]:row for row in rows}
    assert by_field["title"]["changed"] is True
    assert by_field["properties.magnitude"]["changed"] is False
    assert by_field["summary"]["raw_missing"] is True
    assert by_field["summary"]["normalized_missing"] is True
