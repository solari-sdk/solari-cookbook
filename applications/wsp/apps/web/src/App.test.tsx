// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectView, WorkspaceView } from "@wsp/protocol";
import { Shell } from "./App.js";
import type { Api } from "./protocol/client.js";
import { useStore } from "./protocol/store.js";
import { FIRST_RUN_WORDS } from "./sidebar/words.js";

const project: ProjectView = { id: "pr_1", name: "spoo", computer: "here", source: { kind: "folder", path: "/Users/dev/spoo" }, path: "/Users/dev/spoo", remote: "https://github.com/dev/spoo.git", defaultBranch: "main", memoryKey: "-Users-dev-spoo", memoryDir: "/Users/dev/.claude-cfg/projects/-Users-dev-spoo/memory", createdAt: "t" };
const workspace: WorkspaceView = {
  id: "ws_a",
  name: "pricing page",
  kind: "local",
  machineId: "local",
  project: { id: "pr_1", name: "spoo", path: "/Users/dev/spoo", computer: "here" },
  phase: "running",
  golden: "",
  createdAt: "t",
};

function mount({ projects, workspaces, projectsRead = true }: { projects: ProjectView[]; workspaces: WorkspaceView[]; projectsRead?: boolean }) {
  useStore.setState({
    api: { subscribe: () => () => {}, sessionHistory: async () => [], initGet: async () => ({ keys: { solari: false }, home: "/Users/dev", agents: [], pricing: null, job: null }) } as unknown as Api,
    ready: true,
    projectsRead,
    projects,
    workspaces,
    statuses: {},
    sessions: {},
    places: [],
    landings: {},
    selectedId: null,
    selectedThreadId: null,
    settingsOpen: false,
    creations: [],
  } as never);
  render(<Shell />);
}

afterEach(() => {
  cleanup();
  useStore.setState({ api: null, projects: [], workspaces: [], projectsRead: false } as never);
});

describe("what the centre of the window shows", () => {
  it("is the first run while this wsp holds no project and no workspace", () => {
    mount({ projects: [], workspaces: [] });
    expect(screen.getByText(FIRST_RUN_WORDS.title)).toBeDefined();
  });

  it("is nothing at all until the host has answered about the projects, so that screen never paints over work", () => {
    mount({ projects: [], workspaces: [], projectsRead: false });
    expect(screen.queryByText(FIRST_RUN_WORDS.title)).toBeNull();
    expect(document.querySelector("[data-k=project-home]")).toBeNull();
  });

  it("is not the first run while a workspace stands, whose project record has not arrived yet, and no project's home either", () => {
    mount({ projects: [], workspaces: [workspace] });
    expect(screen.queryByText(FIRST_RUN_WORDS.title)).toBeNull();
    expect(document.querySelector("[data-k=project-home]")).toBeNull();
  });

  it("is the first project's home once there is a project and nothing is picked, never a line that asks for a pick", () => {
    mount({ projects: [project], workspaces: [workspace] });
    expect(document.querySelector("[data-k=project-home]")).not.toBeNull();
    expect(screen.queryByText(FIRST_RUN_WORDS.title)).toBeNull();
    expect(screen.queryByText("Pick a workspace to continue")).toBeNull();
  });
});
