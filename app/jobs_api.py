from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.job_store import get_job_execution, job_metrics, list_job_executions

router = APIRouter(prefix="/api/v1", tags=["jobs"])


@router.get("/jobs")
def jobs(source_id: str | None = None, correlation_id: str | None = None, status: str | None = None, limit: int = Query(500, ge=1, le=1000)) -> list[dict[str, object]]:
    return list_job_executions(source_id=source_id, correlation_id=correlation_id, status=status, limit=limit)


@router.get("/jobs/metrics")
def metrics() -> dict[str, object]: return job_metrics()


def _sse_event(event: str, payload: dict[str, object]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, sort_keys=True, default=str)}\n\n"


async def _metric_stream(interval_seconds: float, count: int) -> AsyncIterator[str]:
    sent = 0
    while count == 0 or sent < count:
        yield _sse_event(
            "job-metrics",
            {"generated_at": datetime.now(timezone.utc).isoformat(), "metrics": job_metrics()},
        )
        sent += 1
        if count == 0 or sent < count:
            await asyncio.sleep(interval_seconds)


@router.get("/jobs/stream", response_class=StreamingResponse)
def stream_job_metrics(
    interval_seconds: float = Query(5.0, ge=1.0, le=60.0),
    count: int = Query(0, ge=0, le=1000),
) -> StreamingResponse:
    return StreamingResponse(
        _metric_stream(interval_seconds, count),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/jobs/{job_id}")
def job(job_id: str) -> dict[str, object]:
    try: return get_job_execution(job_id)
    except KeyError as exc: raise HTTPException(404, "job execution not found") from exc
