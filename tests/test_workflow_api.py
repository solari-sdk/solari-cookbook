import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.workflow_api import WorkflowRequest, rerun_workflow, run_workflow, validate_workflow


def _request():
    return WorkflowRequest(
        playbook={
            "id": "test-summary",
            "name": "Test summary",
            "version": 1,
            "steps": [
                {"id": "events", "action": "current_events", "depends_on": []},
                {"id": "count", "action": "row_count", "depends_on": ["events"]},
            ],
        },
        inputs={"limit": 10},
    )


def test_workflow_routes_and_graph_contract(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = TestClient(app)
    spec = client.get("/openapi.json").json()
    assert "/api/v1/workflows/validate" in spec["paths"]
    assert "/api/v1/workflows/run" in spec["paths"]
    assert "/api/v1/workflows/rerun" in spec["paths"]

    graph = validate_workflow(_request())
    assert graph["topological_order"] == ["events", "count"]
    assert graph["edges"] == [{"source": "events", "target": "count"}]
    assert "current_events" in graph["available_actions"]


def test_workflow_run_and_rerun_use_current_persisted_data(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    first = run_workflow(_request())
    assert first["status"] == "success"
    assert first["outputs"]["count"] == 0
    second = rerun_workflow(_request())
    assert second["status"] == "success"
    assert second["rerun"] is True


def test_workflow_api_rejects_cycles_and_unknown_actions():
    cyclic = WorkflowRequest(playbook={"id":"cycle","name":"cycle","steps":[{"id":"a","action":"row_count","depends_on":["b"]},{"id":"b","action":"row_count","depends_on":["a"]}]})
    with pytest.raises(HTTPException) as raised:
        validate_workflow(cyclic)
    assert raised.value.status_code == 400
    unknown = WorkflowRequest(playbook={"id":"bad","name":"bad","steps":[{"id":"a","action":"arbitrary_code","depends_on":[]}]})
    with pytest.raises(HTTPException) as raised_unknown:
        run_workflow(unknown)
    assert raised_unknown.value.status_code == 400
