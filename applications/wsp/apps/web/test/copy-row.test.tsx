// SPDX-License-Identifier: AGPL-3.0-only
// The copy row every sheet and detail draws a line to paste in: the whole
// line as one run of text that scrolls sideways in its own box, never broken
// and never cut, with the copy glyph beside the box and never over it.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CopyRow } from "../src/settings/sheetParts.js";

afterEach(cleanup);

const LINE = "npm install -g @ampcode/cli@0.0.1790352060-g26b83c";

describe("the copy row", () => {
  it("holds the line as one run of text that scrolls sideways, whole on its hover, the glyph outside the box", () => {
    render(<CopyRow k="line" value={LINE} />);
    const value = document.querySelector<HTMLElement>("[data-k=line]")!;
    expect(value.textContent).toBe(LINE);
    expect(value.children).toHaveLength(0);
    expect(value.getAttribute("title")).toBe(LINE);
    expect(value.className).toContain("overflow-x-auto");
    expect(value.className).toContain("whitespace-pre");
    expect(value.className).not.toContain("truncate");
    expect(value.className).not.toContain("break-words");
    const copy = document.querySelector<HTMLButtonElement>("[data-copy-row=line] button")!;
    expect(value.contains(copy)).toBe(false);
    expect(copy.className).toContain("shrink-0");
  });
});
