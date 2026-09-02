import pytest
from fastapi.testclient import TestClient
from src.server.app import app
from src.config import settings

client = TestClient(app)


def test_status_endpoint():
    response = client.get("/api/status")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"
    assert "resolution" in data


def test_index_html_endpoint():
    response = client.get("/")
    assert response.status_code == 200
    assert "Solari" in response.text
    assert "War Room" in response.text


def test_kill_desktop_endpoint():
    response = client.post("/api/desktop/kill")
    assert response.status_code == 200
    assert response.json()["success"] is True


def test_run_task_endpoint_mock():
    settings.use_mock_desktop = True
    response = client.post("/api/run-task", json={
        "instruction": "Search for Tokyo weather and read it back",
        "use_mock": True
    })
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert "summary" in data
