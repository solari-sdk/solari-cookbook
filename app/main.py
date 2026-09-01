from __future__ import annotations

from fastapi import FastAPI, HTTPException

from app.contracts import EventRecord, SourceDescriptor
from app.sources import usgs_earthquakes

app = FastAPI(
    title="Solari OSINT Operations Center",
    version="0.1.0",
    description="Public-source OSINT operations dashboard and Solari execution showcase.",
)

SOURCES: dict[str, SourceDescriptor] = {
    usgs_earthquakes.SOURCE.id: usgs_earthquakes.SOURCE,
}


@app.get("/api/v1/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "solari-osint-operations-center",
        "sources_registered": len(SOURCES),
    }


@app.get("/api/v1/sources", response_model=list[SourceDescriptor])
def list_sources() -> list[SourceDescriptor]:
    return list(SOURCES.values())


@app.get("/api/v1/events/live/{source_id}", response_model=list[EventRecord])
def collect_live(source_id: str, limit: int = 100) -> list[EventRecord]:
    if limit < 1 or limit > 1000:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 1000")

    if source_id == usgs_earthquakes.SOURCE.id:
        _, events = usgs_earthquakes.collect()
        return events[:limit]

    raise HTTPException(status_code=404, detail="unknown source")
