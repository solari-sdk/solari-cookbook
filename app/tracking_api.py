from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.contracts import GeoPoint
from app.tracking import add_position, list_geofence_events, list_geofences, list_positions, list_tracks, replay_track, save_geofence, save_track

router = APIRouter(prefix="/api/v1", tags=["tracking"])


class TrackInput(BaseModel):
    id: str = Field(min_length=1, max_length=256)
    label: str = Field(min_length=1, max_length=500)
    object_type: str = Field(min_length=1, max_length=100)
    properties: dict[str, Any] = Field(default_factory=dict)


class PositionInput(BaseModel):
    observed_at: datetime
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    precision: str | None = Field(default=None, max_length=200)
    source_id: str | None = Field(default=None, max_length=200)
    properties: dict[str, Any] = Field(default_factory=dict)
    evaluate_geofences: bool = True


class GeofenceInput(BaseModel):
    id: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=500)
    kind: Literal["bbox", "polygon"]
    geometry: dict[str, Any]
    enabled: bool = True


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError): return HTTPException(404, str(exc).strip("'"))
    if isinstance(exc, ValueError): return HTTPException(400, str(exc))
    return HTTPException(500, type(exc).__name__)


@router.get("/tracks")
def tracks(object_type: str | None = None, limit: int = Query(500, ge=1, le=1000)) -> list[dict[str, object]]:
    return list_tracks(object_type=object_type, limit=limit)


@router.put("/tracks/{track_id}")
def put_track(track_id: str, body: TrackInput) -> dict[str, object]:
    if track_id != body.id: raise HTTPException(400, "path track_id must equal body id")
    try: return save_track(body.id, body.label, body.object_type, properties=body.properties)
    except Exception as exc: raise _error(exc) from exc


@router.get("/tracks/{track_id}/positions")
def positions(track_id: str, start: str | None = None, end: str | None = None, limit: int = Query(10000, ge=1, le=10000)) -> list[dict[str, object]]:
    return list_positions(track_id, start=start, end=end, limit=limit)


@router.post("/tracks/{track_id}/positions")
def add_track_position(track_id: str, body: PositionInput) -> dict[str, object]:
    try: return add_position(track_id, body.observed_at, GeoPoint(latitude=body.latitude, longitude=body.longitude, precision=body.precision), source_id=body.source_id, properties=body.properties, evaluate_geofences=body.evaluate_geofences)
    except Exception as exc: raise _error(exc) from exc


@router.get("/tracks/{track_id}/replay")
def replay(track_id: str, start: str | None = None, end: str | None = None) -> dict[str, object]:
    return replay_track(track_id, start=start, end=end)


@router.get("/geofences")
def geofences(enabled_only: bool = False) -> list[dict[str, object]]: return list_geofences(enabled_only=enabled_only)


@router.put("/geofences/{geofence_id}")
def put_geofence(geofence_id: str, body: GeofenceInput) -> dict[str, object]:
    if geofence_id != body.id: raise HTTPException(400, "path geofence_id must equal body id")
    try: return save_geofence(body.id, body.name, kind=body.kind, geometry=body.geometry, enabled=body.enabled)
    except Exception as exc: raise _error(exc) from exc


@router.get("/geofence-events")
def geofence_events(track_id: str | None = None, geofence_id: str | None = None, limit: int = Query(1000, ge=1, le=10000)) -> list[dict[str, object]]:
    return list_geofence_events(track_id=track_id, geofence_id=geofence_id, limit=limit)
