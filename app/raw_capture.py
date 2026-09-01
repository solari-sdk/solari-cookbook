from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from app.contracts import AcquisitionEnvelope, EventRecord
from app.raw_archive import RawArchive


DEFAULT_RAW_ARCHIVE_ROOT = Path("data/raw-archive")


class RawCaptureError(RuntimeError):
    """Raised when a successful registered collection cannot retain its raw bytes."""


class RawCaptureIntegrityError(RawCaptureError):
    """Raised when captured bytes disagree with an acquisition content digest."""


@dataclass(slots=True)
class CapturedResponse:
    index: int
    data: bytearray = field(default_factory=bytearray)
    content_type: str | None = None
    http_status: int | None = None

    @property
    def bytes(self) -> bytes:
        return bytes(self.data)


class _CapturingResponse:
    """Transparent urllib response proxy that records exactly the bytes consumed."""

    def __init__(self, response: Any, capture: CapturedResponse) -> None:
        self._response = response
        self._capture = capture
        self._refresh_metadata()

    def _refresh_metadata(self) -> None:
        status = getattr(self._response, "status", None)
        self._capture.http_status = int(status) if isinstance(status, int) else None
        headers = getattr(self._response, "headers", None)
        if headers is not None and hasattr(headers, "get"):
            value = headers.get("Content-Type")
            self._capture.content_type = str(value) if value else None

    def _record(self, value: Any) -> Any:
        if isinstance(value, bytes):
            self._capture.data.extend(value)
        elif isinstance(value, bytearray):
            self._capture.data.extend(bytes(value))
        return value

    def read(self, *args: Any, **kwargs: Any) -> Any:
        return self._record(self._response.read(*args, **kwargs))

    def read1(self, *args: Any, **kwargs: Any) -> Any:
        return self._record(self._response.read1(*args, **kwargs))

    def readline(self, *args: Any, **kwargs: Any) -> Any:
        return self._record(self._response.readline(*args, **kwargs))

    def readlines(self, *args: Any, **kwargs: Any) -> Any:
        lines = self._response.readlines(*args, **kwargs)
        for line in lines:
            self._record(line)
        return lines

    def readinto(self, buffer: Any) -> Any:
        count = self._response.readinto(buffer)
        if isinstance(count, int) and count > 0:
            self._capture.data.extend(bytes(memoryview(buffer)[:count]))
        return count

    def __iter__(self) -> _CapturingResponse:
        return self

    def __next__(self) -> Any:
        line = self.readline()
        if line in (b"", ""):
            raise StopIteration
        return line

    def __enter__(self) -> _CapturingResponse:
        entered = self._response.__enter__()
        if entered is not None:
            self._response = entered
        self._refresh_metadata()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> Any:
        return self._response.__exit__(exc_type, exc, tb)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._response, name)


class _CapturingOpener:
    """Proxy for urllib opener objects used by allowlisted/custom redirect collectors."""

    def __init__(self, opener: Any, wrap_response: Callable[[Any], _CapturingResponse]) -> None:
        self._opener = opener
        self._wrap_response = wrap_response

    def open(self, *args: Any, **kwargs: Any) -> _CapturingResponse:
        return self._wrap_response(self._opener.open(*args, **kwargs))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._opener, name)


def _archive_root_from_environment() -> Path:
    configured = os.getenv("SOLARI_RAW_ARCHIVE_DIR", "").strip()
    return Path(configured) if configured else DEFAULT_RAW_ARCHIVE_ROOT


