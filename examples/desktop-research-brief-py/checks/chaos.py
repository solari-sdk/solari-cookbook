"""Step 9 gate.
Part A (free, no VM, no model): retry() and capture() absorb transient faults; stale frames compare equal.
Part B (real, ~3 min): a short research run under injected faults must still complete with findings.

Run: python step9_chaos_test.py
"""
import asyncio
import hashlib
import shutil
import struct
import zlib

from agent.actuator import retry
from agent.brain import Brain
from agent.chaos import ChaosBrain, ChaosDesktop, ChaosStats
from agent.config import RUNS_DIR
from agent.loop import ResearchAgent, RunConfig
from agent.memory import Memory
from agent.perception import Observation, capture
from agent.session import desktop_session, log

OUT = RUNS_DIR / "step9"


def _png(w: int, h: int) -> bytes:
    """Minimal valid PNG of the requested size (for capture() unit test)."""
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x00" * (w * 3) for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class FlakyDesktop:
    """Fails the first N screenshot calls, then returns a PNG of the given size."""
    def __init__(self, fail_first: int, size: tuple[int, int]) -> None:
        self.fail_first, self.size, self.calls = fail_first, size, 0

    async def screenshot(self, format: str = "png") -> bytes:  # noqa: A002 - mirrors SDK signature
        self.calls += 1
        if self.calls <= self.fail_first:
            raise ConnectionError("flaky")
        return _png(*self.size)


async def part_a() -> None:
    # retry(): two failures then success -> returns; three failures -> raises RuntimeError
    n = {"i": 0}
    async def flaky2() -> str:
        n["i"] += 1
        if n["i"] < 3:
            raise ConnectionError("x")
        return "ok"
    assert await retry(flaky2, base_delay=0.01, what="t") == "ok"
    async def always() -> None:
        raise ConnectionError("x")
    try:
        await retry(always, base_delay=0.01, what="t")
        raise AssertionError("retry should have raised")
    except RuntimeError:
        pass

    # capture(): absorbs 2 transient failures; rejects wrong dimensions loudly
    obs = await capture(FlakyDesktop(2, (64, 32)), 64, 32)
    assert (obs.width, obs.height) == (64, 32)
    try:
        await capture(FlakyDesktop(0, (60, 32)), 64, 32, retries=1)
        raise AssertionError("wrong size must raise")
    except RuntimeError:
        pass

    # stale detection: identical bytes -> identical digest -> same_as() True
    png = _png(8, 8)
    a = Observation(png, 8, 8, 0.0, hashlib.sha1(png).hexdigest())
    b = Observation(png, 8, 8, 1.0, hashlib.sha1(png).hexdigest())
    assert a.same_as(b)
    print("PART A OK: retry backoff, capture retries + size check, stale-frame equality")


async def part_b() -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    stats = ChaosStats()
    brain = ChaosBrain(ratelimit_every=6, stats=stats)
    mem = Memory.load_or_new(OUT, "Pinetree Research")
    cfg = RunConfig(target="Pinetree Research", homepage="https://pinetree-research.com", max_actions=45, max_tasks=2)
    async with desktop_session(timeout_ms=15 * 60_000) as real:
        chaos = ChaosDesktop(real, p_fail=0.15, stale_every=7, seed=42)
        chaos.stats = stats
        agent = ResearchAgent(chaos, brain, mem, cfg, out_dir=OUT)
        await agent.run()
    print(f"\n{stats}")
    print(f"recovered: actuator retries visible above; model API retries={brain.retries}")
    ok = bool(mem.findings) and (stats.transport + stats.stale + stats.ratelimit) > 0
    print("STEP 9 COMPLETE" if ok else "FAIL: run did not survive injected faults (or nothing was injected)")


if __name__ == "__main__":
    asyncio.run(part_a())
    asyncio.run(part_b())