"""Step 7 gate: run the research loop end-to-end on the first N tasks, then resume for the rest.

Run:  python step7_loop_test.py --fresh --max-tasks 3     (first pass)
      python step7_loop_test.py                            (resume: remaining pending tasks)
      python step7_loop_test.py --retry-failed             (reset failed tasks to pending, then resume)
"""
import argparse
import asyncio
import shutil

from agent.brain import Brain
from agent.config import RUNS_DIR
from agent.loop import ResearchAgent, RunConfig
from agent.memory import Memory
from agent.session import desktop_session

OUT = RUNS_DIR / "step7"


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--target", default="Pinetree Research")
    p.add_argument("--homepage", default="https://pinetree-research.com")
    p.add_argument("--max-tasks", type=int, default=None, help="cap tasks this run (rest stay pending)")
    p.add_argument("--max-actions", type=int, default=90)
    p.add_argument("--fresh", action="store_true", help="delete previous checkpoint and frames")
    p.add_argument("--retry-failed", action="store_true", help="reset failed/skipped tasks to pending")
    a = p.parse_args()

    if a.fresh:
        shutil.rmtree(OUT, ignore_errors=True)
    mem = Memory.load_or_new(OUT, a.target)
    if a.retry_failed:
        n = 0
        for t in mem.plan:
            if t["status"] in ("failed", "skipped"):
                t["status"], t["note"], n = "pending", "", n + 1
        mem.save()
        print(f"reset {n} task(s) to pending")

    cfg = RunConfig(target=a.target, homepage=a.homepage, max_actions=a.max_actions, max_tasks=a.max_tasks)
    brain = Brain()
    async with desktop_session(timeout_ms=25 * 60_000) as desktop:
        agent = ResearchAgent(desktop, brain, mem, cfg, out_dir=OUT)
        await agent.run()
    print("STEP 7 COMPLETE" if mem.findings else "FAIL: no findings")


if __name__ == "__main__":
    asyncio.run(main())