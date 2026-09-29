"""Step 8 gate: compose the brief from the step 7 checkpoint, write it in Mousepad on the VM, save, verify.

Run: python step8_report_test.py
"""
import asyncio

from agent.actuator import Actuator
from agent.brain import Brain
from agent.config import RUNS_DIR, SCREEN_H, SCREEN_W
from agent.memory import Memory
from agent.report import compose_brief, write_on_desktop
from agent.session import desktop_session, log

RUN = RUNS_DIR / "step7"


async def main() -> None:
    mem = Memory.load(RUN)
    log(f"loaded checkpoint: {len(mem.findings)} findings, {len(mem.sources())} sources")
    brain = Brain()

    md = await compose_brief(brain, mem)
    log(f"brief composed: {len(md)} chars, {md.count(chr(10))} lines, {md.count('[')} citation marks")

    async with desktop_session(timeout_ms=6 * 60_000) as desktop:
        act = Actuator(desktop, SCREEN_W, SCREEN_H, out_dir=RUN / "report_frames")
        res = await write_on_desktop(desktop, act, mem, md)

    print("\n=== BRIEF (first 40 lines) ===")
    print("\n".join(md.splitlines()[:40]))
    print("...")
    print(f"\nlocal copy : {res.local_path}")
    print(f"VM path    : {res.vm_path}")
    print(f"pasted ok  : {res.pasted_verified}")
    print(f"GUI saved  : {res.gui_save_verified}")
    print(f"download   : {res.download_url or '(none)'}")
    print("STEP 8 COMPLETE" if res.pasted_verified or res.gui_save_verified else "FAIL: neither paste nor save verified")


if __name__ == "__main__":
    asyncio.run(main())