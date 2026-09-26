// SPDX-License-Identifier: AGPL-3.0-only
// The code views in the right panel take a side as a prop and colour their
// tokens from it. That side has to be the side the page is drawing: the tints
// a diff paints its rows with are mixed from the page's own tokens, so a view
// themed for the other side draws its lines in an ink those tints were never
// measured against. The page opens on the dark side and the preference flips
// it after the first paint, so the prop has to follow, not be read once.
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/DiffWorkerPoolProvider.js", () => ({
  DiffWorkerPoolProvider: ({ theme, children }: { theme: string; children?: ReactNode }) => <div data-pool-theme={theme}>{children}</div>,
}));
vi.mock("../src/diffs/DiffSurface.js", () => ({
  DiffSurface: ({ theme }: { theme: string }) => <div data-diff-theme={theme} />,
}));

import { useRightPanelStore } from "../src/rightPanelStore.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { resetSurfaces, WS } from "./surface-harness.js";

function Panel() {
  const state = useRightPanelStore(s => s.byWorkspaceId[WS]);
  return state ? <RightPanel workspaceId={WS} state={state} mode="inline" /> : null;
}

beforeEach(() => {
  resetSurfaces();
  document.documentElement.classList.add("dark");
});
afterEach(() => document.documentElement.classList.remove("dark"));

describe("the right panel's code views", () => {
  it("take the side the page is drawing, and follow it when the computer's side changes", async () => {
    act(() => useRightPanelStore.getState().open(WS, "diff"));
    const { container } = render(<Panel />);
    const side = () => container.querySelector("[data-diff-theme]")?.getAttribute("data-diff-theme");
    await waitFor(() => expect(side()).toBe("dark"));
    expect(container.querySelector("[data-pool-theme]")?.getAttribute("data-pool-theme")).toBe("dark");

    await act(async () => { document.documentElement.classList.remove("dark"); });
    await waitFor(() => expect(side()).toBe("light"));
    expect(container.querySelector("[data-pool-theme]")?.getAttribute("data-pool-theme")).toBe("light");
  });
});
