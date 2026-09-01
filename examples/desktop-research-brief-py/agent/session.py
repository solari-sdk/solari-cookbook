"""Desktop lifecycle: create -> connect -> wait ready -> yield -> ALWAYS destroy.

Kept separate from navigation because lifecycle must be correct even when everything else
crashes: a leaked VM bills until its timeout. Destroyed sessions still appear as 'Stopped' in
the console; delete them there periodically.
"""
from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from solari_desktop import DesktopClient

from .config import DESKTOP_TEMPLATE, RESOLUTION, SOLARI_BASE_URL

_T0 = time.time()

# Chrome with --no-sandbox on the 2048 MB default hit 'Aw, Snap! error code 5' (renderer OOM)
# on GitHub. 4 GB makes it rare; the retry in Browser.navigate makes it survivable.
DEFAULT_MEM_MB = 4096


def log(msg: str) -> None:
    print(f"[{time.time() - _T0:6.1f}s] {msg}", flush=True)


async def _wait_ready(desktop, attempts: int = 30) -> None:
    for i in range(attempts):
        health = await desktop.health()
        if getattr(health, "ready", False):
            log(f"display ready after {i + 1} poll(s)")
            return
        await asyncio.sleep(1)
    raise RuntimeError(f"display not ready after {attempts}s")


@asynccontextmanager
async def desktop_session(
    timeout_ms: int = 10 * 60_000, record: bool = False, mem_mb: int = DEFAULT_MEM_MB
) -> AsyncIterator:
    """record=True asks Solari to record the session; desktop.recordingUrl is populated after
    desktop.record.stop(). Used for the demo video, off by default to keep test runs cheap."""
    async with DesktopClient(api_key=os.environ["SOLARI_API_KEY"], base_url=SOLARI_BASE_URL) as client:
        desktop = await client.create(
            template=DESKTOP_TEMPLATE,
            resolution=RESOLUTION,
            timeout_ms=timeout_ms,
            mem_mb=mem_mb,
            record=record or None,
        )
        log(f"session {desktop.sessionId}  (watch live: console.getsolari.com -> Desktops)")
        try:
            await desktop.connect()
            await _wait_ready(desktop)
            yield desktop
        finally:
            await desktop.close()
            await client.destroy(desktop.sessionId)
            log("session destroyed")