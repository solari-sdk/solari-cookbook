"""Fault injection for reliability testing. Never imported by the agent itself.

Three fault classes, each mapped to a real-world failure and to the mechanism that must absorb it:
- transport failures on SDK calls  (websocket hiccup, gateway 5xx)   -> actuator.retry()
- stale screenshot frames           (VNC lag, slow paint)              -> digest 'NO CHANGE' -> re-decide / stall
- model API rate limits (429)       (shared quota, bursty usage)       -> Brain.call() backoff

ChaosDesktop wraps a real Desktop handle: it delegates everything, but randomly raises before mouse /
keyboard / clipboard calls and periodically returns the previous screenshot. ChaosBrain raises a real
anthropic.RateLimitError every Nth API attempt, underneath Brain.call's retry loop.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, Iterable

import anthropic
import httpx

from .brain import Brain
from .session import log


@dataclass
class ChaosStats:
    transport: int = 0
    stale: int = 0
    ratelimit: int = 0

    def __str__(self) -> str:
        return f"injected: transport={self.transport} stale_frames={self.stale} rate_limits={self.ratelimit}"


class _Namespace:
    """Proxy for desktop.mouse / .keyboard / .clipboard: same methods, with a chance of failing first."""

    def __init__(self, target: Any, chaos: "ChaosDesktop", names: Iterable[str], label: str) -> None:
        self._t, self._c, self._names, self._label = target, chaos, set(names), label

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._t, name)
        if name not in self._names or not callable(attr):
            return attr

        async def wrapped(*a: Any, **kw: Any) -> Any:
            self._c._maybe_fail(f"{self._label}.{name}")
            return await attr(*a, **kw)

        return wrapped


class ChaosDesktop:
    def __init__(self, desktop: Any, *, p_fail: float = 0.15, stale_every: int = 7, seed: int = 42) -> None:
        self._d = desktop
        self._rng = random.Random(seed)  # seeded: the same faults every run, so a fix can be verified
        self.p_fail = p_fail
        self.stale_every = stale_every
        self.stats = ChaosStats()
        self._shots = 0
        self._last_png: bytes | None = None
        self.mouse = _Namespace(desktop.mouse, self, {"click", "double_click", "move", "scroll"}, "mouse")
        self.keyboard = _Namespace(desktop.keyboard, self, {"type", "press", "hotkey"}, "keyboard")
        self.clipboard = _Namespace(desktop.clipboard, self, {"get", "set"}, "clipboard")

    def _maybe_fail(self, what: str) -> None:
        if self._rng.random() < self.p_fail:
            self.stats.transport += 1
            log(f"  [chaos] transport failure injected on {what}")
            raise ConnectionError(f"chaos: injected transport failure on {what}")

    async def screenshot(self, **kw: Any) -> bytes:
        self._shots += 1
        if self.stale_every and self._last_png is not None and self._shots % self.stale_every == 0:
            self.stats.stale += 1
            log("  [chaos] stale frame injected")
            return self._last_png
        self._maybe_fail("screenshot")
        png = await self._d.screenshot(**kw)
        self._last_png = png
        return png

    def __getattr__(self, name: str) -> Any:
        return getattr(self._d, name)  # exec, open, files, health, connect, close, sessionId, download_url ...


class ChaosBrain(Brain):
    def __init__(self, *args: Any, ratelimit_every: int = 6, stats: ChaosStats | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.ratelimit_every = ratelimit_every
        self.stats = stats or ChaosStats()
        self._n = 0

    async def _create(self, **kwargs: Any) -> anthropic.types.Message:
        self._n += 1
        if self.ratelimit_every and self._n % self.ratelimit_every == 0:
            self.stats.ratelimit += 1
            log("  [chaos] 429 rate limit injected")
            req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
            raise anthropic.RateLimitError("chaos: injected rate limit", response=httpx.Response(429, request=req), body=None)
        return await super()._create(**kwargs)