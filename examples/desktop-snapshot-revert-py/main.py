"""Revert a desktop and get back a running app with its unsaved text.

A sandbox snapshot restores files. A desktop snapshot also restores memory: here
an editor's unsaved buffer, whose process was killed after the snapshot.
"""

import asyncio
import os
import pathlib

from solari_sandbox import SandboxClient

LINE = "unsaved text that exists only in the editor's memory"


async def wait_ready(desktop) -> None:
    # After a revert the guest resumes from its memory image and the old control
    # socket is dead, even if the handle still says connected. It accepts a new
    # connection only once it is back, so keep redialling until health() answers.
    for _ in range(300):
        try:
            if not desktop.connected:
                await desktop.connect()
            if (await desktop.health()).ready:
                return
        except Exception:
            await desktop.close()
        await asyncio.sleep(1)
    raise TimeoutError("desktop never became ready")


async def editor_text(desktop) -> str:
    # Read the editor's buffer, not pixels: select all, copy, read the clipboard.
    # Clear the clipboard first so an old copy can't pass for the editor's text.
    await desktop.clipboard.set("")
    await desktop.mouse.click(320, 300)  # inside Mousepad's text area
    # A chord is one string. hotkey("ctrl", "a") typed a plain "a" (Sept 2026).
    await desktop.keyboard.press("ctrl+a")
    await desktop.keyboard.press("ctrl+c")
    await asyncio.sleep(1)
    return await desktop.clipboard.get()


async def is_running(desktop, pid: int) -> bool:
    # Match on the pid open() returned: process.list() gave empty names (Sept 2026).
    return pid in {p.pid for p in await desktop.process.list()}


async def main() -> None:
    # Snapshots and revert live on the unified /sandboxes route, so the desktop
    # comes from SandboxClient.create_desktop, not DesktopClient.create.
    async with SandboxClient(
        api_key=os.environ["SOLARI_API_KEY"], base_url="https://api.getsolari.com"
    ) as client:
        desktop = await client.create_desktop(
            template="default", resolution="1280x720", timeout_ms=10 * 60_000
        )
        snapshot = None
        try:
            await wait_ready(desktop)
            pid = await desktop.open("mousepad")
            await asyncio.sleep(4)
            await desktop.mouse.click(320, 300)
            await desktop.keyboard.type(LINE)

            # Positive control: the readback sees what we typed.
            assert await editor_text(desktop) == LINE, "readback failed before snapshot"
            assert await is_running(desktop, pid), "mousepad is not running"
            print(f"before snapshot: mousepad pid {pid}, buffer matches")

            snapshot = await desktop.snapshot("desktop-revert-demo")
            print("snapshot:", snapshot)

            # Negative case: kill the editor. The text was never saved, so it is gone.
            await desktop.process.kill(pid)
            await asyncio.sleep(2)
            assert not await is_running(desktop, pid), "editor still running"
            print("after kill: no mousepad process, unsaved text lost")

            # Revert needs a running machine: in September 2026 a paused sandbox got
            # 409 "revert needs a running sandbox". Restores then took either ~22 s or
            # 70-160 s, so wait_ready allows five minutes.
            loop = asyncio.get_running_loop()
            start = loop.time()
            await desktop.revert(snapshot)
            await desktop.close()
            await wait_ready(desktop)
            print(f"revert: healthy again after {loop.time() - start:.0f} s")

            assert await is_running(desktop, pid), "editor did not come back"
            text = await editor_text(desktop)
            assert text == LINE, f"buffer after revert: {text!r}"
            print(f"after revert: mousepad pid {pid} is back, buffer matches")
            shot = await desktop.screenshot(format="png")
            pathlib.Path("screenshot.png").write_bytes(shot)
        finally:
            # kill() destroys the VM; close() only drops the channel. The snapshot
            # outlives the VM and is billed as storage, so delete it too.
            await desktop.kill()
            if snapshot is not None:
                await client.delete_snapshot(snapshot)
    print("Desktop killed and snapshot deleted.")


if __name__ == "__main__":
    asyncio.run(main())
