from __future__ import annotations

import csv
import io
import json
from typing import Any


def events_json(events: list[dict[str, Any]]) -> str:
    return json.dumps(events, ensure_ascii=False, indent=2, default=str)


def events_csv(events: list[dict[str, Any]]) -> str:
    fields = ["id", "source_id", "source_record_id", "category", "title", "summary", "observed_at", "updated_at", "latitude", "longitude", "severity", "quality_score"]
    out = io.StringIO(); writer = csv.DictWriter(out, fieldnames=fields); writer.writeheader()
    for event in events:
        writer.writerow({field: event.get(field) for field in fields})
    return out.getvalue()


def events_geojson(events: list[dict[str, Any]]) -> dict[str, Any]:
    features=[]
    for event in events:
        lat=event.get("latitude"); lon=event.get("longitude")
        if lat is None or lon is None:
            continue
        properties={key:value for key,value in event.items() if key not in {"latitude","longitude"}}
        features.append({"type":"Feature","id":event.get("id"),"geometry":{"type":"Point","coordinates":[lon,lat]},"properties":properties})
    return {"type":"FeatureCollection","features":features}
