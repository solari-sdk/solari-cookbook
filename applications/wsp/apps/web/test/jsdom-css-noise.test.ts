// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

// The stylesheet the file tree writes on every render, cut to the line jsdom's parser gives up on.
const UNPARSEABLE = "@layer base, unsafe;\n@layer unsafe {\n  :host { --trees-font-size-override: 12px; }\n}";

describe("what jsdom reports out of a render", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.head.replaceChildren();
  });

  it("says nothing when a stylesheet is past its parser, which no app of ours can act on", () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const style = document.createElement("style");
    document.head.append(style);
    style.textContent = UNPARSEABLE;
    expect(printed).not.toHaveBeenCalled();
  });

  it("still reports everything else it would have, so the filter cannot hide a real one", () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const errors = (window as unknown as { _virtualConsole: { emit(event: string, error: unknown): void } })._virtualConsole;
    errors.emit("jsdomError", Object.assign(new Error("a resource did not load"), { type: "resource loading" }));
    expect(printed).toHaveBeenCalled();
  });
});
