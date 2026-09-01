from datetime import datetime, timedelta, timezone

import pytest

from app.alerts import (
    _public_https_url,
    acknowledge_alert,
    emit_alert,
    evaluate_change,
    evaluate_correlation,
    evaluate_event,
    list_alerts,
    save_watch_rule,
)


def test_event_geo_severity_and_source_watch_rules(tmp_path):
    db = tmp_path / "alerts.sqlite3"
    save_watch_rule("source", "Source", "source", {"source_id": "source-a"}, path=db)
    save_watch_rule("severity", "High", "severity", {"minimum": "high"}, path=db)
    save_watch_rule("geo", "Region", "geo", {"min_lat": 40, "max_lat": 50, "min_lon": -130, "max_lon": -120}, path=db)
    event = {"id": "e1", "source_id": "source-a", "severity": "severe", "latitude": 47.6, "longitude": -122.3}
    assert {rule["id"] for rule in evaluate_event(event, path=db)} == {"source", "severity", "geo"}


def test_entity_observable_correlation_and_change_rules(tmp_path):
    db = tmp_path / "alerts.sqlite3"
    save_watch_rule("entity", "Entity", "entity", {"entity_id": "entity-1"}, path=db)
    save_watch_rule("observable", "Observable", "observable", {"value": "example.org"}, path=db)
    save_watch_rule("correlation", "Correlation", "correlation", {"minimum_score": 0.8}, path=db)
    save_watch_rule("change", "Change", "change", {"fields": ["status", "severity"]}, path=db)
    event = {"entity_ids": ["entity-1"], "observables": ["Example.ORG"]}
    assert {rule["id"] for rule in evaluate_event(event, path=db)} == {"entity", "observable"}
    assert evaluate_correlation(0.9, {}, path=db)[0]["id"] == "correlation"
    assert evaluate_change({"status": "a"}, {"status": "b"}, path=db)[0]["id"] == "change"


def test_alert_history_acknowledgement_and_suppression(tmp_path):
    db = tmp_path / "alerts.sqlite3"
    save_watch_rule("rule", "Rule", "category", {"category": "test"}, path=db)
    now = datetime.now(timezone.utc)
    first = emit_alert("rule", "e1", "Matched", {"event_id": "e1"}, severity="high", suppression_seconds=600, now=now, path=db)
    assert first is not None
    duplicate = emit_alert("rule", "e1", "Matched", {"event_id": "e1"}, severity="high", suppression_seconds=600, now=now + timedelta(seconds=10), path=db)
    assert duplicate is None
    later = emit_alert("rule", "e1", "Matched", {"event_id": "e1"}, severity="high", suppression_seconds=600, now=now + timedelta(seconds=601), path=db)
    assert later is not None
    acknowledged = acknowledge_alert(first["id"], analyst="analyst", status="resolved", path=db)
    assert acknowledged["status"] == "resolved"
    assert len(list_alerts(rule_id="rule", path=db)) == 2


def test_output_connector_rejects_local_destinations(monkeypatch):
    monkeypatch.setattr("socket.getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(ValueError, match="public addresses"):
        _public_https_url("https://example.invalid/hook")
    with pytest.raises(ValueError, match="HTTPS"):
        _public_https_url("http://example.invalid/hook")
