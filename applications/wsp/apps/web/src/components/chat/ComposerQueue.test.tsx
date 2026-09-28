// SPDX-License-Identifier: AGPL-3.0-only
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerQueue, STEER_NOTICE } from "./ComposerQueue";

const rows = [
  { id: "a", prompt: "what model are you?" },
  { id: "b", prompt: "and the context window?" },
];

function mount(over: Partial<Parameters<typeof ComposerQueue>[0]> = {}) {
  const handlers = { onEdit: vi.fn(), onRemove: vi.fn(), onSteer: vi.fn() };
  const view = render(<ComposerQueue rows={rows} steering={null} steer="stop" {...handlers} {...over} />);
  return { ...handlers, view };
}

describe("ComposerQueue", () => {
  it("renders nothing for an empty queue", () => {
    const { container } = render(<ComposerQueue rows={[]} steering={null} steer="stop" onEdit={() => {}} onRemove={() => {}} onSteer={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists the rows in order, each editable, marked queued, with a labelled remove and send-now button", () => {
    const { onEdit, onRemove, onSteer } = mount();
    const inputs = screen.getAllByRole("textbox", { name: "Queued message" }) as HTMLTextAreaElement[];
    expect(inputs.map(i => i.value)).toEqual(["what model are you?", "and the context window?"]);
    expect(screen.getAllByText("queued")).toHaveLength(2);
    expect(screen.queryByText(/\d/)).toBeNull();
    fireEvent.change(inputs[1]!, { target: { value: "and the context window, in tokens?" } });
    expect(onEdit).toHaveBeenCalledWith("b", "and the context window, in tokens?");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove queued message" })[0]!);
    expect(onRemove).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getAllByRole("button", { name: "Stop the turn and send now" })[1]!);
    expect(onSteer).toHaveBeenCalledWith("b");
  });

  it("removes a row blurred while emptied, keeps one with text", () => {
    const { onRemove } = mount({ rows: [{ id: "a", prompt: "   " }, rows[1]!] });
    const [blank, kept] = screen.getAllByRole("textbox", { name: "Queued message" });
    fireEvent.blur(kept!);
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.blur(blank!);
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("keeps the send-now button in place while nothing can go, disabled, so the row does not shift", () => {
    const { onSteer, view } = mount({ steer: null });
    const buttons = screen.getAllByRole("button", { name: "Send now" }) as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every(b => b.disabled)).toBe(true);
    fireEvent.click(buttons[0]!);
    expect(onSteer).not.toHaveBeenCalled();
    const shape = [...view.container.querySelectorAll("li")].map(li => li.children.length);
    view.rerender(<ComposerQueue rows={rows} steering={null} steer="now" onEdit={() => {}} onRemove={() => {}} onSteer={onSteer} />);
    const now = screen.getAllByRole("button", { name: "Send now" }) as HTMLButtonElement[];
    expect(now.every(b => !b.disabled)).toBe(true);
    fireEvent.click(now[1]!);
    expect(onSteer).toHaveBeenCalledWith("b");
    expect([...view.container.querySelectorAll("li")].map(li => li.children.length)).toEqual(shape);
    view.rerender(<ComposerQueue rows={rows} steering={null} steer="stop" onEdit={() => {}} onRemove={() => {}} onSteer={onSteer} />);
    expect(screen.getAllByRole("button", { name: "Stop the turn and send now" })).toHaveLength(2);
    expect([...view.container.querySelectorAll("li")].map(li => li.children.length)).toEqual(shape);
  });

  it("marks the promoted row as next, disables its send-now and shows the one-line notice while the stop is in flight", () => {
    mount({ steering: "b" });
    expect(screen.getByText("next")).toBeDefined();
    expect(screen.getAllByText("queued")).toHaveLength(1);
    expect((screen.getAllByRole("button", { name: "Stop the turn and send now" })[1] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(STEER_NOTICE);
  });

  it("drops the notice once the promoted row has left the queue", () => {
    mount({ steering: "gone" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("with a harness that steers, the promoted row reads next and its button waits, but no stop notice shows: nothing is being stopped", () => {
    mount({ steering: "b", steer: "now" });
    expect(screen.getByText("next")).toBeDefined();
    expect((screen.getAllByRole("button", { name: "Send now" })[1] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
