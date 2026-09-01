from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from pathlib import Path

from app.storage import DB_PATH, connect


@dataclass(slots=True)
class EventPage:
    items: list[dict[str, object]]
    next_cursor: str | None


def encode_cursor(offset: int) -> str:
    payload = json.dumps({"offset": offset}, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    if len(cursor) > 256:
        raise ValueError("cursor is too long")
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(cursor + padding))
        offset = int(payload["offset"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid cursor") from exc
    if offset < 0 or offset > 10_000_000:
        raise ValueError("invalid cursor offset")
    return offset


def event_page(
    *, limit: int = 100, cursor: str | None = None,
    source_id: str | None = None, category: str | None = None,
    path: Path = DB_PATH,
) -> EventPage:
    offset = decode_cursor(cursor)
    clauses=[]; values: list[object]=[]
    if source_id: clauses.append("source_id=?"); values.append(source_id)
    if category: clauses.append("category=?"); values.append(category)
    where=f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.extend([limit + 1, offset])
    with connect(path) as db:
        rows=db.execute(f"SELECT * FROM events {where} ORDER BY observed_at DESC,id DESC LIMIT ? OFFSET ?",values).fetchall()
    items=[dict(row) for row in rows[:limit]]
    return EventPage(items=items,next_cursor=encode_cursor(offset+limit) if len(rows)>limit else None)
