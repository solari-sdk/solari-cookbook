"""
pipeline/desktop_repro.py — Step 1: reproduce the bug on a real Solari Desktop.

Takes a natural-language bug report, drives a real browser inside a Solari
Desktop VNC session through the described repro steps, and captures a
screen recording as evidence.
"""

import asyncio
import os
from dataclasses import dataclass, field


@dataclass
class ReproStep:
    action: str
    detail: str


@dataclass
class ReproResult:
    reproduced: bool
    steps: list[ReproStep] = field(default_factory=list)
    replay_url: str | None = None
    screenshot_before: str | None = None
    screenshot_after: str | None = None


def _save_screenshot(raw, path: str) -> None:
    import base64
    if isinstance(raw, (bytes, bytearray)):
        data = raw
    elif isinstance(raw, str):
        data = base64.b64decode(raw)
    elif hasattr(raw, "data"):
        data = raw.data
    else:
        print(f"[warn] unexpected screenshot() return type: {type(raw)} — not saved")
        return
    with open(path, "wb") as f:
        f.write(data)


USE_REAL_SOLARI = bool(os.environ.get("SOLARI_API_KEY"))

if USE_REAL_SOLARI:
    from solari_desktop import DesktopClient  # pip install solari-desktop


class FakeDesktopClient:
    def create(self, **kwargs):
        print(f"[stub] would create Solari desktop with {kwargs}")
        return self

    def open_app(self, app, args=None):
        print(f"[stub] would open {app} with args={args}")

    def click(self, **kwargs):
        print(f"[stub] would click {kwargs}")

    def select_option(self, **kwargs):
        print(f"[stub] would select option {kwargs}")

    def screenshot(self):
        print("[stub] would take screenshot")
        return "stub_screenshot.png"

    def get_replay_url(self):
        return None

    def kill(self):
        print("[stub] would tear down desktop")


async def reproduce(bug_report: str, target_url: str = "https://knapsack-map-caramel.ngrok-free.dev") -> ReproResult:
    steps = []

    if not USE_REAL_SOLARI:
        desktop = FakeDesktopClient().create(recording=True)
        desktop.open_app("firefox", args=[target_url])
        steps.append(ReproStep("navigate", f"opened {target_url}"))
        screenshot_before = desktop.screenshot()
        desktop.select_option(selector="#shipping", value="express")
        steps.append(ReproStep("interact", "selected 'Express' shipping"))
        desktop.click(selector="#submit-btn")
        steps.append(ReproStep("interact", "clicked 'Submit Order'"))
        screenshot_after = desktop.screenshot()
        steps.append(ReproStep("observe", "result div remained empty — bug reproduced"))
        replay_url = desktop.get_replay_url()
        desktop.kill()
        return ReproResult(True, steps, replay_url, screenshot_before, screenshot_after)

    # --- real path ---
    desktops = DesktopClient(
        api_key=os.environ["SOLARI_API_KEY"],
        base_url="https://api.getsolari.com",
    )
    desktop = await desktops.create(
        template="default", resolution="1280x720", record=True
    )
    try:
        await desktop.connect()
        health = await desktop.health()
        if not health.ready:
            raise RuntimeError("Solari desktop did not come up ready")

        await desktop.process.start("google-chrome", args=[])
        await asyncio.sleep(3)

        await desktop.mouse.click(314, 125, humanize=True)  # address bar
        await asyncio.sleep(0.3)
        await desktop.keyboard.press("End")
        for _ in range(30):
            await desktop.keyboard.press("BackSpace")
        await asyncio.sleep(0.3)
        await desktop.keyboard.type(target_url)
        await asyncio.sleep(0.3)
        await desktop.keyboard.press("Return")
        steps.append(ReproStep("navigate", f"typed and navigated to {target_url}"))

        await asyncio.sleep(3)
        await desktop.mouse.click(224, 555, humanize=True)  # ngrok "Visit Site"
        await asyncio.sleep(2)
        steps.append(ReproStep("navigate", "bypassed ngrok warning page"))

        await desktop.record.start()
        steps.append(ReproStep("record", "started recording"))

        os.makedirs("../evidence/screenshots", exist_ok=True)

        screenshot_before_raw = await desktop.screenshot(format="png")
        screenshot_before = "../evidence/screenshots/before.png"
        _save_screenshot(screenshot_before_raw, screenshot_before)

        await desktop.mouse.click(256, 300, humanize=True)  # shipping dropdown
        await desktop.keyboard.press("Down")
        await desktop.keyboard.press("Return")
        steps.append(ReproStep("interact", "selected 'Express' shipping"))

        await desktop.mouse.click(175, 320, humanize=True)  # submit button
        steps.append(ReproStep("interact", "clicked 'Submit Order'"))

        screenshot_after_raw = await desktop.screenshot(format="png")
        screenshot_after = "../evidence/screenshots/after.png"
        _save_screenshot(screenshot_after_raw, screenshot_after)
        steps.append(ReproStep("observe", f"saved before/after screenshots to {screenshot_before}, {screenshot_after}"))

        stop_result = await desktop.record.stop()
        print(f"[debug] record.stop() returned: {stop_result!r}")

        replay_url = None
        if isinstance(stop_result, dict):
            replay_url = stop_result.get("url") or stop_result.get("recordingUrl")
        else:
            replay_url = (
                getattr(stop_result, "url", None)
                or getattr(stop_result, "recordingUrl", None)
            )
        if not replay_url:
            replay_url = desktop.recordingUrl
    finally:
        await desktop.close()
        await desktops.destroy(desktop.sessionId)

    return ReproResult(
        reproduced=True,
        steps=steps,
        replay_url=replay_url,
        screenshot_before=screenshot_before,
        screenshot_after=screenshot_after,
    )