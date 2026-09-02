from abc import ABC, abstractmethod
from typing import Optional, List, Tuple, Dict, Any


class BaseDesktopClient(ABC):
    """Abstract Base Class for Solari Desktop and Mock Desktop implementations."""

    @abstractmethod
    async def create(self, width: int = 1024, height: int = 768, timeout_seconds: int = 600) -> "BaseDesktopClient":
        """Provisions a Linux Desktop VM instance."""
        pass

    @abstractmethod
    async def connect(self) -> None:
        """Establishes WebSocket / command channel connection."""
        pass

    @abstractmethod
    async def screenshot(self) -> bytes:
        """Captures a screenshot of the current desktop and returns JPEG/PNG bytes."""
        pass

    @abstractmethod
    async def mouse_click(self, x: int, y: int, button: str = "left", click_type: str = "single") -> None:
        """Simulates a mouse click at coordinates (x, y)."""
        pass

    @abstractmethod
    async def mouse_move(self, x: int, y: int) -> None:
        """Moves the mouse cursor to (x, y)."""
        pass

    @abstractmethod
    async def mouse_drag(self, start_x: int, start_y: int, end_x: int, end_y: int) -> None:
        """Performs a drag and drop motion from start coordinates to end coordinates."""
        pass

    @abstractmethod
    async def type_text(self, text: str, delay_ms: int = 15) -> None:
        """Types a string into the active desktop window."""
        pass

    @abstractmethod
    async def press_key(self, key: str) -> None:
        """Presses a specific keyboard key (e.g. 'Return', 'BackSpace', 'Tab', 'ctrl+c')."""
        pass

    @abstractmethod
    async def scroll(self, direction: str = "down", amount: int = 3) -> None:
        """Scrolls the mouse wheel up or down."""
        pass

    @abstractmethod
    async def exec_command(self, cmd: str | List[str]) -> Dict[str, Any]:
        """
        Executes a command inside the desktop environment.
        Note: Handles the Solari gotcha where commands are not shell-interpreted by default.
        """
        pass

    @abstractmethod
    async def close(self) -> None:
        """Disconnects the client control session."""
        pass

    @abstractmethod
    async def kill(self) -> None:
        """
        Terminates and destroys the VM instance permanently.
        Note: In Solari, close() only ends the connection session, whereas kill() / destroy() actually ends the VM!
        """
        pass
