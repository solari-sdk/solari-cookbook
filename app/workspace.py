from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from app.contracts import CaseRecord
from app.storage import DB_PATH, connect

Disposition = Literal["unreviewed", "true_positive", "false_positive", "suspicious"]
ListState = Literal["none", "allowlist", "blocklist"]

WORKSPACE_SCHEMA = """
CREATE TABLE IF NOT EXISTS case_activity (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    actor TEXT,
    action TEXT NOT NULL,
    object_type TEXT,
    object_id TEXT,
    note TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analyst_annotations (
    id TEXT PRIMARY KEY,
    case_id TEXT,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    author TEXT,
    body TEXT NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'unreviewed',
    list_state TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(case_id, object_type, object_id)
);
CREATE TABLE IF NOT EXISTS case_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    notes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_attachments (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source_url TEXT,
    acquisition_id TEXT,
    artifact_sha256 TEXT,
    mime_type TEXT,
    note TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_links (
    evidence_id TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(evidence_id, object_type, object_id)
);
CREATE TABLE IF NOT EXISTS correction_overlays (
    id TEXT PRIMARY KEY,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    field TEXT NOT NULL,
    original_json TEXT,
    corrected_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    author TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS validation_errors (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    acquisition_id TEXT,
    record_ref TEXT,
    error_type TEXT NOT NULL,
    error_message TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS source_reliability (
    source_id TEXT PRIMARY KEY,
    score REAL NOT NULL,
    reason TEXT,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppression_rules (
    id TEXT PRIMARY KEY,
    match_type TEXT NOT NULL,
    pattern TEXT NOT NULL,
    reason TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_activity_case ON case_activity(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_object ON analyst_annotations(object_type, object_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_case ON analyst_annotations(case_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_case ON bookmarks(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_case ON evidence_attachments(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_links_object ON evidence_links(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_corrections_object ON correction_overlays(object_type, object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_source ON validation_errors(source_id, resolved_at, created_at DESC);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _workspace_db(path: Path = DB_PATH):
    db = connect(path)
    db.executescript(WORKSPACE_SCHEMA)
    return db


def _require_case(db, case_id: str) -> None:
    if not db.execute("SELECT 1 FROM cases WHERE id=?", (case_id,)).fetchone():
        raise KeyError("case not found")


def record_activity(
    case_id: str,
    action: str,
    *,
    actor: str | None = None,
    object_type: str | None = None,
    object_id: str | None = None,
    note: str | None = None,
    path: Path = DB_PATH,
) -> dict[str, object]:
    if not action.strip():
        raise ValueError("action is required")
    item = {
        "id": uuid4().hex,
        "case_id": case_id,
        "actor": actor,
        "action": action.strip(),
        "object_type": object_type,
        "object_id": object_id,
        "note": note,
        "created_at": utc_now(),
    }
    with _workspace_db(path) as db:
        _require_case(db, case_id)
        db.execute(
            "INSERT INTO case_activity (id,case_id,actor,action,object_type,object_id,note,created_at) VALUES (?,?,?,?,?,?,?,?)",
            tuple(item[key] for key in ("id", "case_id", "actor", "action", "object_type", "object_id", "note", "created_at")),
        )
    return item


def list_case_activity(case_id: str, limit: int = 500, path: Path = DB_PATH) -> list[dict[str, object]]:
    with _workspace_db(path) as db:
        _require_case(db, case_id)
        rows = db.execute(
            "SELECT * FROM case_activity WHERE case_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
            (case_id, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def create_annotation(
    object_type: str,
    object_id: str,
    body: str,
    *,
    case_id: str | None = None,
    author: str | None = None,
    disposition: Disposition = "unreviewed",
    list_state: ListState = "none",
    path: Path = DB_PATH,
) -> dict[str, object]:
    if not object_type.strip() or not object_id.strip() or not body.strip():
        raise ValueError("object_type, object_id and body are required")
    if disposition not in {"unreviewed", "true_positive", "false_positive", "suspicious"}:
        raise ValueError("unsupported disposition")
    if list_state not in {"none", "allowlist", "blocklist"}:
        raise ValueError("unsupported list_state")
    now = utc_now()
    item = {
        "id": uuid4().hex,
        "case_id": case_id,
        "object_type": object_type.strip(),
        "object_id": object_id.strip(),
        "author": author,
        "body": body.strip(),
        "disposition": disposition,
        "list_state": list_state,
        "created_at": now,
        "updated_at": now,
    }
    with _workspace_db(path) as db:
        if case_id:
            _require_case(db, case_id)
        db.execute(
            "INSERT INTO analyst_annotations (id,case_id,object_type,object_id,author,body,disposition,list_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            tuple(item[key] for key in ("id", "case_id", "object_type", "object_id", "author", "body", "disposition", "list_state", "created_at", "updated_at")),
        )
    if case_id:
        record_activity(case_id, "annotation_added", actor=author, object_type=object_type, object_id=object_id, path=path)
    return item


def list_annotations(
    *,
    object_type: str | None = None,
    object_id: str | None = None,
    case_id: str | None = None,
    disposition: str | None = None,
    list_state: str | None = None,
    limit: int = 500,
    path: Path = DB_PATH,
) -> list[dict[str, object]]:
    clauses: list[str] = []
    values: list[Any] = []
    for column, value in (("object_type", object_type), ("object_id", object_id), ("case_id", case_id), ("disposition", disposition), ("list_state", list_state)):
        if value is not None:
            clauses.append(f"{column}=?")
            values.append(value)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with _workspace_db(path) as db:
        rows = db.execute(f"SELECT * FROM analyst_annotations {where} ORDER BY updated_at DESC,id DESC LIMIT ?", values).fetchall()
    return [dict(row) for row in rows]


def create_bookmark(case_id: str, object_type: str, object_id: str, *, label: str | None = None, path: Path = DB_PATH) -> dict[str, object]:
    now = utc_now()
    item = {"id": uuid4().hex, "case_id": case_id, "object_type": object_type, "object_id": object_id, "label": label, "created_at": now}
    with _workspace_db(path) as db:
        _require_case(db, case_id)
        existing = db.execute("SELECT * FROM bookmarks WHERE case_id=? AND object_type=? AND object_id=?", (case_id, object_type, object_id)).fetchone()
        if existing:
            return dict(existing)
        db.execute("INSERT INTO bookmarks (id,case_id,object_type,object_id,label,created_at) VALUES (?,?,?,?,?,?)", (item["id"], case_id, object_type, object_id, label, now))
    record_activity(case_id, "bookmark_added", object_type=object_type, object_id=object_id, note=label, path=path)
    return item


def list_bookmarks(case_id: str, path: Path = DB_PATH) -> list[dict[str, object]]:
    with _workspace_db(path) as db:
        _require_case(db, case_id)
        rows = db.execute("SELECT * FROM bookmarks WHERE case_id=? ORDER BY created_at DESC,id DESC", (case_id,)).fetchall()
    return [dict(row) for row in rows]


def save_case_template(
    template_id: str,
    name: str,
    *,
    status: str = "open",
    priority: str = "normal",
    tags: list[str] | None = None,
    notes: str = "",
    path: Path = DB_PATH,
) -> dict[str, object]:
    now = utc_now()
    if status not in {"open", "paused", "closed", "archived"}:
        raise ValueError("unsupported case status")
    if priority not in {"low", "normal", "high", "critical"}:
        raise ValueError("unsupported case priority")
    item = {"id": template_id, "name": name, "status": status, "priority": priority, "tags": tags or [], "notes": notes, "updated_at": now}
    with _workspace_db(path) as db:
        existing = db.execute("SELECT created_at FROM case_templates WHERE id=?", (template_id,)).fetchone()
        created_at = existing["created_at"] if existing else now
        db.execute(
            "INSERT INTO case_templates (id,name,status,priority,tags_json,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,priority=excluded.priority,tags_json=excluded.tags_json,notes=excluded.notes,updated_at=excluded.updated_at",
            (template_id, name, status, priority, json.dumps(tags or [], sort_keys=True), notes, created_at, now),
        )
    return {**item, "created_at": created_at}


def list_case_templates(path: Path = DB_PATH) -> list[dict[str, object]]:
    with _workspace_db(path) as db:
        rows = db.execute("SELECT * FROM case_templates ORDER BY name,id").fetchall()
    output: list[dict[str, object]] = []
    for row in rows:
        item = dict(row)
        item["tags"] = json.loads(item.pop("tags_json"))
        output.append(item)
    return output


def create_case_from_template(template_id: str, case_id: str, title: str, *, owner: str | None = None, path: Path = DB_PATH) -> dict[str, object]:
    with _workspace_db(path) as db:
        row = db.execute("SELECT * FROM case_templates WHERE id=?", (template_id,)).fetchone()
        if not row:
            raise KeyError("case template not found")
        now = datetime.now(timezone.utc)
        case = CaseRecord(
            id=case_id,
            title=title,
            status=row["status"],
            priority=row["priority"],
            owner=owner,
            tags=json.loads(row["tags_json"]),
            notes=row["notes"],
            created_at=now,
            updated_at=now,
        )
        db.execute(
            "INSERT INTO cases (id,title,status,priority,owner,tags_json,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (case.id, case.title, case.status, case.priority, case.owner, json.dumps(case.tags, sort_keys=True), case.notes, case.created_at.isoformat(), case.updated_at.isoformat()),
        )
    record_activity(case_id, "case_created_from_template", actor=owner, note=template_id, path=path)
    return case.model_dump(mode="json")


def clone_case(source_case_id: str, new_case_id: str, new_title: str, *, owner: str | None = None, note: str | None = None, path: Path = DB_PATH) -> dict[str, object]:
    with _workspace_db(path) as db:
        source = db.execute("SELECT * FROM cases WHERE id=?", (source_case_id,)).fetchone()
        if not source:
            raise KeyError("source case not found")
        if db.execute("SELECT 1 FROM cases WHERE id=?", (new_case_id,)).fetchone():
            raise ValueError("new case id already exists")
        now = utc_now()
        db.execute(
            "INSERT INTO cases (id,title,status,priority,owner,tags_json,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (new_case_id, new_title, "open", source["priority"], owner if owner is not None else source["owner"], source["tags_json"], source["notes"], now, now),
        )
        rows = db.execute("SELECT object_type,object_id FROM case_objects WHERE case_id=?", (source_case_id,)).fetchall()
        for row in rows:
            db.execute("INSERT INTO case_objects (case_id,object_type,object_id,added_at) VALUES (?,?,?,?)", (new_case_id, row["object_type"], row["object_id"], now))
        evidence = db.execute("SELECT * FROM evidence_attachments WHERE case_id=?", (source_case_id,)).fetchall()
        for row in evidence:
            new_evidence_id = uuid4().hex
            db.execute(
                "INSERT INTO evidence_attachments (id,case_id,title,source_url,acquisition_id,artifact_sha256,mime_type,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (new_evidence_id, new_case_id, row["title"], row["source_url"], row["acquisition_id"], row["artifact_sha256"], row["mime_type"], row["note"], now),
            )
            links = db.execute("SELECT object_type,object_id FROM evidence_links WHERE evidence_id=?", (row["id"],)).fetchall()
            for link in links:
                db.execute("INSERT INTO evidence_links (evidence_id,object_type,object_id,created_at) VALUES (?,?,?,?)", (new_evidence_id, link["object_type"], link["object_id"], now))
    record_activity(new_case_id, "case_cloned", actor=owner, object_type="case", object_id=source_case_id, note=note, path=path)
    return {"case_id": new_case_id, "source_case_id": source_case_id, "objects_cloned": len(rows), "evidence_cloned": len(evidence)}


def set_case_archived(case_id: str, archived: bool, *, actor: str | None = None, path: Path = DB_PATH) -> dict[str, object]:
    status = "archived" if archived else "open"
    now = utc_now()
    with _workspace_db(path) as db:
        _require_case(db, case_id)
        db.execute("UPDATE cases SET status=?,updated_at=? WHERE id=?", (status, now, case_id))
    record_activity(case_id, "case_archived" if archived else "case_restored", actor=actor, path=path)
    return {"case_id": case_id, "status": status, "updated_at": now}


def create_evidence_attachment(
    case_id: str,
    title: str,
    *,
    source_url: str | None = None,
    acquisition_id: str | None = None,
    artifact_sha256: str | None = None,
    mime_type: str | None = None,
    note: str | None = None,
    path: Path = DB_PATH,
) -> dict[str, object]:
    if not title.strip():
        raise ValueError("evidence title is required")
    item = {
        "id": uuid4().hex,
        "case_id": case_id,
        "title": title.strip(),
        "source_url": source_url,
        "acquisition_id": acquisition_id,
        "artifact_sha256": artifact_sha256,
        "mime_type": mime_type,
        "note": note,
        "created_at": utc_now(),
    }
    with _workspace_db(path) as db:
        _require_case(db, case_id)
        db.execute(
            "INSERT INTO evidence_attachments (id,case_id,title,source_url,acquisition_id,artifact_sha256,mime_type,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            tuple(item[key] for key in ("id", "case_id", "title", "source_url", "acquisition_id", "artifact_sha256", "mime_type", "note", "created_at")),
        )
    record_activity(case_id, "evidence_attached", object_type="evidence", object_id=str(item["id"]), note=title, path=path)
    return item


def link_evidence(evidence_id: str, object_type: str, object_id: str, path: Path = DB_PATH) -> dict[str, object]:
    if object_type not in {"event", "entity", "relationship"}:
        raise ValueError("unsupported evidence link type")
    now = utc_now()
    with _workspace_db(path) as db:
        evidence = db.execute("SELECT case_id FROM evidence_attachments WHERE id=?", (evidence_id,)).fetchone()
        if not evidence:
            raise KeyError("evidence not found")
        db.execute("INSERT OR IGNORE INTO evidence_links (evidence_id,object_type,object_id,created_at) VALUES (?,?,?,?)", (evidence_id, object_type, object_id, now))
        case_id = evidence["case_id"]
    record_activity(case_id, "evidence_linked", object_type=object_type, object_id=object_id, note=evidence_id, path=path)
    return {"evidence_id": evidence_id, "object_type": object_type, "object_id": object_id, "created_at": now}


def list_evidence_attachments(case_id: str, path: Path = DB_PATH) -> list[dict[str, object]]:
    with _workspace_db(path) as db:
        _require_case(db, case_id)
        rows = db.execute("SELECT * FROM evidence_attachments WHERE case_id=? ORDER BY created_at DESC,id DESC", (case_id,)).fetchall()
        output: list[dict[str, object]] = []
        for row in rows:
            item = dict(row)
            links = db.execute("SELECT object_type,object_id,created_at FROM evidence_links WHERE evidence_id=? ORDER BY object_type,object_id", (row["id"],)).fetchall()
            item["links"] = [dict(link) for link in links]
            output.append(item)
    return output


def add_correction_overlay(
    object_type: str,
    object_id: str,
    field: str,
    corrected_value: object,
    *,
    original_value: object | None = None,
    reason: str,
    author: str | None = None,
    path: Path = DB_PATH,
) -> dict[str, object]:
    if not reason.strip():
        raise ValueError("correction reason is required")
    item = {
        "id": uuid4().hex,
        "object_type": object_type,
        "object_id": object_id,
        "field": field,
        "original_value": original_value,
        "corrected_value": corrected_value,
        "reason": reason.strip(),
        "author": author,
        "created_at": utc_now(),
    }
    with _workspace_db(path) as db:
        db.execute(
            "INSERT INTO correction_overlays (id,object_type,object_id,field,original_json,corrected_json,reason,author,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (item["id"], object_type, object_id, field, json.dumps(original_value, sort_keys=True), json.dumps(corrected_value, sort_keys=True), item["reason"], author, item["created_at"]),
        )
    return item


def list_correction_overlays(object_type: str, object_id: str, path: Path = DB_PATH) -> list[dict[str, object]]:
    with _workspace_db(path) as db:
        rows = db.execute("SELECT * FROM correction_overlays WHERE object_type=? AND object_id=? ORDER BY created_at DESC,id DESC", (object_type, object_id)).fetchall()
    output=[]
    for row in rows:
        item=dict(row)
        item["original_value"]=json.loads(item.pop("original_json"))
        item["corrected_value"]=json.loads(item.pop("corrected_json"))
        output.append(item)
    return output


def record_validation_error(
    source_id: str,
    error_type: str,
    error_message: str,
    *,
    acquisition_id: str | None = None,
    record_ref: str | None = None,
    payload: object | None = None,
    path: Path = DB_PATH,
) -> dict[str, object]:
    item={"id":uuid4().hex,"source_id":source_id,"acquisition_id":acquisition_id,"record_ref":record_ref,"error_type":error_type,"error_message":error_message,"payload":payload,"created_at":utc_now(),"resolved_at":None}
    with _workspace_db(path) as db:
        db.execute("INSERT INTO validation_errors (id,source_id,acquisition_id,record_ref,error_type,error_message,payload_json,created_at,resolved_at) VALUES (?,?,?,?,?,?,?,?,NULL)",(item["id"],source_id,acquisition_id,record_ref,error_type,error_message,json.dumps(payload,sort_keys=True) if payload is not None else None,item["created_at"]))
    return item


def list_validation_errors(*, source_id: str | None = None, unresolved_only: bool = True, limit: int = 500, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses=[]; values: list[Any]=[]
    if source_id: clauses.append("source_id=?"); values.append(source_id)
    if unresolved_only: clauses.append("resolved_at IS NULL")
    where=f"WHERE {' AND '.join(clauses)}" if clauses else ""; values.append(limit)
    with _workspace_db(path) as db:
        rows=db.execute(f"SELECT * FROM validation_errors {where} ORDER BY created_at DESC,id DESC LIMIT ?",values).fetchall()
    output=[]
    for row in rows:
        item=dict(row); raw=item.pop("payload_json"); item["payload"]=json.loads(raw) if raw else None; output.append(item)
    return output


def resolve_validation_error(error_id: str, path: Path = DB_PATH) -> dict[str, object]:
    now=utc_now()
    with _workspace_db(path) as db:
        result=db.execute("UPDATE validation_errors SET resolved_at=? WHERE id=?",(now,error_id))
        if result.rowcount == 0: raise KeyError("validation error not found")
    return {"id":error_id,"resolved_at":now}


def set_source_reliability(source_id: str, score: float, *, reason: str | None = None, path: Path = DB_PATH) -> dict[str, object]:
    if not 0.0 <= score <= 1.0: raise ValueError("score must be between 0 and 1")
    now=utc_now()
    with _workspace_db(path) as db:
        db.execute("INSERT INTO source_reliability (source_id,score,reason,updated_at) VALUES (?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET score=excluded.score,reason=excluded.reason,updated_at=excluded.updated_at",(source_id,score,reason,now))
    return {"source_id":source_id,"score":score,"reason":reason,"updated_at":now}


def list_source_reliability(path: Path = DB_PATH) -> list[dict[str, object]]:
    with _workspace_db(path) as db:
        rows=db.execute("SELECT * FROM source_reliability ORDER BY source_id").fetchall()
    return [dict(row) for row in rows]


def save_suppression_rule(rule_id: str, match_type: str, pattern: str, reason: str, *, enabled: bool = True, path: Path = DB_PATH) -> dict[str, object]:
    if match_type not in {"exact", "substring", "hostname", "cidr", "regex"}: raise ValueError("unsupported suppression match type")
    now=utc_now()
    with _workspace_db(path) as db:
        existing=db.execute("SELECT created_at FROM suppression_rules WHERE id=?",(rule_id,)).fetchone(); created=existing["created_at"] if existing else now
        db.execute("INSERT INTO suppression_rules (id,match_type,pattern,reason,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET match_type=excluded.match_type,pattern=excluded.pattern,reason=excluded.reason,enabled=excluded.enabled,updated_at=excluded.updated_at",(rule_id,match_type,pattern,reason,1 if enabled else 0,created,now))
    return {"id":rule_id,"match_type":match_type,"pattern":pattern,"reason":reason,"enabled":enabled,"created_at":created,"updated_at":now}


def list_suppression_rules(*, enabled_only: bool = False, path: Path = DB_PATH) -> list[dict[str, object]]:
    where="WHERE enabled=1" if enabled_only else ""
    with _workspace_db(path) as db:
        rows=db.execute(f"SELECT * FROM suppression_rules {where} ORDER BY id").fetchall()
    output=[]
    for row in rows:
        item=dict(row); item["enabled"]=bool(item["enabled"]); output.append(item)
    return output


def reproducibility_manifest(case_id: str, path: Path = DB_PATH) -> dict[str, object]:
    with _workspace_db(path) as db:
        case=db.execute("SELECT * FROM cases WHERE id=?",(case_id,)).fetchone()
        if not case: raise KeyError("case not found")
        objects=db.execute("SELECT object_type,object_id,added_at FROM case_objects WHERE case_id=? ORDER BY object_type,object_id",(case_id,)).fetchall()
        event_ids=[row["object_id"] for row in objects if row["object_type"]=="event"]
        source_ids: set[str]=set(); acquisition_ids: set[str]=set(); transformations=[]
        for event_id in event_ids:
            row=db.execute("SELECT source_id,evidence_json FROM events WHERE id=?",(event_id,)).fetchone()
            if not row: continue
            source_ids.add(row["source_id"])
            for evidence in json.loads(row["evidence_json"]):
                acquisition_id=evidence.get("acquisition_id")
                if acquisition_id: acquisition_ids.add(acquisition_id)
                if evidence.get("kind") in {"transformed","inferred"}: transformations.append({"event_id":event_id,**evidence})
        evidence=db.execute("SELECT id,acquisition_id,artifact_sha256,source_url,created_at FROM evidence_attachments WHERE case_id=? ORDER BY id",(case_id,)).fetchall()
        for row in evidence:
            if row["acquisition_id"]: acquisition_ids.add(row["acquisition_id"])
        activity=db.execute("SELECT action,object_type,object_id,created_at FROM case_activity WHERE case_id=? ORDER BY created_at,id",(case_id,)).fetchall()
        case_dict=dict(case); case_dict["tags"]=json.loads(case_dict.pop("tags_json"))
    return {
        "format":"solari-reproducibility-manifest",
        "version":1,
        "generated_at":utc_now(),
        "case":case_dict,
        "source_ids":sorted(source_ids),
        "acquisition_ids":sorted(acquisition_ids),
        "objects":[dict(row) for row in objects],
        "evidence":[dict(row) for row in evidence],
        "transformations":transformations,
        "activity":[dict(row) for row in activity],
    }
