// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's host foot over a fake desktop bridge: the foot naming the host
// the window is on and opening the Hosts menu with that one marked, and the
// boot gate asking the shell for a token before it asks the person for a code.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_WORDS, WS_PATH, type BootPayload, type ContextMenuItem, type DesktopBridge, type HostsView } from "@wsp/protocol";
import { BootGate } from "../src/BootGate.js";
import { PAIR_HEADING } from "../src/PairScreen.js";
import { HostFoot } from "../src/hosts/HostFoot.js";
import { clearNotices, lastNotice } from "./notice-text.js";

const VIEW: HostsView = {
  here: "This Mac",
  current: "box",
  hosts: [{ alias: "box", url: "https://hbox1.boxes.example" }],
};

type Bridge = Pick<DesktopBridge, "hosts" | "contextMenu" | "switchHost" | "hostToken">;

function fakeBridge(over: Partial<Bridge> = {}): Bridge & { menus: ContextMenuItem[][] } {
  const menus: ContextMenuItem[][] = [];
  const bridge = {
    menus,
    hosts: vi.fn(async () => VIEW),
    contextMenu: vi.fn(async (items: ContextMenuItem[]) => {
      menus.push(items);
      return null;
    }),
    switchHost: vi.fn(async () => ({ ok: true as const })),
    hostToken: vi.fn(async () => undefined),
    ...over,
  };
  (window as unknown as { wsp?: unknown }).wsp = bridge;
  return bridge;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { wsp?: unknown }).wsp;
});

describe("the sidebar's host foot", () => {
  it("names the host the window is on and opens the Hosts menu through the shell with that one marked", async () => {
    const bridge = fakeBridge();
    render(<HostFoot />);
    await screen.findByText("box");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: HOST_WORDS.hosts }));
    });
    expect(bridge.menus).toHaveLength(1);
    const rows = bridge.menus[0]!;
    expect(rows.map(r => [r.label, r.checked ?? null])).toEqual([
      ["This Mac", false],
      ["box", true],
    ]);
  });

  it("choosing a row asks the shell to switch to that host, null for this computer", async () => {
    const bridge = fakeBridge({ contextMenu: vi.fn(async () => "switch:") });
    render(<HostFoot />);
    await screen.findByText("box");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: HOST_WORDS.hosts }));
    });
    expect(bridge.switchHost).toHaveBeenCalledWith(null);
    (bridge.contextMenu as ReturnType<typeof vi.fn>).mockResolvedValue("switch:box");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: HOST_WORDS.hosts }));
    });
    expect(bridge.switchHost).toHaveBeenLastCalledWith("box");
  });

  it("a hosts list the shell refused reads as not read, and a refused switch is a notice in the shell's words", async () => {
    fakeBridge({ hosts: vi.fn(async () => { throw new Error("hosts.json unreadable"); }) });
    render(<HostFoot />);
    await waitFor(() => expect(document.querySelector("[data-host-label]")?.textContent).toBe("hosts not read"));
    // Nothing opens from a list that was not read, so the row carries no menu glyph.
    expect(document.querySelector("[data-host-foot] svg")).toBeNull();
    cleanup();
    clearNotices();
    fakeBridge({ contextMenu: vi.fn(async () => "switch:"), switchHost: vi.fn(async () => ({ ok: false as const, error: "that host is not answering" })) });
    render(<HostFoot />);
    await screen.findByText("box");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: HOST_WORDS.hosts }));
    });
    expect(lastNotice()).toBe("that host is not answering");
  });

  it("draws nothing in a browser tab", () => {
    const { container } = render(<HostFoot />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the boot gate in the shell", () => {
  const boot = (over: Partial<BootPayload> = {}): BootPayload => ({ wsPort: 4410, wsPath: WS_PATH, paired: false, version: "0.0.0", ...over });
  const at = { protocol: "http:", host: "127.0.0.1:1" };

  it("with no token in the page asks the shell, and goes through on what it answers", async () => {
    const bridge = fakeBridge({ hostToken: vi.fn(async () => "device-token") });
    render(<BootGate boot={boot()} at={at} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    await waitFor(() => expect(bridge.hostToken).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector("[data-k=booting]")).toBeNull());
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
  });

  it("with no token anywhere shows the pairing screen", async () => {
    fakeBridge();
    render(<BootGate boot={boot()} at={at} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    expect(await screen.findByText(PAIR_HEADING)).toBeTruthy();
  });

  it("on this computer's own page asks the shell too, since the page carries a digest of the host's token and never the token", async () => {
    const bridge = fakeBridge({ hostToken: vi.fn(async () => "host-token") });
    render(<BootGate boot={boot({ tokenHash: "a".repeat(64), paired: true })} at={at} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    await waitFor(() => expect(bridge.hostToken).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector("[data-k=booting]")).toBeNull());
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
  });
});
