import pytest

from app.sources import usgs_water_latest


def test_usgs_water_config_bounds():
    assert usgs_water_latest._configured_ids("01646500,USGS-01491000") == ["USGS-01646500", "USGS-01491000"]
    assert usgs_water_latest._parameter_codes("") == ["00060", "00065"]
    assert usgs_water_latest._parameter_codes("00060,00065,00060") == ["00060", "00065"]
    with pytest.raises(RuntimeError):
        usgs_water_latest._configured_ids("")
    with pytest.raises(RuntimeError):
        usgs_water_latest._configured_ids("not-a-site")
    with pytest.raises(RuntimeError):
        usgs_water_latest._parameter_codes("60")


def test_usgs_water_normalization_preserves_provisional_metadata_without_inferring_flooding():
    payload = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "id": "fixture-feature",
            "geometry": {"type": "Point", "coordinates": [-77.1276, 38.9498]},
            "properties": {
                "monitoring_location_id": "USGS-01646500",
                "parameter_code": "00060",
                "value": "1234.5",
                "unit_of_measure": "ft3/s",
                "approval_status": "Provisional",
                "qualifier": ["P"],
                "time": "2026-09-01T08:15:00+00:00",
                "last_modified": "2026-09-01T08:20:00+00:00",
                "timeseries_id": "fixture-series",
            },
        }],
    }
    events = usgs_water_latest.normalize(payload, "acq-fixture")
    assert len(events) == 1
    event = events[0]
    assert event.category == "water-observation"
    assert event.location.latitude == pytest.approx(38.9498)
    assert event.location.longitude == pytest.approx(-77.1276)
    assert event.properties["value"] == pytest.approx(1234.5)
    assert event.properties["approval_status"] == "Provisional"
    assert event.properties["provisional_data_possible"] is True
    assert event.severity is None
    assert "no flood severity is inferred" in event.evidence[0].note


def test_usgs_water_rejects_malformed_shapes_and_bounds_feature_count():
    with pytest.raises(ValueError, match="features array"):
        usgs_water_latest.normalize({}, "acq-fixture")
    payload = {"features": [{}] * (usgs_water_latest.MAX_FEATURES + 1)}
    with pytest.raises(ValueError, match="exceeds"):
        usgs_water_latest.normalize(payload, "acq-fixture")
