from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from app.contracts import stable_id
from app.storage import DB_PATH, connect

ExecutionKind = Literal["browser", "sandbox", "desktop"]
ExecutionStatus = Literal["success", "failure"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS solari_executions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    target TEXT,
    session_id TEXT,
    summary_json TEXT NOT NULL,
    artifact_sha256s_json TEXT NOT NULL,
    error_type TEXT,
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_solari_executions_kind_completed
ON solari_executions(kind, completed_at DESC);
"""


def _db(path: Path = DB_PATH):
    db = connect(path)
    db.executescript(SCHEMA)
    return db


def record_solari_execution(
    kind: ExecutionKind,
    status: ExecutionStatus,
    *,
    started_at: datetime,
    completed_at: datetime,
    target: str | None = None,
    session_id: str | None = None,
    summary: dict[str, Any] | None = None,
    artifact_sha256s: list[str] | None = None,
    error_type: str | None = None,
    error_message: str | None = None,
    execution_id: str | None = None,
    path: Path = DB_PATH,
) -> dict[str, object]:
    if started_at.tzinfo is None or completed_at.tzinfo is None:
        raise ValueError("Solari execution timestamps must be timezone-aware")
    if completed_at < started_at:
        raise ValueError("completed_at must be on or after started_at")
    artifacts = sorted(set(artifact_sha256s or []))
    if any(len(item) != 64 or any(ch not in "0123456789abcdef" for ch in item.lower()) for item in artifacts):
        raise ValueError("artifact_sha256s must contain SHA-256 hex digests")
    normalized_artifacts = [item.lower() for item in artifacts]
    row_id = execution_id or stable_id("solari-execution", kind, started_at.isoformat(), target or "", session_id or "")
    with _db(path) as db:
        db.execute(
            "INSERT OR REPLACE INTO solari_executions (id,kind,status,started_at,completed_at,target,session_id,summary_json,artifact_sha256s_json,error_type,error_message) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                row_id,
                kind,
                status,
                started_at.astimezone(timezone.utc).isoformat(),
                completed_at.astimezone(timezone.utc).isoformat(),
                target,
                session_id,
                json.dumps(summary or {}, ensure_ascii=False, sort_keys=True),
                json.dumps(normalized_artifacts),
                error_type,
                (error_message or "")[:1000] or None,
            ),
        )
    return get_solari_execution(row_id, path=path)


def _decode(row) -> dict[str, object]:
    item = dict(row)
    item["summary"] = json.loads(item.pop("summary_json"))
    item["artifact_sha256s"] = json.loads(item.pop("artifact_sha256s_json"))
    return item


def get_solari_execution(execution_id: str, *, path: Path = DB_PATH) -> dict[str, object]:
    with _db(path) as db:
        row = db.execute("SELECT * FROM solari_executions WHERE id=?", (execution_id,)).fetchone()
    if not row:
        raise KeyError("Solari execution not found")
    return _decode(row)


def list_solari_executions(
    *,
    kind: ExecutionKind | None = None,
    limit: int = 100,
    path: Path = DB_PATH,
) -> list[dict[str, object]]:
    if not 1 <= limit <= 1000:
        raise ValueError("limit must be between 1 and 1000")
    query = "SELECT * FROM solari_executions"
    values: list[object] = []
    if kind:
        query += " WHERE kind=?"
        values.append(kind)
    query += " ORDER BY completed_at DESC,id LIMIT ?"
    values.append(limit)
    with _db(path) as db:
        rows = db.execute(query, values).fetchall()
    return [_decode(row) for row in rows]
