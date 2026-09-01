from __future__ import annotations

import ipaddress
import json
import socket
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from uuid import uuid4

from app.storage import DB_PATH, connect

ALERT_SCHEMA = """
CREATE TABLE IF NOT EXISTS watch_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    config_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT,
    acknowledged_by TEXT,
    status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS idx_watch_rules_type ON watch_rules(rule_type,enabled);
CREATE INDEX IF NOT EXISTS idx_alerts_rule_created ON alerts(rule_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_fingerprint ON alerts(rule_id,fingerprint,created_at DESC);
"""

SEVERITY_ORDER = {"info": 0, "low": 1, "moderate": 2, "medium": 2, "high": 3, "severe": 4, "critical": 5, "extreme": 5}
RULE_TYPES = {"source", "category", "severity", "geo", "entity", "observable", "correlation", "change"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db(path: Path = DB_PATH):
    db = connect(path)
    db.executescript(ALERT_SCHEMA)
    return db


def save_watch_rule(rule_id: str, name: str, rule_type: str, config: dict[str, Any], *, enabled: bool = True, path: Path = DB_PATH) -> dict[str, object]:
    if rule_type not in RULE_TYPES:
        raise ValueError("unsupported watch rule type")
    if not name.strip():
        raise ValueError("watch rule name is required")
    _validate_rule_config(rule_type, config)
    now = utc_now()
    with _db(path) as db:
        existing = db.execute("SELECT created_at FROM watch_rules WHERE id=?", (rule_id,)).fetchone()
        created = existing["created_at"] if existing else now
        db.execute(
            "INSERT INTO watch_rules (id,name,rule_type,config_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,rule_type=excluded.rule_type,config_json=excluded.config_json,enabled=excluded.enabled,updated_at=excluded.updated_at",
            (rule_id, name.strip(), rule_type, json.dumps(config, sort_keys=True), 1 if enabled else 0, created, now),
        )
    return {"id": rule_id, "name": name.strip(), "rule_type": rule_type, "config": config, "enabled": enabled, "created_at": created, "updated_at": now}


def _validate_rule_config(rule_type: str, config: dict[str, Any]) -> None:
    required = {
        "source": {"source_id"},
        "category": {"category"},
        "severity": {"minimum"},
        "geo": {"min_lat", "max_lat", "min_lon", "max_lon"},
        "entity": {"entity_id"},
        "observable": {"value"},
        "correlation": {"minimum_score"},
        "change": {"fields"},
    }[rule_type]
    missing = [key for key in required if key not in config]
    if missing:
        raise ValueError(f"missing watch config keys: {', '.join(sorted(missing))}")
    if rule_type == "severity" and str(config["minimum"]).lower() not in SEVERITY_ORDER:
        raise ValueError("unsupported severity threshold")
    if rule_type == "geo":
        min_lat, max_lat = float(config["min_lat"]), float(config["max_lat"])
        min_lon, max_lon = float(config["min_lon"]), float(config["max_lon"])
        if not (-90 <= min_lat <= max_lat <= 90 and -180 <= min_lon <= max_lon <= 180):
            raise ValueError("invalid geographic watch bounds")
    if rule_type == "correlation" and not 0 <= float(config["minimum_score"]) <= 1:
        raise ValueError("minimum_score must be between 0 and 1")
    if rule_type == "change" and not isinstance(config["fields"], list):
        raise ValueError("change fields must be a list")


def list_watch_rules(*, enabled_only: bool = False, rule_type: str | None = None, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses: list[str] = []
    values: list[Any] = []
    if enabled_only:
        clauses.append("enabled=1")
    if rule_type:
        clauses.append("rule_type=?")
        values.append(rule_type)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with _db(path) as db:
        rows = db.execute(f"SELECT * FROM watch_rules {where} ORDER BY name,id", values).fetchall()
    output=[]
    for row in rows:
        item=dict(row); item["config"]=json.loads(item.pop("config_json")); item["enabled"]=bool(item["enabled"]); output.append(item)
    return output


def _matches_event(rule: dict[str, object], event: dict[str, Any]) -> bool:
    kind = str(rule["rule_type"])
    config = dict(rule["config"])
    if kind == "source":
        return str(event.get("source_id")) == str(config["source_id"])
    if kind == "category":
        return str(event.get("category")) == str(config["category"])
    if kind == "severity":
        actual = SEVERITY_ORDER.get(str(event.get("severity") or "info").lower(), 0)
        threshold = SEVERITY_ORDER[str(config["minimum"]).lower()]
        return actual >= threshold
    if kind == "geo":
        lat = event.get("latitude")
        lon = event.get("longitude")
        if lat is None or lon is None:
            location = event.get("location") or {}
            if isinstance(location, dict):
                lat = location.get("latitude")
                lon = location.get("longitude")
        if lat is None or lon is None:
            return False
        return float(config["min_lat"]) <= float(lat) <= float(config["max_lat"]) and float(config["min_lon"]) <= float(lon) <= float(config["max_lon"])
    if kind == "entity":
        entity_ids = event.get("entity_ids") or []
        return str(config["entity_id"]) in {str(value) for value in entity_ids}
    if kind == "observable":
        wanted = str(config["value"]).casefold()
        values = event.get("observables") or []
        return wanted in {str(value).casefold() for value in values}
    return False


def evaluate_event(event: dict[str, Any], *, path: Path = DB_PATH) -> list[dict[str, object]]:
    matches=[]
    for rule in list_watch_rules(enabled_only=True, path=path):
        if rule["rule_type"] in {"source", "category", "severity", "geo", "entity", "observable"} and _matches_event(rule, event):
            matches.append(rule)
    return matches


def evaluate_correlation(score: float, payload: dict[str, Any], *, path: Path = DB_PATH) -> list[dict[str, object]]:
    return [rule for rule in list_watch_rules(enabled_only=True, rule_type="correlation", path=path) if score >= float(dict(rule["config"])["minimum_score"])]


def evaluate_change(previous: dict[str, Any], current: dict[str, Any], *, path: Path = DB_PATH) -> list[dict[str, object]]:
    matches=[]
    for rule in list_watch_rules(enabled_only=True, rule_type="change", path=path):
        fields = [str(field) for field in dict(rule["config"])["fields"]]
        if any(previous.get(field) != current.get(field) for field in fields):
            matches.append(rule)
    return matches


def _fingerprint(rule_id: str, subject_id: str, payload: dict[str, Any]) -> str:
    stable = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return sha256(f"{rule_id}|{subject_id}|{stable}".encode("utf-8")).hexdigest()


def emit_alert(
    rule_id: str,
    subject_id: str,
    title: str,
    payload: dict[str, Any],
    *,
    severity: str = "info",
    suppression_seconds: int = 300,
    now: datetime | None = None,
    path: Path = DB_PATH,
) -> dict[str, object] | None:
    if suppression_seconds < 0:
        raise ValueError("suppression_seconds must be non-negative")
    now = now or datetime.now(timezone.utc)
    fingerprint = _fingerprint(rule_id, subject_id, payload)
    cutoff = (now - timedelta(seconds=suppression_seconds)).isoformat()
    with _db(path) as db:
        if not db.execute("SELECT 1 FROM watch_rules WHERE id=? AND enabled=1", (rule_id,)).fetchone():
            raise KeyError("enabled watch rule not found")
        duplicate = db.execute("SELECT id FROM alerts WHERE rule_id=? AND fingerprint=? AND created_at>=? ORDER BY created_at DESC LIMIT 1", (rule_id, fingerprint, cutoff)).fetchone()
        if duplicate:
            return None
        item = {"id": uuid4().hex, "rule_id": rule_id, "fingerprint": fingerprint, "severity": severity, "title": title, "payload": payload, "created_at": now.isoformat(), "acknowledged_at": None, "acknowledged_by": None, "status": "open"}
        db.execute("INSERT INTO alerts (id,rule_id,fingerprint,severity,title,payload_json,created_at,acknowledged_at,acknowledged_by,status) VALUES (?,?,?,?,?,?,?,NULL,NULL,'open')", (item["id"], rule_id, fingerprint, severity, title, json.dumps(payload, sort_keys=True), item["created_at"]))
    return item


def list_alerts(*, status: str | None = None, rule_id: str | None = None, limit: int = 500, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses=[]; values: list[Any]=[]
    if status: clauses.append("status=?"); values.append(status)
    if rule_id: clauses.append("rule_id=?"); values.append(rule_id)
    where=f"WHERE {' AND '.join(clauses)}" if clauses else ""; values.append(limit)
    with _db(path) as db:
        rows=db.execute(f"SELECT * FROM alerts {where} ORDER BY created_at DESC,id DESC LIMIT ?", values).fetchall()
    output=[]
    for row in rows:
        item=dict(row); item["payload"]=json.loads(item.pop("payload_json")); output.append(item)
    return output


def acknowledge_alert(alert_id: str, *, analyst: str | None = None, status: str = "acknowledged", path: Path = DB_PATH) -> dict[str, object]:
    if status not in {"acknowledged", "resolved", "dismissed"}:
        raise ValueError("unsupported alert disposition")
    now=utc_now()
    with _db(path) as db:
        result=db.execute("UPDATE alerts SET acknowledged_at=?,acknowledged_by=?,status=? WHERE id=?", (now, analyst, status, alert_id))
        if result.rowcount == 0:
            raise KeyError("alert not found")
    return {"id": alert_id, "acknowledged_at": now, "acknowledged_by": analyst, "status": status}


def _public_https_url(url: str) -> str:
    parsed=urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("output connector URL must use HTTPS with a hostname")
    if parsed.username or parsed.password:
        raise ValueError("credentials in output connector URLs are not allowed")
    try:
        addresses={item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)}
    except socket.gaierror as exc:
        raise ValueError("output connector hostname could not be resolved") from exc
    for address in addresses:
        ip=ipaddress.ip_address(address)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise ValueError("output connector must resolve only to public addresses")
    return url


def deliver_json(url: str, payload: dict[str, Any], *, timeout_seconds: int = 10, headers: dict[str, str] | None = None) -> dict[str, object]:
    endpoint=_public_https_url(url)
    data=json.dumps(payload, sort_keys=True).encode("utf-8")
    safe_headers={"Content-Type":"application/json","User-Agent":"solari-osint-operations-center/0.8"}
    for key, value in (headers or {}).items():
        if key.lower() in {"host", "content-length", "authorization", "proxy-authorization", "cookie"}:
            raise ValueError(f"unsafe connector header: {key}")
        safe_headers[key]=value
    request=Request(endpoint, data=data, headers=safe_headers, method="POST")
    with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - validated HTTPS public destination
        body=response.read(64 * 1024)
        status=getattr(response,"status",200)
        content_type=response.headers.get("Content-Type")
    return {"status":status,"content_type":content_type,"response_bytes":len(body)}


def deliver_webhook(url: str, alert: dict[str, Any], *, timeout_seconds: int = 10) -> dict[str, object]:
    return deliver_json(url, {"type":"solari-alert","version":1,"alert":alert}, timeout_seconds=timeout_seconds)
