"""Research-brief agent on a Solari Desktop - one command, end to end.

    python main.py --target "Pinetree Research" --homepage https://pinetree-research.com

What happens:
  1. A Linux desktop VM is created on Solari. Chrome is launched and maximised.
  2. The homepage is read from screenshots; a research plan (site subpages + web searches) is made.
  3. Each plan task is executed: navigate or search -> pick a result -> read 1-4 screens -> extract
     cited findings into a JSON checkpoint. Every action and observation is logged; frames are saved.
  4. A cited Markdown brief is composed from the findings, pasted into Mousepad on the VM, saved via
     the GUI to /root/reports/, verified by reading the file back, and a signed download URL printed.
  5. The VM is destroyed. A local copy of the brief and the full checkpoint stay in runs/<target>/.

Flags:
  --resume        continue a previous run of the same target (skips visited pages, pending tasks only)
  --max-tasks N   execute at most N plan tasks this run (cheap trial; rest stay pending for --resume)
  --record        ask Solari to record the session; prints the recording URL at the end
  --skip-report   research only (no brief)
"""
from __future__ import annotations

import argparse
import asyncio
import shutil
import time
from pathlib import Path

from agent.brain import Brain
from agent.config import RUNS_DIR
from agent.loop import ResearchAgent, RunConfig
from agent.memory import Memory
from agent.report import compose_brief, slug, write_on_desktop
from agent.session import desktop_session, log


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Autonomous research brief via a Solari Desktop computer-use agent.")
    p.add_argument("--target", required=True, help='e.g. "Pinetree Research"')
    p.add_argument("--homepage", required=True, help="e.g. https://pinetree-research.com")
    p.add_argument("--max-tasks", type=int, default=None, help="cap plan tasks executed this run")
    p.add_argument("--max-actions", type=int, default=90, help="global action budget (desktop actions + model decisions)")
    p.add_argument("--timeout-min", type=int, default=25, help="VM idle timeout; the VM dies after this even if we crash")
    p.add_argument("--run-dir", default=None, help="where checkpoint/frames/brief go (default runs/<target-slug>)")
    p.add_argument("--resume", action="store_true", help="continue from an existing checkpoint instead of starting fresh")
    p.add_argument("--record", action="store_true", help="record the session (mp4) on Solari")
    p.add_argument("--skip-report", action="store_true", help="research only; do not write the brief")
    return p.parse_args()


async def run(a: argparse.Namespace) -> int:
    t0 = time.time()
    run_dir = Path(a.run_dir) if a.run_dir else RUNS_DIR / slug(a.target)
    if not a.resume:
        shutil.rmtree(run_dir, ignore_errors=True)
    mem = Memory.load_or_new(run_dir, a.target)
    brain = Brain()
    cfg = RunConfig(target=a.target, homepage=a.homepage, max_actions=a.max_actions, max_tasks=a.max_tasks)

    recording_url: str | None = None
    result = None
    async with desktop_session(timeout_ms=a.timeout_min * 60_000, record=a.record) as desktop:
        if a.record:
            try:
                await desktop.record.start()
            except Exception as e:  # noqa: BLE001 - recording is a nice-to-have, never fatal
                log(f"record.start: {type(e).__name__}: {e} (session-level recording may still apply)")

        agent = ResearchAgent(desktop, brain, mem, cfg, out_dir=run_dir / "frames")
        await agent.run()

        if mem.findings and not a.skip_report:
            md = await compose_brief(brain, mem)
            log(f"brief composed: {len(md)} chars")
            result = await write_on_desktop(desktop, agent.act, mem, md)

        if a.record:
            try:
                await desktop.record.stop()
                recording_url = getattr(desktop, "recordingUrl", None)
            except Exception as e:  # noqa: BLE001
                log(f"record.stop: {type(e).__name__}: {e}")

    print("\n=== DONE ===")
    print(f"target      : {a.target}")
    print(f"findings    : {len(mem.findings)} from {len(mem.sources())} sources")
    print(f"checkpoint  : {mem.path}")
    if result:
        print(f"brief (local): {result.local_path}")
        print(f"brief (VM)   : {result.vm_path}   pasted_verified={result.pasted_verified} gui_save_verified={result.gui_save_verified}")
        print(f"download     : {result.download_url or '(unavailable)'}")
    elif not a.skip_report:
        print("brief        : not written (no findings)")
    if a.record:
        print(f"recording    : {recording_url or '(not yet available - check the session in console.getsolari.com)'}")
    print(f"model calls  : {brain.calls} (retries {brain.retries})   elapsed: {time.time() - t0:.0f}s")
    return 0 if mem.findings else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parse_args())))
