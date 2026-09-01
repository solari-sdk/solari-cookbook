from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_endpoint() -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["sources_registered"] >= 1


def test_readiness_and_version_endpoints() -> None:
    readiness = client.get("/api/v1/ready")
    assert readiness.status_code == 200
    assert set(readiness.json()["checks"]) == {"static_dashboard", "sqlite"}
    version = client.get("/api/v1/version")
    assert version.status_code == 200
    assert version.json()["api_version"] == "v1"


def test_schema_endpoint_exposes_typed_contracts() -> None:
    response = client.get("/api/v1/schema")
    assert response.status_code == 200
    assert {"event", "source", "acquisition", "entity", "relationship", "case"} <= set(response.json())


def test_sources_endpoint_lists_usgs() -> None:
    response = client.get("/api/v1/sources")
    assert response.status_code == 200
    source_ids = {item["id"] for item in response.json()}
    assert "usgs-earthquakes" in source_ids


def test_event_bounds_validation() -> None:
    assert client.get("/api/v1/events?min_lat=20&max_lat=10").status_code == 400
    assert client.get("/api/v1/events?min_lon=20&max_lon=10").status_code == 400
    assert client.get("/api/v1/events?min_lat=-91").status_code == 422


def test_metrics_endpoint_is_dashboard_safe() -> None:
    response = client.get("/api/v1/metrics")
    assert response.status_code == 200
    payload = response.json()
    assert payload["version"]
    assert {"acquisitions", "events", "event_history", "entities", "relationships", "cases"} <= set(payload["counts"])
    assert "sources_stale" in payload


def test_correlation_endpoint_is_bounded_and_never_auto_merges() -> None:
    response = client.get("/api/v1/correlation/candidates?limit=2&min_score=0.5")
    assert response.status_code == 200
    payload = response.json()
    assert payload["auto_merged"] is False
    assert isinstance(payload["candidates"], list)
    assert client.get("/api/v1/correlation/candidates?limit=1").status_code == 422


def test_unknown_live_source_returns_404() -> None:
    response = client.get("/api/v1/events/live/not-a-source")
    assert response.status_code == 404
