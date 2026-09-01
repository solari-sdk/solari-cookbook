from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

CURRENT_EVENT_SCHEMA_VERSION = 1
Migration = Callable[[dict[str, Any]], dict[str, Any]]


def _v0_to_v1(payload: dict[str, Any]) -> dict[str, Any]:
    migrated = deepcopy(payload)
    event = dict(migrated.get("event") or migrated)
    if "geo" in event and "location" not in event:
        event["location"] = event.pop("geo")
    event.setdefault("quality_score", 1.0)
    return {"schema": "event", "version": 1, "event": event}


EVENT_MIGRATIONS: dict[int, Migration] = {0: _v0_to_v1}


def event_envelope(event: dict[str, Any], *, version: int = CURRENT_EVENT_SCHEMA_VERSION) -> dict[str, Any]:
    if version != CURRENT_EVENT_SCHEMA_VERSION:
        raise ValueError("only the current event schema can be emitted")
    return {"schema": "event", "version": version, "event": deepcopy(event)}


def migrate_event_payload(payload: dict[str, Any], *, to_version: int = CURRENT_EVENT_SCHEMA_VERSION) -> dict[str, Any]:
    if to_version < 1 or to_version > CURRENT_EVENT_SCHEMA_VERSION:
        raise ValueError("unsupported target event schema version")
    current = int(payload.get("version", 0))
    working = deepcopy(payload)
    if current > to_version:
        raise ValueError("downgrade migrations are not supported")
    while current < to_version:
        migration = EVENT_MIGRATIONS.get(current)
        if migration is None:
            raise ValueError(f"no event migration registered from version {current}")
        working = migration(working)
        current = int(working["version"])
    if working.get("schema") != "event":
        raise ValueError("payload is not an event schema envelope")
    return working
