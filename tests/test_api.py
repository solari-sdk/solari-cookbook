from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_endpoint() -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["sources_registered"] >= 1


def test_sources_endpoint_lists_usgs() -> None:
    response = client.get("/api/v1/sources")
    assert response.status_code == 200
    source_ids = {item["id"] for item in response.json()}
    assert "usgs-earthquakes" in source_ids


def test_unknown_live_source_returns_404() -> None:
    response = client.get("/api/v1/events/live/not-a-source")
    assert response.status_code == 404
