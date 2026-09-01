from __future__ import annotations

from datetime import datetime, timezone

from app.sources.ioda_outage_alerts import MAX_ALERTS, SOURCE, _request_url, normalize


def test_ioda_request_is_bounded_to_country_alerts_and_six_hour_window():
    now = datetime(2026, 9, 1, 16, 0, tzinfo=timezone.utc)
    url, start, until = _request_url(now)
    assert start == datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)
    assert until == now
    assert "entityType=country" in url
    assert f"limit={MAX_ALERTS}" in url
    assert "from=" in url and "until=" in url


def test_ioda_normalization_preserves_detector_signal_boundary():
    payload = {
        "data": [
            {
                "entity": {"type": "country", "code": "CA", "name": "Canada", "attrs": {"region": "North America"}},
                "datasource": "bgp",
                "level": "warning",
                "time": 1788278400,
                "value": 82,
                "historyValue": 100,
                "condition": "below historical baseline",
            },
            {
                "entity": {"type": "country", "code": "US", "name": "United States"},
                "datasource": "active-probing",
                "level": "normal",
                "time": 1788278400,
                "value": 100,
                "historyValue": 100,
            },
        ]
    }
    events = normalize(payload, "ioda-test-acquisition")
    assert len(events) == 1
    event = events[0]
    assert event.source_id == SOURCE.id
    assert event.category == "internet-reachability-alert"
    assert event.severity == "moderate"
    assert event.properties["country_code"] == "CA"
    assert event.properties["datasource"] == "bgp"
    assert event.properties["value_to_history_ratio"] == 0.82
    assert event.properties["interpretation"] == "detector_signal_only_no_cause_or_impact_inference"
    assert "does not establish cause" in (event.summary or "")
    assert "no outage cause or consequence is inferred" in (event.evidence[0].note or "")


def test_ioda_normalization_rejects_non_country_and_malformed_records():
    payload = {
        "data": [
            {"entity": {"type": "asn", "code": "64500", "name": "Example ASN"}, "datasource": "bgp", "level": "critical", "time": 1788278400},
            {"entity": {"type": "country", "code": "GB", "name": "United Kingdom"}, "datasource": "bgp", "level": "critical", "time": "not-a-timestamp"},
            {"entity": {"type": "country", "code": "", "name": "Unknown"}, "datasource": "bgp", "level": "critical", "time": 1788278400},
        ]
    }
    assert normalize(payload, "ioda-test-acquisition") == []


def test_ioda_normalization_is_deterministic():
    payload = {
        "data": [
            {
                "entity": {"type": "country", "code": "JP", "name": "Japan"},
                "datasource": "merit-nt",
                "level": "critical",
                "time": 1788278400,
                "value": 40,
                "historyValue": 100,
            }
        ]
    }
    first = normalize(payload, "a")[0]
    second = normalize(payload, "b")[0]
    assert first.id == second.id
    assert first.source_record_id == second.source_record_id
    assert first.severity == "high"
