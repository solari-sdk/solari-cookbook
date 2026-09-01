from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from app.contracts import AcquisitionEnvelope, AcquisitionMethod
from app.sources.spc_hail_reports import SOURCE, convective_day_start, normalize, parse_hail_csv


FIXTURE = """Time,Size,Location,County,State,Lat,Lon,Comments
1338,125,4 NW Turners,Greene,MO,37.22,-93.20,Measured 1.25 inch hail.
0020,UNK,3 NNW Cedar Hill,Dallas,TX,32.63,-96.98,Location and time estimated by radar.
bad,100,Unknown,Nowhere,XX,91.0,-200.0,Invalid coordinate row.
"""


def _acquisition() -> AcquisitionEnvelope:
    stamp = datetime(2026, 9, 1, 12, 30, tzinfo=timezone.utc)
    return AcquisitionEnvelope(
        id="spc-hail-test-acquisition",
        source_id=SOURCE.id,
        method=AcquisitionMethod.FEED,
        requested_url="https://www.spc.noaa.gov/climo/reports/today_hail.csv",
        final_url="https://www.spc.noaa.gov/climo/reports/today_hail.csv",
        started_at=stamp,
        completed_at=stamp,
        status="success",
        http_status=200,
        content_type="text/csv",
        content_sha256="a" * 64,
    )


def test_convective_day_rolls_at_1200_utc():
    assert convective_day_start(datetime(2026, 9, 1, 11, 59, tzinfo=timezone.utc)) == date(2026, 8, 31)
    assert convective_day_start(datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)) == date(2026, 9, 1)


def test_hail_fixture_preserves_preliminary_observation_boundary():
    rows = parse_hail_csv(FIXTURE)
    assert len(rows) == 3
    events = normalize(rows, _acquisition(), date(2026, 9, 1))
    assert len(events) == 2
    first, second = events
    assert first.category == "storm-observation-hail"
    assert first.location is not None and first.location.latitude == 37.22
    assert first.properties["hail_size_inches"] == 1.25
    assert first.properties["preliminary"] is True
    assert first.properties["warning_or_forecast"] is False
    assert first.observed_at.isoformat() == "2026-09-01T13:38:00+00:00"
    assert second.observed_at.isoformat() == "2026-09-02T00:20:00+00:00"
    assert second.properties["hail_size_inches"] is None
    assert "must not be treated as a warning" in (first.evidence[0].note or "")
    assert first.id == normalize(rows, _acquisition(), date(2026, 9, 1))[0].id


def test_hail_csv_requires_documented_columns():
    with pytest.raises(ValueError, match="missing required columns"):
        parse_hail_csv("Time,Location,Lat,Lon\n1338,Somewhere,1,2\n")


def test_hail_csv_record_count_is_bounded():
    header = "Time,Size,Location,County,State,Lat,Lon,Comments\n"
    body = "".join(f"1338,100,Location {index},County,ST,35.0,-97.0,Report {index}\n" for index in range(10001))
    with pytest.raises(ValueError, match="exceeds 10000 records"):
        parse_hail_csv(header + body)
