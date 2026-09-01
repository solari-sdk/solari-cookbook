from __future__ import annotations

import json
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from app.storage import DB_PATH, connect

COLLAB_SCHEMA = """
CREATE TABLE IF NOT EXISTS analyst_audit (
    id TEXT PRIMARY KEY, actor TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT,
    correlation_id TEXT, before_hash TEXT, after_hash TEXT, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_views (
    id TEXT PRIMARY KEY, case_id TEXT, name TEXT NOT NULL, owner TEXT, state_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS case_assignments (
    case_id TEXT NOT NULL, assignee TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(case_id, assignee)
);
CREATE TABLE IF NOT EXISTS handoff_notes (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL, author TEXT, recipient TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_decisions (
    id TEXT PRIMARY KEY, case_id TEXT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, reviewer TEXT,
    decision TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyst_audit_target ON analyst_audit(target_type,target_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_views_case ON saved_views(case_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignments_queue ON case_assignments(assignee,status,priority,updated_at);
CREATE INDEX IF NOT EXISTS idx_handoff_case ON handoff_notes(case_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_object ON review_decisions(object_type,object_id,created_at DESC);
"""

Decision = Literal["approved", "rejected", "needs_changes"]
AssignmentStatus = Literal["queued", "in_progress", "blocked", "done"]
_SENSITIVE_KEYS = {"password", "secret", "token", "api_key", "apikey", "cookie", "authorization", "session"}


def _db(path: Path = DB_PATH):
    db = connect(path)
    db.executescript(COLLAB_SCHEMA)
    return db


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(value: object | None) -> str | None:
    if value is None:
        return None
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")
    return sha256(encoded).hexdigest()


