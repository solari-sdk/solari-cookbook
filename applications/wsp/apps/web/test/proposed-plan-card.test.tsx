// SPDX-License-Identifier: AGPL-3.0-only
// Saving a proposed plan into the workspace: the dialog the person is looking
// at says what is wrong with the path, and a save that went through closes it
// with nothing more said.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProposedPlanCard } from "../src/components/chat/ProposedPlanCard.js";
import { useNotices } from "../src/notices/store.js";
import { DisconnectedError, RequestError } from "../src/protocol/client.js";

const PLAN = "# Plan\n\n1. Do the thing";

async function openSave(onSavePlan: (input: { path: string; contents: string }) => Promise<void>) {
  render(<ProposedPlanCard planMarkdown={PLAN} cwd="/w" workspaceRoot="/w" resolvedTheme="dark" onSavePlan={onSavePlan} />);
  fireEvent.click(screen.getByRole("button", { name: "Plan actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save to task" }));
  return (await screen.findByLabelText("Folder")) as HTMLInputElement;
}

async function reopenSave() {
  fireEvent.click(screen.getByRole("button", { name: "Plan actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save to task" }));
  await screen.findByLabelText("Folder");
}

const refusalText = () => document.querySelector("[data-k='plan-path-refusal']")?.textContent ?? "";

beforeEach(() => act(() => useNotices.getState().clear()));

describe("saving a plan to the workspace", () => {
  it("an empty path is said under the field, not as a toast, and typing clears it", async () => {
    const save = vi.fn(async () => {});
    const field = await openSave(save);
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(document.querySelector("[data-k='plan-path-refusal']")?.textContent).toBe("Type a path to save the plan to.");
    expect(useNotices.getState().notices).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "plan.md" } });
    expect(document.querySelector("[data-k='plan-path-refusal']")?.textContent ?? "").toBe("");
  });

  it("a save that went through closes the dialog and says nothing more", async () => {
    const save = vi.fn(async () => {});
    const field = await openSave(save);
    fireEvent.change(field, { target: { value: "plan.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ path: "plan.md", contents: expect.any(String) }));
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
    expect(useNotices.getState().notices).toEqual([]);
  });

  it("a refused save is said under the field with the host's fix, the dialog stays, and no toast", async () => {
    const save = vi.fn(async () => { throw new RequestError("plans/ is not writable Check the folder's owner.", undefined, "Check the folder's owner."); });
    const field = await openSave(save);
    fireEvent.change(field, { target: { value: "plans/plan.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.querySelector("[data-k='plan-path-refusal']")?.textContent).toBe("Plan not saved: plans/ is not writable Check the folder's owner."));
    expect(screen.getByLabelText("Folder")).toBeTruthy();
    expect(useNotices.getState().notices).toEqual([]);
  });

  it("a refusal leaves when Save is pressed again, and a save that then goes through reopens to an empty slot", async () => {
    let refuse = true;
    let release = () => {};
    const save = vi.fn(async () => {
      if (refuse) throw new RequestError("busy", undefined, "Try again.");
      await new Promise<void>(resolve => { release = resolve; });
    });
    const field = await openSave(save);
    fireEvent.change(field, { target: { value: "plan.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refusalText()).toBe("Plan not saved: busy Try again."));
    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Saving..." });
    expect(refusalText()).toBe("");
    await act(async () => release());
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
    await reopenSave();
    expect(refusalText()).toBe("");
  });

  it("a refusal and then Cancel reopens to an empty slot", async () => {
    const save = vi.fn(async () => { throw new RequestError("busy", undefined, "Try again."); });
    const field = await openSave(save);
    fireEvent.change(field, { target: { value: "plan.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refusalText()).toBe("Plan not saved: busy Try again."));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
    await reopenSave();
    expect(refusalText()).toBe("");
  });

  it("an empty path said and then Cancel reopens to an empty slot", async () => {
    const field = await openSave(vi.fn(async () => {}));
    fireEvent.change(field, { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(refusalText()).toBe("Type a path to save the plan to.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Folder")).toBeNull());
    await reopenSave();
    expect(refusalText()).toBe("");
  });

  it("a connection lost during the save says the plan was not saved, and no toast", async () => {
    const field = await openSave(vi.fn(async () => { throw new DisconnectedError("lost"); }));
    fireEvent.change(field, { target: { value: "plan.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refusalText()).toBe("Plan not saved: runtime connection lost"));
    expect(useNotices.getState().notices).toEqual([]);
  });
});
