from datetime import datetime, timedelta, timezone

from app.task_queue import (
    add_schedule,
    claim_task,
    complete_task,
    enqueue_due_schedules,
    enqueue_task,
    fail_task,
    heartbeat_worker,
    list_schedules,
    list_tasks,
    queue_metrics,
)
from app.worker import run_once


def test_priority_claim_dedupe_and_completion(tmp_path):
    path = tmp_path / "queue.sqlite3"
    first = enqueue_task("workflow-run", {"value": 1}, priority=100, dedupe_key="same", path=path)
    duplicate = enqueue_task("workflow-run", {"value": 2}, priority=100, dedupe_key="same", path=path)
    high = enqueue_task("workflow-run", {"value": 3}, priority=900, path=path)
    assert duplicate["id"] == first["id"]
    claimed = claim_task("worker:test", path=path)
    assert claimed["id"] == high["id"]
    completed = complete_task(claimed["id"], {"ok": True}, path=path)
    assert completed["status"] == "succeeded"
    assert completed["result_summary"] == {"ok": True}
    assert len(list_tasks(path=path)) == 2


def test_failed_task_retries_then_becomes_terminal(tmp_path):
    path = tmp_path / "queue.sqlite3"
    task = enqueue_task("workflow-run", {}, max_attempts=2, path=path)
    first = claim_task("worker:test", path=path)
    retried = fail_task(first["id"], RuntimeError("transient"), retry_delay_seconds=0, path=path)
    assert retried["status"] == "pending"
    second = claim_task("worker:test", path=path)
    terminal = fail_task(second["id"], RuntimeError("still broken"), retry_delay_seconds=0, path=path)
    assert terminal["id"] == task["id"]
    assert terminal["status"] == "failed"
    assert terminal["attempt_count"] == 2
    assert terminal["last_error"] == "still broken"


def test_queue_metrics_include_worker_utilization_and_timings(tmp_path):
    path = tmp_path / "queue.sqlite3"
    now = datetime.now(timezone.utc)
    task = enqueue_task("workflow-run", {}, path=path)
    heartbeat_worker("worker:busy", status="running", current_task_id=task["id"], path=path, now=now)
    heartbeat_worker("worker:idle", status="idle", path=path, now=now)
    claimed = claim_task("worker:busy", path=path, now=now)
    complete_task(claimed["id"], {"done": True}, path=path, now=now + timedelta(seconds=2))
    metrics = queue_metrics(path=path, now=now + timedelta(seconds=2))
    assert metrics["active_workers"] == 2
    assert metrics["busy_workers"] == 1
    assert metrics["worker_utilization"] == 0.5
    assert metrics["succeeded"] == 1
    assert metrics["queue_wait_samples"] == 1
    assert metrics["run_duration_samples"] == 1
    assert metrics["run_duration_ms_average"] >= 1900


def test_due_schedule_enqueues_once_and_advances_slot(tmp_path):
    path = tmp_path / "queue.sqlite3"
    now = datetime.now(timezone.utc).replace(microsecond=0)
    schedule = add_schedule(
        "hourly public source",
        "collect-source",
        {"source_id": "usgs-earthquakes"},
        interval_seconds=3600,
        next_run_at=now,
        path=path,
    )
    first = enqueue_due_schedules(path=path, now=now)
    second = enqueue_due_schedules(path=path, now=now)
    assert len(first) == 1
    assert second == []
    tasks = list_tasks(path=path)
    assert len(tasks) == 1
    assert tasks[0]["dedupe_key"] == f"schedule:{schedule['id']}:{now.isoformat()}"
    updated = list_schedules(path=path)[0]
    assert datetime.fromisoformat(updated["next_run_at"]) == now + timedelta(hours=1)


def test_background_worker_executes_bounded_workflow_task(tmp_path):
    path = tmp_path / "queue.sqlite3"
    playbook = {
        "id": "durable-count",
        "name": "Durable count",
        "version": 1,
        "steps": [{"id": "count", "action": "row_count", "depends_on": []}],
    }
    task = enqueue_task("workflow-run", {"playbook": playbook, "inputs": {}, "approvals": []}, path=path)
    assert run_once("worker:test", path=path) is True
    updated = next(item for item in list_tasks(path=path) if item["id"] == task["id"])
    assert updated["status"] == "succeeded"
    assert updated["result_summary"]["playbook_id"] == "durable-count"
    assert updated["result_summary"]["status"] == "success"
    metrics = queue_metrics(path=path)
    assert metrics["succeeded"] == 1
