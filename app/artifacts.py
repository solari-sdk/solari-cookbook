from __future__ import annotations

import json
import mimetypes
from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path

DEFAULT_ROOT = Path("data/artifacts")
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    sha256: str
    size_bytes: int
    mime_type: str
    original_name: str | None
    relative_path: str


def store_artifact(data: bytes, *, original_name: str | None = None, mime_type: str | None = None, root: Path = DEFAULT_ROOT) -> ArtifactRecord:
    if len(data) > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact exceeds 50 MiB safety limit")
    digest = sha256(data).hexdigest()
    destination = root / "sha256" / digest[:2] / digest
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        destination.write_bytes(data)
    resolved_mime = mime_type or mimetypes.guess_type(original_name or "")[0] or "application/octet-stream"
    return ArtifactRecord(digest, len(data), resolved_mime, original_name, str(destination.relative_to(root)))


def load_artifact(record: ArtifactRecord, *, root: Path = DEFAULT_ROOT) -> bytes:
    path = (root / record.relative_path).resolve()
    root_resolved = root.resolve()
    if root_resolved not in path.parents:
        raise ValueError("artifact path escapes store root")
    data = path.read_bytes()
    if sha256(data).hexdigest() != record.sha256:
        raise ValueError("artifact integrity check failed")
    return data


def artifact_manifest(records: list[ArtifactRecord]) -> dict[str, object]:
    unique = {record.sha256: record for record in records}
    return {
        "format": "solari-artifact-manifest",
        "version": 1,
        "artifacts": [asdict(unique[key]) for key in sorted(unique)],
    }


def manifest_json(records: list[ArtifactRecord]) -> str:
    return json.dumps(artifact_manifest(records), indent=2, sort_keys=True)
