from app.exports import events_csv, events_geojson


def sample():
    return [{"id":"e1","source_id":"s","source_record_id":"1","category":"test","title":"Event","summary":None,"observed_at":"2026-09-01T00:00:00Z","updated_at":None,"latitude":47.6,"longitude":-122.3,"severity":"low","quality_score":1.0}]


def test_csv_export():
    text=events_csv(sample())
    assert "source_id" in text
    assert "Event" in text


def test_geojson_export():
    data=events_geojson(sample())
    assert data["type"]=="FeatureCollection"
    assert data["features"][0]["geometry"]["coordinates"]==[-122.3,47.6]
