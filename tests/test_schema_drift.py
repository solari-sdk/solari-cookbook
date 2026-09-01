from pathlib import Path

import pytest

from app.schema_drift import detect_schema_drift, quarantine_record


def test_schema_drift_detects_missing_and_unexpected_fields_and_quarantines(tmp_path: Path):
    record = {"id": "1", "unexpected": True}
    report = detect_schema_drift(record, required_fields={"id", "title"}, known_fields={"id", "title"})
    assert report.drift is True
    assert report.missing_required == ("title",)
    assert report.unexpected_fields == ("unexpected",)
    path = quarantine_record(record, report, source_id="public-source", root=tmp_path / "quarantine")
    assert path.is_file()
    assert '"record_sha256"' in path.read_text(encoding="utf-8")
    assert '"unexpected": true' in path.read_text(encoding="utf-8")


def test_clean_record_is_not_quarantined(tmp_path: Path):
    record = {"id": "1", "title": "ok"}
    report = detect_schema_drift(record, required_fields={"id", "title"}, known_fields={"id", "title"})
    assert report.drift is False
    with pytest.raises(ValueError):
        quarantine_record(record, report, source_id="public-source", root=tmp_path)
