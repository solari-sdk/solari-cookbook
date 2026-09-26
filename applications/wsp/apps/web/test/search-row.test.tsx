// SPDX-License-Identifier: AGPL-3.0-only
// The search row's tooltip: the row's face carries no key, so the chord for
// the palette lives in the tooltip, read from the keybinding table. Base UI's
// tooltip opens on pointer hover, which jsdom cannot stage; the popup renders
// inline instead.
import { fireEvent, render, screen } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { onOpenCommandPalette } from "../src/commandPaletteBus.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { shortcutLabelForCommand } from "../src/keybindings.js";
import { SearchRow } from "../src/sidebar/SearchRow.js";

vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

describe("the search row", () => {
  it("keeps the palette chord in a tooltip read from the keybinding table, with nothing on the row's face", () => {
    render(
      <SidebarProvider defaultOpen>
        <SearchRow />
      </SidebarProvider>,
    );
    const chord = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "commandPalette.toggle");
    expect(chord).not.toBeNull();
    expect(screen.getByRole("tooltip").textContent).toBe(`Search (${chord})`);
    const row = screen.getByRole("button", { name: "Search" });
    expect(row.textContent).toBe("Search");
    expect(row.querySelector("kbd")).toBeNull();
  });

  it("is a plain row at the rows' height with no fill and no hairline of its own, the hover every other row has", () => {
    render(
      <SidebarProvider defaultOpen>
        <SearchRow />
      </SidebarProvider>,
    );
    const row = screen.getByRole("button", { name: "Search" });
    expect(row.hasAttribute("data-search-row")).toBe(true);
    expect(row.className).not.toMatch(/(^|\s)(bg-sidebar-row-selected|border-sidebar-border|bg-sidebar-control-surface|bg-black|bg-white|tint|ring-1)(\s|$)/);
    expect(row.className).toContain("hover:bg-sidebar-row-hover");
    expect(row.className).toContain("h-9");
  });

  it("is still the palette's door with the tooltip around it", () => {
    render(
      <SidebarProvider defaultOpen>
        <SearchRow />
      </SidebarProvider>,
    );
    const opened: boolean[] = [];
    const off = onOpenCommandPalette(detail => opened.push(detail.toggle === true));
    const row = screen.getByRole("button", { name: "Search" });
    expect(row.querySelector("svg.lucide-search")).not.toBeNull();
    fireEvent.click(row);
    expect(opened).toEqual([false]);
    off();
  });
});
