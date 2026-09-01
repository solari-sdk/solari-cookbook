from datetime import datetime, timedelta, timezone

import pytest

from app.quality import WarningEntry, WarningMatch, aggregate_confidence, completeness_score, staleness_score, warning_matches


def test_warning_list_match_modes() -> None:
    entries = [
        WarningEntry("exact", "known-value", WarningMatch.EXACT, "fixture"),
        WarningEntry("sub", "benign", WarningMatch.SUBSTRING, "fixture"),
        WarningEntry("host", "example.org", WarningMatch.HOSTNAME, "fixture"),
        WarningEntry("cidr", "192.0.2.0/24", WarningMatch.CIDR, "fixture"),
        WarningEntry("regex", r"^TEST-[0-9]+$", WarningMatch.REGEX, "fixture"),
    ]
    assert [item.id for item in warning_matches("known-value", entries)] == ["exact"]
    assert [item.id for item in warning_matches("safe-benign-value", entries)] == ["sub"]
    assert [item.id for item in warning_matches("https://sub.example.org/path", entries)] == ["host"]
    assert [item.id for item in warning_matches("192.0.2.42", entries)] == ["cidr"]
    assert [item.id for item in warning_matches("TEST-42", entries)] == ["regex"]


def test_quality_scores_are_bounded_and_explicit() -> None:
    assert completeness_score(["a", "b"], {"a": 1, "b": None}) == 0.5
    now = datetime(2026, 9, 1, tzinfo=timezone.utc)
    assert staleness_score(now, fresh_seconds=100, now=now) == 1.0
    assert staleness_score(now - timedelta(seconds=100), fresh_seconds=100, now=now) == 0.0
    assert 0 < aggregate_confidence(0.8, 0.9, 0.7) < 1
    with pytest.raises(ValueError):
        aggregate_confidence(1.2, 1, 1)
