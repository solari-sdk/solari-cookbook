from datetime import datetime, timezone
from pathlib import Path

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, EvidenceKind, EvidenceReference, GeoPoint
from app.storage import list_events, save_acquisition, save_events


def test_sqlite_persistence_is_idempotent(tmp_path: Path) -> None:
    db = tmp_path / "ops.sqlite3"
    acquisition = AcquisitionEnvelope(
        id="acq-1",
        source_id="fixture",
        method=AcquisitionMethod.FEED,
        requested_url="https://example.com/feed",
        final_url="https://example.com/feed",
        started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        completed_at=datetime(2026, 1, 1, 0, 0, 1, tzinfo=timezone.utc),
        status="success",
        http_status=200,
        content_type="application/json",
        content_sha256="abc",
    )
    event = EventRecord(
        id="event-1",
        source_id="fixture",
        source_record_id="source-1",
        category="test",
        title="Fixture event",
        observed_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        location=GeoPoint(latitude=1, longitude=2),
        evidence=[EvidenceReference(acquisition_id="acq-1", field="*", kind=EvidenceKind.OBSERVED)],
    )

    save_acquisition(acquisition, db)
    assert save_events([event], db) == 1
    assert save_events([event], db) == 1

    rows = list_events(path=db)
    assert len(rows) == 1
    assert rows[0]["id"] == "event-1"
    assert rows[0]["latitude"] == 1
    assert rows[0]["longitude"] == 2
