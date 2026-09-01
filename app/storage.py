from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.contracts import AcquisitionEnvelope, CaseRecord, EntityRecord, EventRecord, RelationshipRecord

DB_PATH = Path("data/solari_ops.sqlite3")

SCHEMA = """
CREATE TABLE IF NOT EXISTS acquisitions (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, method TEXT NOT NULL, requested_url TEXT NOT NULL,
    final_url TEXT, started_at TEXT NOT NULL, completed_at TEXT NOT NULL, status TEXT NOT NULL,
    http_status INTEGER, content_type TEXT, content_sha256 TEXT, error_type TEXT, error_message TEXT,
    metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_record_id TEXT NOT NULL, category TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT, observed_at TEXT NOT NULL, updated_at TEXT, latitude REAL,
    longitude REAL, geo_precision TEXT, severity TEXT, quality_score REAL NOT NULL,
    properties_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
    first_seen TEXT, last_seen TEXT, sighting_count INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS event_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
    payload_json TEXT NOT NULL, FOREIGN KEY(event_id) REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, aliases_json TEXT NOT NULL,
    first_seen TEXT, last_seen TEXT, latitude REAL, longitude REAL, geo_precision TEXT,
    confidence REAL NOT NULL, properties_json TEXT NOT NULL, evidence_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY, source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL, type TEXT NOT NULL,
    first_seen TEXT, last_seen TEXT, confidence REAL NOT NULL, observed INTEGER NOT NULL,
    properties_json TEXT NOT NULL, evidence_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL,
    owner TEXT, tags_json TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS case_objects (
    case_id TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL, added_at TEXT NOT NULL,
    PRIMARY KEY(case_id, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS idx_events_observed_at ON events(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source_id ON events(source_id);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_location ON events(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_event_history_event ON event_history(event_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_case_objects_case ON case_objects(case_id, object_type);
CREATE INDEX IF NOT EXISTS idx_acquisitions_source_completed ON acquisitions(source_id, completed_at DESC);
"""


def _ensure_event_columns(db: sqlite3.Connection) -> None:
    existing = {row[1] for row in db.execute("PRAGMA table_info(events)").fetchall()}
    for name, definition in {"first_seen": "TEXT", "last_seen": "TEXT", "sighting_count": "INTEGER NOT NULL DEFAULT 1"}.items():
        if name not in existing:
            db.execute(f"ALTER TABLE events ADD COLUMN {name} {definition}")
    now = datetime.now(timezone.utc).isoformat()
    db.execute("UPDATE events SET first_seen=COALESCE(first_seen, observed_at, ?), last_seen=COALESCE(last_seen, updated_at, observed_at, ?) WHERE first_seen IS NULL OR last_seen IS NULL", (now, now))


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA)
    _ensure_event_columns(connection)
    return connection


def save_acquisition(acquisition: AcquisitionEnvelope, path: Path = DB_PATH) -> None:
    with connect(path) as db:
        db.execute("""INSERT INTO acquisitions (id,source_id,method,requested_url,final_url,started_at,completed_at,status,http_status,content_type,content_sha256,error_type,error_message,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET final_url=excluded.final_url,completed_at=excluded.completed_at,status=excluded.status,http_status=excluded.http_status,content_type=excluded.content_type,content_sha256=excluded.content_sha256,error_type=excluded.error_type,error_message=excluded.error_message,metadata_json=excluded.metadata_json""", (acquisition.id, acquisition.source_id, acquisition.method.value, str(acquisition.requested_url), str(acquisition.final_url) if acquisition.final_url else None, acquisition.started_at.isoformat(), acquisition.completed_at.isoformat(), acquisition.status, acquisition.http_status, acquisition.content_type, acquisition.content_sha256, acquisition.error_type, acquisition.error_message, json.dumps(acquisition.metadata, sort_keys=True)))


def save_events(events: list[EventRecord], path: Path = DB_PATH) -> int:
    recorded_at = datetime.now(timezone.utc).isoformat()
    with connect(path) as db:
        for event in events:
            payload = event.model_dump(mode="json")
            db.execute("""INSERT INTO events (id,source_id,source_record_id,category,title,summary,observed_at,updated_at,latitude,longitude,geo_precision,severity,quality_score,properties_json,evidence_json,first_seen,last_seen,sighting_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,summary=excluded.summary,updated_at=excluded.updated_at,latitude=excluded.latitude,longitude=excluded.longitude,geo_precision=excluded.geo_precision,severity=excluded.severity,quality_score=excluded.quality_score,properties_json=excluded.properties_json,evidence_json=excluded.evidence_json,last_seen=excluded.last_seen,sighting_count=events.sighting_count+1""", (event.id,event.source_id,event.source_record_id,event.category,event.title,event.summary,event.observed_at.isoformat(),event.updated_at.isoformat() if event.updated_at else None,event.location.latitude if event.location else None,event.location.longitude if event.location else None,event.location.precision if event.location else None,event.severity,event.quality_score,json.dumps(event.properties,sort_keys=True),json.dumps([x.model_dump(mode="json") for x in event.evidence],sort_keys=True),recorded_at,recorded_at))
            db.execute("INSERT INTO event_history (event_id,recorded_at,payload_json) VALUES (?,?,?)", (event.id, recorded_at, json.dumps(payload, sort_keys=True)))
    return len(events)


