"""Step 3 gate: closed-loop grounding. Claude picks the click target, we click it, Claude confirms.

Two vision calls (~$0.03). Run: python step3_ground_test.py
"""
import asyncio
import json

from agent.brain import Brain
from agent.config import RUNS_DIR, SCREEN_H, SCREEN_W
from agent.perception import capture
from agent.session import desktop_session, log

OUT = RUNS_DIR / "step3"
MARKER = "grounding ok 42"


async def main() -> None:
    brain = Brain()
    async with desktop_session(timeout_ms=5 * 60_000) as desktop:
        await desktop.open("mousepad")
        await asyncio.sleep(4)

        obs1 = await capture(desktop, SCREEN_W, SCREEN_H)
        obs1.save(OUT / "01_before.png")

        action = await brain.decide(
            obs1,
            goal="Click inside the empty text-editing area of the Mousepad window so that typing will insert text there.",
        )
        log(f"brain -> {action.describe()}  | {action.reasoning}")
        (OUT / "action.json").write_text(json.dumps(action.raw, indent=2))
        if action.kind != "click":
            raise SystemExit(f"FAIL: expected a click, got {action.kind}")

        await desktop.mouse.click(action.x, action.y, humanize=True)
        await desktop.keyboard.type(MARKER)

        obs2 = await capture(desktop, SCREEN_W, SCREEN_H, settle_s=1.5)
        obs2.save(OUT / "02_after.png")
        if obs2.same_as(obs1):
            raise SystemExit("FAIL: screen did not change after click+type (stale screenshot or dead click)")

        ok, evidence = await brain.judge(
            obs2, f"Does the exact text '{MARKER}' appear inside the text editor's document area?"
        )
        log(f"verify -> {ok}  | {evidence}")
        print("STEP 3 COMPLETE" if ok else "FAIL: grounding not confirmed - send me runs/step3/*.png")


if __name__ == "__main__":
    asyncio.run(main())