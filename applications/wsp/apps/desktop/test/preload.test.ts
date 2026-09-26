// SPDX-License-Identifier: AGPL-3.0-only
// The bridge the preload hands the page, and the channel each of its calls
// rides. The page reads this contract through @wsp/protocol's DesktopBridge,
// so a name that drifts here is a switcher card with no picture on it.
import type { DesktopBridge } from "@wsp/protocol";
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
const send = vi.fn();
const sendSync = vi.fn(() => false);
const on = vi.fn();
const off = vi.fn();
const exposeInMainWorld = vi.fn();
const DROPPED = "/Users/me/Projects/spoo";
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke, send, sendSync, on, off }, webUtils: { getPathForFile: () => DROPPED } }));

// The preload reads the renderer's argv as its module body runs, which is the first import below.
process.argv.push("--wsp-version=0.1.7", "--wsp-bundle-hover=Downloads the AppImage.");

async function bridge(): Promise<DesktopBridge> {
  await import("../src/preload.js");
  expect(exposeInMainWorld).toHaveBeenCalledOnce();
  const [name, exposed] = exposeInMainWorld.mock.calls[0]!;
  expect(name).toBe("wsp");
  return exposed as DesktopBridge;
}

describe("the preload's bridge", () => {
  it("carries the release this shell is, so a page from a host of another one can say which half is behind", async () => {
    expect((await bridge()).version).toBe("0.1.7");
  });

  it("carries the words over Get that the shell's platform row gives", async () => {
    expect((await bridge()).bundleHover).toBe("Downloads the AppImage.");
  });

  it("carries the picture calls the switcher's cards need, each on its own channel", async () => {
    const wsp = await bridge();
    await wsp.capturePreview("ws_a");
    expect(invoke).toHaveBeenLastCalledWith("preview:capture", "ws_a");
    await wsp.workspacePreview("ws_b");
    expect(invoke).toHaveBeenLastCalledWith("preview:read", "ws_b");
    await wsp.localFonts("Berkeley Mono");
    expect(invoke).toHaveBeenLastCalledWith("fonts:local", "Berkeley Mono");
    await wsp.pickFolder();
    expect(invoke).toHaveBeenLastCalledWith("folder:pick");
  });

  it("carries the first launch's calls, each on its own channel", async () => {
    const wsp = (await bridge()) as DesktopBridge & { agents(): Promise<unknown>; install(ids: string[]): Promise<unknown>; finish(): Promise<void> };
    await wsp.agents();
    expect(invoke).toHaveBeenLastCalledWith("onboarding:agents");
    await wsp.install(["claude", "codex"]);
    expect(invoke).toHaveBeenLastCalledWith("onboarding:install", ["claude", "codex"]);
    await wsp.finish();
    expect(invoke).toHaveBeenLastCalledWith("onboarding:finish");
  });

  it("asks the shell before it hands over the path of a dropped file, and answers nothing when that is refused", async () => {
    const wsp = await bridge();
    const dropped = {} as File;
    sendSync.mockReturnValueOnce(true);
    expect(wsp.droppedPath(dropped)).toBe(DROPPED);
    expect(sendSync).toHaveBeenLastCalledWith("drop:allowed");
    sendSync.mockReturnValueOnce(false);
    expect(wsp.droppedPath(dropped)).toBeUndefined();
  });

  it("says when a terminal has focus and hands back the chords the shell stood aside from, unsubscribing with the same listener", async () => {
    const wsp = await bridge();
    wsp.setTerminalFocus(true);
    expect(send).toHaveBeenLastCalledWith("terminal:focus", true);
    wsp.setTheme("light");
    expect(send).toHaveBeenLastCalledWith("theme:set", "light");
    const chords: unknown[] = [];
    const stop = wsp.onShellChord(chord => chords.push(chord));
    expect(on).toHaveBeenLastCalledWith("shell:chord", expect.any(Function));
    const listen = on.mock.calls.at(-1)![1] as (event: unknown, chord: unknown) => void;
    listen(null, { key: "=", code: "Equal", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    expect(chords).toEqual([{ key: "=", code: "Equal", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }]);
    stop();
    expect(off).toHaveBeenLastCalledWith("shell:chord", listen);
  });

  it("hands over a build that needs the person and takes the click back, unsubscribing with the same listener", async () => {
    const wsp = await bridge();
    wsp.needsYou({ what: "sign in to GitHub CLI login", since: 1_760_000_000_000 });
    expect(send).toHaveBeenLastCalledWith("needs-you:say", { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 });
    let opened = 0;
    const stop = wsp.onNeedsYouOpen(() => (opened += 1));
    expect(on).toHaveBeenLastCalledWith("needs-you:open", expect.any(Function));
    const listen = on.mock.calls.at(-1)![1] as (event: unknown) => void;
    listen(null);
    expect(opened).toBe(1);
    stop();
    expect(off).toHaveBeenLastCalledWith("needs-you:open", listen);
  });
});

describe("the hosts the window can move between", () => {
  it("carries the token, the list and the switch on their own channels", async () => {
    const wsp = await bridge();
    await wsp.hostToken();
    expect(invoke).toHaveBeenLastCalledWith("hosts:token");
    await wsp.hosts();
    expect(invoke).toHaveBeenLastCalledWith("hosts:list");
    await wsp.switchHost("box");
    expect(invoke).toHaveBeenLastCalledWith("hosts:switch", "box");
  });
});
