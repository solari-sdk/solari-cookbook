from __future__ import annotations

from fastapi import APIRouter, Query

from app.correlation import correlate_events
from app.event_store import event_models

router = APIRouter(prefix="/api/v1/correlation", tags=["correlation"])


@router.get("/candidates")
def correlation_candidates(
    limit: int = Query(1000, ge=2, le=5000),
    max_time_seconds: int = Query(3600, ge=1, le=604800),
    max_distance_km: float = Query(100.0, gt=0, le=20000),
    min_score: float = Query(0.6, ge=0, le=1),
) -> dict[str, object]:
    candidates = correlate_events(
        event_models(limit),
        max_time_seconds=max_time_seconds,
        max_distance_km=max_distance_km,
        min_score=min_score,
    )
    return {
        "candidates": [candidate.as_dict() for candidate in candidates],
        "count": len(candidates),
        "auto_merged": False,
        "explanation": "Candidates are suggestions only; source records remain independent and provenance-preserving.",
    }
