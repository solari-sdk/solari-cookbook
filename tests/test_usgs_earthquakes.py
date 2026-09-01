from app.sources.usgs_earthquakes import normalize


def test_normalize_usgs_feature() -> None:
    payload = {
        "features": [
            {
                "id": "example123",
                "properties": {
                    "mag": 5.4,
                    "place": "Example Region",
                    "time": 1788220800000,
                    "updated": 1788220860000,
                    "type": "earthquake",
                    "felt": 12,
                    "alert": "green",
                    "tsunami": 0,
                    "url": "https://earthquake.usgs.gov/earthquakes/eventpage/example123",
                },
                "geometry": {"type": "Point", "coordinates": [-122.5, 37.7, 8.2]},
            }
        ]
    }

    events = normalize(payload, "acq-test")
    assert len(events) == 1
    event = events[0]
    assert event.source_record_id == "example123"
    assert event.category == "earthquake"
    assert event.severity == "high"
    assert event.location is not None
    assert event.location.latitude == 37.7
    assert event.location.longitude == -122.5
    assert event.properties["depth_km"] == 8.2
    assert event.evidence[0].acquisition_id == "acq-test"
    assert event.evidence[0].field == "*"


def test_id_is_stable_for_same_source_record() -> None:
    payload = {
        "features": [
            {
                "id": "same-id",
                "properties": {"mag": 2.0, "place": "Test", "time": 1788220800000},
                "geometry": {"type": "Point", "coordinates": [1.0, 2.0, 3.0]},
            }
        ]
    }

    first = normalize(payload, "acq-a")[0]
    second = normalize(payload, "acq-b")[0]
    assert first.id == second.id
