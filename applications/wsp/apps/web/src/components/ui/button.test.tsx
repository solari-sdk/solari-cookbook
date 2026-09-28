// SPDX-License-Identifier: AGPL-3.0-only
// The one drawing of a keycap that cannot be pressed yet, which every sheet and
// dialog reads off this component rather than spelling again: the outline
// variant, disabled, marked, dimmed a step further than an ordinary disabled
// control, at the size and in the slot the live one has.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button.js";

afterEach(cleanup);

const classesOf = (word: string): string[] => screen.getByRole("button", { name: word }).className.split(" ");

describe("a held keycap", () => {
  it("is the outline variant, disabled and marked, whatever variant it was asked for", () => {
    render(<Button held>Add</Button>);
    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.hasAttribute("data-held")).toBe(true);
    expect(classesOf("Add")).toEqual(expect.arrayContaining(["border-input"]));
    expect(classesOf("Add")).not.toEqual(expect.arrayContaining(["bg-primary"]));
  });

  it("takes the variant back and lets go the moment it is no longer held", () => {
    render(<Button held>Add</Button>);
    const held = { size: classesOf("Add").filter(c => c.startsWith("h-") || c.startsWith("px-")), word: screen.getByRole("button", { name: "Add" }).textContent };
    cleanup();
    render(<Button>Add</Button>);
    const live = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(live.disabled).toBe(false);
    expect(live.hasAttribute("data-held")).toBe(false);
    expect(classesOf("Add")).toEqual(expect.arrayContaining(["bg-primary"]));
    // The switch moves nothing: same size classes, same word, same slot.
    expect({ size: classesOf("Add").filter(c => c.startsWith("h-") || c.startsWith("px-")), word: live.textContent }).toEqual(held);
  });

  it("falls further down the opacity ramp than an ordinary disabled control, and keeps only the one step", () => {
    render(<Button held>Add</Button>);
    // The generic disabled step read as the live outline beside it in a row's slot, so a held control takes its
    // own; both at once would leave the stronger one deciding and the weaker one saying nothing.
    expect(classesOf("Add")).toEqual(expect.arrayContaining(["disabled:opacity-50"]));
    expect(classesOf("Add")).not.toEqual(expect.arrayContaining(["disabled:opacity-64"]));
    cleanup();
    render(<Button disabled>Removing…</Button>);
    expect(classesOf("Removing…")).toEqual(expect.arrayContaining(["disabled:opacity-64"]));
  });

  it("stays disabled when the caller disables for its own reason as well", () => {
    render(
      <Button held disabled={false}>
        Save
      </Button>,
    );
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves a busy keycap its own variant, since busy is not held", () => {
    render(
      <Button disabled>
        Removing…
      </Button>,
    );
    const busy = screen.getByRole("button", { name: "Removing…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.hasAttribute("data-held")).toBe(false);
    expect(classesOf("Removing…")).toEqual(expect.arrayContaining(["bg-primary"]));
  });
});
