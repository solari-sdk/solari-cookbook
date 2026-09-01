from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Generic, TypeVar

T = TypeVar("T")


class SourceRateLimited(RuntimeError):
    def __init__(self, retry_after_seconds: float):
        self.retry_after_seconds = max(0.0, retry_after_seconds)
        super().__init__(f"source rate limited; retry after {self.retry_after_seconds:.3f}s")


class SourceQuotaExceeded(RuntimeError):
    def __init__(self, retry_after_seconds: float):
        self.retry_after_seconds = max(0.0, retry_after_seconds)
        super().__init__(f"source quota exceeded; retry after {self.retry_after_seconds:.3f}s")


@dataclass(frozen=True, slots=True)
class SourceRuntimePolicy:
    min_interval_seconds: float = 1.0
    max_calls_per_window: int = 60
    window_seconds: float = 60.0
    cache_ttl_seconds: float = 15.0

    def __post_init__(self) -> None:
        if self.min_interval_seconds < 0:
            raise ValueError("min_interval_seconds must be non-negative")
        if self.max_calls_per_window < 1 or self.max_calls_per_window > 100000:
            raise ValueError("max_calls_per_window must be between 1 and 100000")
        if self.window_seconds <= 0 or self.cache_ttl_seconds < 0:
            raise ValueError("window_seconds must be positive and cache_ttl_seconds non-negative")


@dataclass(slots=True)
class SourceRuntimeStats:
    network_calls: int = 0
    cache_hits: int = 0
    rate_limited: int = 0
    quota_limited: int = 0
    last_started_monotonic: float | None = None
    recent_calls: deque[float] = field(default_factory=deque)
    cached_at_monotonic: float | None = None
    cached_value: object | None = None


class SourceRuntime:
    """Thread-safe process-local source runtime guard.

    The class deliberately does not invent provider policies. Callers configure a
    policy per source from documented provider limits or a conservative project
    default. Cache and quota state are process-local and diagnostic, not durable.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._states: dict[str, SourceRuntimeStats] = {}

    def _state(self, source_id: str) -> SourceRuntimeStats:
        return self._states.setdefault(source_id, SourceRuntimeStats())

    def run(self, source_id: str, operation: Callable[[], T], policy: SourceRuntimePolicy, *, force: bool = False, clock: Callable[[], float] = time.monotonic) -> T:
        now = clock()
        with self._lock:
            state = self._state(source_id)
            cutoff = now - policy.window_seconds
            while state.recent_calls and state.recent_calls[0] <= cutoff:
                state.recent_calls.popleft()
            if not force and state.cached_at_monotonic is not None and state.cached_value is not None:
                if now - state.cached_at_monotonic <= policy.cache_ttl_seconds:
                    state.cache_hits += 1
                    return state.cached_value  # type: ignore[return-value]
            if len(state.recent_calls) >= policy.max_calls_per_window:
                state.quota_limited += 1
                retry_after = policy.window_seconds - (now - state.recent_calls[0])
                raise SourceQuotaExceeded(retry_after)
            if state.last_started_monotonic is not None:
                elapsed = now - state.last_started_monotonic
                if elapsed < policy.min_interval_seconds:
                    state.rate_limited += 1
                    raise SourceRateLimited(policy.min_interval_seconds - elapsed)
            state.last_started_monotonic = now
            state.recent_calls.append(now)
            state.network_calls += 1

        value = operation()
        completed = clock()
        with self._lock:
            state = self._state(source_id)
            state.cached_at_monotonic = completed
            state.cached_value = value
        return value

    def stats(self) -> dict[str, dict[str, object]]:
        with self._lock:
            return {
                source_id: {
                    "network_calls": state.network_calls,
                    "cache_hits": state.cache_hits,
                    "rate_limited": state.rate_limited,
                    "quota_limited": state.quota_limited,
                    "recent_calls": len(state.recent_calls),
                    "has_cache": state.cached_value is not None,
                }
                for source_id, state in sorted(self._states.items())
            }

    def clear_cache(self, source_id: str | None = None) -> None:
        with self._lock:
            targets = [self._states[source_id]] if source_id in self._states else self._states.values() if source_id is None else []
            for state in targets:
                state.cached_at_monotonic = None
                state.cached_value = None
