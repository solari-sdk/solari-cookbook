"""Step 4 gate: browser detect -> launch -> navigate three times -> scroll -> verify each.

Every distinct frame is saved to runs/step4/NNN.png automatically. Run: python step4_nav_test.py
"""
import asyncio

from agent.actuator import Actuator
from agent.brain import Brain
from agent.browser import Browser, ddg_url
from agent.config import RUNS_DIR, SCREEN_H, SCREEN_W
from agent.session import desktop_session, log

OUT = RUNS_DIR / "step4"


async def main() -> None:
    brain = Brain()
    async with desktop_session(timeout_ms=6 * 60_000) as desktop:
        act = Actuator(desktop, SCREEN_W, SCREEN_H, out_dir=OUT)
        browser = Browser(desktop, act, brain)

        await browser.launch("https://pinetree-research.com")
        obs = await browser.navigate(ddg_url("Pinetree Research computer use agents"))

        before = obs
        await act.scroll(2)
        after = await act.observe(settle_s=0.8)
        if after.same_as(before):
            raise SystemExit("FAIL: scroll had no visible effect")
        log("scroll changed the screen")

        await browser.navigate("https://github.com/solari-sdk/solari-cookbook")
        print(f"STEP 4 COMPLETE  (browser={browser.binary})")


if __name__ == "__main__":
    asyncio.run(main())