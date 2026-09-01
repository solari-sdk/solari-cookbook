import io
import json
import zipfile
from datetime import datetime, timedelta, timezone

from app.artifact_catalog import (
    artifact_metadata,
    artifact_preview,
    build_evidence_bundle,
    catalog_bytes,
    cleanup_expired_artifacts,
    link_artifact,
    list_artifacts,
    set_artifact_retention,
    tag_artifact,
)


def test_catalog_preview_tags_links_and_bundle(tmp_path):
    db = tmp_path / "catalog.sqlite3"
    root = tmp_path / "artifacts"
    item = catalog_bytes(b'{"hello":"world"}', original_name="sample.json", mime_type="application/json", actor="analyst", source="fixture", root=root, path=db)
    digest = item["sha256"]
    assert len(digest) == 64

    tagged = tag_artifact(digest, "Public", path=db)
    assert tagged["tags"] == ["public"]
    linked = link_artifact(digest, "event", "event-1", path=db)
    assert linked["links"][0]["object_id"] == "event-1"
    assert list_artifacts(tag="public", path=db)[0]["sha256"] == digest

    preview = artifact_preview(digest, root=root, path=db)
    assert preview["previewable"] is True
    assert '"hello"' in preview["preview_text"]

    bundle = build_evidence_bundle([digest, digest], root=root, path=db)
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        names = sorted(archive.namelist())
        assert names == [f"artifacts/{digest}", "manifest.json"]
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["artifacts"][0]["sha256"] == digest
        assert archive.read(f"artifacts/{digest}") == b'{"hello":"world"}'


def test_artifact_retention_dry_run_and_cleanup(tmp_path):
    db = tmp_path / "catalog.sqlite3"
    root = tmp_path / "artifacts"
    item = catalog_bytes(b"expired", original_name="expired.txt", retention_days=0, root=root, path=db)
    digest = item["sha256"]
    set_artifact_retention(digest, retention_days=0, path=db)
    future = datetime.now(timezone.utc) + timedelta(seconds=1)

    planned = cleanup_expired_artifacts(dry_run=True, now=future, root=root, path=db)
    assert planned["expired"] == [digest]
    assert artifact_metadata(digest, path=db)["sha256"] == digest

    result = cleanup_expired_artifacts(dry_run=False, now=future, root=root, path=db)
    assert result["deleted"] == [digest]
    assert not any(root.rglob(digest))