class RawCapturingAdapter:
    """Registry proxy that retains consumed public-source response bytes immutably.

    Source modules remain independently unit-testable. Registry/runtime callers use
    this proxy, which serializes same-source collection while temporarily wrapping
    either the module's imported ``urlopen`` function or an explicit ``build_opener``
    boundary. This covers the registered direct urllib collectors without replacing
    their source-specific request validation or redirect policy.
    """

    def __init__(self, module: ModuleType, *, archive_root: Path | None = None) -> None:
        self._module = module
        self._archive_root = archive_root
        self._collect_lock = threading.RLock()
        self.SOURCE = module.SOURCE
        has_network_boundary = callable(getattr(module, "urlopen", None)) or callable(getattr(module, "build_opener", None))
        self.raw_capture_supported = has_network_boundary and callable(getattr(module, "collect", None))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._module, name)

    def _archive(self) -> RawArchive:
        return RawArchive(self._archive_root or _archive_root_from_environment())

    def collect(self, *args: Any, **kwargs: Any) -> tuple[AcquisitionEnvelope, list[EventRecord]]:
        if not self.raw_capture_supported:
            raise RawCaptureError(f"registered source {self.SOURCE.id} does not expose a capturable urllib network boundary")

        captures: list[CapturedResponse] = []

        def wrap_response(response: Any) -> _CapturingResponse:
            capture = CapturedResponse(index=len(captures))
            captures.append(capture)
            return _CapturingResponse(response, capture)

        with self._collect_lock:
            original_urlopen = getattr(self._module, "urlopen", None)
            original_build_opener = getattr(self._module, "build_opener", None)

            if callable(original_urlopen):
                def capturing_urlopen(*open_args: Any, **open_kwargs: Any) -> _CapturingResponse:
                    return wrap_response(original_urlopen(*open_args, **open_kwargs))
                setattr(self._module, "urlopen", capturing_urlopen)

            if callable(original_build_opener):
                def capturing_build_opener(*open_args: Any, **open_kwargs: Any) -> _CapturingOpener:
                    return _CapturingOpener(original_build_opener(*open_args, **open_kwargs), wrap_response)
                setattr(self._module, "build_opener", capturing_build_opener)

            try:
                acquisition, events = self._module.collect(*args, **kwargs)
            finally:
                if callable(original_urlopen):
                    setattr(self._module, "urlopen", original_urlopen)
                if callable(original_build_opener):
                    setattr(self._module, "build_opener", original_build_opener)

        if acquisition.status != "success":
            return acquisition, events

        completed = [capture for capture in captures if capture.data]
        if not completed:
            raise RawCaptureError(f"successful source {self.SOURCE.id} collection produced no captured response bytes")

        if len(completed) == 1 and acquisition.content_sha256:
            digest = sha256(completed[0].bytes).hexdigest()
            if digest != acquisition.content_sha256:
                raise RawCaptureIntegrityError(
                    f"captured bytes for {self.SOURCE.id} do not match acquisition content_sha256"
                )

        archive = self._archive()
        retained: list[dict[str, object]] = []
        for capture in completed:
            data = capture.bytes
            digest = sha256(data).hexdigest()
            capture_id = f"{acquisition.id}:response:{capture.index}"
            ref = archive.put(
                data,
                acquisition_id=capture_id,
                source_id=acquisition.source_id,
                media_type=capture.content_type,
                metadata={
                    "parent_acquisition_id": acquisition.id,
                    "response_index": capture.index,
                    "http_status": capture.http_status,
                    "content_type": capture.content_type,
                    "capture_scope": "bytes-consumed-by-collector",
                },
            )
            retained.append(
                {
                    "sha256": ref.sha256,
                    "size_bytes": ref.size_bytes,
                    "response_index": capture.index,
                    "http_status": capture.http_status,
                    "content_type": capture.content_type,
                }
            )
            if ref.sha256 != digest:
                raise RawCaptureIntegrityError(f"raw archive digest mismatch for {self.SOURCE.id}")

        acquisition.metadata["raw_archive_retained"] = True
        acquisition.metadata["raw_archive_object_count"] = len(retained)
        acquisition.metadata["raw_archive_objects"] = retained
        if len(retained) == 1:
            acquisition.metadata["raw_archive_sha256"] = retained[0]["sha256"]
        return acquisition, events
