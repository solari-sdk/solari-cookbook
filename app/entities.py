from __future__ import annotations

from app.contracts import EntityRecord, EventRecord, RelationshipRecord, stable_id


def derive_graph(events: list[EventRecord]) -> tuple[list[EntityRecord], list[RelationshipRecord]]:
    """Build a deterministic graph projection without inventing facts.

    Each normalized event becomes an event entity. Source and location entities are
    created only from fields already present on the event, and edges describe those
    observed/normalized relationships. No semantic inference is performed here.
    """
    entities: dict[str, EntityRecord] = {}
    relationships: dict[str, RelationshipRecord] = {}

    for event in events:
        event_entity_id = stable_id("entity", "event", event.id)
        entities[event_entity_id] = EntityRecord(
            id=event_entity_id,
            type="event",
            label=event.title,
            first_seen=event.observed_at,
            last_seen=event.updated_at or event.observed_at,
            location=event.location,
            confidence=event.quality_score,
            properties={"event_id": event.id, "category": event.category, "severity": event.severity},
            evidence=event.evidence,
        )

        source_entity_id = stable_id("entity", "source", event.source_id)
        entities[source_entity_id] = EntityRecord(
            id=source_entity_id,
            type="source",
            label=event.source_id,
            first_seen=event.observed_at,
            last_seen=event.updated_at or event.observed_at,
            properties={"source_id": event.source_id},
            evidence=event.evidence,
        )
        reported_id = stable_id("relationship", event_entity_id, "reported_by", source_entity_id)
        relationships[reported_id] = RelationshipRecord(
            id=reported_id,
            source_entity_id=event_entity_id,
            target_entity_id=source_entity_id,
            type="reported_by",
            first_seen=event.observed_at,
            last_seen=event.updated_at or event.observed_at,
            confidence=1.0,
            observed=True,
            evidence=event.evidence,
        )

        if event.location:
            location_entity_id = stable_id(
                "entity", "location", f"{event.location.latitude:.6f}", f"{event.location.longitude:.6f}"
            )
            entities[location_entity_id] = EntityRecord(
                id=location_entity_id,
                type="location",
                label=f"{event.location.latitude:.6f}, {event.location.longitude:.6f}",
                first_seen=event.observed_at,
                last_seen=event.updated_at or event.observed_at,
                location=event.location,
                properties={"precision": event.location.precision},
                evidence=event.evidence,
            )
            located_id = stable_id("relationship", event_entity_id, "occurred_at", location_entity_id)
            relationships[located_id] = RelationshipRecord(
                id=located_id,
                source_entity_id=event_entity_id,
                target_entity_id=location_entity_id,
                type="occurred_at",
                first_seen=event.observed_at,
                last_seen=event.updated_at or event.observed_at,
                confidence=event.quality_score,
                observed=True,
                evidence=event.evidence,
            )

    return list(entities.values()), list(relationships.values())
