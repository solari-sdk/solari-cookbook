import pytest

from app.sources.celestrak_weather_satellites import MAX_OBJECTS, normalize


def test_celestrak_weather_object_normalization():
    payload = [{
        "OBJECT_NAME": "EXAMPLE WEATHER SAT",
        "OBJECT_ID": "2026-001A",
        "EPOCH": "2026-09-01T10:00:00.000000",
        "MEAN_MOTION": 14.2,
        "ECCENTRICITY": 0.001,
        "INCLINATION": 98.7,
        "RA_OF_ASC_NODE": 120.0,
        "ARG_OF_PERICENTER": 80.0,
        "MEAN_ANOMALY": 10.0,
        "EPHEMERIS_TYPE": 0,
        "CLASSIFICATION_TYPE": "U",
        "NORAD_CAT_ID": 99999,
        "ELEMENT_SET_NO": 42,
        "REV_AT_EPOCH": 1234,
    }]
    event = normalize(payload, "acq-orbit")[0]
    assert event.category == "satellite-orbit"
    assert event.properties["norad_catalog_id"] == 99999
    assert event.properties["inclination_deg"] == 98.7
    assert event.observed_at.isoformat().startswith("2026-09-01T10:00:00")
    assert event.evidence[0].acquisition_id == "acq-orbit"


def test_celestrak_object_limit_is_enforced():
    with pytest.raises(ValueError):
        normalize([{}] * (MAX_OBJECTS + 1), "acq")
