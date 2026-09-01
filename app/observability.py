from __future__ import annotations

import json
import logging
import re
import time
from contextvars import ContextVar
from uuid import uuid4

from fastapi import FastAPI, Request

CORRELATION_ID: ContextVar[str | None] = ContextVar("correlation_id", default=None)
SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
logger = logging.getLogger("solari.operations")


def current_correlation_id() -> str | None:
    return CORRELATION_ID.get()


def _correlation_id(request: Request) -> str:
    proposed = request.headers.get("X-Correlation-ID", "").strip()
    return proposed if SAFE_ID.fullmatch(proposed) else uuid4().hex


def _log(payload: dict[str, object]) -> None:
    logger.info(json.dumps(payload, sort_keys=True, default=str, separators=(",", ":")))


def install_observability(app: FastAPI) -> None:
    """Install one safe request logger with correlation IDs.

    The logger intentionally records route-level operational metadata only. It does
    not include request bodies, query values, cookies, authorization headers, or
    response payloads, preventing diagnostics from becoming a secret/session leak.
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
                "correlation_id": correlation_id,
                "method": request.method,
                "path": request.url.path,
                "error_type": type(exc).__name__,
            })
            raise
        finally:
            duration_ms = (time.perf_counter() - started) * 1000.0
            _log({
                "event": "http_request_completed",
                "correlation_id": correlation_id,
                "method": request.method,
                "path": request.url.path,
                "status_code": status_code,
                "duration_ms": round(duration_ms, 3),
            })
            CORRELATION_ID.reset(token)
