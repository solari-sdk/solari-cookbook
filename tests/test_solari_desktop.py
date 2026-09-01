import sys
import types

import pytest

from app.solari_desktop import capture_public_url


class _Mouse:
    def __init__(self, calls): self.calls = calls
    async def click(self, x, y, humanize=False): self.calls.append(("click", x, y, humanize))


class _Keyboard:
    def __init__(self, calls): self.calls = calls
    async def type(self, text): self.calls.append(("type", text))


class _Desktop:
    sessionId = "desktop-test"

    def __init__(self, calls):
        self.calls = calls
        self.mouse = _Mouse(calls)
        self.keyboard = _Keyboard(calls)

    async def connect(self): self.calls.append(("connect",))
    async def health(self): return types.SimpleNamespace(ready=True)
    async def open(self, name): self.calls.append(("open", name)); return 101
    async def exec(self, command, args=None): self.calls.append(("exec", command, tuple(args or [])))
    async def screenshot(self, format="png"): self.calls.append(("screenshot", format)); return b"desktop-png"
    async def close(self): self.calls.append(("close",))


@pytest.mark.asyncio
async def test_desktop_public_capture_exercises_gui_and_destroys_session(monkeypatch):
    calls = []

    class DesktopClient:
        def __init__(self, api_key, base_url):
            assert api_key == "test-key"
            assert base_url.startswith("https://")

        async def __aenter__(self): return self
        async def __aexit__(self, exc_type, exc, tb): return False
        async def create(self, **kwargs):
            calls.append(("create", kwargs["template"], kwargs["resolution"]))
            return _Desktop(calls)
        async def destroy(self, session_id): calls.append(("destroy", session_id))

    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "solari_desktop", types.SimpleNamespace(DesktopClient=DesktopClient))
    result = await capture_public_url("https://example.org/public", settle_seconds=0)

    assert result.ready is True
    assert result.screenshot == b"desktop-png"
    assert result.acquisition.method.value == "desktop"
    assert result.acquisition.metadata["interpretation_boundary"].startswith("screenshot retained")
    assert ("open", "mousepad") in calls
    assert ("click", 320, 300, True) in calls
    assert ("type", "Public-source visual capture: example.org") in calls
    assert ("exec", "google-chrome", ("--new-window", "https://example.org/public")) in calls
    assert ("close",) in calls
    assert ("destroy", "desktop-test") in calls


@pytest.mark.asyncio
async def test_desktop_capture_requires_key_and_https(monkeypatch):
    monkeypatch.delenv("SOLARI_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        await capture_public_url("https://example.org/", settle_seconds=0)

    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    with pytest.raises(ValueError):
        await capture_public_url("http://example.org/", settle_seconds=0)
