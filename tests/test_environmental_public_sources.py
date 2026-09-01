from datetime import timezone

import pytest

from app.sources import airnow_daily_quality, ndbc_latest_observations, usgs_volcano_elevated, usgs_water_latest
from app.sources.registry import SOURCES


def test_environmental_public_adapters_are_registered():
    expected = {
        "airnow-daily-quality",
        "ndbc-latest-observations",
        "usgs-volcano-elevated",
        "usgs-water-latest",
    }
    assert expected <= set(SOURCES)


def test_usgs_hans_elevated_volcano_normalization_preserves_official_status():
    payload = [{
        "vnum": "123456",
        "volcano_name": "Sample Volcano",
        "notice_identifier": "fixture-notice",
        "sent_unixtime": 1788264000,
        "color_code": "ORANGE",
        "alert_level": "WATCH",
        "obs_fullname": "Sample Volcano Observatory",
        "obs_abbr": "SVO",
        "notice_type_cd": "VAN",
        "notice_url": "https://volcanoes.usgs.gov/fixture",
    }]
    events = usgs_volcano_elevated.normalize(payload, "acq-fixture")
    assert len(events) == 1
    event = events[0]
    assert event.category == "volcano-status"
    assert event.severity == "high"
    assert event.properties["color_code"] == "ORANGE"
    assert event.properties["alert_level"] == "WATCH"
    assert event.location is None
    assert event.observed_at.tzinfo == timezone.utc
    assert "no coordinates are inferred" in event.evidence[0].note


def test_ndbc_latest_observation_normalization_keeps_measurements_non_hazardous():
    text = "46042 36.785 -122.398 2026 09 01 13 50 280 5.1 6.2 1.4 8 6.5 270 1014.2 -0.5 16.2 14.8 12.0 10.0 0.3\n"
    records = ndbc_latest_observations.parse_latest_observations(text)
    assert len(records) == 1
    events = ndbc_latest_observations.normalize(records, "acq-fixture")
    assert len(events) == 1
    event = events[0]
    assert event.category == "marine-observation"
    assert event.location.latitude == pytest.approx(36.785)
    assert event.location.longitude == pytest.approx(-122.398)
    assert event.properties["wind_speed_m_s"] == pytest.approx(5.1)
    assert event.properties["wave_height_m"] == pytest.approx(1.4)
    assert event.severity is None
    assert "no hazard condition is inferred" in event.evidence[0].note


def test_environmental_adapters_keep_distinct_semantics():
    assert airnow_daily_quality.SOURCE.category == "air-quality"
    assert usgs_water_latest.SOURCE.category == "water-observation"
    assert usgs_volcano_elevated.SOURCE.category == "volcano-status"
    assert ndbc_latest_observations.SOURCE.category == "marine-observation"
