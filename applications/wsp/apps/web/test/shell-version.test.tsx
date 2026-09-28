// SPDX-License-Identifier: AGPL-3.0-only
// A desktop shell attached to a host it did not start can be of another
// release than the page that host serves, and then half the bridge's calls
// fail with nothing said. The page compares the two on load and says it as a
// notice, with the releases page behind its button
// where there is a newer app to get. A browser tab has no second half and says
// nothing.
import { act, render, waitFor } from "@testing-library/react";
import { GET_THE_APP_WORD, type BootPayload } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { Notices } from "../src/notices/Notice.js";
import { useShellVersionEffect } from "../src/shell/shellVersion.js";
import { ScriptedSocket } from "./scripted-socket.js";
import { clearNotices, lastAction, lastNotice } from "./notice-text.js";

const served = (boot: BootPayload | undefined): void => {
  const holder = window as unknown as { __WSP__?: BootPayload };
  if (boot === undefined) delete holder.__WSP__;
  else holder.__WSP__ = boot;
};

function Reader() {
  useShellVersionEffect();
  return null;
}

beforeEach(() => {
  clearNotices();
  served({ wsPort: 1, tokenHash: "a".repeat(64), wsPath: "/ws", paired: true, version: "0.1.5" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.wsp;
  served(undefined);
  document.body.innerHTML = "";
});

describe("a shell and the host that served it its page", () => {
  it("says nothing at all in a browser tab, which has no shell half to be behind", () => {
    render(<Reader />);
    expect(lastNotice()).toBeNull();
  });

  it("says nothing while the shell and the host are one release", () => {
    window.wsp = { version: "0.1.5" };
    render(<Reader />);
    expect(lastNotice()).toBeNull();
  });

  it("names both releases and offers the releases page when the app is the older half", () => {
    window.wsp = { version: "0.1.3" };
    render(<Reader />);
    expect(lastNotice()).toBe("this app is 0.1.3, the host is 0.1.5: get the new app");
    expect(lastAction()).toBe(GET_THE_APP_WORD);
  });

  it("asks for the app's own host when the host is the older half, with nothing to download", () => {
    window.wsp = { version: "0.1.9" };
    render(<Reader />);
    expect(lastNotice()).toBe("this app is 0.1.9, the host is 0.1.5: run the app's own host");
    expect(lastAction()).toBeNull();
  });

  it("catches the shell that started this: a bridge with no version at all is one from before the bridge had one", () => {
    window.wsp = { pickFolder: async () => undefined };
    render(<Reader />);
    expect(lastNotice()).toBe("this app is older than the host, which is 0.1.5: get the new app");
    expect(lastAction()).toBe(GET_THE_APP_WORD);
  });

  it("is read by the app itself on load, not only by whoever calls the hook", async () => {
    ScriptedSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", ScriptedSocket);
    window.wsp = { version: "0.1.3" };
    render(<App wsUrl="ws://test" token="tok" />);
    await waitFor(() => expect(lastNotice()).toBe("this app is 0.1.3, the host is 0.1.5: get the new app"));
  });

  it("lands as a toast whose button opens the releases page away from this window", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    window.wsp = { version: "0.1.3" };
    render(
      <>
        <Reader />
        <Notices />
      </>,
    );
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-notice]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(line.textContent).toContain("this app is 0.1.3, the host is 0.1.5: get the new app");
    const button = document.querySelector<HTMLElement>("[data-notice-action]")!;
    expect(button.textContent).toBe(GET_THE_APP_WORD);
    act(() => button.click());
    expect(open).toHaveBeenCalledWith("https://github.com/Zingzy/wsp/releases", "_blank", "noopener,noreferrer");
  });
});
