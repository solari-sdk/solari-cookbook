"""Server package for FastAPI War Room dashboard."""

from src.server.app import app
from src.server.websocket_manager import war_room_manager

__all__ = ["app", "war_room_manager"]
