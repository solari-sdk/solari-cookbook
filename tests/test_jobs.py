from datetime import datetime, timedelta, timezone

from app.jobs import CircuitBreaker, FailureClass, JobStatus, RetryPolicy, classify_exception, run_with_retry


def test_retry_succeeds_after_transient_failure_without_real_sleep() -> None:
    calls = {"count": 0}
    delays: list[float] = []

    def operation() -> str:
        calls["count"] += 1
        if calls["count"] == 1:
            raise TimeoutError("temporary")
        return "ok"

    execution = run_with_retry(
        "fixture",
        operation,
        policy=RetryPolicy(max_attempts=3, base_delay_seconds=0.1),
        sleeper=delays.append,
    )
    assert execution.status is JobStatus.SUCCEEDED
    assert execution.attempts == 2
    assert execution.result == "ok"
    assert delays == [0.1]
    assert len(execution.attempt_durations_ms) == 2


def test_validation_failure_is_terminal_without_retry() -> None:
    def invalid_operation() -> str:
        raise ValueError("bad input")

    execution = run_with_retry("fixture", invalid_operation, sleeper=lambda seconds: None)
    assert execution.status is JobStatus.FAILED
    assert execution.attempts == 1
    assert execution.failure_class is FailureClass.VALIDATION
    assert execution.terminal


def test_circuit_breaker_recovers_after_cooldown() -> None:
    now = datetime(2026, 9, 1, tzinfo=timezone.utc)
    breaker = CircuitBreaker(failure_threshold=2, cooldown_seconds=30)
    breaker.record_failure(now)
    breaker.record_failure(now)
    assert not breaker.can_run(now + timedelta(seconds=29))
    assert breaker.can_run(now + timedelta(seconds=30))
    assert breaker.consecutive_failures == 0


def test_failure_taxonomy_is_explicit() -> None:
    assert classify_exception(TimeoutError()) is FailureClass.TRANSIENT
    assert classify_exception(ValueError()) is FailureClass.VALIDATION
    assert classify_exception(RuntimeError("HTTP 429")) is FailureClass.RATE_LIMITED
