from datetime import timezone

import pytest

from app.sources import ndbc_latest_observations, usgs_volcano_elevated


def test_usgs_elevated_volcano_normalization_preserves_status_without_guessing_location():
    payload = [{
        "obs_fullname": "Example Volcano Observatory",
        "obs_abbr": "evo",
        "volcano_name": "Example Volcano",
        "vnum": "300000",
        "notice_type_cd": "DU",
        "notice_identifier": "DOI-USGS-EVO-2026-09-01T00:00:00+00:00",
        "sent_utc": "2026-09-01 00:05:00",
        "sent_unixtime": 1788221100,
        "color_code": "ORANGE",
        "alert_level": "WATCH",
        "notice_url": "https://volcanoes.usgs.gov/hans-public/notice/example",
        "notice_data": "https://volcanoes.usgs.gov/hans-public/api/notice/getNotice/example",
    }]
    events = usgs_volcano_elevated.normalize(payload, "acq-fixture")
    assert len(events) == 1
    event = events[0]
    assert event.category == "volcano-status"
    assert event.severity == "high"
    assert event.location is None
    assert event.properties["color_code"] == "ORANGE"
    assert event.properties["alert_level"] == "WATCH"
    assert event.properties["location_not_in_elevated_status_response"] is True
    assert event.observed_at.tzinfo == timezone.utc


def test_usgs_volcano_status_severity_mapping_and_bounds():
    assert usgs_volcano_elevated._severity("RED", "WARNING") == "extreme"
    assert usgs_volcano_elevated._severity("YELLOW", "ADVISORY") == "moderate"
    assert usgs_volcano_elevated._severity("GREEN", "NORMAL") == "low"
    with pytest.raises(ValueError, match="must be an array"):
        usgs_volcano_elevated.normalize({}, "acq-fixture")  # type: ignore[arg-type]


def test_ndbc_latest_observations_parser_handles_missing_values_and_coordinates():
    text = """#STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
#text deg deg yr mo day hr mn degT m/s m/s m sec sec degT hPa hPa degC degC degC nmi ft
41002 31.743 -74.955 2026 09 01 08 30 50 3.0 4.0 MM MM MM MM 1017.0 MM 27.9 29.2 24.9 MM MM
41065 32.802 -79.619 2026 09 01 07 58 MM MM MM 0.5 7 5.4 129 MM MM MM 27.7 MM MM MM
"""
    records = ndbc_latest_observations.parse_latest_observations(text)
    assert len(records) == 2
    assert records[0]["station"] == "41002"
    assert records[0]["wind_speed_m_s"] == pytest.approx(3.0)
    assert records[0]["wave_height_m"] is None
    assert records[1]["wind_speed_m_s"] is None
    assert records[1]["wave_height_m"] == pytest.approx(0.5)
    events = ndbc_latest_observations.normalize(records, "acq-fixture")
    assert len(events) == 2
    assert events[0].location.latitude == pytest.approx(31.743)
    assert events[0].category == "marine-observation"
    assert events[0].properties["station_id"] == "41002"
    assert events[0].properties["pressure_hpa"] == pytest.approx(1017.0)


def test_ndbc_parser_skips_invalid_rows_without_inference():
    text = """# headers
BAD 95.0 -74.0 2026 09 01 08 30 50 3 4 MM MM MM MM 1017 MM 27 29 25 MM MM
SHORT 1 2
"""
    assert ndbc_latest_observations.parse_latest_observations(text) == []
