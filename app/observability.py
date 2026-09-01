from __future__ import annotations

import json
import logging
import re
import time
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import uuid4

from fastapi import FastAPI, Request

CORRELATION_ID: ContextVar[str | None] = ContextVar("correlation_id", default=None)
JOB_ID: ContextVar[str | None] = ContextVar("job_id", default=None)
SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
logger = logging.getLogger("solari.operations")


def current_correlation_id() -> str | None:
    return CORRELATION_ID.get()


def current_job_id() -> str | None:
    return JOB_ID.get()


@contextmanager
def execution_log_context(*, job_id: str | None = None, correlation_id: str | None = None):
    """Bind safe execution identifiers so request and worker logs share one trail."""
    if job_id is not None and not SAFE_ID.fullmatch(job_id):
        raise ValueError("invalid job_id")
    if correlation_id is not None and not SAFE_ID.fullmatch(correlation_id):
        raise ValueError("invalid correlation_id")
    job_token = JOB_ID.set(job_id if job_id is not None else JOB_ID.get())
    correlation_token = CORRELATION_ID.set(correlation_id if correlation_id is not None else CORRELATION_ID.get())
    try:
        yield
    finally:
        CORRELATION_ID.reset(correlation_token)
        JOB_ID.reset(job_token)


def _correlation_id(request: Request) -> str:
    proposed = request.headers.get("X-Correlation-ID", "").strip()
    return proposed if SAFE_ID.fullmatch(proposed) else uuid4().hex


def _log(payload: dict[str, object]) -> None:
    enriched = dict(payload)
    correlation_id = current_correlation_id()
    job_id = current_job_id()
    if correlation_id is not None:
        enriched.setdefault("correlation_id", correlation_id)
    if job_id is not None:
        enriched.setdefault("job_id", job_id)
    logger.info(json.dumps(enriched, sort_keys=True, default=str, separators=(",", ":")))


def structured_event(event: str, **fields: object) -> None:
    if not event.strip():
        raise ValueError("event name is required")
    _log({"event": event.strip(), **fields})


def install_observability(app: FastAPI) -> None:
    """Install one safe request logger with correlation IDs.

    The logger intentionally records route-level operational metadata only. It does
    not include request bodies, query values, cookies, authorization headers, or
    response payloads, preventing diagnostics from becoming a secret/session leak.
    Worker/job code may bind a job ID with ``execution_log_context`` so the same
    structured trail carries both request correlation and execution identity.
    """

    @app.middleware("http")
    async def request_observability(request: Request, call_next):
        correlation_id = _correlation_id(request)
        token = CORRELATION_ID.set(correlation_id)
        started = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers["X-Correlation-ID"] = correlation_id
            return response
        except Exception as exc:
            _log({
                "event": "http_request_failed",
                "method": request.method,
                "path": request.url.path,
                "error_type": type(exc).__name__,
            })
            raise
        finally:
            duration_ms = (time.perf_counter() - started) * 1000.0
            _log({
                "event": "http_request_completed",
                "method": request.method,
                "path": request.url.path,
                "status_code": status_code,
                "duration_ms": round(duration_ms, 3),
            })
            CORRELATION_ID.reset(token)
