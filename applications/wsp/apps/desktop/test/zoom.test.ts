// SPDX-License-Identifier: AGPL-3.0-only
// The shell's own zoom chords. Its menu registers them, so the page never
// receives them; while a terminal holds focus they belong to the pane's text
// size, and the shell has to stand aside and hand the press back.
import { describe, expect, it } from "vitest";
import { isShellZoomChord, shellChordOf, type ShellKeyInput } from "../src/zoom.js";

const press = (key: string, over: Partial<ShellKeyInput> = {}): ShellKeyInput => ({
  type: "keyDown",
  key,
  code: key === "-" ? "Minus" : key === "0" ? "Digit0" : "Equal",
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...over,
});

describe("the shell's zoom chords", () => {
  it("are the mod chords the platform's menu zooms the window on", () => {
    for (const key of ["+", "=", "-", "0"]) {
      expect(isShellZoomChord(press(key, { meta: true }), "darwin")).toBe(true);
      expect(isShellZoomChord(press(key, { control: true }), "linux")).toBe(true);
    }
    expect(isShellZoomChord(press("+", { meta: true, shift: true }), "darwin")).toBe(true);
  });

  it("are not the other platform's mod, an unmodified key, an option chord or a key up", () => {
    expect(isShellZoomChord(press("=", { control: true }), "darwin")).toBe(false);
    expect(isShellZoomChord(press("=", { meta: true }), "linux")).toBe(false);
    expect(isShellZoomChord(press("="), "darwin")).toBe(false);
    expect(isShellZoomChord(press("=", { meta: true, alt: true }), "darwin")).toBe(false);
    expect(isShellZoomChord({ ...press("=", { meta: true }), type: "keyUp" }, "darwin")).toBe(false);
    expect(isShellZoomChord(press("j", { meta: true }), "darwin")).toBe(false);
  });

  it("go back to the page in the spelling its keybindings read", () => {
    expect(shellChordOf(press("+", { meta: true, shift: true }))).toEqual({
      key: "+",
      code: "Equal",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    });
  });
});
