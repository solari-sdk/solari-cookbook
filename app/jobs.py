from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Callable, Generic, TypeVar

T = TypeVar("T")


class FailureClass(str, Enum):
    TRANSIENT = "transient"
    RATE_LIMITED = "rate_limited"
    VALIDATION = "validation"
    PERMANENT = "permanent"


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay_seconds: float = 0.5
    max_delay_seconds: float = 10.0

    def __post_init__(self) -> None:
        if self.max_attempts < 1 or self.max_attempts > 10:
            raise ValueError("max_attempts must be between 1 and 10")
        if self.base_delay_seconds < 0 or self.max_delay_seconds < self.base_delay_seconds:
            raise ValueError("invalid retry delay bounds")

    def delay_for_attempt(self, attempt: int) -> float:
        if attempt < 1:
            raise ValueError("attempt must be positive")
        return min(self.max_delay_seconds, self.base_delay_seconds * (2 ** (attempt - 1)))


@dataclass(slots=True)
class JobExecution(Generic[T]):
    name: str
    status: JobStatus = JobStatus.PENDING
    attempts: int = 0
    started_at: datetime | None = None
    completed_at: datetime | None = None
    result: T | None = None
    error_type: str | None = None
    error_message: str | None = None
    failure_class: FailureClass | None = None
    attempt_durations_ms: list[float] = field(default_factory=list)

    @property
    def terminal(self) -> bool:
        return self.status in {JobStatus.SUCCEEDED, JobStatus.FAILED}


@dataclass(slots=True)
class CircuitBreaker:
    failure_threshold: int = 3
    cooldown_seconds: int = 60
    consecutive_failures: int = 0
    opened_at: datetime | None = None

    def __post_init__(self) -> None:
        if self.failure_threshold < 1:
            raise ValueError("failure_threshold must be positive")
        if self.cooldown_seconds < 1:
            raise ValueError("cooldown_seconds must be positive")

    def can_run(self, now: datetime | None = None) -> bool:
        if self.opened_at is None:
            return True
        now = now or datetime.now(timezone.utc)
        if now >= self.opened_at + timedelta(seconds=self.cooldown_seconds):
            self.consecutive_failures = 0
            self.opened_at = None
            return True
        return False

    def record_success(self) -> None:
        self.consecutive_failures = 0
        self.opened_at = None

    def record_failure(self, now: datetime | None = None) -> None:
        self.consecutive_failures += 1
        if self.consecutive_failures >= self.failure_threshold:
            self.opened_at = now or datetime.now(timezone.utc)


def classify_exception(exc: Exception) -> FailureClass:
    name = type(exc).__name__.lower()
    message = str(exc).lower()
    if "429" in message or ("rate" in name and "limit" in name) or "rate_limited" in message or "rate limited" in message or "quota exceeded" in message:
        return FailureClass.RATE_LIMITED
    if isinstance(exc, (ValueError, TypeError, KeyError)) or "validation" in name or '"error_type":"validation' in message:
        return FailureClass.VALIDATION
    transient_markers = (
        "timeout", "timed out", "network_error", "connection", "temporary", "temporarily",
        "502", "503", "504", "connection reset", "connection refused", "remote disconnected",
    )
    if isinstance(exc, (TimeoutError, ConnectionError)) or any(marker in message for marker in transient_markers):
        return FailureClass.TRANSIENT
    return FailureClass.PERMANENT


def run_with_retry(
    name: str,
    operation: Callable[[], T],
    *,
    policy: RetryPolicy | None = None,
    breaker: CircuitBreaker | None = None,
    sleeper: Callable[[float], None] = time.sleep,
) -> JobExecution[T]:
    policy = policy or RetryPolicy()
    execution: JobExecution[T] = JobExecution(name=name, status=JobStatus.RUNNING, started_at=datetime.now(timezone.utc))
    if breaker is not None and not breaker.can_run():
        execution.status = JobStatus.FAILED
        execution.completed_at = datetime.now(timezone.utc)
        execution.error_type = "CircuitOpen"
        execution.error_message = "circuit breaker is in cooldown"
        execution.failure_class = FailureClass.TRANSIENT
        return execution

    for attempt in range(1, policy.max_attempts + 1):
        execution.attempts = attempt
        started = time.perf_counter()
        try:
            execution.result = operation()
            execution.attempt_durations_ms.append((time.perf_counter() - started) * 1000.0)
            execution.status = JobStatus.SUCCEEDED
            execution.completed_at = datetime.now(timezone.utc)
            if breaker is not None:
                breaker.record_success()
            return execution
        except Exception as exc:  # caller receives structured failure state, not a hidden retry loop
            execution.attempt_durations_ms.append((time.perf_counter() - started) * 1000.0)
            failure_class = classify_exception(exc)
            execution.error_type = type(exc).__name__
            execution.error_message = str(exc)
            execution.failure_class = failure_class
            retryable = failure_class in {FailureClass.TRANSIENT, FailureClass.RATE_LIMITED}
            if not retryable or attempt >= policy.max_attempts:
                execution.status = JobStatus.FAILED
                execution.completed_at = datetime.now(timezone.utc)
                if breaker is not None:
                    breaker.record_failure()
                return execution
            delay = policy.delay_for_attempt(attempt)
            retry_after = getattr(exc, "retry_after_seconds", None)
            if isinstance(retry_after, (int, float)) and retry_after > 0:
                delay = min(policy.max_delay_seconds, max(delay, float(retry_after)))
            sleeper(delay)

    raise AssertionError("unreachable")