def save_entities(entities: list[EntityRecord], path: Path = DB_PATH) -> int:
    with connect(path) as db:
        for entity in entities:
            db.execute("""INSERT INTO entities (id,type,label,aliases_json,first_seen,last_seen,latitude,longitude,geo_precision,confidence,properties_json,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,label=excluded.label,aliases_json=excluded.aliases_json,first_seen=COALESCE(entities.first_seen,excluded.first_seen),last_seen=excluded.last_seen,latitude=excluded.latitude,longitude=excluded.longitude,geo_precision=excluded.geo_precision,confidence=excluded.confidence,properties_json=excluded.properties_json,evidence_json=excluded.evidence_json""", (entity.id,entity.type,entity.label,json.dumps(entity.aliases,sort_keys=True),entity.first_seen.isoformat() if entity.first_seen else None,entity.last_seen.isoformat() if entity.last_seen else None,entity.location.latitude if entity.location else None,entity.location.longitude if entity.location else None,entity.location.precision if entity.location else None,entity.confidence,json.dumps(entity.properties,sort_keys=True),json.dumps([x.model_dump(mode="json") for x in entity.evidence],sort_keys=True)))
    return len(entities)


def save_relationships(relationships: list[RelationshipRecord], path: Path = DB_PATH) -> int:
    with connect(path) as db:
        for rel in relationships:
            db.execute("""INSERT INTO relationships (id,source_entity_id,target_entity_id,type,first_seen,last_seen,confidence,observed,properties_json,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_entity_id=excluded.source_entity_id,target_entity_id=excluded.target_entity_id,type=excluded.type,first_seen=COALESCE(relationships.first_seen,excluded.first_seen),last_seen=excluded.last_seen,confidence=excluded.confidence,observed=excluded.observed,properties_json=excluded.properties_json,evidence_json=excluded.evidence_json""", (rel.id,rel.source_entity_id,rel.target_entity_id,rel.type,rel.first_seen.isoformat() if rel.first_seen else None,rel.last_seen.isoformat() if rel.last_seen else None,rel.confidence,1 if rel.observed else 0,json.dumps(rel.properties,sort_keys=True),json.dumps([x.model_dump(mode="json") for x in rel.evidence],sort_keys=True)))
    return len(relationships)


def save_case(case: CaseRecord, path: Path = DB_PATH) -> None:
    with connect(path) as db:
        db.execute("""INSERT INTO cases (id,title,status,priority,owner,tags_json,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,priority=excluded.priority,owner=excluded.owner,tags_json=excluded.tags_json,notes=excluded.notes,updated_at=excluded.updated_at""", (case.id,case.title,case.status,case.priority,case.owner,json.dumps(case.tags,sort_keys=True),case.notes,case.created_at.isoformat(),case.updated_at.isoformat()))


def add_case_object(case_id: str, object_type: str, object_id: str, path: Path = DB_PATH) -> None:
    if object_type not in {"event", "entity", "relationship", "evidence"}:
        raise ValueError("unsupported case object type")
    with connect(path) as db:
        if not db.execute("SELECT 1 FROM cases WHERE id=?", (case_id,)).fetchone():
            raise KeyError("case not found")
        db.execute("INSERT OR IGNORE INTO case_objects (case_id,object_type,object_id,added_at) VALUES (?,?,?,?)", (case_id,object_type,object_id,datetime.now(timezone.utc).isoformat()))


