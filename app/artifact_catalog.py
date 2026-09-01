from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.artifacts import DEFAULT_ROOT, ArtifactRecord, load_artifact, store_artifact
from app.storage import DB_PATH, connect

CATALOG_SCHEMA = """
CREATE TABLE IF NOT EXISTS artifact_catalog (
    sha256 TEXT PRIMARY KEY,
    size_bytes INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    original_name TEXT,
    relative_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_accessed_at TEXT,
    retention_until TEXT,
    custody_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_tags (
    sha256 TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY(sha256, tag)
);
CREATE TABLE IF NOT EXISTS artifact_links (
    sha256 TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(sha256, object_type, object_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_artifact_retention ON artifact_catalog(retention_until);
CREATE INDEX IF NOT EXISTS idx_artifact_links_object ON artifact_links(object_type, object_id);
"""

MAX_BUNDLE_BYTES = 200 * 1024 * 1024
MAX_PREVIEW_BYTES = 64 * 1024


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db(path: Path = DB_PATH):
    db = connect(path)
    db.executescript(CATALOG_SCHEMA)
    return db


def _record_from_row(row) -> ArtifactRecord:
    return ArtifactRecord(
        sha256=row["sha256"],
        size_bytes=int(row["size_bytes"]),
        mime_type=row["mime_type"],
        original_name=row["original_name"],
        relative_path=row["relative_path"],
    )


def catalog_artifact(
    record: ArtifactRecord,
    *,
    actor: str | None = None,
    source: str | None = None,
    retention_days: int | None = None,
    path: Path = DB_PATH,
) -> dict[str, object]:
    if retention_days is not None and retention_days < 0:
        raise ValueError("retention_days must be non-negative")
    now = utc_now()
    retention_until = None
    if retention_days is not None:
        retention_until = (datetime.now(timezone.utc) + timedelta(days=retention_days)).isoformat()
    custody = [{"action": "cataloged", "at": now, "actor": actor, "source": source}]
    with _db(path) as db:
        existing = db.execute("SELECT custody_json,created_at FROM artifact_catalog WHERE sha256=?", (record.sha256,)).fetchone()
        created_at = existing["created_at"] if existing else now
        if existing:
            existing_custody = json.loads(existing["custody_json"])
            custody = existing_custody + [{"action": "recataloged", "at": now, "actor": actor, "source": source}]
        db.execute(
            "INSERT INTO artifact_catalog (sha256,size_bytes,mime_type,original_name,relative_path,created_at,last_accessed_at,retention_until,custody_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(sha256) DO UPDATE SET size_bytes=excluded.size_bytes,mime_type=excluded.mime_type,original_name=COALESCE(excluded.original_name,artifact_catalog.original_name),relative_path=excluded.relative_path,retention_until=COALESCE(excluded.retention_until,artifact_catalog.retention_until),custody_json=excluded.custody_json",
            (record.sha256, record.size_bytes, record.mime_type, record.original_name, record.relative_path, created_at, None, retention_until, json.dumps(custody, sort_keys=True)),
        )
    return artifact_metadata(record.sha256, path=path)


def catalog_bytes(
    data: bytes,
    *,
    original_name: str | None = None,
    mime_type: str | None = None,
    actor: str | None = None,
    source: str | None = None,
    retention_days: int | None = None,
    root: Path = DEFAULT_ROOT,
    path: Path = DB_PATH,
) -> dict[str, object]:
    record = store_artifact(data, original_name=original_name, mime_type=mime_type, root=root)
    return catalog_artifact(record, actor=actor, source=source, retention_days=retention_days, path=path)


def artifact_metadata(sha256_digest: str, *, path: Path = DB_PATH) -> dict[str, object]:
    with _db(path) as db:
        row = db.execute("SELECT * FROM artifact_catalog WHERE sha256=?", (sha256_digest,)).fetchone()
        if not row:
            raise KeyError("artifact not found")
        tags = [item["tag"] for item in db.execute("SELECT tag FROM artifact_tags WHERE sha256=? ORDER BY tag", (sha256_digest,)).fetchall()]
        links = [dict(item) for item in db.execute("SELECT object_type,object_id,relation,created_at FROM artifact_links WHERE sha256=? ORDER BY object_type,object_id,relation", (sha256_digest,)).fetchall()]
    item = dict(row)
    item["custody"] = json.loads(item.pop("custody_json"))
    item["tags"] = tags
    item["links"] = links
    return item


