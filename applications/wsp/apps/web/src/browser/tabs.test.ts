// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import { currentAddress, previewTabSnapshots, resetBrowserTabs, useBrowserTabs } from "./tabs.js";

const WS = "ws_tabs";

afterEach(resetBrowserTabs);

describe("a browser tab is a port and a path", () => {
  it("a new path on the same port is a new history entry; the same address again is not", () => {
    const tabs = useBrowserTabs.getState();
    const id = tabs.createTab(WS, { port: 3000, path: "/" });
    tabs.navigate(WS, id, { port: 3000, path: "/about?x=1" });
    tabs.navigate(WS, id, { port: 3000, path: "/about?x=1" });
    const tab = useBrowserTabs.getState().byWorkspaceId[WS]![id]!;
    expect(tab.entries).toEqual([null, { port: 3000, path: "/" }, { port: 3000, path: "/about?x=1" }]);
    expect(currentAddress(tab)).toEqual({ port: 3000, path: "/about?x=1" });
    tabs.back(WS, id);
    expect(currentAddress(useBrowserTabs.getState().byWorkspaceId[WS]![id]!)).toEqual({ port: 3000, path: "/" });
  });

  it("the strip's title and url carry the path, and the root reads as the port alone", () => {
    const tabs = useBrowserTabs.getState();
    const root = tabs.createTab(WS, { port: 5173, path: "/" });
    const deep = tabs.createTab(WS, { port: 3000, path: "/about?x=1" });
    const snapshots = previewTabSnapshots(useBrowserTabs.getState().byWorkspaceId[WS]!, [{ port: 5173, pid: 1, process: "node" }]);
    expect(snapshots[root]).toEqual({ tabId: root, url: "http://localhost:5173", title: "node :5173" });
    expect(snapshots[deep]).toEqual({ tabId: deep, url: "http://localhost:3000/about?x=1", title: ":3000/about?x=1" });
  });
});
