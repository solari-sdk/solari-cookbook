// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Root } from "../src/App.js";
import { Gallery, GALLERY_SECTIONS } from "../src/gallery/Gallery.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("gallery", () => {
  it("mounts every kit section in jsdom without console errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      render(<Gallery />);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ui kit gallery");
    const sections = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(sections).toEqual(GALLERY_SECTIONS.map((s) => s.id));
    expect(sections.length).toBeGreaterThanOrEqual(16);
    expect(errors).not.toHaveBeenCalled();
  });

  it("Root shows the gallery under #gallery and leaves it when the hash changes", () => {
    vi.stubGlobal("WebSocket", class { close() {} });
    window.location.hash = "#gallery";
    render(<Root wsUrl="ws://127.0.0.1:1" token="" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ui kit gallery");
    act(() => {
      window.location.hash = "#other";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByText(/connecting to runtime/)).toBeTruthy();
  });
});
