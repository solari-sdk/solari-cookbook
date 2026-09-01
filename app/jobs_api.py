from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.domain_contract_api import router as domain_contract_router
from app.job_store import get_job_execution, job_metrics, list_job_executions
from app.solari_api import router as solari_router
from app.task_queue import list_schedules, list_tasks, queue_metrics
from app.workflow_api import router as workflow_router

router = APIRouter()
jobs_router = APIRouter(prefix="/api/v1", tags=["jobs"])


@jobs_router.get("/jobs")
def jobs(source_id: str | None = None, correlation_id: str | None = None, status: str | None = None, limit: int = Query(500, ge=1, le=1000)) -> list[dict[str, object]]:
    return list_job_executions(source_id=source_id, correlation_id=correlation_id, status=status, limit=limit)


@jobs_router.get("/jobs/metrics")
def metrics() -> dict[str, object]:
    return {"executions": job_metrics(), "queue": queue_metrics()}


@jobs_router.get("/queue/tasks")
def queued_tasks(status: str | None = None, limit: int = Query(100, ge=1, le=1000)) -> list[dict[str, object]]:
    try:
        return list_tasks(status=status, limit=limit)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@jobs_router.get("/queue/metrics")
def durable_queue_metrics() -> dict[str, object]:
    return queue_metrics()


@jobs_router.get("/schedules")
def schedules(enabled: bool | None = None) -> list[dict[str, object]]:
    return list_schedules(enabled=enabled)


def _sse_event(event: str, payload: dict[str, object]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, sort_keys=True, default=str)}\n\n"


async def _metric_stream(interval_seconds: float, count: int) -> AsyncIterator[str]:
    sent = 0
    while count == 0 or sent < count:
        yield _sse_event(
            "job-metrics",
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "metrics": {"executions": job_metrics(), "queue": queue_metrics()},
            },
        )
        sent += 1
        if count == 0 or sent < count:
            await asyncio.sleep(interval_seconds)


@jobs_router.get("/jobs/stream", response_class=StreamingResponse)
def stream_job_metrics(
    interval_seconds: float = Query(5.0, ge=1.0, le=60.0),
    count: int = Query(0, ge=0, le=1000),
) -> StreamingResponse:
    return StreamingResponse(
        _metric_stream(interval_seconds, count),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@jobs_router.get("/jobs/{job_id}")
def job(job_id: str) -> dict[str, object]:
    try:
        return get_job_execution(job_id)
    except KeyError as exc:
        raise HTTPException(404, "job execution not found") from exc


router.include_router(jobs_router)
router.include_router(domain_contract_router)
router.include_router(solari_router)
router.include_router(workflow_router)
