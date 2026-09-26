// SPDX-License-Identifier: AGPL-3.0-only
// The drawer's viewport asks the host for the person's Ghostty config as it
// opens and hands the surface what the file says: the theme's colors under the
// app's, the font and its fallbacks unless the viewer typed one, the cursor,
// the padding and the opacity; a translucent file marks the mount and drops
// its background, so the desktop window's material can show through the canvas
// alone; no host, or a host that cannot answer, leaves the defaults.
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalConfig } from "@wsp/protocol";
import { TerminalViewport } from "../src/components/ThreadTerminalDrawer.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { appTerminalFontSize, GhosttyTerminalSurface } from "../src/terminal/ghostty/surface.js";
import type { TerminalIo } from "../src/terminal/pty-io.js";

vi.setConfig({ testTimeout: 20_000 });

const red = { r: 243, g: 139, b: 168 };
const FILE: TerminalConfig = {
  files: ["/Users/dev/.config/ghostty/config"],
  fontFamily: ["Berkeley Mono", "Symbols Nerd Font Mono"],
  fontSize: 13,
  background: { r: 30, g: 30, b: 46 },
  palette: [null, red, ...Array<null>(14).fill(null)],
  cursorStyle: "underline",
  windowPaddingX: { left: 2, right: 4 },
  backgroundOpacity: 0.85,
};

afterEach(() => {
  vi.restoreAllMocks();
  useStore.setState({ api: null, conn: "connecting" });
  document.documentElement.classList.remove("dark");
  document.body.innerHTML = "";
});

async function open(read: Api["hostTerminalConfig"] | undefined, config: Parameters<typeof TerminalViewport>[0]["config"] = {}) {
  const create = vi.spyOn(GhosttyTerminalSurface, "create");
  useStore.setState({ api: (read === undefined ? {} : { hostTerminalConfig: read }) as unknown as Api });
  const io: TerminalIo = { attach: () => () => {}, write: () => {}, resize: () => {} };
  const view = (next: Parameters<typeof TerminalViewport>[0]["config"]) => (
    <TerminalViewport terminalId="pty1" io={io} config={next} focusRequestId={0} autoFocus={false} resizeEpoch={0} drawerHeight={300} />
  );
  const { rerender } = render(view(config));
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  const surface = await create.mock.results[0]!.value;
  const mount = document.querySelector<HTMLElement>("[data-terminal-viewport]")!;
  return { options: create.mock.calls[0]![1], surface, mount, create, setConfig: (next: Parameters<typeof TerminalViewport>[0]["config"]) => rerender(view(next)) };
}

