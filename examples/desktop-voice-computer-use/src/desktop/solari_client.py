import asyncio
import io
import json
from typing import Optional, List, Dict, Any
import httpx
from src.config import settings
from src.utils.logger import logger
from src.desktop.interface import BaseDesktopClient


class SolariDesktopClient(BaseDesktopClient):
    """
    Client for managing and controlling Solari Linux Desktop VMs via Solari Cloud API.
    
    Handles key Solari platform behaviors:
    1. Life-cycle teardown: close() cleanly disconnects the stream; kill() shuts down the VM.
    2. Non-shell-interpreted execution: exec_command wraps string commands in ['bash', '-c', cmd]
       so pipes, subshells, and environment variables evaluate as expected.
    3. Low-latency computer-use actions: mouse_click, mouse_move, type_text, press_key, scroll.
    """

    def __init__(self, api_key: Optional[str] = None, api_base: Optional[str] = None):
        self.api_key = api_key or settings.solari_api_key
        self.api_base = (api_base or settings.solari_api_base).rstrip("/")
        self.desktop_id: Optional[str] = None
        self.ws_url: Optional[str] = None
        self.http_client: Optional[httpx.AsyncClient] = None
        self.is_connected: bool = False
        self._sdk_instance = None

    def _get_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": "SolariVoiceAgent/1.0"
        }

    async def create(
        self,
        width: int = 1024,
        height: int = 768,
        timeout_seconds: int = 600
    ) -> "SolariDesktopClient":
        """Provisions a new Solari Linux Desktop VM."""
        logger.info(f"[Solari Desktop] Provisioning cloud VM ({width}x{height}, timeout={timeout_seconds}s)...")
        
        # Try official SDK if installed
        try:
            from solari_desktop import DesktopClient as SDKDesktopClient
            sdk_client = SDKDesktopClient(api_key=self.api_key)
            self._sdk_instance = await sdk_client.create()
            self.desktop_id = getattr(self._sdk_instance, "id", "dsk_sdk_managed")
            logger.info(f"[Solari Desktop] VM created via SDK: {self.desktop_id}")
            return self
        except ImportError:
            pass  # Fall back to native API REST client

        # Direct REST API
        self.http_client = httpx.AsyncClient(
            base_url=self.api_base,
            headers=self._get_headers(),
            timeout=httpx.Timeout(60.0, connect=15.0)
        )

        payload = {
            "resolution": {"width": width, "height": height},
            "timeout": timeout_seconds,
            "onTimeout": settings.desktop_on_timeout
        }

        try:
            response = await self.http_client.post("/v1/desktops", json=payload)
            response.raise_for_status()
            data = response.json()
            self.desktop_id = data.get("id") or data.get("desktop_id") or "dsk_live"
            self.ws_url = data.get("ws_url") or data.get("stream_url")
            logger.info(f"[Solari Desktop] VM provisioned successfully: ID={self.desktop_id}")
            return self
        except Exception as e:
            logger.error(f"[Solari Desktop] Failed to create VM via API: {e}")
            raise

    async def connect(self) -> None:
        """Establishes connection to the desktop instance."""
        if self._sdk_instance:
            if hasattr(self._sdk_instance, "connect"):
                await self._sdk_instance.connect()
            self.is_connected = True
            logger.info(f"[Solari Desktop] Connected to SDK desktop session.")
            return

        if not self.desktop_id:
            raise RuntimeError("Desktop VM is not provisioned. Call create() first.")

        self.is_connected = True
        logger.info(f"[Solari Desktop] Connected to desktop {self.desktop_id}.")

    async def screenshot(self) -> bytes:
        """Captures a screenshot of the remote desktop."""
        if self._sdk_instance and hasattr(self._sdk_instance, "screenshot"):
            return await self._sdk_instance.screenshot()

        if not self.http_client or not self.desktop_id:
            raise RuntimeError("Desktop not initialized.")

        try:
            response = await self.http_client.get(f"/v1/desktops/{self.desktop_id}/screenshot")
            response.raise_for_status()
            return response.content
        except Exception as e:
            logger.error(f"[Solari Desktop] Screenshot capture failed: {e}")
            raise

    async def mouse_click(self, x: int, y: int, button: str = "left", click_type: str = "single") -> None:
        """Simulates a mouse click on the remote desktop."""
        logger.info(f"[Solari Desktop] Mouse click at ({x}, {y}) [button={button}, type={click_type}]")
        if self._sdk_instance and hasattr(self._sdk_instance, "click"):
            await self._sdk_instance.click(x=x, y=y, button=button)
            return

        payload = {"x": x, "y": y, "button": button, "click_type": click_type}
        await self._send_action("mouse_click", payload)

    async def mouse_move(self, x: int, y: int) -> None:
        """Moves mouse cursor to coordinate (x, y)."""
        logger.info(f"[Solari Desktop] Mouse move to ({x}, {y})")
        if self._sdk_instance and hasattr(self._sdk_instance, "mouse_move"):
            await self._sdk_instance.mouse_move(x=x, y=y)
            return

        payload = {"x": x, "y": y}
        await self._send_action("mouse_move", payload)

    async def mouse_drag(self, start_x: int, start_y: int, end_x: int, end_y: int) -> None:
        """Drags mouse from start to end coordinates."""
        logger.info(f"[Solari Desktop] Mouse drag ({start_x}, {start_y}) -> ({end_x}, {end_y})")
        payload = {"start_x": start_x, "start_y": start_y, "end_x": end_x, "end_y": end_y}
        await self._send_action("mouse_drag", payload)

    async def type_text(self, text: str, delay_ms: int = 15) -> None:
        """Types string into the desktop."""
        logger.info(f"[Solari Desktop] Typing text: {text}")
        if self._sdk_instance and hasattr(self._sdk_instance, "type"):
            await self._sdk_instance.type(text)
            return

        payload = {"text": text, "delay_ms": delay_ms}
        await self._send_action("type", payload)

    async def press_key(self, key: str) -> None:
        """Presses a key or key combination."""
        logger.info(f"[Solari Desktop] Key press: {key}")
        if self._sdk_instance and hasattr(self._sdk_instance, "key_press"):
            await self._sdk_instance.key_press(key)
            return

        payload = {"key": key}
        await self._send_action("key_press", payload)

    async def scroll(self, direction: str = "down", amount: int = 3) -> None:
        """Scrolls the mouse wheel."""
        logger.info(f"[Solari Desktop] Scrolling {direction} by {amount}")
        payload = {"direction": direction, "amount": amount}
        await self._send_action("scroll", payload)

    async def exec_command(self, cmd: str | List[str]) -> Dict[str, Any]:
        """
        Executes a command inside the Solari desktop VM.
        
        GOTCHA HANDLED: Solari commands are not shell-interpreted by default.
        If a raw string is passed, wrap it in ['bash', '-c', cmd] to enable pipes,
        environment expansion, and shell builtins.
        """
        if isinstance(cmd, str):
            command_args = ["bash", "-c", cmd]
            logger.info(f"[Solari Desktop] Wrapped command in bash shell interpreter: {cmd}")
        else:
            command_args = cmd
            logger.info(f"[Solari Desktop] Executing direct binary args: {command_args}")

        if self._sdk_instance and hasattr(self._sdk_instance, "exec"):
            return await self._sdk_instance.exec(command_args)

        if not self.http_client or not self.desktop_id:
            raise RuntimeError("Desktop client not initialized.")

        try:
            response = await self.http_client.post(
                f"/v1/desktops/{self.desktop_id}/exec",
                json={"command": command_args}
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"[Solari Desktop] Command execution error: {e}")
            return {"exit_code": 1, "error": str(e)}

    async def _send_action(self, action_type: str, payload: Dict[str, Any]) -> None:
        """Sends a computer-use action to the desktop instance."""
        if not self.http_client or not self.desktop_id:
            raise RuntimeError("Desktop client not initialized.")

        try:
            response = await self.http_client.post(
                f"/v1/desktops/{self.desktop_id}/actions/{action_type}",
                json=payload
            )
            response.raise_for_status()
            # Allow brief rendering tick for the remote X11 server
            await asyncio.sleep(0.3)
        except Exception as e:
            logger.error(f"[Solari Desktop] Action {action_type} failed: {e}")
            raise

    async def close(self) -> None:
        """Disconnects the client control session."""
        logger.info(f"[Solari Desktop] Closing client connection for desktop {self.desktop_id}...")
        self.is_connected = False
        if self._sdk_instance and hasattr(self._sdk_instance, "close"):
            try:
                await self._sdk_instance.close()
            except Exception:
                pass

        if self.http_client:
            await self.http_client.aclose()
            self.http_client = None

    async def kill(self) -> None:
        """
        Terminates and destroys the VM instance permanently.
        
        GOTCHA HANDLED: In Solari, close() only ends the connection session.
        kill() (or destroy()) actually ends the VM and halts billing.
        """
        logger.info(f"[Solari Desktop] ⚠️ Killing / Terminating VM {self.desktop_id}...")
        if self._sdk_instance:
            if hasattr(self._sdk_instance, "kill"):
                await self._sdk_instance.kill()
            elif hasattr(self._sdk_instance, "destroy"):
                await self._sdk_instance.destroy()
            return

        if self.desktop_id:
            try:
                # Use a fresh client if existing was closed
                client = self.http_client or httpx.AsyncClient(
                    base_url=self.api_base,
                    headers=self._get_headers()
                )
                await client.delete(f"/v1/desktops/{self.desktop_id}")
                logger.info(f"[Solari Desktop] VM {self.desktop_id} successfully killed.")
                if not self.http_client:
                    await client.aclose()
            except Exception as e:
                logger.warning(f"[Solari Desktop] Warning during VM termination: {e}")
            finally:
                self.desktop_id = None
                self.is_connected = False
