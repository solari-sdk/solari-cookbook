from datetime import datetime, timedelta, timezone

import pytest

from app.solari_execution_store import get_solari_execution, list_solari_executions, record_solari_execution


def test_solari_execution_store_round_trip(tmp_path):
    path = tmp_path / "ops.sqlite3"
    started = datetime(2026, 1, 1, tzinfo=timezone.utc)
    completed = started + timedelta(seconds=2)
    digest = "a" * 64
    saved = record_solari_execution(
        "browser",
        "success",
        started_at=started,
        completed_at=completed,
        target="https://example.org/",
        session_id="browser-1",
        summary={"title": "Example", "recording": True},
        artifact_sha256s=[digest],
        path=path,
    )
    assert saved["kind"] == "browser"
    assert saved["summary"]["recording"] is True
    assert saved["artifact_sha256s"] == [digest]
    assert get_solari_execution(saved["id"], path=path)["session_id"] == "browser-1"
    assert list_solari_executions(kind="browser", path=path)[0]["id"] == saved["id"]
    assert list_solari_executions(kind="sandbox", path=path) == []


def test_solari_execution_store_rejects_invalid_bounds(tmp_path):
    path = tmp_path / "ops.sqlite3"
    now = datetime.now(timezone.utc)
    with pytest.raises(ValueError):
        record_solari_execution("sandbox", "success", started_at=now, completed_at=now, artifact_sha256s=["bad"], path=path)
    with pytest.raises(ValueError):
        list_solari_executions(limit=1001, path=path)
