from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from app.contracts import AcquisitionEnvelope, CaseRecord, EntityRecord, EventRecord, RelationshipRecord, SourceDescriptor
from app.correlation_api import router as correlation_router
from app.entities import derive_graph
from app.exports import events_csv, events_geojson
from app.graph_api import router as graph_router
from app.pagination_api import router as pagination_router
from app.sources import nws_alerts, swpc_alerts, usgs_earthquakes
from app.storage import (
    case_contents, connect, list_acquisitions, list_cases, list_entities, list_event_history,
    list_events, list_evidence, list_relationships, save_acquisition, save_entities, save_events,
    save_relationships, source_health,
)

VERSION = "0.7.1"
app = FastAPI(title="Solari OSINT Operations Center", version=VERSION, description="Public-source OSINT operations dashboard and Solari execution showcase.")
app.include_router(graph_router)
app.include_router(pagination_router)
app.include_router(correlation_router)
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
ADAPTERS = {adapter.SOURCE.id: adapter for adapter in (usgs_earthquakes, nws_alerts, swpc_alerts)}
SOURCES: dict[str, SourceDescriptor] = {key: adapter.SOURCE for key, adapter in ADAPTERS.items()}


def _acquisition_rows(limit: int = 100, source_id: str | None = None) -> list[dict[str, object]]:
    rows = list_acquisitions(limit, source_id)
    for row in rows:
        raw = row.pop("metadata_json", "{}")
        try:
            row["metadata"] = json.loads(str(raw))
        except json.JSONDecodeError:
            row["metadata"] = {"decode_error": True}
    return rows


@app.get("/")
def dashboard() -> FileResponse: return FileResponse(STATIC_DIR / "index.html")

@app.get("/api/v1/health")
def health() -> dict[str, object]: return {"status":"ok","service":"solari-osint-operations-center","version":VERSION,"sources_registered":len(SOURCES)}

@app.get("/api/v1/ready")
def ready() -> dict[str, object]:
    checks={"static_dashboard":(STATIC_DIR/"index.html").is_file(),"sqlite":False}
    try:
        with connect() as db: checks["sqlite"]=db.execute("SELECT 1").fetchone()[0]==1
    except Exception: checks["sqlite"]=False
    return {"status":"ready" if all(checks.values()) else "not_ready","checks":checks,"version":VERSION}

@app.get("/api/v1/version")
def version() -> dict[str, object]: return {"service":"solari-osint-operations-center","version":VERSION,"api_version":"v1"}

@app.get("/api/v1/schema")
def schemas() -> dict[str, object]:
    return {"event":EventRecord.model_json_schema(),"source":SourceDescriptor.model_json_schema(),"acquisition":AcquisitionEnvelope.model_json_schema(),"entity":EntityRecord.model_json_schema(),"relationship":RelationshipRecord.model_json_schema(),"case":CaseRecord.model_json_schema()}

