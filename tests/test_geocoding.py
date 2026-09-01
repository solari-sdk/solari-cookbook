from app import geocoding


def test_search_places_normalizes_bbox_and_uncertainty(monkeypatch):
    monkeypatch.setattr(
        geocoding,
        "_nominatim_json",
        lambda endpoint, params: [{
            "place_id": 123,
            "lat": "49.2827",
            "lon": "-123.1207",
            "display_name": "Example Place",
            "boundingbox": ["49.20", "49.35", "-123.25", "-123.00"],
            "category": "place",
            "type": "city",
            "importance": 0.7,
            "address": {"country_code": "ca"},
        }],
    )
    result = geocoding.search_places("Example Place", limit=1)[0]
    assert result.provider_object_id == "123"
    assert result.location.latitude == 49.2827
    assert result.bounding_box == [49.2, 49.35, -123.25, -123.0]
    assert result.uncertainty_m is not None and result.uncertainty_m > 0
    assert result.attribution == geocoding.NOMINATIM_ATTRIBUTION


def test_reverse_geocode_preserves_provider_source(monkeypatch):
    monkeypatch.setattr(
        geocoding,
        "_nominatim_json",
        lambda endpoint, params: {
            "place_id": 456,
            "lat": str(params["lat"]),
            "lon": str(params["lon"]),
            "display_name": "Reverse Result",
            "boundingbox": ["47.5", "47.7", "-122.4", "-122.2"],
            "address": {},
        },
    )
    result = geocoding.reverse_geocode(47.6, -122.3)
    assert result.display_name == "Reverse Result"
    assert result.source_url.startswith("https://nominatim.openstreetmap.org/reverse?")


def test_geocoding_rejects_unbounded_queries():
    try:
        geocoding.search_places("x")
        raise AssertionError("short query should fail")
    except ValueError:
        pass
    try:
        geocoding.search_places("valid", limit=11)
        raise AssertionError("oversized limit should fail")
    except ValueError:
        pass
