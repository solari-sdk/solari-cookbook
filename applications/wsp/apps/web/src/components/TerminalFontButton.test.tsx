// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { TERMINAL_FONT_KEY, useTerminalViewportConfig } from "../terminal/fontSetting";
import { TerminalFontButton, TerminalFontCard } from "./TerminalFontButton";

/** The button and the card wired the way the terminal pane wires them, next to what the pane would draw with. */
function Harness() {
  const [open, setOpen] = useState(false);
  const config = useTerminalViewportConfig("ws_a");
  return (
    <>
      <TerminalFontButton className="btn" open={open} onToggle={() => setOpen(o => !o)} />
      {open ? <TerminalFontCard onClose={() => setOpen(false)} /> : null}
      <output data-testid="family">{config.font?.family ?? "(default)"}</output>
    </>
  );
}

const open = () => act(async () => fireEvent.click(screen.getByRole("button", { name: "Terminal font" })));

describe("terminal font button and card", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete (window as unknown as { __WSP__?: unknown }).__WSP__;
  });

  it("opens on click, names the detected font as what empty means, and commits a typed family on blur", async () => {
    (window as unknown as { __WSP__: unknown }).__WSP__ = { wsPort: 1, token: "", terminalFont: "Hack" };
    render(<Harness />);
    expect(screen.getByTestId("family").textContent).toBe("Hack");
    expect(screen.queryByRole("textbox", { name: "Terminal font" })).toBeNull();
    await open();
    const input = screen.getByRole("textbox", { name: "Terminal font" }) as HTMLInputElement;
    expect(input.placeholder).toBe("Hack");
    expect(screen.getByText(/Empty draws with Hack, your terminal's font\./)).toBeTruthy();
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "Iosevka" } });
      fireEvent.blur(input);
    });
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBe("Iosevka");
    expect(screen.getByTestId("family").textContent).toBe("Iosevka");
  });

  it("Enter commits like blur, clearing the field returns the pane to the default, Escape and the button close the card", async () => {
    window.localStorage.setItem(TERMINAL_FONT_KEY, "Iosevka");
    render(<Harness />);
    expect(screen.getByTestId("family").textContent).toBe("Iosevka");
    await open();
    const input = screen.getByRole("textbox", { name: "Terminal font" }) as HTMLInputElement;
    expect(input.value).toBe("Iosevka");
    expect(input.placeholder).toBe("SF Mono");
    expect(screen.getByText(/Empty draws with the default font\./)).toBeTruthy();
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
    });
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
    expect(screen.getByTestId("family").textContent).toBe("(default)");
    await act(async () => fireEvent.keyDown(input, { key: "Escape" }));
    expect(screen.queryByRole("textbox", { name: "Terminal font" })).toBeNull();
    await open();
    expect(screen.getByRole("textbox", { name: "Terminal font" })).toBeTruthy();
    await open();
    expect(screen.queryByRole("textbox", { name: "Terminal font" })).toBeNull();
  });
});
