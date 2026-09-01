from datetime import datetime, timedelta, timezone

from app.contracts import GeoPoint
from app.tracking import add_position, list_geofence_events, list_positions, point_in_geofence, replay_track, save_geofence, save_track


def test_track_history_replay_and_geofence_transitions(tmp_path):
    db = tmp_path / "tracking.sqlite3"
    save_track("track-1", "Public object", "vessel", properties={"public": True}, path=db)
    geofence = save_geofence("area-1", "Area", kind="bbox", geometry={"min_lat": 0, "max_lat": 10, "min_lon": 0, "max_lon": 10}, path=db)
    assert point_in_geofence(GeoPoint(latitude=5, longitude=5), geofence)

    start = datetime.now(timezone.utc)
    first = add_position("track-1", start, GeoPoint(latitude=20, longitude=20), source_id="public-source", path=db)
    assert first["geofence_events"] == []
    entered = add_position("track-1", start + timedelta(minutes=1), GeoPoint(latitude=5, longitude=5), source_id="public-source", path=db)
    assert entered["geofence_events"][0]["event_type"] == "enter"
    exited = add_position("track-1", start + timedelta(minutes=2), GeoPoint(latitude=20, longitude=20), source_id="public-source", path=db)
    assert exited["geofence_events"][0]["event_type"] == "exit"

    positions = list_positions("track-1", path=db)
    assert len(positions) == 3
    replay = replay_track("track-1", path=db)
    assert replay["count"] == 3
    events = list_geofence_events(track_id="track-1", path=db)
    assert [event["event_type"] for event in reversed(events)] == ["enter", "exit"]


def test_polygon_geofence(tmp_path):
    db = tmp_path / "tracking.sqlite3"
    geofence = save_geofence("poly", "Polygon", kind="polygon", geometry={"vertices": [
        {"latitude": 0, "longitude": 0},
        {"latitude": 0, "longitude": 10},
        {"latitude": 10, "longitude": 10},
        {"latitude": 10, "longitude": 0},
    ]}, path=db)
    assert point_in_geofence(GeoPoint(latitude=5, longitude=5), geofence)
    assert not point_in_geofence(GeoPoint(latitude=15, longitude=15), geofence)
