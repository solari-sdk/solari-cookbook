from __future__ import annotations

import ipaddress
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, Field

from app.storage import DB_PATH, connect

ObservableType = Literal["domain", "ip", "url", "email", "username", "phone", "hash", "other"]

OBSERVABLE_SCHEMA = """
CREATE TABLE IF NOT EXISTS observables (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    canonical_value TEXT NOT NULL,
    first_seen TEXT,
    last_seen TEXT,
    confidence REAL NOT NULL,
    properties_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(type, canonical_value)
);
CREATE TABLE IF NOT EXISTS observable_links (
    observable_id TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(observable_id, object_type, object_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_observable_type_value ON observables(type, canonical_value);
CREATE INDEX IF NOT EXISTS idx_observable_links_object ON observable_links(object_type, object_id);
"""


class ObservableRecord(BaseModel):
    id: str
    type: ObservableType
    value: str
    canonical_value: str
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    properties: dict[str, Any] = Field(default_factory=dict)


def _db(path: Path = DB_PATH):
    db = connect(path)
    db.executescript(OBSERVABLE_SCHEMA)
    return db


def canonicalize_observable(observable_type: ObservableType, value: str) -> str:
    clean = value.strip()
    if not clean:
        raise ValueError("observable value is required")
    if observable_type == "domain":
        return clean.rstrip(".").lower().encode("idna").decode("ascii")
    if observable_type == "ip":
        return str(ipaddress.ip_address(clean))
    if observable_type == "url":
        parsed = urlsplit(clean)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            raise ValueError("URL observable must use HTTP or HTTPS with a hostname")
        hostname = parsed.hostname.rstrip(".").lower().encode("idna").decode("ascii")
        port = parsed.port
        default_port = 80 if parsed.scheme.lower() == "http" else 443
        netloc = hostname if port in (None, default_port) else f"{hostname}:{port}"
        return urlunsplit((parsed.scheme.lower(), netloc, parsed.path or "/", parsed.query, ""))
    if observable_type == "email":
        local, separator, domain = clean.rpartition("@")
        if not separator or not local or not domain:
            raise ValueError("invalid email observable")
        return f"{local}@{domain.rstrip('.').lower().encode('idna').decode('ascii')}"
    if observable_type == "hash":
        return clean.lower()
    return clean.casefold() if observable_type == "username" else clean


def make_observable(
    observable_type: ObservableType,
    value: str,
    *,
    first_seen: datetime | None = None,
    last_seen: datetime | None = None,
    confidence: float = 1.0,
    properties: dict[str, Any] | None = None,
) -> ObservableRecord:
    canonical = canonicalize_observable(observable_type, value)
    digest = sha256(f"observable|{observable_type}|{canonical}".encode("utf-8")).hexdigest()
    return ObservableRecord(id=digest, type=observable_type, value=value.strip(), canonical_value=canonical, first_seen=first_seen, last_seen=last_seen, confidence=confidence, properties=properties or {})


def save_observable(record: ObservableRecord, *, path: Path = DB_PATH) -> dict[str, object]:
    import json

    now = datetime.now(timezone.utc).isoformat()
    with _db(path) as db:
        db.execute(
            "INSERT INTO observables (id,type,value,canonical_value,first_seen,last_seen,confidence,properties_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(type,canonical_value) DO UPDATE SET value=excluded.value,first_seen=COALESCE(observables.first_seen,excluded.first_seen),last_seen=COALESCE(excluded.last_seen,observables.last_seen),confidence=excluded.confidence,properties_json=excluded.properties_json,updated_at=excluded.updated_at",
            (record.id, record.type, record.value, record.canonical_value, record.first_seen.isoformat() if record.first_seen else None, record.last_seen.isoformat() if record.last_seen else None, record.confidence, json.dumps(record.properties, sort_keys=True), now, now),
        )
        row = db.execute("SELECT * FROM observables WHERE type=? AND canonical_value=?", (record.type, record.canonical_value)).fetchone()
    return _decode(row)


def _decode(row) -> dict[str, object]:
    import json

    item = dict(row)
    item["properties"] = json.loads(item.pop("properties_json"))
    return item


def list_observables(*, observable_type: str | None = None, query: str | None = None, limit: int = 500, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses: list[str] = []
    values: list[object] = []
    if observable_type:
        clauses.append("type=?")
        values.append(observable_type)
    if query:
        clauses.append("(value LIKE ? OR canonical_value LIKE ? OR properties_json LIKE ?)")
        values.extend([f"%{query}%"] * 3)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with _db(path) as db:
        rows = db.execute(f"SELECT * FROM observables {where} ORDER BY COALESCE(last_seen,first_seen,updated_at) DESC,id LIMIT ?", values).fetchall()
    return [_decode(row) for row in rows]


def link_observable(observable_id: str, object_type: str, object_id: str, *, relation: str = "observed_in", path: Path = DB_PATH) -> dict[str, object]:
    if object_type not in {"case", "event", "entity", "relationship", "artifact", "acquisition"}:
        raise ValueError("unsupported observable link type")
    now = datetime.now(timezone.utc).isoformat()
    with _db(path) as db:
        if not db.execute("SELECT 1 FROM observables WHERE id=?", (observable_id,)).fetchone():
            raise KeyError("observable not found")
        db.execute("INSERT OR IGNORE INTO observable_links (observable_id,object_type,object_id,relation,created_at) VALUES (?,?,?,?,?)", (observable_id, object_type, object_id, relation, now))
    return {"observable_id": observable_id, "object_type": object_type, "object_id": object_id, "relation": relation, "created_at": now}


def observable_links(observable_id: str, *, path: Path = DB_PATH) -> list[dict[str, object]]:
    with _db(path) as db:
        rows = db.execute("SELECT object_type,object_id,relation,created_at FROM observable_links WHERE observable_id=? ORDER BY object_type,object_id,relation", (observable_id,)).fetchall()
    return [dict(row) for row in rows]
