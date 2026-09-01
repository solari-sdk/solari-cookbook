from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from app.contracts import GeoPoint
from app.geospatial import in_bbox, point_in_polygon
from app.storage import DB_PATH, connect

TRACK_SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    object_type TEXT NOT NULL,
    properties_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS track_positions (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    precision TEXT,
    source_id TEXT,
    properties_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geofences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    geometry_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geofence_state (
    track_id TEXT NOT NULL,
    geofence_id TEXT NOT NULL,
    inside INTEGER NOT NULL,
    position_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(track_id, geofence_id)
);
CREATE TABLE IF NOT EXISTS geofence_events (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    geofence_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    position_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_positions_track_time ON track_positions(track_id,observed_at,id);
CREATE INDEX IF NOT EXISTS idx_geofence_events_track_time ON geofence_events(track_id,observed_at,id);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db(path: Path = DB_PATH):
    db = connect(path)
    db.executescript(TRACK_SCHEMA)
    return db


def save_track(track_id: str, label: str, object_type: str, *, properties: dict[str, Any] | None = None, path: Path = DB_PATH) -> dict[str, object]:
    if not track_id.strip() or not label.strip() or not object_type.strip():
        raise ValueError("track_id, label and object_type are required")
    now = utc_now()
    with _db(path) as db:
        existing = db.execute("SELECT created_at FROM tracks WHERE id=?", (track_id,)).fetchone()
        created = existing["created_at"] if existing else now
        db.execute(
            "INSERT INTO tracks (id,label,object_type,properties_json,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,object_type=excluded.object_type,properties_json=excluded.properties_json,updated_at=excluded.updated_at",
            (track_id, label.strip(), object_type.strip(), json.dumps(properties or {}, sort_keys=True), created, now),
        )
    return {"id": track_id, "label": label.strip(), "object_type": object_type.strip(), "properties": properties or {}, "created_at": created, "updated_at": now}


def list_tracks(*, object_type: str | None = None, limit: int = 500, path: Path = DB_PATH) -> list[dict[str, object]]:
    where = "WHERE object_type=?" if object_type else ""
    values: list[object] = [object_type] if object_type else []
    values.append(limit)
    with _db(path) as db:
        rows = db.execute(f"SELECT * FROM tracks {where} ORDER BY updated_at DESC,id LIMIT ?", values).fetchall()
    output=[]
    for row in rows:
        item=dict(row); item["properties"]=json.loads(item.pop("properties_json")); output.append(item)
    return output


def save_geofence(
    geofence_id: str,
    name: str,
    *,
    kind: Literal["bbox", "polygon"],
    geometry: dict[str, Any],
    enabled: bool = True,
    path: Path = DB_PATH,
) -> dict[str, object]:
    _validate_geometry(kind, geometry)
    now=utc_now()
    with _db(path) as db:
        existing=db.execute("SELECT created_at FROM geofences WHERE id=?",(geofence_id,)).fetchone(); created=existing["created_at"] if existing else now
        db.execute("INSERT INTO geofences (id,name,kind,geometry_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,geometry_json=excluded.geometry_json,enabled=excluded.enabled,updated_at=excluded.updated_at",(geofence_id,name,kind,json.dumps(geometry,sort_keys=True),1 if enabled else 0,created,now))
    return {"id":geofence_id,"name":name,"kind":kind,"geometry":geometry,"enabled":enabled,"created_at":created,"updated_at":now}


def _validate_geometry(kind: str, geometry: dict[str, Any]) -> None:
    if kind == "bbox":
        required={"min_lat","max_lat","min_lon","max_lon"}
        if not required <= set(geometry): raise ValueError("bbox geofence requires min/max lat/lon")
        in_bbox(GeoPoint(latitude=float(geometry["min_lat"]), longitude=float(geometry["min_lon"])), min_lat=float(geometry["min_lat"]), max_lat=float(geometry["max_lat"]), min_lon=float(geometry["min_lon"]), max_lon=float(geometry["max_lon"]))
    elif kind == "polygon":
        vertices=geometry.get("vertices")
        if not isinstance(vertices,list) or len(vertices)<3: raise ValueError("polygon geofence requires at least three vertices")
        points=[GeoPoint(latitude=float(item["latitude"]),longitude=float(item["longitude"])) for item in vertices]
        point_in_polygon(points[0],points)
    else:
        raise ValueError("unsupported geofence kind")


def list_geofences(*, enabled_only: bool = False, path: Path = DB_PATH) -> list[dict[str, object]]:
    where="WHERE enabled=1" if enabled_only else ""
    with _db(path) as db: rows=db.execute(f"SELECT * FROM geofences {where} ORDER BY name,id").fetchall()
    output=[]
    for row in rows:
        item=dict(row); item["geometry"]=json.loads(item.pop("geometry_json")); item["enabled"]=bool(item["enabled"]); output.append(item)
    return output


def point_in_geofence(point: GeoPoint, geofence: dict[str, object]) -> bool:
    kind=str(geofence["kind"]); geometry=dict(geofence["geometry"])
    if kind == "bbox":
        return in_bbox(point,min_lat=float(geometry["min_lat"]),max_lat=float(geometry["max_lat"]),min_lon=float(geometry["min_lon"]),max_lon=float(geometry["max_lon"]))
    if kind == "polygon":
        vertices=[GeoPoint(latitude=float(item["latitude"]),longitude=float(item["longitude"])) for item in geometry["vertices"]]
        return point_in_polygon(point,vertices)
    raise ValueError("unsupported geofence kind")


def add_position(
    track_id: str,
    observed_at: datetime,
    point: GeoPoint,
    *,
    source_id: str | None = None,
    properties: dict[str, Any] | None = None,
    evaluate_geofences: bool = True,
    path: Path = DB_PATH,
) -> dict[str, object]:
    position_id=uuid4().hex; created=utc_now()
    if observed_at.tzinfo is None: observed_at=observed_at.replace(tzinfo=timezone.utc)
    with _db(path) as db:
        if not db.execute("SELECT 1 FROM tracks WHERE id=?",(track_id,)).fetchone(): raise KeyError("track not found")
        db.execute("INSERT INTO track_positions (id,track_id,observed_at,latitude,longitude,precision,source_id,properties_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",(position_id,track_id,observed_at.isoformat(),point.latitude,point.longitude,point.precision,source_id,json.dumps(properties or {},sort_keys=True),created))
        db.execute("UPDATE tracks SET updated_at=? WHERE id=?",(created,track_id))
    transitions = _evaluate_transitions(track_id, position_id, observed_at, point, path=path) if evaluate_geofences else []
    return {"id":position_id,"track_id":track_id,"observed_at":observed_at.isoformat(),"latitude":point.latitude,"longitude":point.longitude,"precision":point.precision,"source_id":source_id,"properties":properties or {},"geofence_events":transitions}


def _evaluate_transitions(track_id: str, position_id: str, observed_at: datetime, point: GeoPoint, *, path: Path) -> list[dict[str, object]]:
    transitions=[]
    geofences=list_geofences(enabled_only=True,path=path)
    with _db(path) as db:
        for geofence in geofences:
            inside=point_in_geofence(point,geofence)
            prior=db.execute("SELECT inside FROM geofence_state WHERE track_id=? AND geofence_id=?",(track_id,geofence["id"])).fetchone()
            previous=None if prior is None else bool(prior["inside"])
            db.execute("INSERT INTO geofence_state (track_id,geofence_id,inside,position_id,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(track_id,geofence_id) DO UPDATE SET inside=excluded.inside,position_id=excluded.position_id,updated_at=excluded.updated_at",(track_id,geofence["id"],1 if inside else 0,position_id,utc_now()))
            if previous is None or previous == inside:
                continue
            event_type="enter" if inside else "exit"
            event={"id":uuid4().hex,"track_id":track_id,"geofence_id":geofence["id"],"event_type":event_type,"position_id":position_id,"observed_at":observed_at.isoformat(),"created_at":utc_now()}
            db.execute("INSERT INTO geofence_events (id,track_id,geofence_id,event_type,position_id,observed_at,created_at) VALUES (?,?,?,?,?,?,?)",(event["id"],track_id,geofence["id"],event_type,position_id,event["observed_at"],event["created_at"]))
            transitions.append(event)
    return transitions


def list_positions(track_id: str, *, start: str | None = None, end: str | None = None, limit: int = 10000, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses=["track_id=?"]; values: list[object]=[track_id]
    if start: clauses.append("observed_at>=?"); values.append(start)
    if end: clauses.append("observed_at<=?"); values.append(end)
    values.append(limit)
    with _db(path) as db:
        rows=db.execute(f"SELECT * FROM track_positions WHERE {' AND '.join(clauses)} ORDER BY observed_at,id LIMIT ?",values).fetchall()
    output=[]
    for row in rows:
        item=dict(row); item["properties"]=json.loads(item.pop("properties_json")); output.append(item)
    return output


def replay_track(track_id: str, *, start: str | None = None, end: str | None = None, path: Path = DB_PATH) -> dict[str, object]:
    positions=list_positions(track_id,start=start,end=end,path=path)
    return {"track_id":track_id,"positions":positions,"count":len(positions),"start":positions[0]["observed_at"] if positions else None,"end":positions[-1]["observed_at"] if positions else None}


def list_geofence_events(*, track_id: str | None = None, geofence_id: str | None = None, limit: int = 1000, path: Path = DB_PATH) -> list[dict[str, object]]:
    clauses=[]; values: list[object]=[]
    if track_id: clauses.append("track_id=?"); values.append(track_id)
    if geofence_id: clauses.append("geofence_id=?"); values.append(geofence_id)
    where=f"WHERE {' AND '.join(clauses)}" if clauses else ""; values.append(limit)
    with _db(path) as db: rows=db.execute(f"SELECT * FROM geofence_events {where} ORDER BY observed_at DESC,id DESC LIMIT ?",values).fetchall()
    return [dict(row) for row in rows]
