from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.storage import DB_PATH

TASK_SCHEMA = """
CREATE TABLE IF NOT EXISTS queued_tasks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL,
    available_at TEXT NOT NULL,
    claimed_at TEXT,
    worker_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    attempt_count INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    last_error TEXT,
    result_summary_json TEXT,
    dedupe_key TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queued_tasks_claim ON queued_tasks(status,available_at,priority DESC,created_at,id);
CREATE INDEX IF NOT EXISTS idx_queued_tasks_worker ON queued_tasks(worker_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT NOT NULL,
    current_task_id TEXT,
    completed_jobs INTEGER NOT NULL DEFAULT 0,
    failed_jobs INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    task_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    next_run_at TEXT NOT NULL,
    last_enqueued_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_schedules_due ON task_schedules(enabled,next_run_at,id);
"""
MAX_PAYLOAD_BYTES = 64 * 1024
MAX_RESULT_SUMMARY_BYTES = 64 * 1024
ACTIVE_WORKER_SECONDS = 30


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _text(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _db(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=10000")
    db.executescript(TASK_SCHEMA)
    return db


def _json_payload(value: dict[str, Any], *, label: str) -> str:
    if not isinstance(value, dict):
        raise TypeError(f"{label} must be an object")
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    if len(encoded.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ValueError(f"{label} exceeds {MAX_PAYLOAD_BYTES} byte limit")
    return encoded


def _decode_task(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["payload"] = json.loads(item.pop("payload_json"))
    raw_result = item.pop("result_summary_json")
    item["result_summary"] = json.loads(raw_result) if raw_result else None
    return item


def enqueue_task(
    kind: str,
    payload: dict[str, Any],
    *,
    priority: int = 100,
    available_at: datetime | None = None,
    max_attempts: int = 3,
    dedupe_key: str | None = None,
    path: Path = DB_PATH,
) -> dict[str, Any]:
    if not kind or len(kind) > 100:
        raise ValueError("task kind must be between 1 and 100 characters")
    if priority < -1000 or priority > 1000:
        raise ValueError("priority must be between -1000 and 1000")
    if max_attempts < 1 or max_attempts > 10:
        raise ValueError("max_attempts must be between 1 and 10")
    if dedupe_key is not None and (not dedupe_key or len(dedupe_key) > 200):
        raise ValueError("dedupe_key must be between 1 and 200 characters")
    payload_json = _json_payload(payload, label="task payload")
    now = _now()
    task_id = uuid4().hex
    with _db(path) as db:
        if dedupe_key:
            existing = db.execute("SELECT * FROM queued_tasks WHERE dedupe_key=?", (dedupe_key,)).fetchone()
            if existing:
                return _decode_task(existing)
        db.execute(
            "INSERT INTO queued_tasks (id,kind,payload_json,status,priority,available_at,attempt_count,max_attempts,dedupe_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (task_id, kind, payload_json, "pending", priority, _text(available_at or now), 0, max_attempts, dedupe_key, _text(now), _text(now)),
        )
        row = db.execute("SELECT * FROM queued_tasks WHERE id=?", (task_id,)).fetchone()
    return _decode_task(row)


def claim_task(worker_id: str, *, path: Path = DB_PATH, now: datetime | None = None) -> dict[str, Any] | None:
    if not worker_id or len(worker_id) > 200:
        raise ValueError("worker_id must be between 1 and 200 characters")
    now = now or _now()
    db = _db(path)
    try:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM queued_tasks WHERE status='pending' AND available_at<=? ORDER BY priority DESC,created_at,id LIMIT 1",
            (_text(now),),
        ).fetchone()
        if row is None:
            db.commit()
            return None
        db.execute(
            "UPDATE queued_tasks SET status='running',claimed_at=?,worker_id=?,started_at=COALESCE(started_at,?),attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status='pending'",
            (_text(now), worker_id, _text(now), _text(now), row["id"]),
        )
        claimed = db.execute("SELECT * FROM queued_tasks WHERE id=?", (row["id"],)).fetchone()
        db.commit()
        return _decode_task(claimed)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _result_json(result_summary: dict[str, Any] | None) -> str | None:
    if result_summary is None:
        return None
    encoded = json.dumps(result_summary, sort_keys=True, separators=(",", ":"), default=str)
    if len(encoded.encode("utf-8")) > MAX_RESULT_SUMMARY_BYTES:
        return json.dumps({"truncated": True, "type": type(result_summary).__name__})
    return encoded


def complete_task(task_id: str, result_summary: dict[str, Any] | None = None, *, path: Path = DB_PATH, now: datetime | None = None) -> dict[str, Any]:
    now = now or _now()
    with _db(path) as db:
        changed = db.execute(
            "UPDATE queued_tasks SET status='succeeded',completed_at=?,result_summary_json=?,updated_at=? WHERE id=? AND status='running'",
            (_text(now), _result_json(result_summary), _text(now), task_id),
        ).rowcount
        if changed != 1:
            raise KeyError("running task not found")
        row = db.execute("SELECT * FROM queued_tasks WHERE id=?", (task_id,)).fetchone()
    return _decode_task(row)


def fail_task(task_id: str, error: Exception | str, *, retry_delay_seconds: float = 0, path: Path = DB_PATH, now: datetime | None = None) -> dict[str, Any]:
    if retry_delay_seconds < 0 or retry_delay_seconds > 3600:
        raise ValueError("retry delay must be between 0 and 3600 seconds")
    now = now or _now()
    message = str(error)[:4000]
    with _db(path) as db:
        row = db.execute("SELECT * FROM queued_tasks WHERE id=? AND status='running'", (task_id,)).fetchone()
        if row is None:
            raise KeyError("running task not found")
        retry = int(row["attempt_count"]) < int(row["max_attempts"])
        if retry:
            available = now + timedelta(seconds=retry_delay_seconds)
            db.execute(
                "UPDATE queued_tasks SET status='pending',available_at=?,claimed_at=NULL,worker_id=NULL,last_error=?,updated_at=? WHERE id=?",
                (_text(available), message, _text(now), task_id),
            )
        else:
            db.execute(
                "UPDATE queued_tasks SET status='failed',completed_at=?,last_error=?,updated_at=? WHERE id=?",
                (_text(now), message, _text(now), task_id),
            )
        updated = db.execute("SELECT * FROM queued_tasks WHERE id=?", (task_id,)).fetchone()
    return _decode_task(updated)


def list_tasks(*, status: str | None = None, limit: int = 100, path: Path = DB_PATH) -> list[dict[str, Any]]:
    if limit < 1 or limit > 1000:
        raise ValueError("limit must be between 1 and 1000")
    values: list[Any] = []
    where = ""
    if status is not None:
        if status not in {"pending", "running", "succeeded", "failed"}:
            raise ValueError("unsupported task status")
        where = "WHERE status=?"
        values.append(status)
    values.append(limit)
    with _db(path) as db:
        rows = db.execute(f"SELECT * FROM queued_tasks {where} ORDER BY created_at DESC,id DESC LIMIT ?", values).fetchall()
    return [_decode_task(row) for row in rows]


def heartbeat_worker(worker_id: str, *, status: str, current_task_id: str | None = None, completed_delta: int = 0, failed_delta: int = 0, path: Path = DB_PATH, now: datetime | None = None) -> None:
    if status not in {"idle", "running", "stopping"}:
        raise ValueError("unsupported worker status")
    now = now or _now()
    with _db(path) as db:
        db.execute(
            "INSERT INTO worker_heartbeats (worker_id,started_at,last_seen,status,current_task_id,completed_jobs,failed_jobs) VALUES (?,?,?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET last_seen=excluded.last_seen,status=excluded.status,current_task_id=excluded.current_task_id,completed_jobs=worker_heartbeats.completed_jobs+excluded.completed_jobs,failed_jobs=worker_heartbeats.failed_jobs+excluded.failed_jobs",
            (worker_id, _text(now), _text(now), status, current_task_id, max(0, completed_delta), max(0, failed_delta)),
        )


def queue_metrics(*, path: Path = DB_PATH, now: datetime | None = None) -> dict[str, Any]:
    now = now or _now()
    active_since = _text(now - timedelta(seconds=ACTIVE_WORKER_SECONDS))
    with _db(path) as db:
        counts = {row["status"]: int(row["count"]) for row in db.execute("SELECT status,COUNT(*) AS count FROM queued_tasks GROUP BY status").fetchall()}
        active_workers = int(db.execute("SELECT COUNT(*) FROM worker_heartbeats WHERE last_seen>=?", (active_since,)).fetchone()[0])
        busy_workers = int(db.execute("SELECT COUNT(*) FROM worker_heartbeats WHERE last_seen>=? AND status='running'", (active_since,)).fetchone()[0])
        wait_values = [float(row[0]) for row in db.execute("SELECT (julianday(claimed_at)-julianday(created_at))*86400000.0 FROM queued_tasks WHERE claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 1000").fetchall() if row[0] is not None]
        run_values = [float(row[0]) for row in db.execute("SELECT (julianday(completed_at)-julianday(started_at))*86400000.0 FROM queued_tasks WHERE completed_at IS NOT NULL AND started_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1000").fetchall() if row[0] is not None]
        oldest = db.execute("SELECT created_at FROM queued_tasks WHERE status='pending' ORDER BY created_at LIMIT 1").fetchone()
    oldest_dt = _parse(oldest[0]) if oldest else None
    return {
        "depth": counts.get("pending", 0),
        "running": counts.get("running", 0),
        "succeeded": counts.get("succeeded", 0),
        "failed": counts.get("failed", 0),
        "active_workers": active_workers,
        "busy_workers": busy_workers,
        "worker_utilization": busy_workers / active_workers if active_workers else 0.0,
        "oldest_pending_age_seconds": max(0.0, (now - oldest_dt).total_seconds()) if oldest_dt else None,
        "queue_wait_ms_average": sum(wait_values) / len(wait_values) if wait_values else None,
        "run_duration_ms_average": sum(run_values) / len(run_values) if run_values else None,
        "queue_wait_samples": len(wait_values),
        "run_duration_samples": len(run_values),
        "active_worker_window_seconds": ACTIVE_WORKER_SECONDS,
    }


def add_schedule(
    name: str,
    task_kind: str,
    payload: dict[str, Any],
    *,
    interval_seconds: int,
    next_run_at: datetime | None = None,
    enabled: bool = True,
    path: Path = DB_PATH,
) -> dict[str, Any]:
    if not name or len(name) > 200:
        raise ValueError("schedule name must be between 1 and 200 characters")
    if interval_seconds < 60 or interval_seconds > 31 * 86400:
        raise ValueError("interval_seconds must be between 60 seconds and 31 days")
    payload_json = _json_payload(payload, label="schedule payload")
    now = _now()
    schedule_id = uuid4().hex
    with _db(path) as db:
        db.execute(
            "INSERT INTO task_schedules (id,name,task_kind,payload_json,interval_seconds,enabled,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (schedule_id, name, task_kind, payload_json, interval_seconds, 1 if enabled else 0, _text(next_run_at or now), _text(now), _text(now)),
        )
        row = db.execute("SELECT * FROM task_schedules WHERE id=?", (schedule_id,)).fetchone()
    return _decode_schedule(row)


def _decode_schedule(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["payload"] = json.loads(item.pop("payload_json"))
    item["enabled"] = bool(item["enabled"])
    return item


def list_schedules(*, enabled: bool | None = None, path: Path = DB_PATH) -> list[dict[str, Any]]:
    where = "" if enabled is None else "WHERE enabled=?"
    values: tuple[Any, ...] = () if enabled is None else (1 if enabled else 0,)
    with _db(path) as db:
        rows = db.execute(f"SELECT * FROM task_schedules {where} ORDER BY next_run_at,id", values).fetchall()
    return [_decode_schedule(row) for row in rows]


def enqueue_due_schedules(*, path: Path = DB_PATH, now: datetime | None = None, limit: int = 100) -> list[dict[str, Any]]:
    if limit < 1 or limit > 1000:
        raise ValueError("limit must be between 1 and 1000")
    now = now or _now()
    db = _db(path)
    due: list[dict[str, Any]] = []
    try:
        db.execute("BEGIN IMMEDIATE")
        rows = db.execute("SELECT * FROM task_schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id LIMIT ?", (_text(now), limit)).fetchall()
        for row in rows:
            schedule = _decode_schedule(row)
            slot = str(row["next_run_at"])
            dedupe_key = f"schedule:{row['id']}:{slot}"
            payload = schedule["payload"]
            payload_json = _json_payload(payload, label="schedule payload")
            existing = db.execute("SELECT id FROM queued_tasks WHERE dedupe_key=?", (dedupe_key,)).fetchone()
            if existing is None:
                task_id = uuid4().hex
                db.execute(
                    "INSERT INTO queued_tasks (id,kind,payload_json,status,priority,available_at,attempt_count,max_attempts,dedupe_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (task_id, row["task_kind"], payload_json, "pending", 100, _text(now), 0, 3, dedupe_key, _text(now), _text(now)),
                )
                due.append({"schedule_id": row["id"], "task_id": task_id, "slot": slot})
            next_run = _parse(slot) or now
            interval = timedelta(seconds=int(row["interval_seconds"]))
            while next_run <= now:
                next_run += interval
            db.execute("UPDATE task_schedules SET next_run_at=?,last_enqueued_at=?,updated_at=? WHERE id=?", (_text(next_run), _text(now), _text(now), row["id"]))
        db.commit()
        return due
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
