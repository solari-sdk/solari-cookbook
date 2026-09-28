// SPDX-License-Identifier: AGPL-3.0-only
// The pane for a daemon this host started and lost: a start the host refused
// says the host's own sentence under the button, then what to do.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ownDaemonDown } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonDown } from "../src/components/DaemonDown.js";
import { DisconnectedError, NO_REASON, RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

const WS = "ws_mac";

function refusing(e: unknown): { asked: string[] } {
  const asked: string[] = [];
  const api = {
    subscribe: () => () => {},
    restartDaemon: async (id: string) => {
      asked.push(id);
      throw e;
    },
  } as unknown as Api;
  act(() => useStore.setState({ api }));
  return { asked };
}

async function startOnce(): Promise<string | null> {
  render(<DaemonDown absent={ownDaemonDown("this Mac")} workspaceId={WS} />);
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Start it" })));
  return document.querySelector("[data-k=start-daemon-refused]")?.textContent ?? null;
}

afterEach(() => {
  cleanup();
  act(() => useStore.setState({ api: null }));
});

describe("a daemon start the host refused", () => {
  it("says the host's sentence, then Start again", async () => {
    const { asked } = refusing(new RequestError("wsp-daemon at /opt/wsp/bin/wsp-daemon is not executable"));
    expect(await startOnce()).toBe("wsp-daemon at /opt/wsp/bin/wsp-daemon is not executable. Start again.");
    expect(asked).toEqual([WS]);
  });

  it("takes the host's own fix in place of Start again when the host gave one", async () => {
    refusing(new RequestError("port 4640 is held by another process. Quit it, then start again.", "conflict", "Quit it, then start again."));
    expect(await startOnce()).toBe("port 4640 is held by another process. Quit it, then start again.");
  });

  it("says the no-reason sentence once, never with a second ask behind it", async () => {
    refusing(new RequestError(NO_REASON));
    expect(await startOnce()).toBe(NO_REASON);
  });

  it("says a lost connection in the client's words, which the banner says too", async () => {
    const lost = new DisconnectedError("lost");
    refusing(lost);
    expect(await startOnce()).toBe(`${lost.message}. Start again.`);
  });

  it("clears the sentence when the next start is asked", async () => {
    refusing(new RequestError("wsp-daemon exited at once"));
    expect(await startOnce()).toBe("wsp-daemon exited at once. Start again.");
    act(() => useStore.setState({ api: { subscribe: () => () => {}, restartDaemon: () => new Promise<void>(() => {}) } as unknown as Api }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Start it" })));
    expect(document.querySelector("[data-k=start-daemon-refused]")).toBeNull();
  });
});