def _assert_shareable(value: object, *, path: str = "state") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).casefold().replace("-", "_")
            if normalized in _SENSITIVE_KEYS or any(term in normalized for term in ("password", "secret", "token", "cookie")):
                raise ValueError(f"saved view contains prohibited sensitive field: {path}.{key}")
            _assert_shareable(child, path=f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _assert_shareable(child, path=f"{path}[{index}]")


def record_audit(
    action: str,
    *,
    actor: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    correlation_id: str | None = None,
    before: object | None = None,
    after: object | None = None,
    detail: dict[str, Any] | None = None,
    path: Path = DB_PATH,
) -> dict[str, object]:
    if not action.strip():
        raise ValueError("audit action is required")
    item = {
        "id": uuid4().hex, "actor": actor, "action": action.strip(), "target_type": target_type,
        "target_id": target_id, "correlation_id": correlation_id, "before_hash": _hash(before),
        "after_hash": _hash(after), "detail": detail or {}, "created_at": _now(),
    }
    with _db(path) as db:
        db.execute("INSERT INTO analyst_audit (id,actor,action,target_type,target_id,correlation_id,before_hash,after_hash,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", (item["id"],actor,item["action"],target_type,target_id,correlation_id,item["before_hash"],item["after_hash"],json.dumps(item["detail"],sort_keys=True),item["created_at"]))
    return item


def list_audit(*, target_type: str | None = None, target_id: str | None = None, limit: int = 500, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses=[]; values: list[object]=[]
    if target_type: clauses.append("target_type=?"); values.append(target_type)
    if target_id: clauses.append("target_id=?"); values.append(target_id)
    where=f"WHERE {' AND '.join(clauses)}" if clauses else ""; values.append(limit)
    with _db(path) as db: rows=db.execute(f"SELECT * FROM analyst_audit {where} ORDER BY created_at DESC,id DESC LIMIT ?",values).fetchall()
    output=[]
    for row in rows:
        item=dict(row); item["detail"]=json.loads(item.pop("detail_json")); output.append(item)
    return output


def save_view(view_id: str, name: str, state: dict[str, Any], *, case_id: str | None = None, owner: str | None = None, path: Path = DB_PATH) -> dict[str, object]:
    if not view_id.strip() or not name.strip(): raise ValueError("view id and name are required")
    _assert_shareable(state)
    now=_now()
    with _db(path) as db:
        existing=db.execute("SELECT created_at FROM saved_views WHERE id=?",(view_id,)).fetchone(); created=existing["created_at"] if existing else now
        db.execute("INSERT INTO saved_views (id,case_id,name,owner,state_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET case_id=excluded.case_id,name=excluded.name,owner=excluded.owner,state_json=excluded.state_json,updated_at=excluded.updated_at",(view_id,case_id,name,owner,json.dumps(state,sort_keys=True),created,now))
    return {"id":view_id,"case_id":case_id,"name":name,"owner":owner,"state":state,"created_at":created,"updated_at":now}


def list_views(*, case_id: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    where="WHERE case_id=?" if case_id else ""; values=[case_id] if case_id else []
    with _db(path) as db: rows=db.execute(f"SELECT * FROM saved_views {where} ORDER BY updated_at DESC,id",values).fetchall()
    output=[]
    for row in rows:
        item=dict(row); item["state"]=json.loads(item.pop("state_json")); output.append(item)
    return output


def assign_case(case_id: str, assignee: str, *, status: AssignmentStatus="queued", priority: int=100, path: Path=DB_PATH) -> dict[str, object]:
    if status not in {"queued","in_progress","blocked","done"}: raise ValueError("unsupported assignment status")
    if not case_id.strip() or not assignee.strip(): raise ValueError("case_id and assignee are required")
    now=_now()
    with _db(path) as db:
        if not db.execute("SELECT 1 FROM cases WHERE id=?",(case_id,)).fetchone(): raise KeyError("case not found")
        existing=db.execute("SELECT created_at FROM case_assignments WHERE case_id=? AND assignee=?",(case_id,assignee)).fetchone(); created=existing["created_at"] if existing else now
        db.execute("INSERT INTO case_assignments (case_id,assignee,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(case_id,assignee) DO UPDATE SET status=excluded.status,priority=excluded.priority,updated_at=excluded.updated_at",(case_id,assignee,status,priority,created,now))
    return {"case_id":case_id,"assignee":assignee,"status":status,"priority":priority,"created_at":created,"updated_at":now}


def work_queue(assignee: str, *, include_done: bool=False, path: Path=DB_PATH) -> list[dict[str, object]]:
    where="WHERE assignee=?" if include_done else "WHERE assignee=? AND status!='done'"
    with _db(path) as db: rows=db.execute(f"SELECT * FROM case_assignments {where} ORDER BY priority ASC,updated_at ASC,case_id",(assignee,)).fetchall()
    return [dict(row) for row in rows]


def add_handoff(case_id: str, body: str, *, author: str | None=None, recipient: str | None=None, path: Path=DB_PATH) -> dict[str, object]:
    if not body.strip(): raise ValueError("handoff body is required")
    item={"id":uuid4().hex,"case_id":case_id,"author":author,"recipient":recipient,"body":body.strip(),"created_at":_now()}
    with _db(path) as db:
        if not db.execute("SELECT 1 FROM cases WHERE id=?",(case_id,)).fetchone(): raise KeyError("case not found")
        db.execute("INSERT INTO handoff_notes (id,case_id,author,recipient,body,created_at) VALUES (?,?,?,?,?,?)",tuple(item[key] for key in ("id","case_id","author","recipient","body","created_at")))
    return item


def list_handoffs(case_id: str, *, path: Path=DB_PATH) -> list[dict[str, object]]:
    with _db(path) as db: rows=db.execute("SELECT * FROM handoff_notes WHERE case_id=? ORDER BY created_at DESC,id DESC",(case_id,)).fetchall()
    return [dict(row) for row in rows]


def record_review(object_type: str, object_id: str, decision: Decision, *, case_id: str | None=None, reviewer: str | None=None, note: str | None=None, path: Path=DB_PATH) -> dict[str, object]:
    if decision not in {"approved","rejected","needs_changes"}: raise ValueError("unsupported review decision")
    item={"id":uuid4().hex,"case_id":case_id,"object_type":object_type,"object_id":object_id,"reviewer":reviewer,"decision":decision,"note":note,"created_at":_now()}
    with _db(path) as db: db.execute("INSERT INTO review_decisions (id,case_id,object_type,object_id,reviewer,decision,note,created_at) VALUES (?,?,?,?,?,?,?,?)",tuple(item[key] for key in ("id","case_id","object_type","object_id","reviewer","decision","note","created_at")))
    return item


def list_reviews(object_type: str, object_id: str, *, path: Path=DB_PATH) -> list[dict[str, object]]:
    with _db(path) as db: rows=db.execute("SELECT * FROM review_decisions WHERE object_type=? AND object_id=? ORDER BY created_at DESC,id DESC",(object_type,object_id)).fetchall()
    return [dict(row) for row in rows]
