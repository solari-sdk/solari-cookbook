"""Perception: turn the desktop into an Observation the brain can consume.

An Observation is immutable and carries a digest so later steps can detect 'the screen did not
change after my action' (stale screenshot / dead click) without another model call.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import struct
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Observation:
    png: bytes
    width: int
    height: int
    taken_at: float
    digest: str  # sha1(png). Cheap equality check for 'nothing changed'.

    def b64(self) -> str:
        return base64.b64encode(self.png).decode("ascii")

    def same_as(self, other: "Observation | None") -> bool:
        return other is not None and self.digest == other.digest

    def save(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.png)
        return path


def _png_size(png: bytes) -> tuple[int, int]:
    # IHDR chunk: width and height are big-endian uint32 at bytes 16..24 of any valid PNG.
    if len(png) < 24 or png[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    w, h = struct.unpack(">II", png[16:24])
    return w, h


async def capture(desktop, expect_w: int, expect_h: int, *, settle_s: float = 0.0, retries: int = 3) -> Observation:
    """Screenshot with backoff. settle_s lets the UI finish painting after an action.

    Verifies the PNG's real dimensions: if the VM ever hands back a different size than configured,
    every coordinate the brain returns is wrong, and we want to fail loudly here, not click blindly.
    """
    if settle_s:
        await asyncio.sleep(settle_s)
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            png = await desktop.screenshot(format="png")
            w, h = _png_size(png)
            if (w, h) != (expect_w, expect_h):
                raise RuntimeError(f"screenshot is {w}x{h}, expected {expect_w}x{expect_h}")
            return Observation(png, w, h, time.time(), hashlib.sha1(png).hexdigest())
        except Exception as e:  # noqa: BLE001 - we retry anything here, then re-raise the last one
            last_err = e
            await asyncio.sleep(0.5 * 2**attempt)
    raise RuntimeError(f"capture failed after {retries} attempts: {last_err}")