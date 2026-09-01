from datetime import timezone

import pytest

from app.sources.aviationweather_metars import MAX_RECORDS, configured_stations, normalize


def test_configured_stations_are_bounded_and_deduplicated():
    assert configured_stations("kmci,KSEA,KMCI") == ["KMCI", "KSEA"]
    with pytest.raises(RuntimeError):
        configured_stations("BAD-STATION")
    with pytest.raises(RuntimeError):
        configured_stations(",".join(f"K{i:03d}" for i in range(26)))


def test_metar_normalization_preserves_provider_observation_without_inferred_status():
    payload = [{
        "icaoId": "KMCI",
        "receiptTime": "2026-09-01T13:26:11.891Z",
        "obsTime": 1788268980,
        "reportTime": "2026-09-01T13:23:00.000Z",
        "temp": 25.6,
        "dewp": 18.9,
        "wdir": 190,
        "wspd": 9,
        "visib": "10+",
        "altim": 1016.7,
        "qcField": 12,
        "metarType": "SPECI",
        "rawOb": "SPECI KMCI 011323Z 19009KT 10SM SCT250 26/19 A3002",
        "lat": 39.2975,
        "lon": -94.7309,
        "name": "Kansas City Intl, MO, US",
        "clouds": [{"cover": "SCT", "base": 25000}],
        "fltCat": "VFR",
    }]
    events = normalize(payload, "acq-test")
    assert len(events) == 1
    event = events[0]
    assert event.source_id == "aviationweather-metars"
    assert event.observed_at.tzinfo == timezone.utc
    assert event.location is not None
    assert event.location.latitude == pytest.approx(39.2975)
    assert event.location.longitude == pytest.approx(-94.7309)
    assert event.properties["flight_category"] == "VFR"
    assert event.properties["raw_observation"].startswith("SPECI KMCI")
    assert event.severity is None
    assert "closure" not in event.summary.lower()
    assert event.evidence[0].acquisition_id == "acq-test"


def test_metar_normalization_skips_malformed_records_and_enforces_provider_limit():
    assert normalize([{"icaoId": "KMCI"}, {"reportTime": "2026-09-01T13:23:00Z"}], "acq") == []
    with pytest.raises(ValueError):
        normalize([{} for _ in range(MAX_RECORDS + 1)], "acq")
