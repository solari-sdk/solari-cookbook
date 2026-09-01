import pytest

from app.schema_contracts import CURRENT_EVENT_SCHEMA_VERSION, event_envelope, migrate_event_payload


def test_current_event_envelope():
    envelope = event_envelope({"id": "event-1", "title": "Public event"})
    assert envelope["schema"] == "event"
    assert envelope["version"] == CURRENT_EVENT_SCHEMA_VERSION
    assert envelope["event"]["id"] == "event-1"


def test_v0_event_migrates_geo_and_quality_score():
    migrated = migrate_event_payload({"id": "legacy", "title": "Legacy", "geo": {"latitude": 1, "longitude": 2}})
    assert migrated["version"] == 1
    assert migrated["event"]["location"] == {"latitude": 1, "longitude": 2}
    assert "geo" not in migrated["event"]
    assert migrated["event"]["quality_score"] == 1.0


def test_event_contract_does_not_silently_downgrade():
    with pytest.raises(ValueError):
        migrate_event_payload({"schema": "event", "version": 1, "event": {}}, to_version=0)
