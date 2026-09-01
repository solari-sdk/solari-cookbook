from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any

from app.contracts import AcquisitionEnvelope, EventRecord


@dataclass(slots=True)
class CollectionResult:
    source_id: str
    acquisition: AcquisitionEnvelope | None
    events: list[EventRecord]
    error_type: str | None = None
    error_message: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.acquisition is not None and self.error_type is None


def collect_many(adapters: dict[str, Any], source_ids: list[str], *, max_workers: int = 4) -> list[CollectionResult]:
    """Collect independent public sources concurrently, returning every outcome.

    Collection runs concurrently but persistence is intentionally left to the caller
    so SQLite writes and graph projection can remain ordered and easy to audit.
    """
    if max_workers < 1 or max_workers > 16:
        raise ValueError("max_workers must be between 1 and 16")
    normalized = list(dict.fromkeys(source_ids))
    if not normalized or len(normalized) > 20:
        raise ValueError("source_ids must contain between 1 and 20 unique entries")
    unknown = [source_id for source_id in normalized if source_id not in adapters]
    if unknown:
        raise KeyError(f"unknown sources: {', '.join(sorted(unknown))}")

    def run(source_id: str) -> CollectionResult:
        try:
            acquisition, events = adapters[source_id].collect()
            return CollectionResult(source_id=source_id, acquisition=acquisition, events=events)
        except Exception as exc:
            return CollectionResult(
                source_id=source_id,
                acquisition=None,
                events=[],
                error_type=type(exc).__name__,
                error_message=str(exc)[:500],
            )

    results: dict[str, CollectionResult] = {}
    with ThreadPoolExecutor(max_workers=min(max_workers, len(normalized))) as pool:
        futures = {pool.submit(run, source_id): source_id for source_id in normalized}
        for future in as_completed(futures):
            result = future.result()
            results[result.source_id] = result
    return [results[source_id] for source_id in normalized]
