from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from types import ModuleType
from urllib.request import Request

import pytest

from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, SourceDescriptor, utc_now
from app.raw_archive import RawArchive
from app.raw_capture import RawCaptureIntegrityError, RawCapturingAdapter
from app.sources.registry import ADAPTERS, REGISTERED_ADAPTERS


class FakeResponse:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.status = 200
        self.headers = {"Content-Type": "application/json"}
        self.url = "https://example.org/public.json"

    def read(self, amount: int = -1) -> bytes:
        if amount is None or amount < 0:
            value, self.payload = self.payload, b""
            return value
        value, self.payload = self.payload[:amount], self.payload[amount:]
        return value

    def geturl(self) -> str:
        return self.url

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


def fake_module(payload: bytes, *, bad_digest: bool = False) -> ModuleType:
    module = ModuleType("fixture_public_source")
    module.SOURCE = SourceDescriptor(
        id="fixture-public-source",
        name="Fixture public source",
        category="fixture",
        authoritative_url="https://example.org/public.json",
        method=AcquisitionMethod.API,
    )
    counter = {"value": 0}

    def urlopen(request: Request, timeout: int = 20) -> FakeResponse:
        assert request.full_url == "https://example.org/public.json"
        assert timeout == 20
        return FakeResponse(payload)

    def collect(timeout_seconds: int = 20):
        counter["value"] += 1
        started = utc_now()
        request = Request("https://example.org/public.json")
        with module.urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read()
        completed = utc_now()
        digest = "0" * 64 if bad_digest else sha256(raw).hexdigest()
        acquisition = AcquisitionEnvelope(
            id=f"fixture-acquisition-{counter['value']}",
            source_id=module.SOURCE.id,
            method=module.SOURCE.method,
            requested_url="https://example.org/public.json",
            final_url="https://example.org/public.json",
            started_at=started,
            completed_at=completed,
            status="success",
            http_status=200,
            content_type="application/json",
            content_sha256=digest,
            metadata={"response_bytes": len(raw)},
        )
        event = EventRecord(
            id=f"fixture-event-{counter['value']}",
            source_id=module.SOURCE.id,
            source_record_id=str(counter["value"]),
            category="fixture",
            title="Fixture",
            observed_at=completed,
        )
        return acquisition, [event]

    module.urlopen = urlopen
    module.collect = collect
    return module


def test_raw_capture_retains_exact_consumed_bytes_and_deduplicates(tmp_path: Path) -> None:
    payload = b'{"public":"payload"}'
    root = tmp_path / "raw"
    adapter = RawCapturingAdapter(fake_module(payload), archive_root=root)

    first, _ = adapter.collect()
    second, _ = adapter.collect()

    expected = sha256(payload).hexdigest()
    assert first.metadata["raw_archive_retained"] is True
    assert first.metadata["raw_archive_object_count"] == 1
    assert first.metadata["raw_archive_sha256"] == expected
    assert first.metadata["raw_archive_objects"][0]["size_bytes"] == len(payload)
    assert second.metadata["raw_archive_sha256"] == expected

    archive = RawArchive(root)
    assert archive.get(expected) == payload
    assert len(archive.metadata(expected)) == 2
    assert len(list((root / "objects").rglob(expected))) == 1


def test_raw_capture_rejects_digest_disagreement_before_accepting_collection(tmp_path: Path) -> None:
    adapter = RawCapturingAdapter(fake_module(b"source bytes", bad_digest=True), archive_root=tmp_path / "raw")
    with pytest.raises(RawCaptureIntegrityError):
        adapter.collect()


def test_every_registered_server_source_uses_raw_capture_proxy() -> None:
    assert len(ADAPTERS) == len(REGISTERED_ADAPTERS)
    assert all(adapter.raw_capture_supported for adapter in ADAPTERS.values())
    assert {module.SOURCE.id for module in REGISTERED_ADAPTERS} == set(ADAPTERS)