def list_artifacts(limit: int = 500, *, tag: str | None = None, object_type: str | None = None, object_id: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses: list[str] = []
    values: list[Any] = []
    joins = ""
    if tag:
        joins += " JOIN artifact_tags t ON t.sha256=a.sha256"
        clauses.append("t.tag=?")
        values.append(tag)
    if object_type or object_id:
        joins += " JOIN artifact_links l ON l.sha256=a.sha256"
        if object_type:
            clauses.append("l.object_type=?")
            values.append(object_type)
        if object_id:
            clauses.append("l.object_id=?")
            values.append(object_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with _db(path) as db:
        rows = db.execute(f"SELECT DISTINCT a.* FROM artifact_catalog a{joins} {where} ORDER BY a.created_at DESC,a.sha256 LIMIT ?", values).fetchall()
    return [artifact_metadata(row["sha256"], path=path) for row in rows]


def tag_artifact(sha256_digest: str, tag: str, *, path: Path = DB_PATH) -> dict[str, object]:
    clean = tag.strip().lower()
    if not clean or len(clean) > 100:
        raise ValueError("tag must be 1-100 characters")
    with _db(path) as db:
        if not db.execute("SELECT 1 FROM artifact_catalog WHERE sha256=?", (sha256_digest,)).fetchone():
            raise KeyError("artifact not found")
        db.execute("INSERT OR IGNORE INTO artifact_tags (sha256,tag) VALUES (?,?)", (sha256_digest, clean))
    return artifact_metadata(sha256_digest, path=path)


def link_artifact(sha256_digest: str, object_type: str, object_id: str, *, relation: str = "evidence", path: Path = DB_PATH) -> dict[str, object]:
    if object_type not in {"case", "event", "entity", "relationship", "acquisition", "execution"}:
        raise ValueError("unsupported artifact link type")
    if not object_id.strip() or not relation.strip():
        raise ValueError("object_id and relation are required")
    now = utc_now()
    with _db(path) as db:
        row = db.execute("SELECT custody_json FROM artifact_catalog WHERE sha256=?", (sha256_digest,)).fetchone()
        if not row:
            raise KeyError("artifact not found")
        db.execute("INSERT OR IGNORE INTO artifact_links (sha256,object_type,object_id,relation,created_at) VALUES (?,?,?,?,?)", (sha256_digest, object_type, object_id, relation, now))
        custody = json.loads(row["custody_json"])
        custody.append({"action": "linked", "at": now, "object_type": object_type, "object_id": object_id, "relation": relation})
        db.execute("UPDATE artifact_catalog SET custody_json=? WHERE sha256=?", (json.dumps(custody, sort_keys=True), sha256_digest))
    return artifact_metadata(sha256_digest, path=path)


def set_artifact_retention(sha256_digest: str, *, retention_days: int | None, path: Path = DB_PATH) -> dict[str, object]:
    if retention_days is not None and retention_days < 0:
        raise ValueError("retention_days must be non-negative")
    until = None if retention_days is None else (datetime.now(timezone.utc) + timedelta(days=retention_days)).isoformat()
    now = utc_now()
    with _db(path) as db:
        row = db.execute("SELECT custody_json FROM artifact_catalog WHERE sha256=?", (sha256_digest,)).fetchone()
        if not row:
            raise KeyError("artifact not found")
        custody = json.loads(row["custody_json"])
        custody.append({"action": "retention_changed", "at": now, "retention_until": until})
        db.execute("UPDATE artifact_catalog SET retention_until=?,custody_json=? WHERE sha256=?", (until, json.dumps(custody, sort_keys=True), sha256_digest))
    return artifact_metadata(sha256_digest, path=path)


def load_cataloged_artifact(sha256_digest: str, *, root: Path = DEFAULT_ROOT, path: Path = DB_PATH) -> tuple[ArtifactRecord, bytes]:
    with _db(path) as db:
        row = db.execute("SELECT * FROM artifact_catalog WHERE sha256=?", (sha256_digest,)).fetchone()
        if not row:
            raise KeyError("artifact not found")
        record = _record_from_row(row)
    data = load_artifact(record, root=root)
    now = utc_now()
    with _db(path) as db:
        row = db.execute("SELECT custody_json FROM artifact_catalog WHERE sha256=?", (sha256_digest,)).fetchone()
        custody = json.loads(row["custody_json"])
        custody.append({"action": "accessed", "at": now})
        db.execute("UPDATE artifact_catalog SET last_accessed_at=?,custody_json=? WHERE sha256=?", (now, json.dumps(custody, sort_keys=True), sha256_digest))
    return record, data


def artifact_preview(sha256_digest: str, *, root: Path = DEFAULT_ROOT, path: Path = DB_PATH) -> dict[str, object]:
    record, data = load_cataloged_artifact(sha256_digest, root=root, path=path)
    textual = record.mime_type.startswith("text/") or record.mime_type in {"application/json", "application/xml", "application/geo+json"}
    preview = None
    truncated = len(data) > MAX_PREVIEW_BYTES
    if textual:
        preview = data[:MAX_PREVIEW_BYTES].decode("utf-8", errors="replace")
    return {"artifact": artifact_metadata(sha256_digest, path=path), "preview_text": preview, "truncated": truncated, "previewable": textual}


def expired_artifacts(*, now: datetime | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    now = now or datetime.now(timezone.utc)
    with _db(path) as db:
        rows = db.execute("SELECT sha256 FROM artifact_catalog WHERE retention_until IS NOT NULL AND retention_until<=? ORDER BY retention_until,sha256", (now.isoformat(),)).fetchall()
    return [artifact_metadata(row["sha256"], path=path) for row in rows]


def cleanup_expired_artifacts(*, dry_run: bool = True, now: datetime | None = None, root: Path = DEFAULT_ROOT, path: Path = DB_PATH) -> dict[str, object]:
    expired = expired_artifacts(now=now, path=path)
    if dry_run:
        return {"dry_run": True, "expired": [item["sha256"] for item in expired], "deleted": []}
    deleted: list[str] = []
    root_resolved = root.resolve()
    with _db(path) as db:
        for item in expired:
            artifact_path = (root / str(item["relative_path"])).resolve()
            if root_resolved not in artifact_path.parents:
                raise ValueError("artifact path escapes store root")
            if artifact_path.exists():
                artifact_path.unlink()
            digest = str(item["sha256"])
            db.execute("DELETE FROM artifact_tags WHERE sha256=?", (digest,))
            db.execute("DELETE FROM artifact_links WHERE sha256=?", (digest,))
            db.execute("DELETE FROM artifact_catalog WHERE sha256=?", (digest,))
            deleted.append(digest)
    return {"dry_run": False, "expired": [item["sha256"] for item in expired], "deleted": deleted}


def build_evidence_bundle(sha256_digests: list[str], *, root: Path = DEFAULT_ROOT, path: Path = DB_PATH) -> bytes:
    unique = sorted(set(sha256_digests))
    records: list[dict[str, object]] = []
    total = 0
    payloads: list[tuple[ArtifactRecord, bytes]] = []
    for digest in unique:
        record, data = load_cataloged_artifact(digest, root=root, path=path)
        total += len(data)
        if total > MAX_BUNDLE_BYTES:
            raise ValueError("evidence bundle exceeds 200 MiB safety limit")
        payloads.append((record, data))
        records.append(artifact_metadata(digest, path=path))
    manifest = {"format": "solari-evidence-bundle", "version": 1, "created_at": utc_now(), "artifacts": records}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, indent=2, sort_keys=True))
        for record, data in payloads:
            archive.writestr(f"artifacts/{record.sha256}", data)
    return buffer.getvalue()
