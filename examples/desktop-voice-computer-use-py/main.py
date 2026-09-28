"""Voice-directed desktop computer-use — dispatch actions from spoken instructions.

Takes natural voice directives, parses them into GUI actions, and executes
them on a hardware-isolated Linux desktop over Solari's WebSocket control channel.

`streamUrl` can be embedded in any VNC viewer to watch the voice loop operate live.
"""

import asyncio
import os
import pathlib
import re

from solari_desktop import DesktopClient

BASE_URL = "https://api.getsolari.com"

# Simulated transcribed voice instructions representing a user's spoken intent.
# In a full voice pipeline, these arrive from an STT model (e.g. Whisper).
DEMO_VOICE_COMMANDS: list[str] = [
    "open mousepad",
    "click text editor at 320 300",
    "type Voice-directed agent connected to Solari desktop.",
    "press Return",
    "type Action dispatched: taking meeting notes via voice command.",
    "take screenshot notes.png",
]


async def dispatch_voice_command(desktop, command: str) -> None:
    """Parse a voice instruction and dispatch the corresponding GUI action."""
    cleaned = command.strip()
    print(f"\n[voice input] \"{cleaned}\"")

    if cleaned.lower().startswith("open ") or cleaned.lower().startswith("launch "):
        app_name = cleaned.split(maxsplit=1)[1].strip()
        print(f" -> opening application: {app_name}")
        pid = await desktop.open(app_name)
        print(f"    launched {app_name} (pid {pid})")
        await asyncio.sleep(3)

    elif "click" in cleaned.lower():
        # Match explicit coordinates e.g. "click at 320 300" or "click text editor at 320 300"
        coords = re.findall(r"\b\d+\b", cleaned)
        if len(coords) >= 2:
            x, y = int(coords[0]), int(coords[1])
        else:
            # Default editor focus point inside mousepad top-left quadrant
            x, y = 320, 300
        print(f" -> mouse click at ({x}, {y})")
        await desktop.mouse.click(x, y, humanize=True)
        await asyncio.sleep(1)

    elif cleaned.lower().startswith("type ") or cleaned.lower().startswith("write "):
        text = cleaned.split(maxsplit=1)[1]
        print(f" -> typing text: {text!r}")
        await desktop.keyboard.type(text)
        await asyncio.sleep(1)

    elif cleaned.lower().startswith("press "):
        key = cleaned.split(maxsplit=1)[1].strip()
        print(f" -> pressing key: {key}")
        await desktop.keyboard.press(key)
        await asyncio.sleep(0.5)

    elif "screenshot" in cleaned.lower():
        words = cleaned.split()
        filename = words[-1] if words[-1].endswith(".png") else "voice_action.png"
        print(f" -> capturing desktop screenshot: {filename}")
        shot = await desktop.screenshot(format="png")
        out = pathlib.Path(filename)
        out.write_bytes(shot)
        print(f"    saved {out} ({len(shot)} bytes)")

    else:
        print(f" -> unhandled voice command: {command}")


async def main() -> None:
    api_key = os.environ.get("SOLARI_API_KEY")
    if not api_key:
        raise RuntimeError("SOLARI_API_KEY environment variable is required")

    async with DesktopClient(
        api_key=api_key,
        base_url=BASE_URL,
    ) as client:
        desktop = await client.create(
            template="default",
            resolution="1280x720",
            timeout_ms=10 * 60_000,
        )
        print("session:", desktop.sessionId)
        print("watch  :", desktop.streamUrl)

        try:
            await desktop.connect()

            # Wait for X11 server to initialize
            for _ in range(30):
                health = await desktop.health()
                if getattr(health, "ready", False):
                    break
                await asyncio.sleep(1)

            # Run through the voice command loop
            print("\nStarting voice-directed computer-use loop...")
            for voice_cmd in DEMO_VOICE_COMMANDS:
                await dispatch_voice_command(desktop, voice_cmd)

            print("\nVoice-directed loop completed successfully.")
        finally:
            # close() disconnects local websocket; destroy() terminates the session
            await desktop.close()
            await client.destroy(desktop.sessionId)


if __name__ == "__main__":
    asyncio.run(main())
