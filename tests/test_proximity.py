from datetime import datetime, timezone

import pytest

from app.contracts import EntityRecord, EventRecord, GeoPoint
from app.proximity import event_entity_proximity


def test_event_entity_proximity_is_bounded_and_non_inferential():
    now = datetime.now(timezone.utc)
    events = [
        EventRecord(id="e1", source_id="s", source_record_id="1", category="test", title="Near", observed_at=now, location=GeoPoint(latitude=47.60, longitude=-122.33)),
        EventRecord(id="e2", source_id="s", source_record_id="2", category="test", title="No location", observed_at=now),
    ]
    entities = [
        EntityRecord(id="n", type="location", label="Nearby", location=GeoPoint(latitude=47.61, longitude=-122.34)),
        EntityRecord(id="f", type="location", label="Far", location=GeoPoint(latitude=40.71, longitude=-74.00)),
    ]
    matches = event_entity_proximity(events, entities, radius_km=5)
    assert len(matches) == 1
    assert matches[0]["event_id"] == "e1"
    assert matches[0]["entity_id"] == "n"
    assert matches[0]["inferred_relationship"] is False
    assert matches[0]["distance_km"] < 5


def test_event_entity_proximity_rejects_negative_radius():
    with pytest.raises(ValueError):
        event_entity_proximity([], [], radius_km=-1)
