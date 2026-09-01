from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from app.alerts_api import router as alerts_router
from app.artifact_api import router as artifact_router
from app.collection import collect_many
from app.contracts import AcquisitionEnvelope, CaseRecord, EntityRecord, EventRecord, RelationshipRecord, SourceDescriptor
from app.correlation_api import router as correlation_router
from app.entities import derive_graph
from app.exports import events_csv, events_geojson
from app.graph_api import router as graph_router
from app.job_store import job_metrics, record_collection_result, record_job_execution
from app.jobs import CircuitBreaker, RetryPolicy, run_with_retry
from app.jobs_api import router as jobs_router
from app.notes_api import router as notes_router
from app.observability import current_correlation_id, install_observability
from app.observables import ObservableRecord
from app.pagination_api import router as pagination_router
from app.recon_api import router as recon_router
from app.sources import nhc_tropical_cyclones, nws_alerts, swpc_alerts, usgs_earthquakes
from app.storage import (
    case_contents, connect, list_acquisitions, list_cases, list_entities, list_event_history,
    list_events, list_evidence, list_relationships, save_acquisition, save_entities, save_events,
    save_relationships, source_health,
)
from app.tracking_api import router as tracking_router
from app.workspace_api import router as workspace_router

VERSION = "0.11.0"
app = FastAPI(title="Solari OSINT Operations Center", version=VERSION, description="Public-source OSINT operations dashboard and Solari execution showcase.")
install_observability(app)
for router in (graph_router, pagination_router, correlation_router, workspace_router, notes_router, artifact_router, alerts_router, recon_router, tracking_router, jobs_router):
    app.include_router(router)
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
ADAPTERS = {adapter.SOURCE.id: adapter for adapter in (usgs_earthquakes, nws_alerts, swpc_alerts, nhc_tropical_cyclones)}
SOURCES: dict[str, SourceDescriptor] = {key: adapter.SOURCE for key, adapter in ADAPTERS.items()}
SOURCE_BREAKERS = {source_id: CircuitBreaker(failure_threshold=3, cooldown_seconds=60) for source_id in ADAPTERS}
COLLECTION_RETRY_POLICY = RetryPolicy(max_attempts=3, base_delay_seconds=0.5, max_delay_seconds=4.0)


def _acquisition_rows(limit: int = 100, source_id: str | None = None) -> list[dict[str, object]]:
    rows = list_acquisitions(limit, source_id)
    for row in rows:
        raw = row.pop("metadata_json", "{}")
        try:
            row["metadata"] = json.loads(str(raw))
        except json.JSONDecodeError:
            row["metadata"] = {"decode_error": True}
    return rows


def _persist_collection(acquisition: AcquisitionEnvelope, events: list[EventRecord]) -> dict[str, object]:
    save_acquisition(acquisition)
    count = save_events(events)
    entities_out, relationships_out = derive_graph(events)
    save_entities(entities_out)
    save_relationships(relationships_out)
    return {
        "source_id": acquisition.source_id,
        "acquisition_id": acquisition.id,
        "status": acquisition.status,
        "events_saved": count,
        "entities_saved": len(entities_out),
        "relationships_saved": len(relationships_out),
    }


def _read_only_openapi() -> dict[str, object]:
    spec = app.openapi()
    paths: dict[str, object] = {}
    for path, operations in spec.get("paths", {}).items():
        if not path.startswith("/api/v1/"):
            continue
        read_operations = {method: operation for method, operation in operations.items() if method.lower() in {"get", "head", "options"}}
        if read_operations:
            paths[path] = read_operations
    return {**spec, "info": {**spec["info"], "title": f"{spec['info']['title']} — read-only explorer"}, "paths": paths}


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
    return {"event":EventRecord.model_json_schema(),"source":SourceDescriptor.model_json_schema(),"acquisition":AcquisitionEnvelope.model_json_schema(),"entity":EntityRecord.model_json_schema(),"relationship":RelationshipRecord.model_json_schema(),"case":CaseRecord.model_json_schema(),"observable":ObservableRecord.model_json_schema()}

