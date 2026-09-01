from __future__ import annotations

from typing import Iterable

from app.contracts import EntityRecord, EventRecord
from app.geospatial import distance_and_bearing


def event_entity_proximity(
    events: Iterable[EventRecord],
    entities: Iterable[EntityRecord],
    *,
    radius_km: float,
) -> list[dict[str, object]]:
    """Find explainable event/entity proximity candidates without inferring a relationship."""
    if radius_km < 0:
        raise ValueError("radius_km must be non-negative")
    entity_items = [entity for entity in entities if entity.location is not None]
    matches: list[dict[str, object]] = []
    for event in events:
        if event.location is None:
            continue
        for entity in entity_items:
            metric = distance_and_bearing(event.location, entity.location)
            if metric["distance_km"] <= radius_km:
                matches.append({
                    "event_id": event.id,
                    "entity_id": entity.id,
                    "distance_km": metric["distance_km"],
                    "initial_bearing_degrees": metric["initial_bearing_degrees"],
                    "radius_km": radius_km,
                    "inferred_relationship": False,
                    "reason": "geospatial-proximity-only",
                })
    return sorted(matches, key=lambda item: (float(item["distance_km"]), str(item["event_id"]), str(item["entity_id"])))
