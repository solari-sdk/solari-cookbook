import asyncio
import io
from typing import Optional, List, Dict, Any
from PIL import Image, ImageDraw, ImageFont
from src.desktop.interface import BaseDesktopClient
from src.utils.logger import logger


class MockDesktopClient(BaseDesktopClient):
    """
    Emulated Linux Desktop for offline testing, local demonstrations, and continuous integration.
    Generates synthetic dynamic screenshots reflecting browser interactions, typing, and mouse clicks.
    """

    def __init__(self, width: int = 1024, height: int = 768):
        self.width = width
        self.height = height
        self.cursor_pos = (200, 200)
        self.active_app = "browser"  # 'browser', 'terminal', 'desktop'
        self.browser_url = "https://www.google.com"
        self.search_query = ""
        self.has_searched = False
        self.is_connected = False
        self.is_killed = False
        self.step_counter = 0

    async def create(self, width: int = 1024, height: int = 768, timeout_seconds: int = 600) -> "MockDesktopClient":
        self.width = width
        self.height = height
        self.is_connected = True
        self.is_killed = False
        logger.info(f"[Mock Desktop] Simulated Linux Desktop created ({width}x{height})")
        return self

    async def connect(self) -> None:
        self.is_connected = True
        logger.info("[Mock Desktop] Connected to simulated desktop session.")

    def _render_frame(self) -> Image.Image:
        """Generates a synthetic screenshot based on current desktop state."""
        img = Image.new("RGB", (self.width, self.height), color=(30, 34, 42))
        draw = ImageDraw.Draw(img)

        # 1. Top Panel / Taskbar (Ubuntu / GNOME style)
        draw.rectangle([0, 0, self.width, 32], fill=(20, 22, 28))
        draw.text((16, 8), "Activities", fill=(220, 220, 220))
        draw.text((self.width // 2 - 40, 8), "12:00 PM - Tokyo", fill=(200, 200, 200))
        draw.text((self.width - 120, 8), "⚡ 100%  📶 🌐", fill=(180, 180, 180))

        # 2. Browser Window
        win_x1, win_y1 = 60, 60
        win_x2, win_y2 = self.width - 60, self.height - 60

        # Window Header
        draw.rectangle([win_x1, win_y1, win_x2, win_y1 + 40], fill=(45, 49, 58))
        # Window buttons (close, minimize, maximize)
        draw.ellipse([win_x1 + 12, win_y1 + 12, win_x1 + 24, win_y1 + 24], fill=(255, 95, 87))
        draw.ellipse([win_x1 + 32, win_y1 + 12, win_x1 + 44, win_y1 + 24], fill=(255, 189, 46))
        draw.ellipse([win_x1 + 52, win_y1 + 12, win_x1 + 64, win_y1 + 24], fill=(39, 201, 63))
        draw.text((win_x1 + 90, win_y1 + 12), "Chromium - Solari Agent Sandbox", fill=(200, 200, 200))

        # URL / Search Bar
        draw.rectangle([win_x1, win_y1 + 40, win_x2, win_y1 + 80], fill=(53, 57, 69))
        draw.rectangle([win_x1 + 100, win_y1 + 46, win_x2 - 100, win_y1 + 74], fill=(30, 34, 42), outline=(80, 85, 95), width=1)
        url_text = f"🔒 {self.browser_url}" + (f"/search?q={self.search_query}" if self.search_query else "")
        draw.text((win_x1 + 115, win_y1 + 52), url_text[:70], fill=(220, 220, 220))

        # Browser Content Area
        draw.rectangle([win_x1, win_y1 + 80, win_x2, win_y2], fill=(245, 247, 250))

        # Content based on search query / state
        content_draw = ImageDraw.Draw(img)
        query_lower = self.search_query.lower()

        if "hacker" in query_lower or "news" in query_lower:
            # Hacker News mock page
            content_draw.rectangle([win_x1 + 20, win_y1 + 95, win_x2 - 20, win_y1 + 125], fill=(255, 102, 0))
            content_draw.text((win_x1 + 30, win_y1 + 102), "Hacker News | new | past | comments | ask | show | jobs", fill=(0, 0, 0))
            
            content_draw.text((win_x1 + 30, win_y1 + 145), "1. ▲ Show HN: Solari Voice Agent - Full Desktop Computer Use (getsolari.com)", fill=(10, 10, 10))
            content_draw.text((win_x1 + 50, win_y1 + 168), "285 points by solari_builder 2 hours ago | hide | 84 comments", fill=(100, 100, 100))

            content_draw.text((win_x1 + 30, win_y1 + 205), "2. ▲ LangGraph: Agent Orchestration with Dynamic State (github.com)", fill=(10, 10, 10))
            content_draw.text((win_x1 + 50, win_y1 + 228), "192 points by ai_engineer 4 hours ago | hide | 47 comments", fill=(100, 100, 100))

            content_draw.text((win_x1 + 30, win_y1 + 265), "3. ▲ OpenAI Whisper v3 & Real-time Speech APIs (openai.com)", fill=(10, 10, 10))
            content_draw.text((win_x1 + 50, win_y1 + 288), "145 points by dev_audio 6 hours ago | hide | 32 comments", fill=(100, 100, 100))
        elif "weather" in query_lower:
            # Weather Result Card
            city = "Tokyo"
            for word in self.search_query.split():
                if word.lower() not in ("weather", "in", "for", "the", "current", "of"):
                    city = word.capitalize()
                    break
            content_draw.rectangle([win_x1 + 40, win_y1 + 110, win_x1 + 480, win_y1 + 320], fill=(255, 255, 255), outline=(220, 224, 230), width=2)
            content_draw.text((win_x1 + 60, win_y1 + 130), f"Weather in {city}", fill=(32, 33, 36))
            content_draw.text((win_x1 + 60, win_y1 + 160), "☀️ 22°C / 72°F", fill=(26, 115, 232))
            content_draw.text((win_x1 + 60, win_y1 + 200), "Condition: Mostly Sunny", fill=(95, 99, 104))
            content_draw.text((win_x1 + 60, win_y1 + 225), "Humidity: 55% | Wind: 10 km/h W", fill=(95, 99, 104))
            content_draw.text((win_x1 + 60, win_y1 + 250), "Precipitation: 0% | UV Index: Moderate", fill=(95, 99, 104))
            content_draw.text((win_x1 + 60, win_y1 + 285), "Forecast: Clear skies throughout the day.", fill=(60, 64, 67))
        elif self.search_query:
            # Dynamic Search Results Card
            title_text = self.search_query.strip().title()
            content_draw.text((win_x1 + 40, win_y1 + 105), f"Search Results for: \"{self.search_query}\"", fill=(32, 33, 36))
            
            # First Result Box
            content_draw.rectangle([win_x1 + 40, win_y1 + 135, win_x2 - 40, win_y1 + 245], fill=(255, 255, 255), outline=(220, 224, 230), width=1)
            content_draw.text((win_x1 + 60, win_y1 + 150), f"🔗 1. {title_text} - Official Overview & Latest Info", fill=(26, 115, 232))
            content_draw.text((win_x1 + 60, win_y1 + 175), f"Detailed information, live documentation, and real-time updates for {self.search_query}.", fill=(77, 81, 86))
            content_draw.text((win_x1 + 60, win_y1 + 195), "Verified source • High relevance match • Updated today", fill=(30, 142, 62))
            
            # Second Result Box
            content_draw.rectangle([win_x1 + 40, win_y1 + 260, win_x2 - 40, win_y1 + 350], fill=(255, 255, 255), outline=(220, 224, 230), width=1)
            content_draw.text((win_x1 + 60, win_y1 + 275), f"🔗 2. Deep Dive: Everything You Need to Know About {title_text}", fill=(26, 115, 232))
            content_draw.text((win_x1 + 60, win_y1 + 300), f"Comprehensive architectural breakdown and practical guide regarding {self.search_query}.", fill=(77, 81, 86))
        else:
            # Google Home Search View
            center_x = (win_x1 + win_x2) // 2
            content_draw.text((center_x - 60, win_y1 + 130), "Google", fill=(66, 133, 244))
            # Search Box input
            content_draw.rectangle([center_x - 220, win_y1 + 180, center_x + 220, win_y1 + 225], fill=(255, 255, 255), outline=(218, 220, 224), width=1)
            content_draw.text((center_x - 200, win_y1 + 195), "Search Google or type a URL...", fill=(150, 150, 150))
            # Buttons
            content_draw.rectangle([center_x - 140, win_y1 + 245, center_x - 20, win_y1 + 280], fill=(248, 249, 250), outline=(218, 220, 224))
            content_draw.text((center_x - 120, win_y1 + 256), "Google Search", fill=(60, 64, 67))
            content_draw.rectangle([center_x + 10, win_y1 + 245, center_x + 150, win_y1 + 280], fill=(248, 249, 250), outline=(218, 220, 224))
            content_draw.text((center_x + 25, win_y1 + 256), "I'm Feeling Lucky", fill=(60, 64, 67))

        # Draw Mouse Cursor
        cx, cy = self.cursor_pos
        draw.polygon([(cx, cy), (cx, cy + 16), (cx + 5, cy + 13), (cx + 11, cy + 18), (cx + 14, cy + 16), (cx + 7, cy + 11), (cx + 12, cy + 10)], fill=(255, 255, 255), outline=(0, 0, 0))

        return img

    async def screenshot(self) -> bytes:
        img = self._render_frame()
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()

    async def mouse_click(self, x: int, y: int, button: str = "left", click_type: str = "single") -> None:
        self.cursor_pos = (x, y)
        self.step_counter += 1
        logger.info(f"[Mock Desktop] Clicked at ({x}, {y})")
        await asyncio.sleep(0.1)

    async def mouse_move(self, x: int, y: int) -> None:
        self.cursor_pos = (x, y)
        await asyncio.sleep(0.05)

    async def mouse_drag(self, start_x: int, start_y: int, end_x: int, end_y: int) -> None:
        self.cursor_pos = (end_x, end_y)
        await asyncio.sleep(0.1)

    async def type_text(self, text: str, delay_ms: int = 15) -> None:
        self.search_query += text
        logger.info(f"[Mock Desktop] Typed: \"{text}\" -> Search buffer is now: \"{self.search_query}\"")
        await asyncio.sleep(0.1)

    async def press_key(self, key: str) -> None:
        logger.info(f"[Mock Desktop] Key pressed: {key}")
        if key.lower() in ("return", "enter"):
            self.has_searched = True
            logger.info(f"[Mock Desktop] Submitted search for: \"{self.search_query}\"")
        await asyncio.sleep(0.1)

    async def scroll(self, direction: str = "down", amount: int = 3) -> None:
        logger.info(f"[Mock Desktop] Scrolled {direction} by {amount}")
        await asyncio.sleep(0.05)

    async def exec_command(self, cmd: str | List[str]) -> Dict[str, Any]:
        logger.info(f"[Mock Desktop] Executed command: {cmd}")
        return {"exit_code": 0, "stdout": "Command completed in mock environment", "stderr": ""}

    async def close(self) -> None:
        logger.info("[Mock Desktop] Closed connection.")
        self.is_connected = False

    async def kill(self) -> None:
        logger.info("[Mock Desktop] Killed simulated VM.")
        self.is_connected = False
        self.is_killed = True
