from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from time import perf_counter
from typing import Any, Callable, Iterable

Enricher = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True, slots=True)
class EnrichmentStep:
    id: str
    run: Enricher


@dataclass(frozen=True, slots=True)
class EnrichmentResult:
    step_id: str
    status: str
    duration_ms: float
    output: dict[str, Any] | None
    error_type: str | None
    error_message: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def run_enrichment_pipeline(
    record: dict[str, Any],
    steps: Iterable[EnrichmentStep],
    *,
    max_workers: int = 4,
) -> dict[str, Any]:
    """Fan out independent enrichers and deterministically fan their results back in."""
    items = list(steps)
    if max_workers < 1:
        raise ValueError("max_workers must be positive")
    if len({step.id for step in items}) != len(items):
        raise ValueError("enrichment step ids must be unique")

    def execute(step: EnrichmentStep) -> EnrichmentResult:
        started = perf_counter()
        try:
            output = step.run(dict(record))
            if not isinstance(output, dict):
                raise TypeError("enrichment step must return a dict")
            return EnrichmentResult(step.id, "success", (perf_counter() - started) * 1000.0, output, None, None)
        except Exception as exc:
            return EnrichmentResult(step.id, "failure", (perf_counter() - started) * 1000.0, None, type(exc).__name__, str(exc))

    results: list[EnrichmentResult] = []
    with ThreadPoolExecutor(max_workers=min(max_workers, max(1, len(items)))) as pool:
        futures = {pool.submit(execute, step): step.id for step in items}
        for future in as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda result: result.step_id)

    merged: dict[str, Any] = {}
    conflicts: dict[str, list[dict[str, Any]]] = {}
    owners: dict[str, str] = {}
    for result in results:
        if result.output is None:
            continue
        for key, value in result.output.items():
            if key not in merged:
                merged[key] = value
                owners[key] = result.step_id
            elif merged[key] != value:
                conflicts.setdefault(key, [{"step_id": owners[key], "value": merged[key]}]).append({"step_id": result.step_id, "value": value})
    return {
        "input": dict(record),
        "enriched": merged,
        "conflicts": conflicts,
        "steps": [result.to_dict() for result in results],
        "status": "success" if all(result.status == "success" for result in results) else "partial",
    }