@app.get("/api/v1/metrics")
def metrics() -> dict[str, object]:
    with connect() as db:
        counts={table:int(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) for table in ("acquisitions","events","event_history","entities","relationships","cases")}
    health_rows=health_by_source()
    recent=_acquisition_rows(1000)
    parser_ms=[float(row["metadata"]["parser_duration_ms"]) for row in recent if isinstance(row.get("metadata"),dict) and row["metadata"].get("parser_duration_ms") is not None]
    response_bytes=[int(row["metadata"]["response_bytes"]) for row in recent if isinstance(row.get("metadata"),dict) and row["metadata"].get("response_bytes") is not None]
    accepted=sum(int(row["metadata"].get("records_accepted",0)) for row in recent if isinstance(row.get("metadata"),dict))
    rejected=sum(int(row["metadata"].get("records_rejected",0)) for row in recent if isinstance(row.get("metadata"),dict))
    return {
        "version": VERSION,
        "counts": counts,
        "sources_registered": len(SOURCES),
        "sources_with_acquisitions": len(health_rows),
        "sources_stale": sum(1 for row in health_rows if row.get("stale")),
        "recent_acquisition_telemetry": {
            "sample_size": len(recent),
            "parser_duration_ms_average": sum(parser_ms)/len(parser_ms) if parser_ms else None,
            "response_bytes_total": sum(response_bytes),
            "records_accepted": accepted,
            "records_rejected": rejected,
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

@app.get("/api/v1/sources",response_model=list[SourceDescriptor])
def sources() -> list[SourceDescriptor]: return list(SOURCES.values())

@app.get("/api/v1/source-dependencies")
def source_dependencies() -> dict[str, object]:
    return {"nodes": sorted(SOURCES), "edges": [{"source_id": source.id, "depends_on": dependency} for source in SOURCES.values() for dependency in source.depends_on]}

@app.get("/api/v1/source-health")
def health_by_source() -> list[dict[str, object]]:
    now=datetime.now(timezone.utc); results=source_health()
    for row in results:
        descriptor=SOURCES.get(str(row["source_id"])); cadence=descriptor.poll_interval_seconds if descriptor else None
        completed=datetime.fromisoformat(str(row["last_completed_at"])) if row.get("last_completed_at") else None
        if completed and completed.tzinfo is None: completed=completed.replace(tzinfo=timezone.utc)
        age=(now-completed).total_seconds() if completed else None; stale_after=cadence*3 if cadence else None
        row["age_seconds"]=age; row["stale_after_seconds"]=stale_after; row["stale"]=bool(age is not None and stale_after is not None and age>stale_after)
    return results

@app.get("/api/v1/acquisitions")
def acquisitions(limit:int=Query(100,ge=1,le=1000),source_id:str|None=None)->list[dict[str,object]]: return _acquisition_rows(limit,source_id)

@app.get("/api/v1/events")
def persisted_events(limit:int=Query(500,ge=1,le=1000),source_id:str|None=None,category:str|None=None,start:str|None=None,end:str|None=None,min_lat:float|None=Query(None,ge=-90,le=90),max_lat:float|None=Query(None,ge=-90,le=90),min_lon:float|None=Query(None,ge=-180,le=180),max_lon:float|None=Query(None,ge=-180,le=180),q:str|None=Query(None,max_length=200))->list[dict[str,object]]:
    if min_lat is not None and max_lat is not None and min_lat>max_lat: raise HTTPException(400,"min_lat must be <= max_lat")
    if min_lon is not None and max_lon is not None and min_lon>max_lon: raise HTTPException(400,"min_lon must be <= max_lon")
    return list_events(limit,source_id,category,start=start,end=end,min_lat=min_lat,max_lat=max_lat,min_lon=min_lon,max_lon=max_lon,query=q)

@app.get("/api/v1/events/{event_id}/history")
def event_history(event_id:str,limit:int=Query(100,ge=1,le=1000))->list[dict[str,object]]: return list_event_history(event_id,limit)

@app.get("/api/v1/evidence")
def evidence(limit:int=Query(500,ge=1,le=1000),source_id:str|None=None)->list[dict[str,object]]: return list_evidence(limit,source_id)

@app.get("/api/v1/entities")
def entities(limit:int=Query(500,ge=1,le=1000),type:str|None=None,q:str|None=Query(None,max_length=200))->list[dict[str,object]]: return list_entities(limit,type,q)

@app.get("/api/v1/relationships")
def relationships(limit:int=Query(500,ge=1,le=1000),entity_id:str|None=None)->list[dict[str,object]]: return list_relationships(limit,entity_id)

@app.get("/api/v1/cases")
def cases(limit:int=Query(100,ge=1,le=1000),status:str|None=None)->list[dict[str,object]]: return list_cases(limit,status)

@app.get("/api/v1/cases/{case_id}/contents")
def contents(case_id:str)->dict[str,list[str]]: return case_contents(case_id)

@app.get("/api/v1/export/events.csv",response_class=PlainTextResponse)
def export_csv(limit:int=Query(1000,ge=1,le=1000))->PlainTextResponse: return PlainTextResponse(events_csv(list_events(limit)),media_type="text/csv",headers={"Content-Disposition":"attachment; filename=events.csv"})

@app.get("/api/v1/export/events.geojson")
def export_geojson(limit:int=Query(1000,ge=1,le=1000))->dict[str,object]: return events_geojson(list_events(limit))

@app.post("/api/v1/collect/{source_id}")
def collect_and_store(source_id:str)->dict[str,object]:
    adapter=ADAPTERS.get(source_id)
    if not adapter: raise HTTPException(404,"unknown source")
    try:
        acquisition,events=adapter.collect(); save_acquisition(acquisition); count=save_events(events)
        entities_out,relationships_out=derive_graph(events); save_entities(entities_out); save_relationships(relationships_out)
        return {"source_id":source_id,"acquisition_id":acquisition.id,"status":acquisition.status,"events_saved":count,"entities_saved":len(entities_out),"relationships_saved":len(relationships_out)}
    except Exception as exc: raise HTTPException(502,f"collector failed: {type(exc).__name__}") from exc

@app.get("/api/v1/events/live/{source_id}",response_model=list[EventRecord])
def collect_live(source_id:str,limit:int=Query(100,ge=1,le=1000))->list[EventRecord]:
    adapter=ADAPTERS.get(source_id)
    if not adapter: raise HTTPException(404,"unknown source")
    _,events=adapter.collect(); return events[:limit]
