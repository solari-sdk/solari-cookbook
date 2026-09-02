from typing import Optional
from src.desktop.interface import BaseDesktopClient
from src.desktop.solari_client import SolariDesktopClient
from src.desktop.mock_desktop import MockDesktopClient
from src.config import settings
from src.utils.logger import logger


def get_desktop_client(use_mock: Optional[bool] = None) -> BaseDesktopClient:
    """Factory to instantiate the appropriate desktop client based on settings or explicit override."""
    force_mock = use_mock if use_mock is not None else settings.use_mock_desktop
    has_valid_key = bool(settings.solari_api_key and not settings.solari_api_key.startswith("slr_live_your"))

    if force_mock or not has_valid_key:
        logger.info("[Desktop Factory] Using Emulated / Mock Desktop environment.")
        return MockDesktopClient(width=settings.desktop_width, height=settings.desktop_height)

    logger.info("[Desktop Factory] Connecting to Live Solari Cloud Desktop API.")
    return SolariDesktopClient(api_key=settings.solari_api_key, api_base=settings.solari_api_base)


__all__ = ["BaseDesktopClient", "SolariDesktopClient", "MockDesktopClient", "get_desktop_client"]
