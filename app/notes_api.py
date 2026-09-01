from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.markdown_safe import render_markdown_safe
from app.storage import connect

router = APIRouter(prefix="/api/v1", tags=["cases"])


@router.get("/cases/{case_id}/notes")
def case_notes(case_id: str) -> dict[str, object]:
    with connect() as db:
        row = db.execute("SELECT notes,updated_at FROM cases WHERE id=?", (case_id,)).fetchone()
    if not row:
        raise HTTPException(404, "case not found")
    markdown = row["notes"] or ""
    return {"case_id": case_id, "markdown": markdown, "html": render_markdown_safe(markdown), "updated_at": row["updated_at"], "renderer": "safe-markdown-subset-v1"}
