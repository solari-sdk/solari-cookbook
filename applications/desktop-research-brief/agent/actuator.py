"""Actuator: turn an Action into Solari SDK calls, with retries, settle detection, frame logging.

Everything that touches desktop.mouse / desktop.keyboard / desktop.screenshot / clipboard goes
through here. The brain never calls the SDK; the loop never calls the SDK. One choke point = one
place to log, retry, and rate-limit.

Every distinct frame observed is written to out_dir as NNN.png. When something fails, the evidence
is already on disk; nobody has to reproduce the run to see what the agent saw.

Key chords (verified empirically on the 'default' template, SDK 0.2.0): the guest honours a single
press() token of X11 keysyms joined by '+', e.g. press("Control_L+l"). hotkey("ctrl","l") does NOT
act as a chord. So the brain speaks 'ctrl+l' and key() translates to keysyms.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Awaitable, Callable, TypeVar

from .brain import Action
from .perception import Observation, capture
from .session import log

T = TypeVar("T")

# Settle times after each action kind, in seconds. UI paint is asynchronous; screenshotting too
# early yields a stale frame and the brain 'sees' its action fail. Tuned by observation, not theory.
SETTLE = {"click": 0.8, "double_click": 1.0, "right_click": 0.8, "type": 0.5, "key": 1.0, "scroll": 0.8, "wait": 0.0}

# Brain-facing names -> X11 keysyms the guest understands. Anything not listed passes through
# unchanged (Return, Escape, Tab, F5, Page_Down, Home, End, a-z, 0-9 are already keysyms).
KEYSYM = {
    "ctrl": "Control_L", "control": "Control_L",
    "alt": "Alt_L",
    "shift": "Shift_L",
    "super": "Super_L", "meta": "Super_L", "win": "Super_L",
    "enter": "Return", "return": "Return",
    "esc": "Escape",
    "pagedown": "Page_Down", "page_down": "Page_Down", "pgdn": "Page_Down",
    "pageup": "Page_Up", "page_up": "Page_Up", "pgup": "Page_Up",
    "backspace": "BackSpace", "delete": "Delete", "del": "Delete",
    "space": "space", "tab": "Tab",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
}


def to_keysym_chord(chord: str) -> str:
    parts = [p.strip() for p in chord.split("+") if p.strip()]
    return "+".join(KEYSYM.get(p.lower(), p) for p in parts)


async def retry(fn: Callable[[], Awaitable[T]], *, attempts: int = 3, base_delay: float = 0.5, what: str = "") -> T:
    """Exponential backoff for transient transport failures (websocket hiccup, gateway 5xx).
    Does NOT retry logic errors: those are raised by us before we get here."""
    last: Exception | None = None
    for i in range(attempts):
        try:
            return await fn()
        except Exception as e:  # noqa: BLE001 - transport layer; we cannot enumerate its exception types
            last = e
            delay = base_delay * 2**i
            log(f"retry {i + 1}/{attempts} {what}: {type(e).__name__}: {e} (sleep {delay:.1f}s)")
            await asyncio.sleep(delay)
    raise RuntimeError(f"{what} failed after {attempts} attempts: {last}")


class Actuator:
    def __init__(self, desktop, width: int, height: int, out_dir: Path | None = None) -> None:
        self.desktop = desktop
        self.width = width
        self.height = height
        self.out_dir = out_dir
        self.last: Observation | None = None
        self._seq = 0
        self._last_saved: str | None = None

    # ---- perception ------------------------------------------------------------------------

    async def observe(self, settle_s: float = 0.0) -> Observation:
        obs = await capture(self.desktop, self.width, self.height, settle_s=settle_s)
        self.last = obs
        if self.out_dir is not None and obs.digest != self._last_saved:
            self._seq += 1
            obs.save(self.out_dir / f"{self._seq:03d}.png")
            self._last_saved = obs.digest
        return obs

    @property
    def last_frame(self) -> str:
        """Filename of the most recently saved frame ('' if frames are not being saved)."""
        return f"{self._seq:03d}.png" if self.out_dir is not None and self._seq else ""

    async def wait_settled(self, *, timeout_s: float = 15.0, interval_s: float = 1.0, stable_n: int = 2) -> Observation:
        """Poll until `stable_n` consecutive screenshots are identical, or timeout.
        Model-free page-load detection. On timeout returns the latest frame anyway: a page with an
        animated element never 'settles', and the brain can still act on it."""
        prev: Observation | None = None
        stable = 0
        deadline = asyncio.get_event_loop().time() + timeout_s
        while True:
            obs = await self.observe()
            stable = stable + 1 if obs.same_as(prev) else 0
            if stable >= stable_n - 1:
                return obs
            if asyncio.get_event_loop().time() > deadline:
                log(f"wait_settled: timeout after {timeout_s}s, proceeding with latest frame")
                return obs
            prev = obs
            await asyncio.sleep(interval_s)

    # ---- primitives --------------------------------------------------------------------------

    async def click(self, x: int, y: int, *, button: str | None = None) -> None:
        await retry(lambda: self.desktop.mouse.click(x, y, button=button, humanize=True), what=f"click({x},{y})")

    async def double_click(self, x: int, y: int) -> None:
        await retry(lambda: self.desktop.mouse.double_click(x, y), what=f"double_click({x},{y})")

    async def type(self, text: str) -> None:
        await retry(lambda: self.desktop.keyboard.type(text), what="type")

    async def key(self, chord: str) -> None:
        """'ctrl+l' -> press('Control_L+l'). Single keys pass through: 'Return', 'F5', 'Page_Down'."""
        ks = to_keysym_chord(chord)
        await retry(lambda: self.desktop.keyboard.press(ks), what=f"key({ks})")

    async def scroll(self, dy: int) -> None:
        """Page_Down/Page_Up per unit. mouse.scroll's direction semantics are undocumented in SDK 0.2.0;
        keyboard paging is deterministic and works in browsers and editors alike."""
        key = "Page_Down" if dy > 0 else "Page_Up"
        for _ in range(min(abs(dy), 5)):
            await self.key(key)
            await asyncio.sleep(0.3)

    async def clipboard_get(self) -> str:
        return await retry(lambda: self.desktop.clipboard.get(), what="clipboard.get")

    async def clipboard_set(self, text: str) -> None:
        await retry(lambda: self.desktop.clipboard.set(text), what="clipboard.set")

    async def read_focused_text(self) -> str:
        """Select-all + copy in the focused widget, then read the VM clipboard.
        Model-free way to learn what a text field actually contains. Returns '' if nothing copied."""
        await self.key("ctrl+a")
        await asyncio.sleep(0.15)
        await self.key("ctrl+c")
        await asyncio.sleep(0.3)
        try:
            return await self.clipboard_get()
        except RuntimeError:
            return ""  # xclip exits 1 on an empty clipboard; that IS the answer

    async def paste(self, text: str) -> None:
        """Clipboard paste: the way to get a long document into an editor without typing it."""
        await self.clipboard_set(text)
        await asyncio.sleep(0.3)
        await self.key("ctrl+v")

    async def maximize_active(self) -> None:
        """Make the focused window fill the screen. Tries xdotool via exec (idempotent), falls back
        to xfwm4's Alt+F10 toggle. A floating 600px window wastes half the pixels the brain pays for."""
        try:
            r = await self.desktop.exec(
                "xdotool",
                args=["getactivewindow", "windowmove", "0", "0", "windowsize", str(self.width), str(self.height)],
                timeout_ms=5000,
            )
            if r.exitCode == 0:
                await asyncio.sleep(0.8)
                return
            log(f"xdotool maximize failed (exit {r.exitCode}): {r.stderr.strip()[:120]} -> Alt+F10")
        except Exception as e:  # noqa: BLE001
            log(f"xdotool unavailable: {type(e).__name__}: {e} -> Alt+F10")
        await self.key("alt+F10")
        await asyncio.sleep(0.8)

    # ---- dispatch ----------------------------------------------------------------------------

    async def perform(self, action: Action) -> Observation:
        """Execute one Action, then return the post-action Observation. The caller compares it
        with the pre-action one (digest) to detect 'nothing happened'."""
        k = action.kind
        if k == "click":
            await self.click(action.x, action.y)  # type: ignore[arg-type]
        elif k == "double_click":
            await self.double_click(action.x, action.y)  # type: ignore[arg-type]
        elif k == "right_click":
            await self.click(action.x, action.y, button="right")  # type: ignore[arg-type]
        elif k == "type":
            await self.type(action.text or "")
        elif k == "key":
            await self.key(action.keys or "")
        elif k == "scroll":
            await self.scroll(action.scroll_dy or 1)
        elif k == "wait":
            await asyncio.sleep(2.0)
        # 'done' / 'fail' perform nothing; the loop handles termination.
        return await self.observe(settle_s=SETTLE.get(k, 0.5))