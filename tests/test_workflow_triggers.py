from datetime import datetime, timedelta, timezone

import pytest

from app.workflow_triggers import PlaybookRegistry, WorkflowTrigger, trigger_matches
from app.workflows import Playbook, WorkflowStep


def test_playbook_registry_returns_deep_copy():
    registry = PlaybookRegistry()
    registry.register(Playbook(id="public-scan", name="Public scan", steps=[WorkflowStep(id="collect", action="collect")]))
    loaded = registry.get("public-scan")
    loaded.name = "Changed"
    assert registry.get("public-scan").name == "Public scan"
    assert registry.list()[0]["step_count"] == 1


def test_schedule_event_and_source_health_triggers():
    now = datetime(2026, 9, 1, 10, tzinfo=timezone.utc)
    due = WorkflowTrigger("hourly", "public-scan", "schedule", {"interval_minutes": 60, "last_run_at": (now - timedelta(minutes=61)).isoformat()})
    not_due = WorkflowTrigger("hourly2", "public-scan", "schedule", {"interval_minutes": 60, "last_run_at": (now - timedelta(minutes=30)).isoformat()})
    assert trigger_matches(due, {}, now=now)
    assert not trigger_matches(not_due, {}, now=now)

    event = WorkflowTrigger("event", "public-scan", "event", {"category": "earthquake", "source_id": "usgs-earthquakes"})
    assert trigger_matches(event, {"category": "earthquake", "source_id": "usgs-earthquakes"}, now=now)
    assert not trigger_matches(event, {"category": "weather", "source_id": "usgs-earthquakes"}, now=now)

    health = WorkflowTrigger("health", "public-scan", "source-health", {"source_id": "usgs-earthquakes", "statuses": ["stale", "failure"]})
    assert trigger_matches(health, {"source_id": "usgs-earthquakes", "status": "stale"}, now=now)
    assert not trigger_matches(health, {"source_id": "usgs-earthquakes", "status": "ok"}, now=now)


def test_schedule_requires_positive_interval():
    with pytest.raises(ValueError):
        trigger_matches(WorkflowTrigger("bad", "x", "schedule", {"interval_minutes": 0}), {})