@app.get("/api/v1/read-only-openapi.json", include_in_schema=False)
def read_only_openapi() -> dict[str, object]: return _read_only_openapi()

@app.get("/api/v1/read-only-docs", response_class=HTMLResponse, include_in_schema=False)
def read_only_docs() -> HTMLResponse: return get_swagger_ui_html(openapi_url="/api/v1/read-only-openapi.json", title="Solari OSINT read-only API explorer")

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
        "jobs": job_metrics(),
        "circuit_breakers": {
            source_id: {
                "can_run": breaker.can_run(),
                "consecutive_failures": breaker.consecutive_failures,
                "opened_at": breaker.opened_at.isoformat() if breaker.opened_at else None,
                "cooldown_seconds": breaker.cooldown_seconds,
            }
            for source_id, breaker in SOURCE_BREAKERS.items()
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

@app.post("/api/v1/collect-batch")
def collect_batch(source_id:list[str]=Query(...),max_workers:int=Query(4,ge=1,le=16))->dict[str,object]:
    try:
        results=collect_many(ADAPTERS,source_id,max_workers=max_workers,retry_policy=COLLECTION_RETRY_POLICY,breakers=SOURCE_BREAKERS)
    except (ValueError,KeyError) as exc:
        raise HTTPException(400,str(exc)) from exc
    output=[]
    correlation_id=current_correlation_id()
    for result in results:
        job=record_collection_result(result,correlation_id=correlation_id)
        if result.succeeded and result.acquisition is not None:
            item=_persist_collection(result.acquisition,result.events)
            item.update({"job_id":job["id"],"attempts":result.attempts,"attempt_durations_ms":result.attempt_durations_ms})
            output.append(item)
        else:
            output.append({"source_id":result.source_id,"status":"failure","job_id":job["id"],"attempts":result.attempts,"failure_class":result.failure_class.value if result.failure_class else None,"error_type":result.error_type,"error_message":result.error_message})
    return {"requested":len(results),"succeeded":sum(1 for item in results if item.succeeded),"failed":sum(1 for item in results if not item.succeeded),"results":output}

@app.post("/api/v1/collect/{source_id}")
def collect_and_store(source_id:str)->dict[str,object]:
    adapter=ADAPTERS.get(source_id)
    if not adapter: raise HTTPException(404,"unknown source")
    execution=run_with_retry(f"collect:{source_id}",adapter.collect,policy=COLLECTION_RETRY_POLICY,breaker=SOURCE_BREAKERS[source_id])
    job=record_job_execution(execution,source_id=source_id,correlation_id=current_correlation_id())
    if execution.result is None:
        raise HTTPException(502,{"message":"collector failed","job_id":job["id"],"failure_class":execution.failure_class.value if execution.failure_class else None,"error_type":execution.error_type})
    acquisition,events=execution.result
    item=_persist_collection(acquisition,events)
    item.update({"job_id":job["id"],"attempts":execution.attempts,"attempt_durations_ms":execution.attempt_durations_ms})
    return item

@app.get("/api/v1/events/live/{source_id}",response_model=list[EventRecord])
def collect_live(source_id:str,limit:int=Query(100,ge=1,le=1000))->list[EventRecord]:
    adapter=ADAPTERS.get(source_id)
    if not adapter: raise HTTPException(404,"unknown source")
    execution=run_with_retry(f"collect-live:{source_id}",adapter.collect,policy=COLLECTION_RETRY_POLICY,breaker=SOURCE_BREAKERS[source_id])
    record_job_execution(execution,source_id=source_id,correlation_id=current_correlation_id())
    if execution.result is None: raise HTTPException(502,"live collector failed")
    _,events=execution.result
    return events[:limit]
