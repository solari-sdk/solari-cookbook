from datetime import timezone

import pytest

from app.temporal import normalize_source_time


def test_aware_timestamp_normalizes_to_utc_with_source_offset_provenance():
    result = normalize_source_time("2026-09-01T03:00:00-07:00")
    assert result.utc == result.utc.astimezone(timezone.utc)
    assert result.utc.isoformat() == "2026-09-01T10:00:00+00:00"
    assert result.assumed_timezone is False
    assert result.timezone_provenance.startswith("source-offset:")


def test_naive_timestamp_requires_explicit_timezone_assumption():
    with pytest.raises(ValueError):
        normalize_source_time("2026-09-01T03:00:00")
    result = normalize_source_time("2026-09-01T03:00:00", assumed_timezone="America/Los_Angeles")
    assert result.utc.isoformat() == "2026-09-01T10:00:00+00:00"
    assert result.assumed_timezone is True
    assert result.timezone_provenance == "assumed:America/Los_Angeles"
