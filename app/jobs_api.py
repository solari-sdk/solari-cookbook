from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.job_store import get_job_execution, job_metrics, list_job_executions

router = APIRouter(prefix="/api/v1", tags=["jobs"])


@router.get("/jobs")
def jobs(source_id: str | None = None, correlation_id: str | None = None, status: str | None = None, limit: int = Query(500, ge=1, le=1000)) -> list[dict[str, object]]:
    return list_job_executions(source_id=source_id, correlation_id=correlation_id, status=status, limit=limit)


@router.get("/jobs/metrics")
def metrics() -> dict[str, object]: return job_metrics()


@router.get("/jobs/{job_id}")
def job(job_id: str) -> dict[str, object]:
    try: return get_job_execution(job_id)
    except KeyError as exc: raise HTTPException(404, "job execution not found") from exc
