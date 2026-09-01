from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.geocoding import reverse_geocode, search_places

router = APIRouter(prefix="/api/v1/geocode", tags=["geocoding"])


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, ValueError):
        return HTTPException(400, str(exc))
    return HTTPException(502, type(exc).__name__)


@router.get("/search")
def place_search(q: str = Query(..., min_length=2, max_length=200), limit: int = Query(5, ge=1, le=10)) -> list[dict[str, object]]:
    try:
        return [item.model_dump(mode="json") for item in search_places(q, limit=limit)]
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/reverse")
def place_reverse(
    latitude: float = Query(..., ge=-90, le=90),
    longitude: float = Query(..., ge=-180, le=180),
    zoom: int = Query(18, ge=0, le=18),
) -> dict[str, object]:
    try:
        return reverse_geocode(latitude, longitude, zoom=zoom).model_dump(mode="json")
    except Exception as exc:
        raise _error(exc) from exc
