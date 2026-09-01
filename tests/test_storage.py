from datetime import datetime, timezone
from pathlib import Path

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, GeoPoint
from app.storage import list_event_history, list_events, save_acquisition, save_events


def _event(event_id: str = "event-1", title: str = "Fixture event", lat: float = 1, lon: float = 2) -> EventRecord:
    return EventRecord(
        id=event_id,
        source_id="fixture",
        source_record_id=event_id,
        category="test",
        title=title,
        observed_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        location=GeoPoint(latitude=lat, longitude=lon),
        evidence=[EvidenceReference(acquisition_id="acq-1", field="*", kind=EvidenceKind.OBSERVED)],
    )


def test_sqlite_persistence_is_idempotent_and_retains_history(tmp_path: Path) -> None:
    db = tmp_path / "ops.sqlite3"
    acquisition = AcquisitionEnvelope(
        id="acq-1", source_id="fixture", method=AcquisitionMethod.FEED,
        requested_url="https://example.com/feed", final_url="https://example.com/feed",
        started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        completed_at=datetime(2026, 1, 1, 0, 0, 1, tzinfo=timezone.utc),
        status="success", http_status=200, content_type="application/json", content_sha256="abc",
    )
    save_acquisition(acquisition, db)
    assert save_events([_event()], db) == 1
    assert save_events([_event(title="Updated fixture")], db) == 1

    rows = list_events(path=db)
    assert len(rows) == 1
    assert rows[0]["id"] == "event-1"
    assert rows[0]["latitude"] == 1
    assert rows[0]["longitude"] == 2
    assert rows[0]["sighting_count"] == 2
    assert rows[0]["first_seen"]
    assert rows[0]["last_seen"]
    assert len(list_event_history("event-1", path=db)) == 2


def test_event_filters_cover_text_time_and_bounds(tmp_path: Path) -> None:
    db = tmp_path / "ops.sqlite3"
    save_events([_event(title="Searchable fixture")], db)
    assert list_events(query="Searchable", path=db)[0]["id"] == "event-1"
    assert list_events(min_lat=0, max_lat=2, min_lon=1, max_lon=3, path=db)[0]["id"] == "event-1"
    assert list_events(start="2025-12-31T00:00:00+00:00", end="2026-01-02T00:00:00+00:00", path=db)[0]["id"] == "event-1"
    assert list_events(min_lat=20, path=db) == []
