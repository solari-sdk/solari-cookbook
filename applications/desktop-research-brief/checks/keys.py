"""Keyboard/clipboard diagnostic: which chord encoding does the guest honour?

For each variant: type 'abc', send select-all via that encoding, type a marker, press Return.
If the chord worked, the line contains only the marker. If not, 'abc' (plus stray letters) survives.
One brain.read() call transcribes the editor. Run: python step4b_keys_test.py
"""
import asyncio

from agent.actuator import Actuator
from agent.brain import Brain
from agent.config import RUNS_DIR, SCREEN_H, SCREEN_W
from agent.session import desktop_session, log

OUT = RUNS_DIR / "step4b"


async def main() -> None:
    brain = Brain()
    async with desktop_session(timeout_ms=5 * 60_000) as desktop:
        act = Actuator(desktop, SCREEN_W, SCREEN_H, out_dir=OUT)
        kb = desktop.keyboard

        await desktop.open("mousepad")
        await asyncio.sleep(4)
        await act.click(319, 320)  # text area position observed in step 3
        await asyncio.sleep(0.5)

        # Variant A: hotkey("ctrl","a")  -> keys ["ctrl","a"]
        await kb.type("abc"); await kb.hotkey("ctrl", "a"); await asyncio.sleep(0.3); await kb.type("A_HOTKEY"); await kb.press("Return")
        # Variant B: press("ctrl+a")     -> keys ["ctrl+a"] as one xdotool-style token
        await kb.type("abc"); await kb.press("ctrl+a"); await asyncio.sleep(0.3); await kb.type("B_PLUS"); await kb.press("Return")
        # Variant C: explicit down/up modifier
        await kb.type("abc"); await kb.down("ctrl"); await kb.press("a"); await kb.up("ctrl"); await asyncio.sleep(0.3); await kb.type("C_DOWNUP"); await kb.press("Return")
        # Variant D: X11 keysym names
        await kb.type("abc"); await kb.press("Control_L+a"); await asyncio.sleep(0.3); await kb.type("D_KEYSYM"); await kb.press("Return")

        obs = await act.observe(settle_s=1.0)
        text = await brain.read(obs, "Transcribe EXACTLY the text visible in the editor's document area, line by line, preserving order. Output only the text.")
        log("editor contents:\n" + text)

        # Clipboard plumbing, independent of keys
        try:
            await desktop.clipboard.set("clip_ok_77")
            await asyncio.sleep(0.3)
            got = await desktop.clipboard.get()
            log(f"clipboard set/get -> {got!r}")
        except Exception as e:  # noqa: BLE001
            log(f"clipboard set/get FAILED: {type(e).__name__}: {e}")

        print("STEP 4B DONE - send the 'editor contents' block and the clipboard line")


if __name__ == "__main__":
    asyncio.run(main())