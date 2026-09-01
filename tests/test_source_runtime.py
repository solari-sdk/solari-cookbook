import pytest

from app.source_runtime import SourceQuotaExceeded, SourceRateLimited, SourceRuntime, SourceRuntimePolicy


def test_source_runtime_cache_and_spacing():
    runtime = SourceRuntime()
    policy = SourceRuntimePolicy(min_interval_seconds=2, max_calls_per_window=10, window_seconds=60, cache_ttl_seconds=1)
    calls = {"count": 0}
    times = iter([0.0, 0.5, 1.5, 2.1, 2.1])

    def clock(): return next(times)
    def operation(): calls["count"] += 1; return f"value-{calls['count']}"

    assert runtime.run("source", operation, policy, clock=clock) == "value-1"
    assert runtime.run("source", operation, policy, clock=clock) == "value-1"
    with pytest.raises(SourceRateLimited):
        runtime.run("source", operation, policy, clock=clock)
    assert runtime.run("source", operation, policy, clock=clock) == "value-2"
    assert calls["count"] == 2
    stats = runtime.stats()["source"]
    assert stats["cache_hits"] == 1
    assert stats["rate_limited"] == 1


def test_source_runtime_quota():
    runtime = SourceRuntime()
    policy = SourceRuntimePolicy(min_interval_seconds=0, max_calls_per_window=2, window_seconds=60, cache_ttl_seconds=0)
    clock_values = iter([0.0, 0.0, 1.0, 1.0, 2.0])
    def clock(): return next(clock_values)
    runtime.run("source", lambda: 1, policy, force=True, clock=clock)
    runtime.run("source", lambda: 2, policy, force=True, clock=clock)
    with pytest.raises(SourceQuotaExceeded):
        runtime.run("source", lambda: 3, policy, force=True, clock=clock)
