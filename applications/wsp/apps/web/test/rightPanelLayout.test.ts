// SPDX-License-Identifier: AGPL-3.0-only
// The shell's rule for which column gives way when the right panel sits inline.
import { describe, expect, it } from "vitest";
import { CENTER_COLUMN_MIN_WIDTH, RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_SHEET_MAX_VIEWPORT, sidebarMaxWidthBeside } from "../src/rightPanelLayout";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../src/shell/sidebarWidth";

describe("sidebarMaxWidthBeside", () => {
  it("leaves the sidebar its full range while the panel is closed or a sheet", () => {
    expect(sidebarMaxWidthBeside(981, false)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxWidthBeside(600, false)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("with the panel inline the sidebar takes only what the window has left once the panel and the centre keep their minimums", () => {
    expect(sidebarMaxWidthBeside(1100, true)).toBe(1100 - RIGHT_PANEL_MIN_WIDTH - CENTER_COLUMN_MIN_WIDTH);
    expect(sidebarMaxWidthBeside(1024, true)).toBe(1024 - RIGHT_PANEL_MIN_WIDTH - CENTER_COLUMN_MIN_WIDTH);
    expect(sidebarMaxWidthBeside(RIGHT_PANEL_SHEET_MAX_VIEWPORT + 1, true)).toBe(RIGHT_PANEL_SHEET_MAX_VIEWPORT + 1 - RIGHT_PANEL_MIN_WIDTH - CENTER_COLUMN_MIN_WIDTH);
  });

  it("never asks for more than the sidebar's widest", () => {
    expect(sidebarMaxWidthBeside(1200, true)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxWidthBeside(2000, true)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("holds the sidebar's own minimum at the narrowest window the panel is inline at", () => {
    expect(sidebarMaxWidthBeside(RIGHT_PANEL_SHEET_MAX_VIEWPORT + 1, true)).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
  });

  it("the breakpoint the media query names is the one the rule reads", () => {
    expect(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).toBe(`(max-width: ${RIGHT_PANEL_SHEET_MAX_VIEWPORT}px)`);
  });
});
