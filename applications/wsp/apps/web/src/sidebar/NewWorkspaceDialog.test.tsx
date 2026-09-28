// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Capabilities, PlaceView, ProjectView , WorkspaceLanding } from "@wsp/protocol";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.js";
import { NEW_WORKSPACE, SAY_THE_WORK, WORK_GHOST, WORK_QUESTION } from "./words.js";

const project = (id: string, name: string, computer = "here"): ProjectView => ({
  id,
  name,
  computer,
  source: { kind: "folder", path: `/Users/dev/${name}` },
  path: `/Users/dev/${name}`,
  remote: `https://github.com/dev/${name}.git`,
  defaultBranch: "main",
  memoryKey: `-Users-dev-${name}`,
  memoryDir: `/Users/dev/.claude-cfg/projects/-Users-dev-${name}/memory`,
  createdAt: "2026-09-17T00:00:00.000Z",
});

const caps = (over: Partial<Capabilities>): Capabilities => ({ copies: true, ownNetwork: false, ...over }) as Capabilities;
/** The computers this host holds: the one it runs on first, then a box of the person's own. */
const PLACES = [
  { id: "here", kind: "computer", name: "studio.local", default: false, present: true, takesForks: false },
  { id: "p_1", kind: "computer", name: "spoo", default: true, present: true, takesForks: true },
] as unknown as PlaceView[];
// The runtime answers the id of the computer it runs on here, which the line names off the places list.
const HERE: WorkspaceLanding = { name: "here", capabilities: caps({}) };
const BOX: WorkspaceLanding = { place: "p_1", name: "spoo", capabilities: caps({ copies: false, ownNetwork: true }) };

function mount(projects: ProjectView[], landings: Record<string, WorkspaceLanding | null> = {}, picked: string | null = null) {
  const onCreate = vi.fn();
  const onCancel = vi.fn();
  render(<NewWorkspaceDialog projects={projects} landings={landings} places={PLACES} picked={picked} onCreate={onCreate} onCancel={onCancel} />);
  return { onCreate, onCancel, field: () => screen.getByLabelText(WORK_QUESTION) as HTMLInputElement, create: () => screen.getByText("Create").closest("button")! };
}

afterEach(cleanup);

describe("New workspace asks one thing", () => {
  it("is titled by the one word entry, asks the work with its ghost, and asks nothing else", () => {
    mount([project("pr_1", "spoo")], { pr_1: HERE });
    expect(screen.getByRole("dialog").textContent).toContain(NEW_WORKSPACE);
    expect(screen.getByLabelText(WORK_QUESTION).getAttribute("placeholder")).toBe(WORK_GHOST);
    // One field, and no base branch, no size and no image caption anywhere on the card.
    expect(screen.getByRole("dialog").querySelectorAll("input")).toHaveLength(1);
    expect(screen.getByRole("dialog").textContent).not.toMatch(/branch|Size|image/i);
  });

  it("holds Create while the question has no answer, says why on hover, and creates on Enter with the one project's id", () => {
    const t = mount([project("pr_1", "spoo")], { pr_1: HERE });
    expect(t.create().getAttribute("data-held")).toBe("");
    expect(t.create().getAttribute("title")).toBe(SAY_THE_WORK);
    fireEvent.change(t.field(), { target: { value: " pricing page " } });
    expect(t.create().getAttribute("data-held")).toBeNull();
    fireEvent.keyDown(t.field(), { key: "Enter" });
    expect(t.onCreate).toHaveBeenCalledWith("pricing page", "pr_1");
  });

  it("reads where the work lands off the landing the host answered, and says nothing until it has", () => {
    mount([project("pr_1", "spoo")], { pr_1: HERE });
    // The computer the host runs on is named the way every other surface names it, never by the id the wire carries.
    expect(document.querySelector("[data-k=landing]")!.textContent).toBe("This Mac shares this Mac's ports");
    cleanup();
    mount([project("pr_2", "wsp", "p_1")], { pr_2: BOX });
    expect(document.querySelector("[data-k=landing]")!.textContent).toBe("spoo own network");
    cleanup();
    // The slot is in the tree from the first paint, so the line arriving moves nothing under it.
    mount([project("pr_1", "spoo")], {});
    expect(document.querySelector("[data-k=landing]")!.textContent).toBe("");
  });

  it("draws the one project as a line of text, and three as a control with the picked one checked", () => {
    mount([project("pr_1", "spoo")], { pr_1: HERE });
    expect(document.querySelector("[data-project=pr_1]")!.tagName).toBe("P");
    cleanup();
    mount([project("pr_1", "spoo"), project("pr_2", "wsp"), project("pr_3", "www")], { pr_1: HERE }, "pr_3");
    expect([...document.querySelectorAll<HTMLElement>("[data-segment]")].map(el => [el.dataset["segment"], el.getAttribute("aria-checked")])).toEqual([
      ["pr_1", "false"],
      ["pr_2", "false"],
      ["pr_3", "true"],
    ]);
  });

  it("is not held on a host with no image, and says nothing about one: a project on this computer forks nothing", () => {
    const t = mount([project("pr_1", "spoo")], { pr_1: HERE });
    fireEvent.change(t.field(), { target: { value: "pricing page" } });
    expect(t.create().getAttribute("data-held")).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/image/i);
  });

  it("cancels on Escape without creating", () => {
    const t = mount([project("pr_1", "spoo")], { pr_1: HERE });
    fireEvent.change(t.field(), { target: { value: "pricing page" } });
    fireEvent.keyDown(t.field(), { key: "Escape" });
    expect(t.onCancel).toHaveBeenCalled();
    expect(t.onCreate).not.toHaveBeenCalled();
  });
});
