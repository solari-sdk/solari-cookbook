from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.source_runtime import SourceRuntime


def make_router(runtime: SourceRuntime) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["sources"])

    @router.get("/source-runtime")
    def source_runtime_stats() -> dict[str, dict[str, object]]:
        return runtime.stats()

    @router.post("/source-runtime/{source_id}/clear-cache")
    def clear_source_cache(source_id: str) -> dict[str, object]:
        known = runtime.stats()
        if source_id not in known:
            raise HTTPException(404, "source runtime state not found")
        runtime.clear_cache(source_id)
        return {"source_id": source_id, "cache_cleared": True}

    return router