describe("the viewport with the person's Ghostty config", () => {
  it("asks the host with the app's scheme and opens the surface on the file's theme, font, cursor, padding and opacity, marking the mount translucent", async () => {
    document.documentElement.classList.add("dark");
    const asked: string[] = [];
    const { options, mount } = await open(async scheme => {
      asked.push(scheme);
      return FILE;
    });
    expect(asked).toEqual(["dark"]);
    expect(options.theme).toMatchObject({ background: { r: 30, g: 30, b: 46 }, palette: FILE.palette });
    expect(options.font).toEqual({ family: "Berkeley Mono", fallbacks: ["Symbols Nerd Font Mono"], size: appTerminalFontSize() });
    expect(options.cursor).toEqual({ style: "underline" });
    expect(options.padding).toEqual({ left: 2, right: 4, top: 4, bottom: 4 });
    expect(options.backgroundOpacity).toBe(0.85);
    await vi.waitFor(() => expect(mount.hasAttribute("data-terminal-translucent")).toBe(true));
    expect(mount.className).not.toContain("bg-[var(--terminal-background)]");
  });

  it("a file naming a size draws at the app's own text size while the preference says the app's; with the file as the source the pane takes the file's, and the flip reaches the surface without a remount", async () => {
    const { options, surface, create, setConfig } = await open(async () => ({ ...FILE, fontFamily: [], fontSize: 16 }));
    expect(options.font).toEqual({ size: appTerminalFontSize() });
    expect(surface.textSize).toBe(appTerminalFontSize());
    const setFont = vi.spyOn(surface, "setFont");
    setConfig({ sizing: { source: "file", zoom: 0 } });
    await vi.waitFor(() => expect(setFont).toHaveBeenCalledWith({ size: 16 }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("the workspace's zoom opens the surface over the base, and a step of it reaches the surface without a remount", async () => {
    const { options, surface, create, setConfig } = await open(async () => ({ ...FILE, fontFamily: [], fontSize: 16 }), { sizing: { source: "app", zoom: -2 } });
    expect(options.font).toEqual({ size: appTerminalFontSize() - 2 });
    const setFont = vi.spyOn(surface, "setFont");
    setConfig({ sizing: { source: "app", zoom: -1 } });
    await vi.waitFor(() => expect(setFont).toHaveBeenCalledWith({ size: appTerminalFontSize() - 1 }));
    setConfig({ sizing: { source: "file", zoom: -1 } });
    await vi.waitFor(() => expect(setFont).toHaveBeenCalledWith({ size: 15 }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a family the viewer typed beats the file's; an opaque file leaves the mount painting its background", async () => {
    const { options, mount } = await open(async () => ({ ...FILE, backgroundOpacity: 1 }), { font: { family: "Hack" }, chosenFont: true });
    expect(options.font).toEqual({ family: "Hack", size: appTerminalFontSize() });
    expect(mount.hasAttribute("data-terminal-translucent")).toBe(false);
    expect(mount.className).toContain("bg-[var(--terminal-background)]");
  });

  it("a flip of the app's scheme asks the host again with the new scheme and applies that side's colors; another change to the html element keeps the file already read", async () => {
    const asked: string[] = [];
    const sides: Record<string, TerminalConfig> = { light: { ...FILE, background: { r: 250, g: 250, b: 250 } }, dark: FILE };
    const { surface } = await open(async scheme => {
      asked.push(scheme);
      return sides[scheme]!;
    });
    const setTheme = vi.spyOn(surface, "setTheme");
    expect(asked).toEqual(["light"]);
    document.documentElement.classList.add("dark");
    await vi.waitFor(() => expect(asked).toEqual(["light", "dark"]));
    await vi.waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({ background: { r: 30, g: 30, b: 46 }, palette: FILE.palette })));
    document.documentElement.setAttribute("style", "--x: 1");
    await vi.waitFor(() => expect(setTheme.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(asked).toEqual(["light", "dark"]);
    expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({ background: { r: 30, g: 30, b: 46 } }));
    // A host that stops answering on a flip leaves the app's colors, not the other side's.
    document.documentElement.classList.remove("dark");
    await vi.waitFor(() => expect(asked).toEqual(["light", "dark", "light"]));
    await vi.waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({ background: { r: 250, g: 250, b: 250 } })));
  });

  it("a pane mounted while the socket is down draws the defaults and says so once; when the socket comes up it takes the file's colours, padding and opacity without a remount, and keeps the app's own text size", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let up = false;
    const read = async (): Promise<TerminalConfig> => {
      if (!up) throw new Error("lost");
      return { ...FILE, fontFamily: [], fontSize: 16 };
    };
    useStore.setState({ conn: "connecting" });
    const { options, surface, mount, create } = await open(read);
    expect(options.font).toEqual({ size: appTerminalFontSize() });
    expect(options.theme.palette).toBeUndefined();
    expect(options.backgroundOpacity).toBe(1);
    expect(mount.hasAttribute("data-terminal-translucent")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("lost");
    const setFont = vi.spyOn(surface, "setFont");
    const setTheme = vi.spyOn(surface, "setTheme");
    const setPadding = vi.spyOn(surface, "setPadding");
    const setOpacity = vi.spyOn(surface, "setBackgroundOpacity");
    up = true;
    useStore.setState({ conn: "live" });
    await vi.waitFor(() => expect(setFont).toHaveBeenCalledWith({ size: appTerminalFontSize() }));
    expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({ background: { r: 30, g: 30, b: 46 }, palette: FILE.palette }));
    expect(setPadding).toHaveBeenCalledWith({ left: 2, right: 4, top: 4, bottom: 4 });
    expect(setOpacity).toHaveBeenCalledWith(0.85);
    expect(surface.textSize).toBe(appTerminalFontSize());
    expect(surface.translucent).toBe(true);
    await vi.waitFor(() => expect(mount.hasAttribute("data-terminal-translucent")).toBe(true));
    expect(mount.className).not.toContain("bg-[var(--terminal-background)]");
    expect(create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no host, or a host that fails to answer, opens the surface on the defaults", async () => {
    const none = await open(undefined, { font: { family: "Hack" } });
    expect(none.options.font).toEqual({ family: "Hack", size: appTerminalFontSize() });
    expect(none.options.backgroundOpacity).toBe(1);
    expect(none.options.padding).toEqual({ left: 4, right: 4, top: 4, bottom: 4 });
    document.body.innerHTML = "";
    const failed = await open(async () => {
      throw new Error("host gone");
    });
    expect(failed.options.backgroundOpacity).toBe(1);
    expect(failed.options.theme.palette).toBeUndefined();
  });
});
