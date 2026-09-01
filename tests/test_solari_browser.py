import pytest

from app.solari_browser import capture_url


@pytest.mark.asyncio
async def test_browser_capture_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SOLARI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="SOLARI_API_KEY"):
        await capture_url("https://example.com")