def list_events(limit: int = 500, source_id: str | None = None, category: str | None = None, *, start: str | None = None, end: str | None = None, min_lat: float | None = None, max_lat: float | None = None, min_lon: float | None = None, max_lon: float | None = None, query: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses: list[str] = []
    values: list[Any] = []
    if source_id: clauses.append("source_id = ?"); values.append(source_id)
    if category: clauses.append("category = ?"); values.append(category)
    if start: clauses.append("observed_at >= ?"); values.append(start)
    if end: clauses.append("observed_at <= ?"); values.append(end)
    if min_lat is not None: clauses.append("latitude >= ?"); values.append(min_lat)
    if max_lat is not None: clauses.append("latitude <= ?"); values.append(max_lat)
    if min_lon is not None: clauses.append("longitude >= ?"); values.append(min_lon)
    if max_lon is not None: clauses.append("longitude <= ?"); values.append(max_lon)
    if query: clauses.append("(title LIKE ? OR summary LIKE ? OR properties_json LIKE ?)"); values.extend([f"%{query}%"] * 3)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with connect(path) as db:
        rows = db.execute(f"SELECT * FROM events {where} ORDER BY observed_at DESC, id DESC LIMIT ?", values).fetchall()
    return [dict(row) for row in rows]


def list_entities(limit: int = 500, entity_type: str | None = None, query: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses=[]; values: list[Any]=[]
    if entity_type: clauses.append("type=?"); values.append(entity_type)
    if query: clauses.append("(label LIKE ? OR aliases_json LIKE ? OR properties_json LIKE ?)"); values.extend([f"%{query}%"]*3)
    where=f"WHERE {' AND '.join(clauses)}" if clauses else ""; values.append(limit)
    with connect(path) as db: rows=db.execute(f"SELECT * FROM entities {where} ORDER BY COALESCE(last_seen,first_seen) DESC,id LIMIT ?",values).fetchall()
    return [dict(row) for row in rows]


def list_relationships(limit: int = 500, entity_id: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    where="WHERE source_entity_id=? OR target_entity_id=?" if entity_id else ""; values: list[Any]=[entity_id,entity_id] if entity_id else []; values.append(limit)
    with connect(path) as db: rows=db.execute(f"SELECT * FROM relationships {where} ORDER BY COALESCE(last_seen,first_seen) DESC,id LIMIT ?",values).fetchall()
    return [dict(row) for row in rows]


def list_cases(limit: int = 100, status: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    where="WHERE status=?" if status else ""; values: list[Any]=[status] if status else []; values.append(limit)
    with connect(path) as db: rows=db.execute(f"SELECT * FROM cases {where} ORDER BY updated_at DESC,id LIMIT ?",values).fetchall()
    output=[]
    for row in rows:
        item=dict(row); item["tags"]=json.loads(item.pop("tags_json")); output.append(item)
    return output


def case_contents(case_id: str, path: Path = DB_PATH) -> dict[str, list[str]]:
    with connect(path) as db: rows=db.execute("SELECT object_type,object_id FROM case_objects WHERE case_id=? ORDER BY object_type,object_id",(case_id,)).fetchall()
    result={"event":[],"entity":[],"relationship":[],"evidence":[]}
    for row in rows: result[row["object_type"]].append(row["object_id"])
    return result


def list_acquisitions(limit: int = 100, source_id: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    where="WHERE source_id = ?" if source_id else ""; values=[source_id] if source_id else []; values.append(limit)
    with connect(path) as db: rows=db.execute(f"SELECT *, (julianday(completed_at)-julianday(started_at))*86400000.0 AS duration_ms FROM acquisitions {where} ORDER BY completed_at DESC LIMIT ?", values).fetchall()
    return [dict(r) for r in rows]


def list_event_history(event_id: str, limit: int = 100, path: Path = DB_PATH) -> list[dict[str, object]]:
    with connect(path) as db:
        rows = db.execute("SELECT recorded_at,payload_json FROM event_history WHERE event_id=? ORDER BY recorded_at DESC,id DESC LIMIT ?", (event_id, limit)).fetchall()
    return [{"recorded_at": row["recorded_at"], "event": json.loads(row["payload_json"])} for row in rows]


def list_evidence(limit: int = 500, source_id: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses = "WHERE source_id = ?" if source_id else ""; values: list[Any] = [source_id] if source_id else []; values.append(limit)
    with connect(path) as db: rows = db.execute(f"SELECT id,source_id,evidence_json FROM events {clauses} ORDER BY observed_at DESC LIMIT ?", values).fetchall()
    output=[]
    for row in rows:
        for evidence in json.loads(row["evidence_json"]): output.append({"event_id": row["id"], "source_id": row["source_id"], **evidence})
    return output


def source_health(path: Path = DB_PATH) -> list[dict[str, object]]:
    with connect(path) as db:
        rows=db.execute("""SELECT a.source_id, a.status AS last_status, a.completed_at AS last_completed_at, a.error_type AS last_error_type, a.error_message AS last_error_message, (julianday(a.completed_at)-julianday(a.started_at))*86400000.0 AS last_duration_ms, (SELECT COUNT(*) FROM acquisitions x WHERE x.source_id=a.source_id) AS runs, (SELECT COUNT(*) FROM acquisitions x WHERE x.source_id=a.source_id AND x.status='failure') AS failures, (SELECT COUNT(*) FROM events e WHERE e.source_id=a.source_id) AS events_stored FROM acquisitions a WHERE a.completed_at=(SELECT MAX(b.completed_at) FROM acquisitions b WHERE b.source_id=a.source_id) ORDER BY a.source_id""").fetchall()
    return [dict(r) for r in rows]
