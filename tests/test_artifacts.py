from pathlib import Path

import pytest

from app.artifacts import artifact_manifest, load_artifact, store_artifact


class MemoryBackend:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put(self, digest: str, data: bytes) -> str:
        key = f"sha256/{digest}"
        self.objects.setdefault(key, data)
        return key

    def get(self, key: str) -> bytes:
        return self.objects[key]


def test_artifact_store_is_content_addressed_and_deduplicated(tmp_path: Path) -> None:
    first = store_artifact(b"public evidence", original_name="evidence.txt", root=tmp_path)
    second = store_artifact(b"public evidence", original_name="copy.txt", root=tmp_path)
    assert first.sha256 == second.sha256
    assert first.relative_path == second.relative_path
    assert load_artifact(first, root=tmp_path) == b"public evidence"
    manifest = artifact_manifest([first, second])
    assert len(manifest["artifacts"]) == 1
    assert manifest["artifacts"][0]["mime_type"] == "text/plain"


def test_artifact_integrity_failure_is_visible(tmp_path: Path) -> None:
    record = store_artifact(b"original", root=tmp_path)
    path = tmp_path / record.relative_path
    path.write_bytes(b"modified")
    with pytest.raises(ValueError, match="integrity"):
        load_artifact(record, root=tmp_path)


def test_artifact_backend_can_be_replaced_without_changing_manifest_contract() -> None:
    backend = MemoryBackend()
    record = store_artifact(b"portable bytes", original_name="item.bin", backend=backend)
    assert record.relative_path.startswith("sha256/")
    assert load_artifact(record, backend=backend) == b"portable bytes"
    assert len(backend.objects) == 1
