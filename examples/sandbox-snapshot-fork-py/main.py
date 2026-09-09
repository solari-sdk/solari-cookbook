"""Seed once, fork a snapshot, and verify each clone restored the exact bytes.

Extracted from Worldline by YesterdaysLemon (applications/worldline).
"""

import asyncio
import hashlib
import os
from contextlib import AsyncExitStack

from solari_sandbox import SandboxClient

PATH = "/tmp/snapshot-seed.txt"
SEED = "One checkpoint. Independent futures.\n"


async def main() -> None:
    async with (
        SandboxClient(
            api_key=os.environ["SOLARI_API_KEY"], base_url="https://api.getsolari.com"
        ) as client,
        AsyncExitStack() as cleanup,
    ):
        base = await client.create(template="base", timeout_ms=300_000)
        # Register deletion immediately, including if connect/seed/snapshot fails.
        async with AsyncExitStack() as base_cleanup:
            base_cleanup.push_async_callback(base.close)
            base_cleanup.push_async_callback(client.kill, base.sandboxId)
            await base.connect()
            await base.files.write(PATH, SEED)
            expected = hashlib.sha256(SEED.encode()).hexdigest()
            assert hashlib.sha256(await base.files.read(PATH)).hexdigest() == expected
            snapshot = await base.snapshot("snapshot-fork-demo")
            cleanup.push_async_callback(client.delete_snapshot, snapshot)
        # The base is gone. Sequential clones also fit a one-VM concurrency limit.
        for number in range(1, 4):
            clone = await client.create(
                template="base", from_snapshot=snapshot, timeout_ms=300_000
            )
            async with AsyncExitStack() as worker_cleanup:
                worker_cleanup.push_async_callback(clone.close)
                worker_cleanup.push_async_callback(client.kill, clone.sandboxId)
                await clone.connect()
                digest = hashlib.sha256(await clone.files.read(PATH)).hexdigest()
                assert digest == expected, f"clone {number} did not restore the seed"
                print(f"clone {number}: restored SHA-256 {digest}")
                # A later clone must restore the seed, not this worker's edit.
                await clone.files.write(PATH, f"changed by clone {number}\n")
    print("All clones verified; base, clones, and snapshot deleted.")


if __name__ == "__main__":
    asyncio.run(main())
