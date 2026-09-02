"""Step 2 smoke test: every primitive the agent will use, once, in one billed minute.

create -> connect -> health poll -> open app -> click -> type -> screenshot -> destroy

Run: python smoke_test.py
"""
import asyncio
import os
import pathlib
import time

from dotenv import load_dotenv
from solari_desktop import DesktopClient

load_dotenv()

BASE_URL = "https://api.getsolari.com"
RESOLUTION = "1280x720"          # agent will use this too: cheap for vision tokens, big enough to read
TIMEOUT_MS = 5 * 60_000          # hard cap: if this script crashes, the VM still dies in 5 min
HOLD_SECONDS = 20                # window for you to open streamUrl and watch it live

T0 = time.time()


def log(msg: str) -> None:
    print(f"[{time.time() - T0:5.1f}s] {msg}")


async def main() -> None:
    async with DesktopClient(api_key=os.environ["SOLARI_API_KEY"], base_url=BASE_URL) as client:
        desktop = await client.create(template="default", resolution=RESOLUTION, timeout_ms=TIMEOUT_MS)
        log(f"session : {desktop.sessionId}")
        log(f"WATCH   : {desktop.streamUrl}")
        try:
            await desktop.connect()

            # Display readiness is NOT implied by create() returning. Acting before ready
            # = clicks into a black screen. This poll is the first "retry" pattern in the project.
            for attempt in range(30):
                health = await desktop.health()
                if getattr(health, "ready", False):
                    break
                await asyncio.sleep(1)
            else:
                raise RuntimeError("display never became ready in 30s")
            log(f"ready after {attempt + 1} health poll(s)")

            pid = await desktop.open("mousepad")   # simple text editor shipped in the default template
            log(f"opened mousepad, pid={pid}")
            await asyncio.sleep(4)                  # app launch is async; window needs time to paint

            await desktop.mouse.click(640, 360, humanize=True)   # dead centre of 1280x720
            await desktop.keyboard.type("hello from step 2 - solari desktop is alive")
            await asyncio.sleep(1.5)

            png = await desktop.screenshot(format="png")
            out = pathlib.Path("step2_screenshot.png")
            out.write_bytes(png)
            log(f"screenshot -> {out.resolve()} ({len(png):,} bytes)")

            log(f"holding {HOLD_SECONDS}s - open the WATCH url above in your browser now")
            await asyncio.sleep(HOLD_SECONDS)
        finally:
            # ALWAYS runs, even on exception. A leaked VM bills until its timeout.
            await desktop.close()
            await client.destroy(desktop.sessionId)
            log("destroyed")


if __name__ == "__main__":
    asyncio.run(main())