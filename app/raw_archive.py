from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class RawObjectRef:
    sha256: str
    size_bytes: int
    object_path: str
    metadata_path: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


class RawArchive:
    """Immutable content-addressed raw-object archive.

    Object bytes are addressed only by SHA-256 and never overwritten. Per-acquisition
    metadata is stored separately so one byte-identical object can be referenced by
    many acquisitions without duplicating content.
    """

    def __init__(self, root: Path) -> None:
        self.root = root

    def _object_path(self, digest: str) -> Path:
        if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
            raise ValueError("invalid SHA-256 digest")
        return self.root / "objects" / digest[:2] / digest

    def _metadata_path(self, digest: str, acquisition_id: str) -> Path:
        safe = "".join(ch for ch in acquisition_id if ch.isalnum() or ch in "._-")
        if not safe:
            raise ValueError("acquisition_id must contain a safe identifier character")
        return self.root / "metadata" / digest[:2] / digest / f"{safe}.json"

    def put(
        self,
        data: bytes,
        *,
        acquisition_id: str,
        source_id: str,
        media_type: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RawObjectRef:
        digest = sha256(data).hexdigest()
        object_path = self._object_path(digest)
        object_path.parent.mkdir(parents=True, exist_ok=True)
        if not object_path.exists():
            object_path.write_bytes(data)
        elif sha256(object_path.read_bytes()).hexdigest() != digest:
            raise RuntimeError("content-addressed object failed integrity verification")

        metadata_path = self._metadata_path(digest, acquisition_id)
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        envelope = {
            "sha256": digest,
            "size_bytes": len(data),
            "acquisition_id": acquisition_id,
            "source_id": source_id,
            "media_type": media_type,
            "metadata": metadata or {},
        }
        encoded = json.dumps(envelope, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
        if metadata_path.exists():
            existing = metadata_path.read_bytes()
            if existing != encoded:
                raise ValueError("metadata for this acquisition/object pair is immutable")
        else:
            metadata_path.write_bytes(encoded)

        return RawObjectRef(
            sha256=digest,
            size_bytes=len(data),
            object_path=str(object_path),
            metadata_path=str(metadata_path),
        )

    def get(self, digest: str) -> bytes:
        path = self._object_path(digest)
        data = path.read_bytes()
        if sha256(data).hexdigest() != digest:
            raise RuntimeError("raw object integrity verification failed")
        return data

    def exists(self, digest: str) -> bool:
        return self._object_path(digest).is_file()

    def metadata(self, digest: str) -> list[dict[str, Any]]:
        directory = self.root / "metadata" / digest[:2] / digest
        if not directory.exists():
            return []
        output: list[dict[str, Any]] = []
        for path in sorted(directory.glob("*.json")):
            output.append(json.loads(path.read_text(encoding="utf-8")))
        return output
