from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from app.artifact_catalog import catalog_bytes, list_artifacts
from app.contracts import EventRecord, GeoPoint
from app.storage import list_events, save_events

EVENT_VOLUME = 5_000
ARTIFACT_VOLUME = 300


def test_representative_retained_event_and_artifact_volume(tmp_path) -> None:
    """Bound a reviewer-sized local workload without making CI a microbenchmark."""
    db_path = tmp_path / "scale.sqlite3"
    artifact_root = tmp_path / "artifacts"
    epoch = datetime(2026, 1, 1, tzinfo=timezone.utc)
    events = [
        EventRecord(
            id=f"scale:{index}",
            source_id=f"source-{index % 20:02d}",
            source_record_id=str(index),
            category=("earthquake", "weather", "marine", "transport")[index % 4],
            title=f"Representative retained event {index}",
            summary="Synthetic public-safe performance fixture",
            observed_at=epoch + timedelta(seconds=index),
            location=GeoPoint(latitude=-80 + (index % 160), longitude=-170 + (index % 340)),
            severity=("low", "moderate", "high")[index % 3],
            quality_score=0.9,
            properties={"fixture": True, "ordinal": index},
        )
        for index in range(EVENT_VOLUME)
    ]

    started = time.perf_counter()
    assert save_events(events, path=db_path) == EVENT_VOLUME
    event_insert_seconds = time.perf_counter() - started

    started = time.perf_counter()
    page = list_events(500, query="Representative retained event", path=db_path)
    event_query_seconds = time.perf_counter() - started
    assert len(page) == 500

    started = time.perf_counter()
    for index in range(ARTIFACT_VOLUME):
        catalog_bytes(
            f"bounded-artifact-{index:04d}".encode("utf-8"),
            original_name=f"artifact-{index:04d}.txt",
            mime_type="text/plain",
            source="scale-smoke",
            root=artifact_root,
            path=db_path,
        )
    artifact_insert_seconds = time.perf_counter() - started

    started = time.perf_counter()
    artifacts = list_artifacts(ARTIFACT_VOLUME, path=db_path)
    artifact_query_seconds = time.perf_counter() - started
    assert len(artifacts) == ARTIFACT_VOLUME

    # Deliberately generous ceilings catch pathological regressions while remaining
    # stable on shared CI runners; these are acceptance bounds, not benchmark claims.
    assert event_insert_seconds < 30
    assert event_query_seconds < 5
    assert artifact_insert_seconds < 30
    assert artifact_query_seconds < 10
