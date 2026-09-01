from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from math import ceil
from typing import Any
from urllib.parse import urlencode

from pydantic import BaseModel, Field

from app.contracts import GeoPoint
from app.geospatial import distance_km
from app.recon import _json_get

NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org"
NOMINATIM_ATTRIBUTION = "OpenStreetMap contributors / Nominatim"
MIN_REQUEST_INTERVAL_SECONDS = 1.05
MAX_RESULTS = 10

_REQUEST_LOCK = threading.Lock()
_LAST_REQUEST_MONOTONIC = 0.0


class GazetteerPlace(BaseModel):
    provider: str = "nominatim"
    provider_object_id: str
    display_name: str
    location: GeoPoint
    bounding_box: list[float] | None = None
    uncertainty_m: int | None = Field(default=None, ge=0)
    category: str | None = None
    type: str | None = None
    importance: float | None = None
    address: dict[str, Any] = Field(default_factory=dict)
    attribution: str = NOMINATIM_ATTRIBUTION
    source_url: str
    queried_at: datetime


def _throttle() -> None:
    global _LAST_REQUEST_MONOTONIC
    with _REQUEST_LOCK:
        now = time.monotonic()
        remaining = MIN_REQUEST_INTERVAL_SECONDS - (now - _LAST_REQUEST_MONOTONIC)
        if remaining > 0:
            time.sleep(remaining)
        _LAST_REQUEST_MONOTONIC = time.monotonic()


def _nominatim_json(endpoint: str, params: dict[str, object]) -> Any:
    if endpoint not in {"search", "reverse"}:
        raise ValueError("unsupported Nominatim endpoint")
    _throttle()
    query = urlencode({key: value for key, value in params.items() if value is not None})
    return _json_get(f"{NOMINATIM_BASE_URL}/{endpoint}?{query}", timeout_seconds=15)


def _bounding_box(value: Any) -> list[float] | None:
    if not isinstance(value, list) or len(value) != 4:
        return None
    try:
        south, north, west, east = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    if not (-90 <= south <= 90 and -90 <= north <= 90 and -180 <= west <= 180 and -180 <= east <= 180):
        return None
    return [south, north, west, east]


def _uncertainty_m(location: GeoPoint, box: list[float] | None) -> int | None:
    if box is None:
        return None
    south, north, west, east = box
    distances = [
        distance_km(location, GeoPoint(latitude=lat, longitude=lon))
        for lat, lon in ((south, west), (south, east), (north, west), (north, east))
    ]
    return ceil(max(distances) * 1000)


def _place(item: dict[str, Any], source_url: str) -> GazetteerPlace:
    try:
        latitude = float(item["lat"])
        longitude = float(item["lon"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("geocoder result is missing valid coordinates") from exc
    location = GeoPoint(latitude=latitude, longitude=longitude, precision="provider point")
    box = _bounding_box(item.get("boundingbox"))
    object_id = item.get("place_id") or f"{item.get('osm_type','object')}:{item.get('osm_id','unknown')}"
    return GazetteerPlace(
        provider_object_id=str(object_id),
        display_name=str(item.get("display_name") or item.get("name") or object_id),
        location=location,
        bounding_box=box,
        uncertainty_m=_uncertainty_m(location, box),
        category=str(item.get("category")) if item.get("category") is not None else None,
        type=str(item.get("type")) if item.get("type") is not None else None,
        importance=float(item["importance"]) if item.get("importance") is not None else None,
        address=dict(item.get("address") or {}),
        source_url=source_url,
        queried_at=datetime.now(timezone.utc),
    )


def search_places(query: str, *, limit: int = 5) -> list[GazetteerPlace]:
    clean = " ".join(query.split())
    if not 2 <= len(clean) <= 200:
        raise ValueError("place query must contain 2 to 200 characters")
    if not 1 <= limit <= MAX_RESULTS:
        raise ValueError(f"limit must be between 1 and {MAX_RESULTS}")
    params = {"q": clean, "format": "jsonv2", "addressdetails": 1, "limit": limit}
    source_url = f"{NOMINATIM_BASE_URL}/search?{urlencode(params)}"
    payload = _nominatim_json("search", params)
    if not isinstance(payload, list):
        raise ValueError("geocoder search response must be a list")
    return [_place(item, source_url) for item in payload[:limit] if isinstance(item, dict)]


def reverse_geocode(latitude: float, longitude: float, *, zoom: int = 18) -> GazetteerPlace:
    point = GeoPoint(latitude=latitude, longitude=longitude)
    if not 0 <= zoom <= 18:
        raise ValueError("zoom must be between 0 and 18")
    params = {"lat": point.latitude, "lon": point.longitude, "format": "jsonv2", "addressdetails": 1, "zoom": zoom}
    source_url = f"{NOMINATIM_BASE_URL}/reverse?{urlencode(params)}"
    payload = _nominatim_json("reverse", params)
    if not isinstance(payload, dict) or payload.get("error"):
        raise ValueError("reverse geocoder returned no suitable public place")
    return _place(payload, source_url)
