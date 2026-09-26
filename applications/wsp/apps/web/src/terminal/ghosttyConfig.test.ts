// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { TerminalConfig } from "@wsp/protocol";
import { appScheme, terminalBaseSize, terminalSurfaceSettings } from "./ghosttyConfig";
import type { GhosttyTheme } from "./ghostty/core";
import { appTerminalFontSize } from "./ghostty/surface";

const APP: GhosttyTheme = {
  background: { r: 14, g: 18, b: 24 },
  foreground: { r: 237, g: 241, b: 247 },
  cursor: { r: 180, g: 203, b: 255 },
  selectionBackground: "rgba(180, 203, 255, 0.25)",
};
const NONE: TerminalConfig = { files: [], fontFamily: [], palette: Array<null>(16).fill(null) };
const red = { r: 243, g: 139, b: 168 };
const green = { r: 166, g: 227, b: 161 };
const FILE: TerminalConfig = {
  files: ["/Users/dev/.config/ghostty/config"],
  fontFamily: ["Berkeley Mono", "Symbols Nerd Font Mono"],
  fontSize: 13,
  background: { r: 30, g: 30, b: 46 },
  palette: [null, red, ...Array<null>(14).fill(null)],
  selectionBackground: { r: 88, g: 91, b: 112 },
  cursorColor: { r: 245, g: 224, b: 220 },
  cursorStyle: "underline",
  cursorStyleBlink: false,
  windowPaddingX: { left: 2, right: 4 },
  backgroundOpacity: 0.85,
  backgroundBlur: 20,
};

describe("terminalSurfaceSettings", () => {
  it("with no config, or none the host could answer, is the app's theme, the viewer's font and the defaults", () => {
    for (const file of [null, NONE]) {
      expect(terminalSurfaceSettings(file, APP, { family: "Hack" }, false)).toEqual({
        theme: APP,
        font: { family: "Hack", size: appTerminalFontSize() },
        padding: { left: 4, right: 4, top: 4, bottom: 4 },
        backgroundOpacity: 1,
      });
      expect(terminalSurfaceSettings(file, APP, undefined, false).font).toEqual({ size: appTerminalFontSize() });
    }
  });

  it("maps the file's keys onto the surface and leaves the app's value where the file set none", () => {
    expect(terminalSurfaceSettings(FILE, APP, { family: "Hack" }, false)).toEqual({
      theme: {
        background: { r: 30, g: 30, b: 46 },
        foreground: APP.foreground,
        cursor: { r: 245, g: 224, b: 220 },
        selectionBackground: "rgb(88, 91, 112)",
        palette: FILE.palette,
      },
      // The file's face and its fallbacks beat the detected family; its size is not read, so the pane keeps the app's.
      font: { family: "Berkeley Mono", fallbacks: ["Symbols Nerd Font Mono"], size: appTerminalFontSize() },
      cursor: { style: "underline", blink: false },
      padding: { left: 2, right: 4, top: 4, bottom: 4 },
      backgroundOpacity: 0.85,
    });
  });

  it("a family the viewer typed wins over the file's; a file naming no face leaves the detected one", () => {
    expect(terminalSurfaceSettings(FILE, APP, { family: "Hack" }, true).font).toEqual({ family: "Hack", size: appTerminalFontSize() });
    expect(terminalSurfaceSettings({ ...FILE, fontFamily: [] }, APP, { family: "Hack" }, false).font).toEqual({ family: "Hack", size: appTerminalFontSize() });
    expect(terminalSurfaceSettings({ ...FILE, fontFamily: [], fontSize: undefined }, APP, undefined, false).font).toEqual({ size: appTerminalFontSize() });
  });

  it("the size is the base the preference names plus the workspace's zoom: the app's own by default, the file's when asked, and the app's again for a file naming none", () => {
    const file = { ...FILE, fontSize: 16 };
    expect(terminalSurfaceSettings(file, APP, undefined, false).font).toEqual({ family: "Berkeley Mono", fallbacks: ["Symbols Nerd Font Mono"], size: appTerminalFontSize() });
    expect(terminalSurfaceSettings(file, APP, undefined, false, { source: "app", zoom: -2 }).font).toEqual({ family: "Berkeley Mono", fallbacks: ["Symbols Nerd Font Mono"], size: appTerminalFontSize() - 2 });
    expect(terminalSurfaceSettings(file, APP, undefined, false, { source: "file", zoom: 0 }).font.size).toBe(16);
    expect(terminalSurfaceSettings(file, APP, undefined, false, { source: "file", zoom: 3 }).font.size).toBe(19);
    expect(terminalSurfaceSettings({ ...FILE, fontSize: undefined }, APP, undefined, false, { source: "file", zoom: 1 }).font.size).toBe(appTerminalFontSize() + 1);
    expect(terminalSurfaceSettings(null, APP, undefined, false, { source: "file", zoom: 0 }).font).toEqual({ size: appTerminalFontSize() });
    expect(terminalBaseSize("file", file)).toBe(16);
    expect(terminalBaseSize("file", null)).toBe(appTerminalFontSize());
    // A zoom past what the surface draws stops at its edge.
    expect(terminalSurfaceSettings(file, APP, undefined, false, { source: "file", zoom: 40 }).font.size).toBe(32);
    expect(terminalSurfaceSettings(file, APP, undefined, false, { source: "app", zoom: -40 }).font.size).toBe(6);
    // The token the app ships is what the pane lands on, and it is the chat's size, not the meta one.
    expect(appTerminalFontSize()).toBe(14);
  });

  it("a palette the file left empty is not sent, and a blink the file did not set leaves libghostty's default", () => {
    const settings = terminalSurfaceSettings({ ...FILE, palette: NONE.palette, cursorStyleBlink: undefined }, APP, undefined, false);
    expect(settings.theme.palette).toBeUndefined();
    expect(settings.cursor).toEqual({ style: "underline" });
    expect(terminalSurfaceSettings({ ...FILE, cursorStyle: undefined, cursorStyleBlink: undefined }, APP, undefined, false).cursor).toBeUndefined();
  });

  it("the app's palette stands in every slot the file leaves alone, and the file's slot wins where it names one", () => {
    const themed: GhosttyTheme = { ...APP, palette: [...Array<null>(15).fill(null), green] };
    // A file naming nothing hands the pane the app's own slots, which is how a light pane gets a light palette.
    expect(terminalSurfaceSettings(NONE, themed, undefined, false).theme.palette).toEqual(themed.palette);
    expect(terminalSurfaceSettings(null, themed, undefined, false).theme.palette).toEqual(themed.palette);
    // Slot one is the file's, slot fifteen still the app's, and the fourteen neither names stay libghostty's.
    expect(terminalSurfaceSettings(FILE, themed, undefined, false).theme.palette).toEqual([null, red, ...Array<null>(13).fill(null), green]);
    // With no palette on either side nothing is sent, so libghostty keeps all sixteen.
    expect(terminalSurfaceSettings(NONE, APP, undefined, false).theme.palette).toBeUndefined();
  });

  it("the scheme is the html element's dark class", () => {
    document.documentElement.classList.remove("dark");
    expect(appScheme()).toBe("light");
    document.documentElement.classList.add("dark");
    expect(appScheme()).toBe("dark");
    document.documentElement.classList.remove("dark");
  });
});
