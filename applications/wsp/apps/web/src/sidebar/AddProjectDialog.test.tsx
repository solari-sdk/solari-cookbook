// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostFolderListing, PlaceView, ProjectView } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { AddProjectDialog } from "./AddProjectDialog.js";
import { ADD_PROJECT_WORDS } from "./words.js";
import { pickOption } from "../../test/select.js";

const HERE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: false, present: true, takesForks: false } as PlaceView;
const BOX: PlaceView = { id: "p_1", kind: "computer", name: "spoo", default: true, present: true, takesForks: true } as PlaceView;
const CLOUD: PlaceView = { id: "p_2", kind: "provider", name: "ascii", default: false, present: true, takesForks: true } as PlaceView;
const IDLE: PlaceView = { id: "p_3", kind: "computer", name: "idle", default: false, present: true, takesForks: false } as PlaceView;

const recorded = (path: string): ProjectView => ({ id: "pr_1", name: "spoo", computer: "here", source: { kind: "folder", path }, path, remote: "https://github.com/dev/spoo.git", defaultBranch: "main", memoryKey: "-x", memoryDir: "/x", createdAt: "t" });

const REPOS: HostFolderListing = {
  dir: "/Users/dev",
  roots: ["/Users/dev"],
  folders: [
    { path: "/Users/dev/code/spoo", repo: true, branch: "main" },
    { path: "/Users/dev/code/wsp", repo: true, branch: "ui/live" },
    { path: "/Users/dev/notes", repo: true },
  ],
  hidden: 0,
};

const LEVEL: HostFolderListing = {
  dir: "/Users/dev",
  roots: ["/Users/dev"],
  folders: [
    { path: "/Users/dev/code", repo: false },
    { path: "/Users/dev/cache", repo: false },
    { path: "/Users/dev/notes", repo: true },
  ],
  hidden: 2,
};

