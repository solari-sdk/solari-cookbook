from __future__ import annotations

import json
import mimetypes
from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Protocol

DEFAULT_ROOT = Path("data/artifacts")
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024


class ArtifactBackend(Protocol):
    """Minimal content-addressed byte-store contract for local or object storage."""

    def put(self, digest: str, data: bytes) -> str: ...
    def get(self, key: str) -> bytes: ...


@dataclass(slots=True)
class LocalArtifactBackend:
    root: Path = DEFAULT_ROOT

    def put(self, digest: str, data: bytes) -> str:
        destination = self.root / "sha256" / digest[:2] / digest
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            destination.write_bytes(data)
        return str(destination.relative_to(self.root))

    def get(self, key: str) -> bytes:
        path = (self.root / key).resolve()
        root_resolved = self.root.resolve()
        if root_resolved not in path.parents:
            raise ValueError("artifact path escapes store root")
        return path.read_bytes()


@dataclass(slots=True)
class S3CompatibleArtifactBackend:
    """Content-addressed artifact backend for an injected S3-compatible client.

    The injected client must expose ``put_object(Bucket=..., Key=..., Body=...)`` and
    ``get_object(Bucket=..., Key=...)``. Credentials stay in the client's normal
    provider/instance-role configuration and are never accepted or persisted here.
    """

    client: Any
    bucket: str
    prefix: str = "artifacts"

    def __post_init__(self) -> None:
        self.bucket = self.bucket.strip()
        self.prefix = self.prefix.strip("/")
        if not self.bucket:
            raise ValueError("S3-compatible artifact bucket is required")
        if not self.prefix or self.prefix in {".", ".."} or ".." in self.prefix.split("/"):
            raise ValueError("invalid S3-compatible artifact prefix")

    def _key(self, digest: str) -> str:
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("artifact digest must be a lowercase SHA-256 hex value")
        return f"{self.prefix}/sha256/{digest[:2]}/{digest}"

    def put(self, digest: str, data: bytes) -> str:
        key = self._key(digest)
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data)
        return key

    def get(self, key: str) -> bytes:
        expected = f"{self.prefix}/sha256/"
        if not key.startswith(expected) or ".." in key.split("/"):
            raise ValueError("artifact key is outside the configured object-storage prefix")
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        body = response.get("Body") if isinstance(response, dict) else None
        if body is None or not hasattr(body, "read"):
            raise ValueError("S3-compatible client returned no readable Body")
        data = body.read()
        if not isinstance(data, (bytes, bytearray)):
            raise ValueError("S3-compatible artifact body must be bytes")
        return bytes(data)


def s3_backend_from_boto3(*, bucket: str, prefix: str = "artifacts", endpoint_url: str | None = None, region_name: str | None = None) -> S3CompatibleArtifactBackend:
    """Create the optional backend using boto3 when the deployment provides it.

    No access key/secret arguments are accepted. boto3's normal environment, profile,
    workload-identity or instance-role credential chain remains outside repository data.
    """
    try:
        import boto3  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("boto3 is required to construct the optional S3-compatible backend") from exc
    if endpoint_url:
        from urllib.parse import urlparse

        parsed = urlparse(endpoint_url)
        local = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if parsed.scheme != "https" and not local:
            raise ValueError("S3-compatible endpoint must use HTTPS except for localhost development")
        if parsed.username or parsed.password:
            raise ValueError("S3-compatible endpoint must not embed credentials")
    client = boto3.client("s3", endpoint_url=endpoint_url, region_name=region_name)
    return S3CompatibleArtifactBackend(client=client, bucket=bucket, prefix=prefix)


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    sha256: str
    size_bytes: int
    mime_type: str
    original_name: str | None
    relative_path: str


def _backend(root: Path, backend: ArtifactBackend | None) -> ArtifactBackend:
    return backend if backend is not None else LocalArtifactBackend(root)


def store_artifact(
    data: bytes,
    *,
    original_name: str | None = None,
    mime_type: str | None = None,
    root: Path = DEFAULT_ROOT,
    backend: ArtifactBackend | None = None,
) -> ArtifactRecord:
    if len(data) > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact exceeds 50 MiB safety limit")
    digest = sha256(data).hexdigest()
    key = _backend(root, backend).put(digest, data)
    resolved_mime = mime_type or mimetypes.guess_type(original_name or "")[0] or "application/octet-stream"
    return ArtifactRecord(digest, len(data), resolved_mime, original_name, key)


def load_artifact(
    record: ArtifactRecord,
    *,
    root: Path = DEFAULT_ROOT,
    backend: ArtifactBackend | None = None,
) -> bytes:
    data = _backend(root, backend).get(record.relative_path)
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
