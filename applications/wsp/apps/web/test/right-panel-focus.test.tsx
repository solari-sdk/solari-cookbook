// SPDX-License-Identifier: AGPL-3.0-only
// Showing the Diff pane in the right panel over a fake daemon wire: the tab
// strip is a sibling above the pane, so the pane itself takes focus as it is
// shown and up a folder (Backspace, Alt+Up) acts on the first key, with
// nothing clicked inside it. The diff worker pool is stood in: it builds real
// Workers, which jsdom has none of.
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/DiffWorkerPoolProvider.js", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

import { useRootStore } from "../src/files/root.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { fakeWire, LISTING, resetSurfaces, shownFolder, WS } from "./surface-harness.js";

beforeEach(resetSurfaces);

const DIFF = { base: null, files: [], truncated: false };
const STATUS = { branch: { oid: "abc", head: "main", ahead: 0, behind: 0 }, entries: [], root: "/root" };

/** The panel as the shell renders it: the tab strip over the one active surface. */
function Panel() {
  const state = useRightPanelStore(s => s.byWorkspaceId[WS]);
  return state ? <RightPanel workspaceId={WS} state={state} mode="inline" /> : null;
}

describe("the right panel's Diff pane", () => {
  it("takes focus as it is shown, so up a folder acts on the first key", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.diff": DIFF, "git.status": STATUS }));
    act(() => {
      useRootStore.getState().follow(WS, "/root/app/lib");
      useRightPanelStore.getState().open(WS, "diff");
    });
    const { container } = render(<Panel />);
    await waitFor(() => expect(container.querySelector("[data-diff-surface]")).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector("[data-diff-surface]")));

    const pane = container.querySelector<HTMLElement>("[data-diff-surface]")!;
    expect(pane.getAttribute("tabindex")).toBe("0");
    expect(shownFolder(container)).toBe("/root/app/lib");

    fireEvent.keyDown(document.activeElement!, { key: "Backspace" });
    await waitFor(() => expect(shownFolder(container)).toBe("/root/app"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(shownFolder(container)).toBe("/root"));
  });
});
