"""Find and kill the sandboxes your run lost track of, and nothing else.

Tag every sandbox with a run id when you create it. After a crash, list by that
tag and kill what matches. Pattern from MisterWanted's orphan recovery in PR #16.
"""

import asyncio
import os
import time
import uuid

from solari_sandbox import SandboxClient

TAG = "cookbook-run"
ALIVE = ("starting", "running", "paused")


def short(sandbox_id):
    return sandbox_id[:10] + "…"  # ids are long opaque tokens


async def wait_for(check, what, timeout_s=120):
    start = time.monotonic()
    while not await check():
        assert time.monotonic() - start < timeout_s, f"timed out waiting for {what}"
        await asyncio.sleep(0.5)
    return time.monotonic() - start


async def main() -> None:
    run_id, other_run = uuid.uuid4().hex[:12], uuid.uuid4().hex[:12]
    created = []  # used only by the finally block; the cleanup must not need it
    async with SandboxClient(
        api_key=os.environ["SOLARI_API_KEY"], base_url="https://api.getsolari.com"
    ) as client:

        async def new(run):
            # Metadata is set at create (no SDK call adds it later), so tag every create.
            box = await client.create(template="base", timeout_ms=300_000, metadata={TAG: run})
            created.append(box.sandboxId)
            return box

        async def tagged(run):
            return [s async for s in client.list_all(metadata={TAG: run})]

        control = None
        try:
            worker = await new(run_id)
            await worker.kill()  # the normal case: we still had its handle
            orphan = await new(run_id)
            orphan_id = orphan.sandboxId
            # The crash: the handle is gone and nothing kills the VM. Issue #81 is a real
            # case of this: a create that raises after its POST leaves a billing VM behind.
            del orphan
            # Positive control: another run's sandbox, which the cleanup must not touch.
            control = await new(other_run)

            # Do not assume the list is instant: measure how long a new sandbox takes to appear.
            async def listed():
                return orphan_id in {s.sandboxId for s in await tagged(run_id)}

            seen = await wait_for(listed, "the orphan to be listed")
            print(f"orphan {short(orphan_id)} listed under its run id after {seen:.1f} s")

            # The cleanup, knowing only the run id.
            matches = await tagged(run_id)
            assert all(s.metadata.get(TAG) == run_id for s in matches)
            assert control.sandboxId not in {s.sandboxId for s in matches}
            for s in matches:
                if s.state in ALIVE:
                    await client.kill(s.sandboxId)
                verb = "killed" if s.state in ALIVE else "skipped"
                print(f"{verb} {short(s.sandboxId)} ({s.state})")

            # Negative case: nothing alive is left under this run id.
            async def none_alive():
                return not [s for s in await tagged(run_id) if s.state in ALIVE]

            gone = await wait_for(none_alive, "the run's sandboxes to stop")
            left = sorted({s.state for s in await tagged(run_id)})
            print(f"run {run_id}: 0 alive after {gone:.1f} s (still listed as: {left or 'none'})")

            others = {s.sandboxId: s.state for s in await tagged(other_run)}
            assert others.get(control.sandboxId) in ALIVE, others
            print(f"control {short(control.sandboxId)} untouched: {others[control.sandboxId]}")
        finally:
            if control is not None:
                await control.kill()  # kill() ends the VM; close() only drops the channel
            for sandbox_id in created:
                await client.kill(sandbox_id)  # idempotent DELETE, in case anything failed
    print("Control killed; every sandbox this script created is gone.")


if __name__ == "__main__":
    asyncio.run(main())
