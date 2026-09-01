from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.jobs import JobExecution
from app.storage import DB_PATH, connect

JOB_SCHEMA = """
CREATE TABLE IF NOT EXISTS job_executions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_id TEXT,
    correlation_id TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    failure_class TEXT,
    error_type TEXT,
    error_message TEXT,
    attempt_durations_json TEXT NOT NULL,
    result_summary_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_started ON job_executions(started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_source_started ON job_executions(source_id,started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_correlation ON job_executions(correlation_id,started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_executions(status,started_at DESC,id DESC);
"""

MAX_RESULT_SUMMARY_BYTES = 64 * 1024


def _db(path: Path = DB_PATH):
    db = connect(path)
    db.executescript(JOB_SCHEMA)
    return db


def _safe_result_summary(result: object) -> object | None:
    if result is None:
        return None
    if isinstance(result, tuple) and len(result) == 2:
        acquisition, events = result
        return {
            "acquisition_id": getattr(acquisition, "id", None),
            "source_id": getattr(acquisition, "source_id", None),
            "events": len(events) if isinstance(events, list) else None,
        }
    if isinstance(result, (str, int, float, bool, list, dict)):
        try:
            encoded = json.dumps(result, default=str).encode("utf-8")
        except (TypeError, ValueError):
            return {"type": type(result).__name__}
        if len(encoded) <= MAX_RESULT_SUMMARY_BYTES:
            return result
    return {"type": type(result).__name__}


def record_job_execution(
    execution: JobExecution[Any],
    *,
    source_id: str | None = None,
    correlation_id: str | None = None,
    path: Path = DB_PATH,
) -> dict[str, object]:
    job_id = uuid4().hex
    created_at = (execution.completed_at or execution.started_at)
    created_text = created_at.isoformat() if created_at else ""
    summary = _safe_result_summary(execution.result)
    with _db(path) as db:
        db.execute(
            "INSERT INTO job_executions (id,name,source_id,correlation_id,status,attempts,started_at,completed_at,failure_class,error_type,error_message,attempt_durations_json,result_summary_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                job_id,
                execution.name,
                source_id,
                correlation_id,
                execution.status.value,
                execution.attempts,
                execution.started_at.isoformat() if execution.started_at else None,
                execution.completed_at.isoformat() if execution.completed_at else None,
                execution.failure_class.value if execution.failure_class else None,
                execution.error_type,
                execution.error_message[:4000] if execution.error_message else None,
                json.dumps(execution.attempt_durations_ms),
                json.dumps(summary, sort_keys=True, default=str) if summary is not None else None,
                created_text,
            ),
        )
    return get_job_execution(job_id, path=path)


def _decode(row) -> dict[str, object]:
    item = dict(row)
    item["attempt_durations_ms"] = json.loads(item.pop("attempt_durations_json"))
    raw = item.pop("result_summary_json")
    item["result_summary"] = json.loads(raw) if raw else None
    item["duration_ms"] = sum(float(value) for value in item["attempt_durations_ms"])
    return item


def get_job_execution(job_id: str, *, path: Path = DB_PATH) -> dict[str, object]:
    with _db(path) as db:
        row = db.execute("SELECT * FROM job_executions WHERE id=?", (job_id,)).fetchone()
    if not row:
        raise KeyError("job execution not found")
    return _decode(row)


def list_job_executions(
    *,
    source_id: str | None = None,
    correlation_id: str | None = None,
    status: str | None = None,
    limit: int = 500,
    path: Path = DB_PATH,
) -> list[dict[str, object]]:
    clauses: list[str] = []
    values: list[object] = []
    for column, value in (("source_id", source_id), ("correlation_id", correlation_id), ("status", status)):
        if value is not None:
            clauses.append(f"{column}=?")
            values.append(value)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with _db(path) as db:
        rows = db.execute(f"SELECT * FROM job_executions {where} ORDER BY COALESCE(started_at,created_at) DESC,id DESC LIMIT ?", values).fetchall()
    return [_decode(row) for row in rows]


def job_metrics(*, path: Path = DB_PATH) -> dict[str, object]:
    with _db(path) as db:
        total = int(db.execute("SELECT COUNT(*) FROM job_executions").fetchone()[0])
        by_status = {row["status"]: int(row["count"]) for row in db.execute("SELECT status,COUNT(*) AS count FROM job_executions GROUP BY status").fetchall()}
        retrying = int(db.execute("SELECT COUNT(*) FROM job_executions WHERE attempts>1").fetchone()[0])
        durations = [json.loads(row["attempt_durations_json"]) for row in db.execute("SELECT attempt_durations_json FROM job_executions ORDER BY started_at DESC LIMIT 1000").fetchall()]
    flattened = [float(value) for values in durations for value in values]
    return {
        "total": total,
        "by_status": by_status,
        "jobs_with_retries": retrying,
        "attempt_duration_ms_average": sum(flattened) / len(flattened) if flattened else None,
        "attempt_samples": len(flattened),
    }
