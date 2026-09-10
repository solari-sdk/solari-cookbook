"""Step 6 gate: homepage -> extract (quality-fixed prompt) -> plan -> checkpoint -> reload plan.

~3 model calls. Run: python step6_plan_test.py
"""
import asyncio
import shutil

from agent.actuator import Actuator
from agent.brain import Brain
from agent.browser import Browser
from agent.config import RUNS_DIR, SCREEN_H, SCREEN_W
from agent.memory import Memory
from agent.planner import load_tasks, make_plan
from agent.session import desktop_session, log

OUT = RUNS_DIR / "step6"
TARGET = "Pinetree Research"
URL = "https://pinetree-research.com"


async def main() -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    brain = Brain()
    mem = Memory.load_or_new(OUT, TARGET)
    async with desktop_session(timeout_ms=6 * 60_000) as desktop:
        act = Actuator(desktop, SCREEN_W, SCREEN_H, out_dir=OUT)
        browser = Browser(desktop, act, brain)

        obs = await browser.launch(URL)
        mem.mark_visited(URL)
        mem.log_step("navigate", f"navigate({URL})", digest=obs.digest)

        ex = await brain.extract(obs, target=TARGET, url=URL, memory=mem.summary(), step=mem.step_no + 1)
        added = mem.add_findings(ex.findings)
        log(f"extract: {len(ex.findings)} findings, {added} new (quality prompt)")
        for f in ex.findings:
            log(f"   [{f.category}/{f.confidence}] {f.fact}")

        tasks = await make_plan(brain, obs, mem, URL)

    print("\n=== PLAN ===")
    for t in load_tasks(Memory.load(OUT)):
        print(f"{t.id:2d}. [{t.kind:6s}] {t.value}\n      goal: {t.goal}  (screens={t.max_screens})")
    print(f"\nmodel_calls={brain.calls}  checkpoint={mem.path}")
    print("STEP 6 COMPLETE" if 5 <= len(tasks) <= 9 else f"FAIL: {len(tasks)} tasks")


if __name__ == "__main__":
    asyncio.run(main())