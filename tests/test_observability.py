import json

import pytest

from app import observability


def test_structured_log_carries_correlation_and_job_ids(monkeypatch):
    messages=[]
    monkeypatch.setattr(observability.logger,"info",messages.append)
    with observability.execution_log_context(job_id="job-1",correlation_id="corr-1"):
        observability.structured_event("collector_step",source_id="public-source")
        assert observability.current_job_id() == "job-1"
        assert observability.current_correlation_id() == "corr-1"
    payload=json.loads(messages[0])
    assert payload["event"] == "collector_step"
    assert payload["job_id"] == "job-1"
    assert payload["correlation_id"] == "corr-1"
    assert payload["source_id"] == "public-source"
    assert observability.current_job_id() is None


def test_execution_context_rejects_unsafe_identifiers():
    with pytest.raises(ValueError):
        with observability.execution_log_context(job_id="bad id with spaces"):
            pass
