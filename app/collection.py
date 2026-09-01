from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any

from app.contracts import AcquisitionEnvelope, EventRecord
from app.jobs import CircuitBreaker, FailureClass, RetryPolicy, run_with_retry


@dataclass(slots=True)
class CollectionResult:
    source_id: str
    acquisition: AcquisitionEnvelope | None
    events: list[EventRecord]
    error_type: str | None = None
    error_message: str | None = None
    failure_class: FailureClass | None = None
    attempts: int = 0
    attempt_durations_ms: list[float] = field(default_factory=list)

    @property
    def succeeded(self) -> bool:
        return self.acquisition is not None and self.error_type is None


def collect_many(
    adapters: dict[str, Any],
    source_ids: list[str],
    *,
    max_workers: int = 4,
    retry_policy: RetryPolicy | None = None,
    breakers: dict[str, CircuitBreaker] | None = None,
) -> list[CollectionResult]:
    """Collect independent public sources concurrently with bounded retries.

    Collection runs concurrently but persistence is intentionally left to the caller
    so SQLite writes and graph projection can remain ordered and easy to audit.
    When a breaker mapping is supplied, repeated terminal failures open a per-source
    cooldown circuit; CircuitBreaker.can_run() automatically closes it after cooldown.
    """
    if max_workers < 1 or max_workers > 16:
        raise ValueError("max_workers must be between 1 and 16")
    normalized = list(dict.fromkeys(source_ids))
    if not normalized or len(normalized) > 20:
        raise ValueError("source_ids must contain between 1 and 20 unique entries")
    unknown = [source_id for source_id in normalized if source_id not in adapters]
    if unknown:
        raise KeyError(f"unknown sources: {', '.join(sorted(unknown))}")
    retry_policy = retry_policy or RetryPolicy()

    def run(source_id: str) -> CollectionResult:
        breaker = breakers.get(source_id) if breakers is not None else None
        execution = run_with_retry(
            f"collect:{source_id}",
            adapters[source_id].collect,
            policy=retry_policy,
            breaker=breaker,
        )
        if execution.status.value == "succeeded" and execution.result is not None:
            acquisition, events = execution.result
            return CollectionResult(
                source_id=source_id,
                acquisition=acquisition,
                events=events,
                attempts=execution.attempts,
                attempt_durations_ms=execution.attempt_durations_ms,
            )
        return CollectionResult(
            source_id=source_id,
            acquisition=None,
            events=[],
            error_type=execution.error_type,
            error_message=execution.error_message[:500] if execution.error_message else None,
            failure_class=execution.failure_class,
            attempts=execution.attempts,
            attempt_durations_ms=execution.attempt_durations_ms,
        )

    results: dict[str, CollectionResult] = {}
    with ThreadPoolExecutor(max_workers=min(max_workers, len(normalized))) as pool:
        futures = {pool.submit(run, source_id): source_id for source_id in normalized}
        for future in as_completed(futures):
            result = future.result()
            results[result.source_id] = result
    return [results[source_id] for source_id in normalized]
