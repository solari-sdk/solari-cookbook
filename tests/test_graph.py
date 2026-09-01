from datetime import datetime, timezone

from app.contracts import EntityRecord, GeoPoint, RelationshipRecord
from app.graph import connected_components, explain_path, filter_entities, neighborhood, shortest_path


def edges() -> list[RelationshipRecord]:
    return [
        RelationshipRecord(id="ab", source_entity_id="a", target_entity_id="b", type="linked"),
        RelationshipRecord(id="bc", source_entity_id="b", target_entity_id="c", type="linked"),
        RelationshipRecord(id="xy", source_entity_id="x", target_entity_id="y", type="linked"),
    ]


def test_neighborhood_and_shortest_path_are_bounded() -> None:
    nearby = neighborhood("a", edges(), depth=1)
    assert nearby["entity_ids"] == ["a", "b"]
    path = shortest_path("a", "c", edges())
    assert path is not None
    assert path["entity_ids"] == ["a", "b", "c"]
    assert [item["relationship_id"] for item in explain_path(path)] == ["ab", "bc"]
    assert shortest_path("a", "y", edges()) is None


def test_connected_components_and_entity_filters() -> None:
    assert connected_components(edges()) == [["a", "b", "c"], ["x", "y"]]
    moment = datetime(2026, 9, 1, tzinfo=timezone.utc)
    entities = [
        EntityRecord(id="a", type="location", label="A", first_seen=moment, location=GeoPoint(latitude=1, longitude=2)),
        EntityRecord(id="b", type="source", label="B", first_seen=moment),
    ]
    assert [item.id for item in filter_entities(entities, min_lat=0, max_lat=2, min_lon=1, max_lon=3)] == ["a"]
    assert [item.id for item in filter_entities(entities, start=moment, end=moment)] == ["a", "b"]
