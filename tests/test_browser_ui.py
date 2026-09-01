from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

import pytest
from playwright.sync_api import Browser, Page, Route, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
STATIC_ROOT = ROOT / "static-console"


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


@pytest.fixture(scope="module")
def browser() -> Browser:
    with sync_playwright() as playwright:
        instance = playwright.chromium.launch(headless=True)
        yield instance
        instance.close()


@pytest.fixture(scope="module")
def static_url() -> str:
    handler = partial(QuietStaticHandler, directory=str(STATIC_ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def dashboard_url(tmp_path_factory: pytest.TempPathFactory) -> str:
    port = _free_port()
    workdir = tmp_path_factory.mktemp("browser-dashboard")
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=workdir,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    health_url = f"http://127.0.0.1:{port}/api/v1/health"
    deadline = time.monotonic() + 15
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"dashboard server exited with status {process.returncode}")
        try:
            with urlopen(health_url, timeout=1) as response:  # noqa: S310 - fixed localhost test endpoint
                if response.status == 200:
                    break
        except Exception as exc:  # pragma: no cover - transient startup timing
            last_error = exc
            time.sleep(0.1)
    else:
        process.terminate()
        raise RuntimeError(f"dashboard server did not become healthy: {last_error}")
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def _leaflet_stub(route: Route) -> None:
    if route.request.url.endswith(".css"):
        route.fulfill(status=200, content_type="text/css", body="")
        return
    route.fulfill(
        status=200,
        content_type="application/javascript",
        body="""
        (() => {
          function chain() {
            let proxy;
            proxy = new Proxy({}, { get(_target, prop) {
              if (prop === 'getZoom') return () => 2;
              if (prop === 'getCenter') return () => ({lat: 0, lng: 0});
              return () => proxy;
            }});
            return proxy;
          }
          window.L = new Proxy({}, { get() { return () => chain(); } });
        })();
        """,
    )


def test_converged_server_workspace_real_browser_smoke(browser: Browser, dashboard_url: str) -> None:
    page = browser.new_page()
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(dashboard_url, wait_until="networkidle")
    expect(page.locator("h1")).to_contain_text("Solari Static OSINT Console")
    expect(page.locator("#runtime-status")).to_contain_text("Server mode active", timeout=10_000)
    expect(page.locator("#server-runtime-controls")).to_be_visible()
    assert page.locator("#server-source option").count() >= 20
    assert page.url.endswith("/workspace/")
    assert not page_errors
    page.close()


def test_advanced_server_dashboard_remains_available(browser: Browser, dashboard_url: str) -> None:
    page = browser.new_page()
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.route("https://unpkg.com/**", _leaflet_stub)
    page.goto(f"{dashboard_url}/server-dashboard", wait_until="domcontentloaded")
    expect(page.locator("h1")).to_have_text("Solari OSINT Operations Center")
    expect(page.locator("#health")).to_contain_text("OK · READY", timeout=10_000)
    expect(page.locator("#streamState")).to_have_text("Current", timeout=10_000)
    source_count = int(page.locator("#sourceCount").inner_text())
    assert source_count >= 20
    assert page.locator("#globeCanvas").count() == 1
    assert page.locator("#workflowDefinition").count() == 1
    assert not page_errors
    page.close()


def test_static_console_first_run_requires_no_backend(browser: Browser, static_url: str) -> None:
    context = browser.new_context()
    page = context.new_page()
    backend_requests: list[str] = []
    page.on("request", lambda request: backend_requests.append(request.url) if "/api/v1/" in request.url else None)
    page.goto(f"{static_url}/", wait_until="networkidle")
    expect(page.locator("h1")).to_contain_text("Solari Static OSINT Console")
    expect(page.locator("#runtime-status")).to_contain_text("Local/static mode")
    expect(page.locator("#storage-status")).to_contain_text("0 of 0", timeout=10_000)
    capabilities = json.loads(page.locator("#capabilities").inner_text())
    assert capabilities["indexed_db"] is True
    assert capabilities["web_crypto"] is True
    assert capabilities["canvas"] is True
    assert backend_requests == []
    context.close()


def test_static_console_indexeddb_v1_migrates_and_persists(browser: Browser, static_url: str) -> None:
    context = browser.new_context()
    page = context.new_page()
    page.goto(f"{static_url}/manifest.webmanifest")
    page.evaluate(
        """
        async () => {
          await new Promise((resolve) => {
            const request = indexedDB.deleteDatabase('solari-static-osint');
            request.onsuccess = request.onerror = request.onblocked = resolve;
          });
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('solari-static-osint', 1);
            request.onupgradeneeded = () => {
              const db = request.result;
              db.createObjectStore('events', {keyPath: 'id'});
              db.createObjectStore('meta', {keyPath: 'key'});
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction(['events', 'meta'], 'readwrite');
              tx.objectStore('events').put({
                id: 'migration-test:1', source_id: 'migration-test', source_record_id: '1',
                category: 'test', title: 'Persisted migration event', summary: null,
                observed_at: '2026-09-01T12:00:00Z', updated_at: null,
                latitude: 49.25, longitude: -122.95, severity: 'low', quality_score: 1,
                properties: {}, evidence: []
              });
              tx.objectStore('meta').put({key: 'legacy', value: true});
              tx.oncomplete = () => { db.close(); resolve(); };
              tx.onerror = () => reject(tx.error);
            };
          });
        }
        """
    )
    page.goto(f"{static_url}/", wait_until="networkidle")
    expect(page.locator("#storage-status")).to_contain_text("1 of 1", timeout=10_000)
    database = page.evaluate(
        """
        async () => await new Promise((resolve, reject) => {
          const request = indexedDB.open('solari-static-osint');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            resolve({version: db.version, stores: [...db.objectStoreNames]});
            db.close();
          };
        })
        """
    )
    assert database["version"] == 3
    assert "meta" not in database["stores"]
    assert {"events", "cases", "artifacts", "acquisitions", "transformations"}.issubset(database["stores"])
    page.reload(wait_until="networkidle")
    expect(page.locator("#storage-status")).to_contain_text("1 of 1", timeout=10_000)
    expect(page.locator("#events")).to_contain_text("Persisted migration event")
    context.close()


def test_static_console_credentials_and_session_configuration_are_not_persisted(browser: Browser, static_url: str) -> None:
    context = browser.new_context()
    page = context.new_page()
    page.goto(f"{static_url}/", wait_until="networkidle")
    page.locator("#solari-key").fill("browser-qa-placeholder-key")
    page.locator("#case-passphrase").fill("browser-qa-placeholder-passphrase")
    page.locator("#broker-endpoint").fill(f"{static_url}/broker")
    expect(page.locator("#key-status")).to_contain_text("loaded in memory")
    page.locator("#clear-key").click()
    expect(page.locator("#solari-key")).to_have_value("")
    page.locator("#solari-key").fill("browser-qa-placeholder-key")
    persisted_text = page.evaluate("() => Object.values(localStorage).join(' ') + Object.values(sessionStorage).join(' ')")
    assert "browser-qa-placeholder" not in persisted_text
    page.close()

    reopened = context.new_page()
    reopened.goto(f"{static_url}/", wait_until="networkidle")
    expect(reopened.locator("#solari-key")).to_have_value("")
    expect(reopened.locator("#case-passphrase")).to_have_value("")
    expect(reopened.locator("#broker-endpoint")).to_have_value("")
    context.close()


def test_static_console_cors_failure_uses_explicit_broker_fallback(browser: Browser, static_url: str) -> None:
    context = browser.new_context()
    page = context.new_page()
    upstream = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "browser-broker-1",
                "properties": {"mag": 4.2, "place": "Browser QA", "time": 1788264000000, "updated": 1788264060000, "type": "earthquake", "tsunami": 0, "url": "https://earthquake.usgs.gov/example"},
                "geometry": {"type": "Point", "coordinates": [-122.95, 49.25, 10.0]},
            }
        ],
    }
    page.route("https://earthquake.usgs.gov/**", lambda route: route.abort("failed"))

    def broker(route: Route) -> None:
        request = json.loads(route.request.post_data or "{}")
        assert request["operation"] == "public-source-fetch"
        assert request["source_id"] == "usgs-earthquakes"
        assert request["source_url"] == upstream
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"status": 200, "body_text": json.dumps(payload), "final_url": upstream, "content_type": "application/geo+json"}),
        )

    page.route(f"{static_url}/broker", broker)
    page.goto(f"{static_url}/", wait_until="networkidle")
    page.locator("#broker-endpoint").fill(f"{static_url}/broker")
    page.locator("#fetch-source").click()
    expect(page.locator("#fetch-status")).to_contain_text("Stored 1 event(s)", timeout=10_000)
    acquisition_routes = page.evaluate(
        """
        async () => {
          const storage = await import('./storage.js');
          const rows = await storage.getAll('acquisitions');
          return rows.map((row) => row.metadata?.route);
        }
        """
    )
    assert acquisition_routes == ["broker-fallback"]
    expect(page.locator("#events")).to_contain_text("M4.2 — Browser QA")
    context.close()
