from pathlib import Path

import pytest

from app.raw_archive import RawArchive


def test_raw_archive_deduplicates_bytes_and_preserves_acquisition_metadata(tmp_path: Path):
    archive = RawArchive(tmp_path / "raw")
    first = archive.put(b"public raw payload", acquisition_id="acq-1", source_id="public-source", media_type="text/plain", metadata={"url": "https://example.test/a"})
    second = archive.put(b"public raw payload", acquisition_id="acq-2", source_id="public-source", media_type="text/plain", metadata={"url": "https://example.test/b"})

    assert first.sha256 == second.sha256
    assert archive.get(first.sha256) == b"public raw payload"
    assert archive.exists(first.sha256)
    assert len(archive.metadata(first.sha256)) == 2
    assert len(list((tmp_path / "raw" / "objects").rglob(first.sha256))) == 1


def test_raw_archive_metadata_is_immutable_for_same_acquisition(tmp_path: Path):
    archive = RawArchive(tmp_path / "raw")
    archive.put(b"same", acquisition_id="acq-1", source_id="source", metadata={"version": 1})
    with pytest.raises(ValueError):
        archive.put(b"same", acquisition_id="acq-1", source_id="source", metadata={"version": 2})
