// SPDX-License-Identifier: AGPL-3.0-only
// What a keystroke on the terminal becomes, measured against the vendored
// libghostty wasm: the encoder's byte table, then the drawer's viewport with
// the real keybinding dispatcher listening on the window. A bound Command
// chord runs its app command and the pty sees nothing; an unbound one that
// would type text is dropped; Terminal.app's three editing chords send their
// control bytes; Control chords are the terminal's.
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onOpenCommandPalette } from "../src/commandPaletteBus.js";
import { TerminalViewport } from "../src/components/ThreadTerminalDrawer.js";
import { SidebarProvider, useSidebar } from "../src/components/ui/sidebar.js";
import { isTerminalAppShortcut } from "../src/keybindings.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { KeybindingDispatcher } from "../src/shell/KeybindingDispatcher.js";
import { GhosttyTerminalCore } from "../src/terminal/ghostty/core.js";
import type { TerminalIo, TerminalScreen } from "../src/terminal/pty-io.js";

const THEME = {
  background: { r: 14, g: 18, b: 24 },
  foreground: { r: 237, g: 241, b: 247 },
  cursor: { r: 180, g: 203, b: 255 },
};

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

vi.setConfig({ testTimeout: 20_000 });

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

function usePlatform(platform: string): void {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("libghostty key encoding", () => {
  let core: GhosttyTerminalCore;
  beforeEach(async () => {
    core = await GhosttyTerminalCore.create(80, 24, 8, 16, THEME, () => {});
  });
  afterEach(() => core.dispose());

  const encode = (init: KeyboardEventInit) => core.encodeKey(key(init));

  it("encodes the byte table for the editing keys", () => {
    expect(encode({ key: "Enter", code: "Enter" })).toBe("\r");
    expect(encode({ key: "Delete", code: "Delete" })).toBe("\x1b[3~");
    expect(encode({ key: "w", code: "KeyW", ctrlKey: true })).toBe("\x17");
    expect(encode({ key: "Backspace", code: "Backspace" })).toBe("\x7f");
    expect(encode({ key: "Backspace", code: "Backspace", altKey: true })).toBe("\x1b\x7f");
    expect(encode({ key: "Backspace", code: "Backspace", ctrlKey: true })).toBe("\x08");
    expect(encode({ key: "ArrowLeft", code: "ArrowLeft", altKey: true })).toBe("\x1b[1;3D");
  });

  it("still sends DEL for a Backspace whose code the browser left blank", () => {
    expect(encode({ key: "Backspace" })).toBe("\x7f");
    expect(encode({ key: "Backspace", altKey: true })).toBe("\x1b\x7f");
  });

  it("types the bare letter for a Command chord, which is why the surface must not", () => {
    expect(encode({ key: "k", code: "KeyK", metaKey: true })).toBe("k");
  });
});

describe("isTerminalAppShortcut", () => {
  const event = (k: string, mods: Partial<KeyboardEventInit> = {}) => ({
    key: k,
    code: `Key${k.toUpperCase()}`,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it("claims the Command chords the defaults bind while a terminal has focus", () => {
    expect(isTerminalAppShortcut(event("j", { metaKey: true }), undefined, MAC)).toBe(true);
    expect(isTerminalAppShortcut(event("k", { metaKey: true }), undefined, MAC)).toBe(true);
    expect(isTerminalAppShortcut(event("b", { metaKey: true }), undefined, MAC)).toBe(true);
    expect(isTerminalAppShortcut(event("d", { metaKey: true }), undefined, MAC)).toBe(true);
    expect(isTerminalAppShortcut(event("n", { metaKey: true }), undefined, MAC)).toBe(true);
  });

  it("leaves unbound Command chords and every Control chord to the terminal", () => {
    expect(isTerminalAppShortcut(event("x", { metaKey: true }), undefined, MAC)).toBe(false);
    expect(isTerminalAppShortcut(event("k", { ctrlKey: true }), undefined, LINUX)).toBe(false);
    expect(isTerminalAppShortcut(event("c", { ctrlKey: true }), undefined, MAC)).toBe(false);
    expect(isTerminalAppShortcut(event("j", { ctrlKey: true }), undefined, LINUX)).toBe(false);
    expect(isTerminalAppShortcut(event("b", { ctrlKey: true }), undefined, LINUX)).toBe(false);
  });
});

describe("the drawer's viewport under the keybinding dispatcher", () => {
  function SidebarOpenProbe() {
    return <span data-testid="sidebar-open">{String(useSidebar().open)}</span>;
  }

  async function mountViewport(platform: string) {
    usePlatform(platform);
    useStore.setState({ selectedId: "ws_a" });
    useRightPanelStore.setState({ byWorkspaceId: {} });
    useTerminalDrawerStore.setState({ byWorkspaceId: {} });
    const data: string[] = [];
    // The textarea exists before the wasm surface listens on it; attach runs once it does.
    let attached: TerminalScreen | null = null;
    const io: TerminalIo = {
      attach: s => {
        attached = s;
        return () => {};
      },
      write: d => data.push(d),
      resize: () => {},
    };
    render(
      <SidebarProvider defaultOpen>
        <KeybindingDispatcher />
        <SidebarOpenProbe />
        <div data-terminal-owner="drawer">
          <TerminalViewport terminalId="pty1" io={io} config={{}} focusRequestId={0} autoFocus={false} resizeEpoch={0} drawerHeight={300} />
        </div>
      </SidebarProvider>,
    );
    await vi.waitFor(() => expect(attached).not.toBeNull(), { timeout: 10_000 });
    const input = document.querySelector<HTMLTextAreaElement>("textarea.ghostty-input")!;
    input.focus();
    const press = (init: KeyboardEventInit) => {
      const event = key(init);
      input.dispatchEvent(event);
      return event;
    };
    const sidebarOpen = () => screen.getByTestId("sidebar-open").textContent;
    const panelOpen = () => useRightPanelStore.getState().byWorkspaceId["ws_a"]?.isOpen ?? true;
    const drawerOpen = () => useTerminalDrawerStore.getState().byWorkspaceId["ws_a"]?.terminalOpen ?? false;
    const program = (bytes: string) => attached!.write(bytes);
    return { data, press, sidebarOpen, panelOpen, drawerOpen, program };
  }

  it("hands a bound Command chord to the app and keeps it out of the pty", async () => {
    const { data, press, sidebarOpen } = await mountViewport(MAC);
    expect(sidebarOpen()).toBe("true");
    const event = press({ key: "b", code: "KeyB", metaKey: true });
    await vi.waitFor(() => expect(sidebarOpen()).toBe("false"));
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("toggles the drawer on Cmd+J while the surface has focus, pty untouched", async () => {
    const { data, press, drawerOpen } = await mountViewport(MAC);
    expect(drawerOpen()).toBe(false);
    const event = press({ key: "j", code: "KeyJ", metaKey: true });
    await vi.waitFor(() => expect(drawerOpen()).toBe(true));
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("hands over a bound chord the encoder would not have typed as text", async () => {
    const { data, press, panelOpen } = await mountViewport(MAC);
    expect(panelOpen()).toBe(true);
    const event = press({ key: "∫", code: "KeyB", metaKey: true, altKey: true });
    await vi.waitFor(() => expect(panelOpen()).toBe(false));
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("hands over a bound chord even once the program asked for the kitty keyboard protocol", async () => {
    const { data, press, sidebarOpen, program } = await mountViewport(MAC);
    program("\x1b[>1u");
    press({ key: "b", code: "KeyB", metaKey: true });
    await vi.waitFor(() => expect(sidebarOpen()).toBe("false"));
    press({ key: "x", code: "KeyX", metaKey: true });
    await vi.waitFor(() => expect(data).toEqual(["\x1b[120;9u"]));
  });

  it("opens the palette on Cmd+K and keeps the chord out of the pty", async () => {
    const { data, press } = await mountViewport(MAC);
    const toggles: boolean[] = [];
    const off = onOpenCommandPalette(detail => toggles.push(detail.toggle === true));
    const event = press({ key: "k", code: "KeyK", metaKey: true });
    await vi.waitFor(() => expect(toggles).toEqual([true]));
    off();
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("drops an unbound Command chord that would type its letter", async () => {
    const { data, press, sidebarOpen } = await mountViewport(MAC);
    const event = press({ key: "x", code: "KeyX", metaKey: true });
    press({ key: "c", code: "KeyC", metaKey: true });
    press({ key: "a", code: "KeyA" });
    await vi.waitFor(() => expect(data).toEqual(["a"]));
    expect(event.defaultPrevented).toBe(false);
    expect(sidebarOpen()).toBe("true");
  });

  it("sends Terminal.app's bytes for Command with Backspace, Left and Right", async () => {
    const { data, press } = await mountViewport(MAC);
    press({ key: "Backspace", code: "Backspace", metaKey: true });
    press({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true });
    press({ key: "ArrowRight", code: "ArrowRight", metaKey: true });
    await vi.waitFor(() => expect(data).toEqual(["\x15", "\x01", "\x05"]));
  });

  it("leaves Control and Option chords to the terminal on macOS", async () => {
    const { data, press, sidebarOpen, drawerOpen } = await mountViewport(MAC);
    press({ key: "c", code: "KeyC", ctrlKey: true });
    press({ key: "j", code: "KeyJ", ctrlKey: true });
    press({ key: "Backspace", code: "Backspace", altKey: true });
    press({ key: "Backspace", code: "Backspace" });
    await vi.waitFor(() => expect(data).toEqual(["\x03", "\n", "\x1b\x7f", "\x7f"]));
    expect(sidebarOpen()).toBe("true");
    expect(drawerOpen()).toBe(false);
  });

  it("types Option+B as the layout's character, the way the native app does with option-as-alt off", async () => {
    const { data, press, sidebarOpen } = await mountViewport(MAC);
    press({ key: "∫", code: "KeyB", altKey: true });
    await vi.waitFor(() => expect(data).toEqual(["∫"]));
    expect(sidebarOpen()).toBe("true");
  });

  it("keeps typing Super chords elsewhere, where mod is Control", async () => {
    const { data, press, sidebarOpen } = await mountViewport(LINUX);
    press({ key: "x", code: "KeyX", metaKey: true });
    press({ key: "Backspace", code: "Backspace", metaKey: true });
    press({ key: "b", code: "KeyB", altKey: true });
    await vi.waitFor(() => expect(data).toEqual(["x", "\x7f", "\x1bb"]));
    expect(sidebarOpen()).toBe("true");
  });
});
