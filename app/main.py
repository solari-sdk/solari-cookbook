from __future__ import annotations

from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from app.contracts import EventRecord, SourceDescriptor
from app.exports import events_csv, events_geojson
from app.sources import nws_alerts, swpc_alerts, usgs_earthquakes
from app.storage import list_acquisitions, list_events, save_acquisition, save_events, source_health

app = FastAPI(title="Solari OSINT Operations Center", version="0.4.0", description="Public-source OSINT operations dashboard and Solari execution showcase.")
STATIC_DIR=Path(__file__).parent/"static"; app.mount("/static",StaticFiles(directory=STATIC_DIR),name="static")
ADAPTERS={x.SOURCE.id:x for x in (usgs_earthquakes,nws_alerts,swpc_alerts)}; SOURCES={k:v.SOURCE for k,v in ADAPTERS.items()}

@app.get("/")
def dashboard(): return FileResponse(STATIC_DIR/"index.html")
@app.get("/api/v1/health")
def health(): return {"status":"ok","service":"solari-osint-operations-center","version":"0.4.0","sources_registered":len(SOURCES)}
@app.get("/api/v1/sources",response_model=list[SourceDescriptor])
def sources(): return list(SOURCES.values())
@app.get("/api/v1/source-health")
def health_by_source(): return source_health()
@app.get("/api/v1/acquisitions")
def acquisitions(limit:int=100,source_id:str|None=None):
    if limit<1 or limit>1000: raise HTTPException(400,"limit must be between 1 and 1000")
    return list_acquisitions(limit,source_id)
@app.get("/api/v1/events")
def persisted_events(limit:int=500,source_id:str|None=None,category:str|None=None):
    if limit<1 or limit>1000: raise HTTPException(400,"limit must be between 1 and 1000")
    return list_events(limit,source_id,category)
@app.get("/api/v1/export/events.csv",response_class=PlainTextResponse)
def export_csv(limit:int=1000): return PlainTextResponse(events_csv(list_events(min(max(limit,1),1000))),media_type="text/csv",headers={"Content-Disposition":"attachment; filename=events.csv"})
@app.get("/api/v1/export/events.geojson")
def export_geojson(limit:int=1000): return events_geojson(list_events(min(max(limit,1),1000)))
@app.post("/api/v1/collect/{source_id}")
def collect_and_store(source_id:str):
    adapter=ADAPTERS.get(source_id)
    if not adapter: raise HTTPException(404,"unknown source")
    try:
        acquisition,events=adapter.collect(); save_acquisition(acquisition); count=save_events(events)
        return {"source_id":source_id,"acquisition_id":acquisition.id,"status":acquisition.status,"events_saved":count}
    except Exception as exc: raise HTTPException(502,f"collector failed: {type(exc).__name__}") from exc
@app.get("/api/v1/events/live/{source_id}",response_model=list[EventRecord])
def collect_live(source_id:str,limit:int=100):
    if limit<1 or limit>1000: raise HTTPException(400,"limit must be between 1 and 1000")
    adapter=ADAPTERS.get(source_id)
    if not adapter: raise HTTPException(404,"unknown source")
    _,events=adapter.collect(); return events[:limit]
