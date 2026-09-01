import pytest

from app.sources import airnow_daily_quality


def test_airnow_daily_parser_and_normalization_preserve_preliminary_date_semantics():
    text = """05/28/19|060410001|San Rafael|OZONE-8HR|PPB|31|8|San Francisco Bay Area AQMD|29|0|37.972200|-122.518900|840060410001
05/28/19|271453052|St. Cloud|OZONE-1HR|PPB|43|1|Minnesota Pollution Control Agency|-999|-999|45.550000|-94.133300|840271453052
"""
    rows = airnow_daily_quality.parse_daily_data(text)
    assert len(rows) == 2
    events = airnow_daily_quality.normalize(rows, "acq-fixture")
    assert len(events) == 2
    first = events[0]
    assert first.category == "air-quality"
    assert first.properties["parameter_name"] == "OZONE-8HR"
    assert first.properties["value"] == pytest.approx(31.0)
    assert first.properties["aqi"] == pytest.approx(29.0)
    assert first.properties["airnow_preliminary"] is True
    assert first.properties["time_precision"] == "day"
    assert first.location.latitude == pytest.approx(37.9722)
    assert first.severity == "low"
    assert events[1].properties["aqi"] is None
    assert events[1].severity is None


def test_airnow_severity_boundaries():
    assert airnow_daily_quality._severity(50) == "low"
    assert airnow_daily_quality._severity(51) == "moderate"
    assert airnow_daily_quality._severity(101) == "high"
    assert airnow_daily_quality._severity(151) == "severe"
    assert airnow_daily_quality._severity(201) == "extreme"
    assert airnow_daily_quality._severity(None) is None


def test_airnow_parser_skips_short_rows():
    assert airnow_daily_quality.parse_daily_data("bad|short\n") == []
