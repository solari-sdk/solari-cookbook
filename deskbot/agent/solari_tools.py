"""Thin async wrapper around Solari's desktop client - the only Solari
product this project uses (see deskbot/README.md for why: this is the
desktop-only submission, and deliberately vision-free - see README).

Call patterns copied from the cookbook's own desktop-computer-use-py
example: connect() before driving the GUI, poll health() until X11 is
ready, click inside a window before typing or keystrokes go wherever the
desktop happened to have focus.
"""

from __future__ import annotations

import asyncio

from solari_desktop import DesktopClient

BASE_URL = "https://api.getsolari.com"


class DesktopToolkit:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self._client: DesktopClient | None = None
        self._desktop = None

    async def _ensure_desktop(self) -> None:
        if self._desktop is not None:
            return
        self._client = DesktopClient(api_key=self.api_key, base_url=BASE_URL)
        await self._client.__aenter__()
        self._desktop = await self._client.create(
            template="default", resolution="1280x720", timeout_ms=10 * 60_000
        )
        await self._desktop.connect()
        for _ in range(30):
            health = await self._desktop.health()
            if getattr(health, "ready", False):
                break
            await asyncio.sleep(1)

    # Every method below returns a plain string (success or "ERROR: ...")
    # rather than raising - these are tool-call results the model reacts to,
    # not exceptions that should crash the whole run.

    async def open_app(self, name: str) -> str:
        await self._ensure_desktop()
        try:
            pid = await self._desktop.open(name)
            await asyncio.sleep(3)
            return f"opened {name!r}, pid {pid}"
        except Exception as e:
            return f"ERROR: {e}"

    async def click(self, x: int, y: int) -> str:
        await self._ensure_desktop()
        try:
            await self._desktop.mouse.click(x, y, humanize=True)
            return f"clicked ({x}, {y})"
        except Exception as e:
            return f"ERROR: {e}"

    async def type_text(self, text: str) -> str:
        await self._ensure_desktop()
        try:
            await self._desktop.keyboard.type(text)
            return f"typed {len(text)} characters"
        except Exception as e:
            return f"ERROR: {e}"

    async def hotkey(self, keys: list[str]) -> str:
        await self._ensure_desktop()
        try:
            # Verified live: keyboard.hotkey(*keys) sends each key as a
            # SEPARATE press/release (ctrl down+up, shift down+up, s
            # down+up in sequence) rather than a held chord - "s" lands as
            # a literal keystroke instead of triggering e.g. Ctrl+Shift+S.
            # Joining into one combo string ("ctrl+shift+s") is what the
            # guest's xdotool-passthrough actually chords correctly.
            await self._desktop.keyboard.hotkey("+".join(keys))
            return f"pressed {'+'.join(keys)}"
        except Exception as e:
            return f"ERROR: {e}"

    async def key_press(self, key: str) -> str:
        await self._ensure_desktop()
        try:
            await self._desktop.keyboard.press(key)
            return f"pressed {key}"
        except Exception as e:
            return f"ERROR: {e}"

    async def shell(self, cmd: str, args: list[str] | None = None) -> str:
        """The agent's only source of ground truth, since it has no vision:
        exec runs a real command inside the desktop VM and returns real
        stdout/stderr/exit code - e.g. `ls`/`cat` to check whether a GUI
        save actually landed a file on disk, without ever looking at a
        screenshot."""
        await self._ensure_desktop()
        try:
            result = await self._desktop.exec(cmd, args=args or [], timeout_ms=15_000)
            out = f"exit={result.exitCode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            return out[:4000]
        except Exception as e:
            return f"ERROR: {e}"

    async def close(self) -> None:
        if self._desktop and self._client:
            await self._desktop.close()
            await self._client.destroy(self._desktop.sessionId)
        if self._client:
            await self._client.aclose()
