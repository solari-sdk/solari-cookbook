import sys
import types

import pytest

from app.solari_browser import BrowserCaptureError, capture_url


class _Response:
    status = 200


class _Page:
    url = "https://example.org/final"

    def __init__(self, *, fail_navigation=False):
        self.fail_navigation = fail_navigation

    async def goto(self, url, wait_until=None):
        if self.fail_navigation:
            raise RuntimeError("temporary navigation failure")
        return _Response()

    async def content(self): return "<html><title>Example</title></html>"
    async def screenshot(self, full_page=False): return b"png-bytes"
    async def title(self): return "Example"


class _Browser:
    id = "browser-test"

    def __init__(self, *, fail_navigation=False):
        self.page = _Page(fail_navigation=fail_navigation)
        self.closed = False

    async def new_page(self): return self.page
    async def close(self): self.closed = True


@pytest.mark.asyncio
async def test_browser_capture_success_is_bounded_and_closes(monkeypatch):
    browsers = []

    class Solari:
        def __init__(self, api_key): assert api_key == "test-key"
        async def launch(self):
            browser = _Browser()
            browsers.append(browser)
            return browser

    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "solari_browser", types.SimpleNamespace(Solari=Solari))
    result = await capture_url("https://example.org/", max_attempts=1, timeout_seconds=2)
    assert result.title == "Example"
    assert result.acquisition.metadata["attempt"] == 1
    assert result.acquisition.metadata["recording_requested"] is False
    assert browsers[0].closed is True


@pytest.mark.asyncio
async def test_browser_capture_opt_in_replay_is_downloaded_after_close(monkeypatch):
    browsers = []

    class Sessions:
        async def download_replay(self, session_id):
            assert session_id == "browser-test"
            assert browsers[0].closed is True
            return b'{"type":"rrweb"}\n'

    class Solari:
        def __init__(self, api_key):
            assert api_key == "test-key"
            self.sessions = Sessions()

        async def launch(self, recording=False):
            assert recording is True
            browser = _Browser()
            browsers.append(browser)
            return browser

    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "solari_browser", types.SimpleNamespace(Solari=Solari))
    result = await capture_url(
        "https://example.org/",
        max_attempts=1,
        timeout_seconds=2,
        recording=True,
        replay_poll_attempts=1,
        replay_poll_delay_seconds=0,
    )
    assert result.replay == b'{"type":"rrweb"}\n'
    assert result.acquisition.metadata["replay_available"] is True
    assert result.acquisition.metadata["replay_bytes"] == len(result.replay)


@pytest.mark.asyncio
async def test_browser_capture_retries_and_preserves_failure_taxonomy(monkeypatch):
    browsers = []

    class Solari:
        def __init__(self, api_key): pass
        async def launch(self):
            browser = _Browser(fail_navigation=True)
            browsers.append(browser)
            return browser

    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "solari_browser", types.SimpleNamespace(Solari=Solari))
    with pytest.raises(BrowserCaptureError) as raised:
        await capture_url("https://example.org/", max_attempts=2, timeout_seconds=2, base_delay_seconds=0)
    assert raised.value.kind == "navigation"
    assert raised.value.attempt == 2
    assert all(browser.closed for browser in browsers)
    assert len(browsers) == 2


@pytest.mark.asyncio
async def test_browser_capture_missing_key_is_configuration_failure(monkeypatch):
    monkeypatch.delenv("SOLARI_API_KEY", raising=False)
    with pytest.raises(BrowserCaptureError) as raised:
        await capture_url("https://example.org/")
    assert raised.value.kind == "configuration"
    assert raised.value.attempt == 0


@pytest.mark.asyncio
async def test_browser_capture_validates_bounds_before_launch(monkeypatch):
    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    with pytest.raises(ValueError):
        await capture_url("http://example.org/")
    with pytest.raises(ValueError):
        await capture_url("https://example.org/", max_attempts=6)
    with pytest.raises(ValueError):
        await capture_url("https://example.org/", replay_poll_attempts=11)
