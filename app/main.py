from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.contracts import EventRecord, SourceDescriptor
from app.sources import usgs_earthquakes
from app.storage import list_events, save_acquisition, save_events

app = FastAPI(
    title="Solari OSINT Operations Center",
    version="0.2.0",
    description="Public-source OSINT operations dashboard and Solari execution showcase.",
)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

SOURCES: dict[str, SourceDescriptor] = {
    usgs_earthquakes.SOURCE.id: usgs_earthquakes.SOURCE,
}


@app.get("/")
def dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/v1/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "solari-osint-operations-center",
        "version": "0.2.0",
        "sources_registered": len(SOURCES),
    }


@app.get("/api/v1/sources", response_model=list[SourceDescriptor])
def list_sources() -> list[SourceDescriptor]:
    return list(SOURCES.values())


@app.get("/api/v1/events")
def persisted_events(limit: int = 500, source_id: str | None = None, category: str | None = None) -> list[dict[str, object]]:
    if limit < 1 or limit > 1000:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 1000")
    return list_events(limit=limit, source_id=source_id, category=category)


@app.post("/api/v1/collect/{source_id}")
def collect_and_store(source_id: str) -> dict[str, object]:
    if source_id != usgs_earthquakes.SOURCE.id:
        raise HTTPException(status_code=404, detail="unknown source")
    acquisition, events = usgs_earthquakes.collect()
    save_acquisition(acquisition)
    count = save_events(events)
    return {
        "source_id": source_id,
        "acquisition_id": acquisition.id,
        "status": acquisition.status,
        "events_saved": count,
    }


@app.get("/api/v1/events/live/{source_id}", response_model=list[EventRecord])
def collect_live(source_id: str, limit: int = 100) -> list[EventRecord]:
    if limit < 1 or limit > 1000:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 1000")
    if source_id == usgs_earthquakes.SOURCE.id:
        _, events = usgs_earthquakes.collect()
        return events[:limit]
    raise HTTPException(status_code=404, detail="unknown source")
