from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.pagination import event_page

router = APIRouter(prefix="/api/v1", tags=["events"])


@router.get("/events/page")
def paged_events(
    limit: int = Query(100, ge=1, le=500),
    cursor: str | None = Query(None, max_length=256),
    source_id: str | None = None,
    category: str | None = None,
) -> dict[str, object]:
    try:
        page = event_page(limit=limit, cursor=cursor, source_id=source_id, category=category)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"items": page.items, "next_cursor": page.next_cursor}
