// SPDX-License-Identifier: AGPL-3.0-only
// The copied libghostty surface running for real under jsdom: the vendored
// wasm parses the bytes we write, keystrokes on its hidden input come out of
// onData as bytes, and a sized mount reports its grid through onResize.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhosttyTerminalCore } from "../src/terminal/ghostty/core.js";
import { GhosttyTerminalSurface } from "../src/terminal/ghostty/surface.js";

const THEME = {
  background: { r: 14, g: 18, b: 24 },
  foreground: { r: 237, g: 241, b: 247 },
  cursor: { r: 180, g: 203, b: 255 },
  selectionBackground: "rgba(180, 203, 255, 0.25)",
};

const surfaces: GhosttyTerminalSurface[] = [];

function mount(width = 800, height = 400): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: width });
  Object.defineProperty(el, "clientHeight", { value: height });
  document.body.appendChild(el);
  return el;
}

async function create(el: HTMLElement, extra: Partial<Parameters<typeof GhosttyTerminalSurface.create>[1]> = {}) {
  const data: string[] = [];
  const resizes: [number, number][] = [];
  const surface = await GhosttyTerminalSurface.create(el, {
    theme: THEME,
    onData: d => data.push(d),
    onResize: (cols, rows) => resizes.push([cols, rows]),
    onSelectionChange: () => {},
    beforeKey: () => true,
    onLinkActivate: () => {},
    ...extra,
  });
  surfaces.push(surface);
  return { surface, data, resizes };
}

afterEach(() => {
  for (const s of surfaces.splice(0)) s.dispose();
  document.body.innerHTML = "";
});

describe("GhosttyTerminalSurface under jsdom", () => {
  it("parses written bytes: a cursor report after three cells answers column 4", async () => {
    const { surface, data } = await create(mount());
    surface.write("abc\x1b[6n");
    await vi.waitFor(() => expect(data.join("")).toContain("\x1b[1;4R"));
  }, 20_000);

  it("a keydown on the hidden input reaches onData as bytes", async () => {
    const { surface, data } = await create(mount());
    surface.input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(data).toEqual(["a"]));
  }, 20_000);

  it("fit sizes the grid from the mount and reports it once through onResize", async () => {
    const { surface, resizes } = await create(mount(800, 400));
    await vi.waitFor(() => expect(resizes).toHaveLength(1), { timeout: 2_000 });
    const [cols, rows] = resizes[0]!;
    expect(cols).toBeGreaterThan(40);
    expect(rows).toBeGreaterThan(10);
    expect([surface.cols, surface.rows]).toEqual([cols, rows]);
  }, 20_000);
});

describe("a Ghostty config's keys on the surface under jsdom", () => {
  it("the file's padding sizes the grid: ten a side leaves fewer columns than the default four, and the surface says it is translucent", async () => {
    const plain = await create(mount(800, 400));
    const padded = await create(mount(800, 400), { padding: { left: 10, right: 10, top: 2, bottom: 2 }, backgroundOpacity: 0.85 });
    await vi.waitFor(() => expect(padded.resizes).toHaveLength(1), { timeout: 2_000 });
    await vi.waitFor(() => expect(plain.resizes).toHaveLength(1), { timeout: 2_000 });
    // The stubbed canvas measures every cell 8 wide: (800 - 20) / 8 against (800 - 8) / 8.
    expect(padded.surface.cols).toBe(97);
    expect(plain.surface.cols).toBe(99);
    expect(padded.surface.translucent).toBe(true);
    expect(plain.surface.translucent).toBe(false);
  }, 20_000);
});

describe("a Ghostty config's keys in libghostty", () => {
  const cores: GhosttyTerminalCore[] = [];
  afterEach(() => {
    for (const c of cores.splice(0)) c.dispose();
  });
  const red = { r: 243, g: 139, b: 168 };

  it("the theme's palette colors what a program paints with SGR 31, and the default palette stands where the theme set nothing", async () => {
    const palette = Array<typeof red | null>(16).fill(null);
    palette[1] = red;
    const core = await GhosttyTerminalCore.create(20, 2, 8, 16, { ...THEME, palette }, () => {});
    cores.push(core);
    const stock = await GhosttyTerminalCore.create(20, 2, 8, 16, THEME, () => {});
    cores.push(stock);
    for (const c of [core, stock]) c.write("\x1b[31mA\x1b[32mB");
    const [a, b] = core.snapshot().rowData[0]!.cells;
    const [stockA, stockB] = stock.snapshot().rowData[0]!.cells;
    expect(a!.foreground).toEqual(red);
    expect(stockA!.foreground).not.toEqual(red);
    // Slot two keeps libghostty's own green.
    expect(b!.foreground).toEqual(stockB!.foreground);
    expect(b!.foreground).not.toEqual(red);
  }, 20_000);

  it("cursor-style and cursor-style-blink are the defaults a session starts in and returns to on DECSCUSR reset", async () => {
    const core = await GhosttyTerminalCore.create(20, 2, 8, 16, THEME, () => {}, { style: "underline", blink: false });
    cores.push(core);
    expect(core.snapshot()).toMatchObject({ cursorStyle: 2, cursorBlinking: false });
    core.write("\x1b[6 q");
    expect(core.snapshot()).toMatchObject({ cursorStyle: 0, cursorBlinking: false });
    core.write("\x1b[0 q");
    expect(core.snapshot()).toMatchObject({ cursorStyle: 2, cursorBlinking: false });
    core.resetAndWrite("");
    expect(core.snapshot()).toMatchObject({ cursorStyle: 2, cursorBlinking: false });
  }, 20_000);
});
