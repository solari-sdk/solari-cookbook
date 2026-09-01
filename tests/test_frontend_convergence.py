from pathlib import Path

from fastapi.testclient import TestClient

from app.main import CANONICAL_FRONTEND_DIR, app


client = TestClient(app)


def test_server_root_redirects_to_canonical_backend_independent_frontend() -> None:
    response = client.get("/", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/workspace/"

    workspace = client.get("/workspace/")
    assert workspace.status_code == 200
    assert "Solari Static OSINT Console" in workspace.text
    assert 'src="server-runtime.js"' in workspace.text
    assert 'id="server-runtime-controls"' in workspace.text


def test_server_mount_serves_the_same_checked_in_static_console_assets() -> None:
    expected = (CANONICAL_FRONTEND_DIR / "server-runtime.js").read_text(encoding="utf-8")
    response = client.get("/workspace/server-runtime.js")
    assert response.status_code == 200
    assert response.text == expected

    local_index = Path("static-console/index.html").read_text(encoding="utf-8")
    served_index = client.get("/workspace/").text
    assert served_index == local_index


def test_advanced_server_operations_dashboard_is_preserved() -> None:
    response = client.get("/server-dashboard")
    assert response.status_code == 200
    assert "Solari OSINT Operations Center" in response.text
    assert 'id="workflowDefinition"' in response.text
    assert 'id="globeCanvas"' in response.text
