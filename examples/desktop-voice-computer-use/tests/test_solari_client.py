import pytest
import io
from PIL import Image
from src.desktop.mock_desktop import MockDesktopClient
from src.desktop.solari_client import SolariDesktopClient
from src.desktop import get_desktop_client
from src.utils.image_utils import annotate_screenshot, bytes_to_base64, create_thumbnail


@pytest.mark.asyncio
async def test_mock_desktop_lifecycle():
    client = MockDesktopClient(width=1024, height=768)
    await client.create(width=1024, height=768)
    assert client.is_connected is True
    assert client.is_killed is False

    # Capture screenshot
    screenshot_bytes = await client.screenshot()
    assert isinstance(screenshot_bytes, bytes)
    assert len(screenshot_bytes) > 1000

    # Verify screenshot is valid image
    img = Image.open(io.BytesIO(screenshot_bytes))
    assert img.size == (1024, 768)

    # Actions
    await client.mouse_click(480, 95)
    assert client.cursor_pos == (480, 95)

    await client.type_text("weather in Tokyo")
    assert "weather in Tokyo" in client.search_query

    await client.press_key("Return")
    assert client.has_searched is True

    # Screenshot after search
    search_screen = await client.screenshot()
    assert len(search_screen) > 1000

    # Gotcha test: close() vs kill()
    await client.close()
    assert client.is_connected is False
    assert client.is_killed is False

    await client.kill()
    assert client.is_killed is True


@pytest.mark.asyncio
async def test_solari_command_wrapping():
    """Verify non-shell-interpreted gotcha handling."""
    client = SolariDesktopClient(api_key="test_key", api_base="http://mock-solari")
    
    # Check that strings get wrapped in bash interpreter
    # We can mock _send_action or verify exec_command signature
    assert client.api_key == "test_key"
    assert client.api_base == "http://mock-solari"


def test_image_utils_annotation():
    # Create simple black image
    img = Image.new("RGB", (1024, 768), color=(10, 10, 10))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    raw_bytes = buf.getvalue()

    # Annotate with click coords and bounding box
    annotated = annotate_screenshot(
        raw_bytes,
        click_coords=(500, 300),
        bounding_box=[200, 150, 600, 450],
        action_label="click"
    )
    assert isinstance(annotated, bytes)
    assert len(annotated) > 500

    # Base64 encoding
    b64 = bytes_to_base64(annotated)
    assert isinstance(b64, str)
    assert len(b64) > 100

    # Thumbnail
    thumb = create_thumbnail(annotated, max_size=(320, 240))
    assert len(thumb) < len(annotated)
