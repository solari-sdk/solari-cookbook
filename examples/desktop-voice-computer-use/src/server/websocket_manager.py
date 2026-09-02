import json
from typing import List, Dict, Any
from fastapi import WebSocket
from src.utils.logger import logger


class WarRoomConnectionManager:
    """Manages real-time WebSocket subscriptions for the War Room Observability Dashboard."""

    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"[War Room WS] Client connected (Active total: {len(self.active_connections)})")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"[War Room WS] Client disconnected (Active total: {len(self.active_connections)})")

    async def broadcast(self, message_type: str, payload: Dict[str, Any]):
        """Broadcasts structured event message to all connected War Room dashboards."""
        if not self.active_connections:
            return

        message = {
            "type": message_type,
            "data": payload
        }
        json_data = json.dumps(message)

        dead_connections = []
        for connection in self.active_connections:
            try:
                await connection.send_text(json_data)
            except Exception as e:
                logger.debug(f"[War Room WS] Send failed for client: {e}")
                dead_connections.append(connection)

        for dead in dead_connections:
            self.disconnect(dead)


# Global singleton instance
war_room_manager = WarRoomConnectionManager()
