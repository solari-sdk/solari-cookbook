"""
evidence/parallel_scale_demo.py — Contrast #1: parallel scale.

Free-tier Solari accounts cap concurrent browser sessions at 3
(confirmed live: 429 ConcurrencyLimitExceeded, cap=3). This demo respects
that cap with a semaphore instead of firing everything at once and eating
errors — still proves the real point honestly: no proxy pool, no
fingerprint rotation, no manual queue/retry logic needed, just a semaphore
and Solari handles the rest. Raising N_SESSIONS beyond the plan cap just
means requests queue instead of erroring; raising the actual concurrency
ceiling is a plan upgrade, not an engineering project — worth stating as
part of the pitch, not hiding.
"""

import asyncio
import os
import time
from dataclasses import dataclass

USE_REAL_SOLARI = bool(os.environ.get("SOLARI_API_KEY"))

if USE_REAL_SOLARI:
    from solari_browser import Solari  # pip install solari-browser

CONCURRENCY_CAP = int(os.environ.get("SOLARI_CONCURRENCY_CAP", "3"))  # free tier = 3


@dataclass
class SessionResult:
    session_id: int
    target: str
    elapsed_ms: float
    title: str | None = None
    error: str | None = None


async def _fake_session(session_id: int, target: str) -> SessionResult:
    start = time.time()
    await asyncio.sleep(0.05)
    return SessionResult(session_id, target, (time.time() - start) * 1000, title="[stub]")


async def _real_session(sem: asyncio.Semaphore, session_id: int, target: str) -> SessionResult:
    start = time.time()
    async with sem:
        try:
            async with Solari(api_key=os.environ["SOLARI_API_KEY"]) as solari:
                async with await solari.launch() as browser:
                    page = await browser.new_page()
                    await page.goto(target, wait_until="networkidle")
                    title = await page.title()
            return SessionResult(session_id, target, (time.time() - start) * 1000, title=title)
        except Exception as e:
            return SessionResult(session_id, target, (time.time() - start) * 1000, error=str(e))


async def run_parallel_scale_demo(n_sessions: int = 10) -> list[SessionResult]:
    targets = [f"https://example.com/?session={i}" for i in range(n_sessions)]

    t0 = time.time()
    if not USE_REAL_SOLARI:
        results = await asyncio.gather(*[_fake_session(i, t) for i, t in enumerate(targets)])
    else:
        sem = asyncio.Semaphore(CONCURRENCY_CAP)
        results = await asyncio.gather(
            *[_real_session(sem, i, t) for i, t in enumerate(targets)]
        )
    total_elapsed = time.time() - t0

    ok = sum(1 for r in results if not r.error)
    print(f"\n{n_sessions} sessions, max {CONCURRENCY_CAP} concurrent: {ok} succeeded, {n_sessions - ok} failed")
    print(f"Total wall-clock: {total_elapsed:.2f}s")
    print("(compare against evidence/local_infra_estimate.md for the DIY cost)")
    return results


if __name__ == "__main__":
    n = int(os.environ.get("N_SESSIONS", "10"))
    for r in asyncio.run(run_parallel_scale_demo(n)):
        status = "OK" if not r.error else f"ERROR: {r.error}"
        print(f"  [{r.session_id}] {r.elapsed_ms:.0f}ms — {status}")