// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { bundleHover } from "../src/get-bundle.js";
import { shellArgFrom } from "../src/shell-args.js";
import { windowOptions } from "../src/window.js";

const htmlClassFrom = (argv: readonly string[]): string | undefined => shellArgFrom(argv, "html-class");

describe("windowOptions", () => {
  it("on macOS hides the title bar, puts the lights in the header row, frosts the window behind a transparent page and names the page's class", () => {
    const options = windowOptions("darwin", "0.1.5", "/app/preload.cjs");
    expect(options).toMatchObject({
      width: 1280,
      height: 800,
      title: "wsp",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 19 },
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: "/app/preload.cjs", additionalArguments: ["--wsp-version=0.1.5", "--wsp-html-class=desktop-mac", `--wsp-bundle-hover=${bundleHover("darwin")}`] },
    });
    expect(htmlClassFrom(["/app/electron", ...options.webPreferences!.additionalArguments!, "--type=renderer"])).toBe("desktop-mac");
  });

  it("everywhere else keeps the stock frame over the opaque background and gives the page no class", () => {
    for (const platform of ["linux", "win32"] as const) {
      const options = windowOptions(platform, "0.1.5");
      expect(options).toMatchObject({ width: 1280, height: 800, title: "wsp", backgroundColor: "#09090b" });
      expect(options).not.toHaveProperty("titleBarStyle");
      expect(options).not.toHaveProperty("trafficLightPosition");
      expect(options).not.toHaveProperty("vibrancy");
      expect(options).not.toHaveProperty("visualEffectState");
      const hover = bundleHover(platform);
      expect(options.webPreferences).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true, additionalArguments: ["--wsp-version=0.1.5", ...(hover === undefined ? [] : [`--wsp-bundle-hover=${hover}`])] });
      expect(htmlClassFrom(["/app/electron", "--type=renderer"])).toBeUndefined();
    }
  });

  it("tells every platform's renderer which release this shell is, so the page can say when its host is another", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const args = windowOptions(platform, "0.1.3", "/app/preload.cjs").webPreferences!.additionalArguments!;
      expect(shellArgFrom(["/app/electron", ...args, "--type=renderer"], "version")).toBe("0.1.3");
    }
  });

  it("hands the renderer the words over Get from its platform's bundle row, and none where no bundle is built", () => {
    const hoverOn = (platform: NodeJS.Platform): string | undefined => shellArgFrom(windowOptions(platform, "0.1.5", "/app/preload.cjs").webPreferences!.additionalArguments!, "bundle-hover");
    expect(hoverOn("darwin")).toMatch(/disk image/);
    expect(hoverOn("linux")).toMatch(/AppImage/);
    expect(hoverOn("win32")).toBeUndefined();
  });

  it("enables no native tabs on any platform, so ctrl+tab and the digit chords reach the page", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(windowOptions(platform, "0.1.5")).not.toHaveProperty("tabbingIdentifier");
      expect(windowOptions(platform, "0.1.5", "/app/preload.cjs")).not.toHaveProperty("tabbingIdentifier");
    }
  });
});
