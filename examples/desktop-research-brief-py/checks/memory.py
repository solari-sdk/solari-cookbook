"""Step 5 gate.
Part A (free): memory round-trip - add, dedupe, save, reload, compare.
Part B (~3 model calls): navigate to one page, extract two screens, store, checkpoint, reload.

Run: python step5_memory_test.py
"""
import asyncio
import shutil
from pathlib import Path

from agent.actuator import Actuator
from agent.brain import Brain
from agent.browser import Browser
from agent.config import RUNS_DIR, SCREEN_H, SCREEN_W
from agent.memory import Finding, Memory
from agent.session import desktop_session, log

OUT = RUNS_DIR / "step5"
TARGET = "Pinetree Research"
URL = "https://pinetree-research.com"


def part_a() -> None:
    d = Path("runs/step5_unit")
    shutil.rmtree(d, ignore_errors=True)
    m = Memory(target="unit", run_dir=d)
    n = m.add_findings([
        Finding("Alpha builds agents.", "approach", "high", "https://a.example", 1),
        Finding("alpha builds agents", "approach", "high", "https://a.example", 1),   # dupe (case/punct)
        Finding("Raised $10M.", "funding", "medium", "https://b.example", 2),
        Finding("Weird category.", "nonsense", "low", "https://b.example", 2),         # -> other
    ])
    assert n == 3, f"expected 3 added, got {n}"
    m.mark_visited("https://a.example/")
    m.mark_visited("http://www.a.example")  # same site, must not duplicate
    assert m.visited == ["https://a.example/"], m.visited
    assert m.has_visited("a.example")
    m.log_step("navigate", "navigate(https://a.example)", frame="001.png", note="ok")
    m2 = Memory.load(d)
    assert [f.fact for f in m2.findings] == [f.fact for f in m.findings]
    assert m2.findings[2].category == "other"
    assert m2.steps[0].action == "navigate(https://a.example)"
    assert "[1] https://a.example" in m2.summary()
    print("PART A OK: dedupe, categories, visited, atomic save/load, summary")


async def part_b() -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    brain = Brain()
    mem = Memory.load_or_new(OUT, TARGET)
    async with desktop_session(timeout_ms=6 * 60_000) as desktop:
        act = Actuator(desktop, SCREEN_W, SCREEN_H, out_dir=OUT)
        browser = Browser(desktop, act, brain)

        obs = await browser.launch(URL)
        mem.mark_visited(URL)
        mem.log_step("navigate", f"navigate({URL})", frame=f"{act._seq:03d}.png", digest=obs.digest)

        for screen in range(2):
            ex = await brain.extract(obs, target=TARGET, url=URL, memory=mem.summary(), step=mem.step_no + 1)
            added = mem.add_findings(ex.findings)
            mem.log_step("extract", f"extract(screen {screen + 1})", frame=f"{act._seq:03d}.png", digest=obs.digest,
                         note=f"{len(ex.findings)} found, {added} new, more_below={ex.more_below}, obstacle={ex.obstacle!r}")
            log(f"screen {screen + 1}: {len(ex.findings)} findings, {added} new; more_below={ex.more_below}; obstacle={ex.obstacle!r}")
            if not ex.more_below:
                break
            await act.scroll(1)
            obs = await act.observe(settle_s=0.8)

    reloaded = Memory.load(OUT)
    print("\n=== MEMORY SUMMARY (as the brain will see it) ===")
    print(reloaded.summary())
    print(f"\ncheckpoint: {reloaded.path}  findings={len(reloaded.findings)} steps={len(reloaded.steps)} model_calls={brain.calls}")
    print("STEP 5 COMPLETE" if reloaded.findings else "FAIL: no findings extracted - send runs/step5/*.png")


if __name__ == "__main__":
    part_a()
    asyncio.run(part_b())