function mount({ places = [HERE], projects = [], add }: { places?: PlaceView[]; projects?: ProjectView[]; add?: (source: string, on?: string) => Promise<ProjectView | null> } = {}) {
  const hostFolders = vi.fn(async (dir?: string, _hidden?: boolean, repos?: boolean) => (repos === true ? REPOS : { ...LEVEL, dir: dir ?? LEVEL.dir }));
  const addProject = vi.fn(add ?? (async (source: string) => recorded(source)));
  const setPreferences = vi.fn(async () => {});
  const openAddComputer = vi.fn();
  useStore.setState({ api: { subscribe: () => () => {}, hostFolders } as unknown as Api, places, projects, addProject, setPreferences, openAddComputer } as never);
  const onClose = vi.fn();
  render(<AddProjectDialog onClose={onClose} />);
  const dialog = () => document.querySelector<HTMLElement>("[data-k=add-project]")!;
  return {
    hostFolders,
    addProject,
    setPreferences,
    openAddComputer,
    onClose,
    field: () => dialog().querySelector<HTMLInputElement>("[data-k=source]")!,
    addButton: () => dialog().querySelector<HTMLButtonElement>("[data-k=add]")!,
    rows: () => [...dialog().querySelectorAll<HTMLElement>("[data-k=folder-row]")],
    dialog,
  };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

const names = (rows: HTMLElement[]): string[] => rows.map(row => row.querySelector("span")!.textContent!);

afterEach(() => {
  cleanup();
  useStore.setState({ api: null, places: [], projects: [] } as never);
});

describe("Add a project", () => {
  it("opens on the repos this computer holds, their paths from the home folder and their branch, and a recorded one reads added", async () => {
    const t = mount({ projects: [recorded("/Users/dev/code/wsp")] });
    await settle();
    expect(t.hostFolders).toHaveBeenCalledWith(undefined, false, true);
    expect(names(t.rows())).toEqual(["spoo", "wsp", "notes"]);
    expect(t.rows()[0]!.textContent).toBe("spoo~/code/spoomain");
    expect(t.rows()[1]!.textContent).toContain(ADD_PROJECT_WORDS.added);
    expect(t.rows()[1]!.getAttribute("aria-disabled")).toBe("true");
    expect(t.field().placeholder).toBe(ADD_PROJECT_WORDS.search);
  });

  it("adds a repo on a click as a project of this computer and closes; a repo already recorded adds nothing", async () => {
    const t = mount({ projects: [recorded("/Users/dev/code/wsp")] });
    await settle();
    fireEvent.click(t.rows()[1]!);
    await settle();
    expect(t.addProject).not.toHaveBeenCalled();
    fireEvent.click(t.rows()[0]!);
    await settle();
    expect(t.addProject).toHaveBeenCalledWith("/Users/dev/code/spoo", undefined);
    expect(t.onClose).toHaveBeenCalled();
    expect(t.setPreferences).not.toHaveBeenCalled();
  });

  it("searches the repos by path as the person types, says so when none match, and Enter adds the lit row", async () => {
    const t = mount();
    await settle();
    fireEvent.change(t.field(), { target: { value: "wsp" } });
    expect(names(t.rows())).toEqual(["wsp"]);
    fireEvent.change(t.field(), { target: { value: "nothing-like-it" } });
    expect(t.rows()).toHaveLength(0);
    expect(t.dialog().textContent).toContain(ADD_PROJECT_WORDS.noMatch);
    fireEvent.change(t.field(), { target: { value: "code" } });
    fireEvent.keyDown(t.field(), { key: "ArrowDown" });
    fireEvent.keyDown(t.field(), { key: "Enter" });
    await settle();
    expect(t.addProject).toHaveBeenCalledWith("/Users/dev/code/wsp", undefined);
  });

  it("walks the disk from a path typed from ~, one level filtered by the name being typed, and Enter on a plain folder goes into it", async () => {
    const t = mount();
    await settle();
    fireEvent.change(t.field(), { target: { value: "~/c" } });
    await settle();
    expect(t.hostFolders).toHaveBeenCalledWith("/Users/dev");
    expect(names(t.rows())).toEqual(["code", "cache"]);
    expect(t.dialog().textContent).toContain(ADD_PROJECT_WORDS.open);
    expect(t.addButton().disabled).toBe(true);
    fireEvent.keyDown(t.field(), { key: "Enter" });
    expect(t.field().value).toBe("~/code/");
    expect(t.addProject).not.toHaveBeenCalled();
  });

  it("says a repository address is cloned on a box, never on this computer, and holds Add", async () => {
    const t = mount({ places: [HERE, BOX] });
    await settle();
    fireEvent.change(t.field(), { target: { value: "https://github.com/dev/spoo.git" } });
    expect(t.rows()).toHaveLength(0);
    expect(t.dialog().textContent).toContain(ADD_PROJECT_WORDS.noCloneHere);
    expect(t.addButton().disabled).toBe(true);
  });

  it("lists this computer and every computer that runs workspaces, and on a box asks for an address and clones it there", async () => {
    const t = mount({ places: [HERE, BOX, CLOUD, IDLE] });
    await settle();
    const column = [...t.dialog().querySelectorAll<HTMLElement>("[data-k^=computer-]")].map(el => el.dataset["k"]);
    expect(column).toEqual(["computer-here", "computer-p_1", "computer-p_2"]);
    fireEvent.click(t.dialog().querySelector("[data-k=computer-p_1]")!);
    expect(t.field().placeholder).toBe(ADD_PROJECT_WORDS.addressOnly);
    expect(t.dialog().textContent).toContain(ADD_PROJECT_WORDS.boxSays("spoo"));
    fireEvent.change(t.field(), { target: { value: "https://github.com/dev/spoo.git" } });
    const clone = t.dialog().querySelector<HTMLElement>("[data-k=clone]")!;
    expect(clone.textContent).toBe(ADD_PROJECT_WORDS.cloneLine("https://github.com/dev/spoo.git", "spoo"));
    fireEvent.click(t.addButton());
    await settle();
    expect(t.addProject).toHaveBeenCalledWith("https://github.com/dev/spoo.git", "p_1");
  });

  it("says a provider clones from an address", async () => {
    const t = mount({ places: [HERE, CLOUD] });
    await settle();
    fireEvent.click(t.dialog().querySelector("[data-k=computer-p_2]")!);
    expect(t.dialog().textContent).toMatch(/clones a project from its repository address/);
  });

  it("Add a computer closes the dialog and opens that sheet", async () => {
    const t = mount();
    await settle();
    fireEvent.click(t.dialog().querySelector("[data-k=add-computer]")!);
    expect(t.onClose).toHaveBeenCalled();
    expect(t.openAddComputer).toHaveBeenCalled();
  });

  it("writes the look picked for the new project once it is recorded", async () => {
    const t = mount();
    await settle();
    await pickOption(t.dialog().querySelector("[data-k=project-hue]")!, "Blue");
    await waitFor(() => expect(t.dialog().querySelector("[data-k=project-hue]")!.textContent).toBe("Blue"));
    fireEvent.click(t.rows()[0]!);
    await settle();
    expect(t.setPreferences).toHaveBeenCalledWith({ projectLook: { pr_1: { icon: "folder", hue: "blue" } } });
  });

  it("puts the runtime's refusal in the foot and stays open", async () => {
    const t = mount({
      add: async () => {
        throw new Error("/Users/dev/notes is not a git repository");
      },
    });
    await settle();
    fireEvent.click(t.rows()[2]!);
    await settle();
    expect(within(t.dialog()).getByText("/Users/dev/notes is not a git repository").dataset["k"]).toBe("add-project-refusal");
    expect(t.onClose).not.toHaveBeenCalled();
  });
});
