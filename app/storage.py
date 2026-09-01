from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from app.contracts import AcquisitionEnvelope, EventRecord

DB_PATH = Path("data/solari_ops.sqlite3")

SCHEMA = """
CREATE TABLE IF NOT EXISTS acquisitions (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    method TEXT NOT NULL,
    requested_url TEXT NOT NULL,
    final_url TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    status TEXT NOT NULL,
    http_status INTEGER,
    content_type TEXT,
    content_sha256 TEXT,
    error_type TEXT,
    error_message TEXT,
    metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    source_record_id TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    observed_at TEXT NOT NULL,
    updated_at TEXT,
    latitude REAL,
    longitude REAL,
    geo_precision TEXT,
    severity TEXT,
    quality_score REAL NOT NULL,
    properties_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_observed_at ON events(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source_id ON events(source_id);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
"""


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA)
    return connection


def save_acquisition(acquisition: AcquisitionEnvelope, path: Path = DB_PATH) -> None:
    with connect(path) as db:
        db.execute(
            """
            INSERT INTO acquisitions (
                id, source_id, method, requested_url, final_url, started_at, completed_at,
                status, http_status, content_type, content_sha256, error_type, error_message,
                metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                final_url=excluded.final_url,
                completed_at=excluded.completed_at,
                status=excluded.status,
                http_status=excluded.http_status,
                content_type=excluded.content_type,
                content_sha256=excluded.content_sha256,
                error_type=excluded.error_type,
                error_message=excluded.error_message,
                metadata_json=excluded.metadata_json
            """,
            (
                acquisition.id,
                acquisition.source_id,
                acquisition.method.value,
                str(acquisition.requested_url),
                str(acquisition.final_url) if acquisition.final_url else None,
                acquisition.started_at.isoformat(),
                acquisition.completed_at.isoformat(),
                acquisition.status,
                acquisition.http_status,
                acquisition.content_type,
                acquisition.content_sha256,
                acquisition.error_type,
                acquisition.error_message,
                json.dumps(acquisition.metadata, sort_keys=True),
            ),
        )


def save_events(events: list[EventRecord], path: Path = DB_PATH) -> int:
    saved = 0
    with connect(path) as db:
        for event in events:
            db.execute(
                """
                INSERT INTO events (
                    id, source_id, source_record_id, category, title, summary, observed_at,
                    updated_at, latitude, longitude, geo_precision, severity, quality_score,
                    properties_json, evidence_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    summary=excluded.summary,
                    updated_at=excluded.updated_at,
                    latitude=excluded.latitude,
                    longitude=excluded.longitude,
                    geo_precision=excluded.geo_precision,
                    severity=excluded.severity,
                    quality_score=excluded.quality_score,
                    properties_json=excluded.properties_json,
                    evidence_json=excluded.evidence_json
                """,
                (
                    event.id,
                    event.source_id,
                    event.source_record_id,
                    event.category,
                    event.title,
                    event.summary,
                    event.observed_at.isoformat(),
                    event.updated_at.isoformat() if event.updated_at else None,
                    event.location.latitude if event.location else None,
                    event.location.longitude if event.location else None,
                    event.location.precision if event.location else None,
                    event.severity,
                    event.quality_score,
                    json.dumps(event.properties, sort_keys=True),
                    json.dumps([item.model_dump(mode="json") for item in event.evidence], sort_keys=True),
                ),
            )
            saved += 1
    return saved


def list_events(limit: int = 500, source_id: str | None = None, category: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses: list[str] = []
    values: list[object] = []
    if source_id:
        clauses.append("source_id = ?")
        values.append(source_id)
    if category:
        clauses.append("category = ?")
        values.append(category)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with connect(path) as db:
        rows = db.execute(
            f"SELECT * FROM events {where} ORDER BY observed_at DESC LIMIT ?",
            values,
        ).fetchall()
    return [dict(row) for row in rows]
