import pytest

from app.solari.sandbox import MAX_STATEFUL_STEPS, build_geospatial_enrichment_program, build_json_transform_program


def test_json_transform_program_uses_serialized_payload():
    program = build_json_transform_program({"items": [1, 2, 3]}, "sum(data['items'])")
    assert "json.loads" in program
    assert "sum(data['items'])" in program


def test_geospatial_enrichment_program_is_bounded_and_deterministic():
    program = build_geospatial_enrichment_program([
        {"latitude": 47.6, "longitude": -122.3},
        {"latitude": 49.28, "longitude": -123.12},
    ])
    namespace = {}
    output = []
    namespace["print"] = lambda value: output.append(value)
    exec(program, namespace, namespace)
    assert output and "total_distance_km" in output[-1]
    with pytest.raises(ValueError):
        build_geospatial_enrichment_program([{"latitude": 47.6, "longitude": -122.3}])
    with pytest.raises(ValueError):
        build_geospatial_enrichment_program([{"latitude": 91, "longitude": 0}, {"latitude": 0, "longitude": 0}])


def test_stateful_step_limit_is_deliberately_small():
    assert MAX_STATEFUL_STEPS == 20
