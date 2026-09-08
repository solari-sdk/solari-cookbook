"""Treat worker completion as a proposal; promote only an audited snapshot."""

import asyncio
import hashlib
import os
import sqlite3
import time
from contextlib import AsyncExitStack, asynccontextmanager, closing
from pathlib import Path

from solari_core import TemplateClient
from solari_sandbox import SandboxClient

DB = "/tmp/transfer.db"
SEED = """
CREATE TABLE accounts (name TEXT PRIMARY KEY, cents INTEGER NOT NULL);
INSERT INTO accounts VALUES ('buyer', 10000), ('seller', 0);
"""


@asynccontextmanager
async def machine(client, **source):
    vm = await client.create(**source, timeout_ms=60_000)
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(client.kill, vm.sandboxId)
        # Close the control socket while the VM is still alive, then kill it.
        cleanup.push_async_callback(vm.close)
        await vm.connect()
        yield vm


async def execute(vm, source):
    result = await vm.commands.run("python3", args=["-c", source])
    if result.exitCode != 0:
        raise RuntimeError("Remote Python command failed")


def audit(data):
    # SQL runs on the host, outside the candidate VM. No worker verdict is used.
    # These are synthetic, fallible-worker inputs, not hostile SQLite files.
    with closing(sqlite3.connect(":memory:")) as db:
        db.deserialize(data)
        db.execute("PRAGMA query_only=ON")
        rows = db.execute("SELECT name, cents FROM accounts ORDER BY name").fetchall()
    return rows == [("buyer", 7500), ("seller", 2500)]


async def main():
    started = time.monotonic()
    print("source SHA-256:", hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    config = dict(
        api_key=os.environ["SOLARI_API_KEY"], base_url="https://api.getsolari.com"
    )
    async with SandboxClient(**config) as client, AsyncExitStack() as cleanup:
        templates = TemplateClient(**config)
        cleanup.push_async_callback(templates.aclose)
        for complete in (False, True):
            label = "complete transfer" if complete else "half transfer"
            async with AsyncExitStack() as case_cleanup:
                async with machine(client, template="base") as worker:
                    # Deterministic stand-in for an agent's multi-step work:
                    # the faulty path commits the debit, omits the credit, and
                    # still says done. No LLM or real payment is involved.
                    credit = (
                        "c.execute(\"UPDATE accounts SET cents=2500 WHERE name='seller'\")"
                        if complete
                        else "pass"
                    )
                    await execute(
                        worker,
                        f"import sqlite3\nc=sqlite3.connect({DB!r})\n"
                        f"c.executescript({SEED!r})\n"
                        "c.execute(\"UPDATE accounts SET cents=7500 WHERE name='buyer'\")\n"
                        f"c.commit()\n{credit}\nc.commit()\nc.close()\nprint('done')",
                    )
                    candidate = await worker.snapshot("audit-promote-candidate")
                    case_cleanup.push_async_callback(client.delete_snapshot, candidate)
                    # Deliberately change the live worker after freezing it.
                    # Auditing or promoting this live state would be wrong.
                    await execute(
                        worker,
                        f"import sqlite3\nc=sqlite3.connect({DB!r})\n"
                        "c.execute('UPDATE accounts SET cents=0')\nc.commit()\nc.close()",
                    )

                # Restore the exact candidate, copy its closed database, and
                # inspect it on the host. The worker and its 'done' are gone.
                async with machine(client, from_snapshot=candidate) as reader:
                    frozen_bytes = await reader.files.read(DB)
                accepted = audit(frozen_bytes)
                print(f"{label}: worker=done audit={'PASS' if accepted else 'REJECT'}")
                if accepted != complete:
                    raise RuntimeError("Unexpected audit decision")
                if not accepted:
                    continue  # No promotion call exists on the rejection path.

                template = await client.promote_snapshot(candidate, "audited-transfer")
                template_id = template["templateId"]
                case_cleanup.push_async_callback(templates.delete, template_id)
                print("promoted audited snapshot:", candidate)
                async with machine(client, template=template_id) as restored:
                    restored_bytes = await restored.files.read(DB)
                    if restored_bytes != frozen_bytes or not audit(restored_bytes):
                        raise RuntimeError(
                            "Promoted template did not preserve audited database"
                        )
                print("template boot: same database bytes, audit=PASS")
    print(
        f"PASS; VMs, snapshots, and template deleted ({time.monotonic() - started:.1f}s)"
    )


if __name__ == "__main__":
    asyncio.run(main())
