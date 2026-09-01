from app.job_store import job_metrics, list_job_executions, record_job_execution
from app.jobs import RetryPolicy, run_with_retry


def test_job_execution_persistence_and_metrics(tmp_path):
    db = tmp_path / "jobs.sqlite3"
    execution = run_with_retry("fixture", lambda: {"ok": True}, policy=RetryPolicy(max_attempts=1))
    stored = record_job_execution(execution, source_id="source-a", correlation_id="corr-1", path=db)
    assert stored["status"] == "succeeded"
    assert stored["result_summary"] == {"ok": True}
    assert stored["correlation_id"] == "corr-1"
    rows = list_job_executions(source_id="source-a", path=db)
    assert rows[0]["id"] == stored["id"]
    metrics = job_metrics(path=db)
    assert metrics["total"] == 1
    assert metrics["by_status"]["succeeded"] == 1
