// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, createContext, useContext, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type Capabilities, type ProjectView, type WorkspaceView , type WorkspaceLanding } from "@wsp/protocol";
import { workspaceActions } from "../actions/workspaceActions.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { hereWord } from "@wsp/protocol";
import { WorkspaceSidebar } from "./WorkspaceSidebar.js";
import { NEW_WORKSPACE, PROJECT_WORDS } from "./words.js";

// The triggers keep their elements and no popup mounts: Base UI's positioning against jsdom's zero-size rects
// costs seconds per open, and this file reads rows rather than popups.
vi.mock("../components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: () => null,
}));

// The switcher's menu on a plain open/closed context: Base UI's popover never settles under jsdom.
vi.mock("../components/ui/popover.js", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Popover = ({ children, open, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) => <Ctx.Provider value={{ open, set: onOpenChange }}>{children}</Ctx.Provider>;
  const PopoverTrigger = ({ children, render: element, disabled, ...props }: { children: ReactNode; render: ReactElement<Record<string, unknown>>; disabled?: boolean; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return cloneElement(element, { ...props, disabled, onClick: () => ctx.set(!ctx.open) }, children);
  };
  const PopoverPopup = ({ children }: { children: ReactNode }) => (useContext(Ctx).open ? <div role="dialog" data-slot="popover-popup">{children}</div> : null);
  return { Popover, PopoverTrigger, PopoverPopup };
});

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

const workspace = (id: string, name: string, projectId: string): WorkspaceView => ({
  id,
  name,
  kind: "local",
  machineId: "local",
  project: { id: projectId, name: projectId, path: `/Users/dev/${projectId}`, computer: "here" },
  phase: "running",
  golden: "",
  createdAt: "2026-09-17T01:00:00.000Z",
  copy: { road: "clonefile", path: "/Users/dev/spoo-pricing-page", source: "/Users/dev/spoo", base: "abc", branch: "agent/pricing-page", carried: "deps-and-config" },
  portBase: 3100,
});

const SHARES = { copies: true, ownNetwork: false } as unknown as Capabilities;
const landing: WorkspaceLanding = { name: "This Mac", capabilities: SHARES };

function mount({ projects, workspaces }: { projects: ProjectView[]; workspaces: WorkspaceView[] }) {
  const create = vi.fn(async (_project: string, name: string) => ({ ...workspace("ws_new", name, "pr_1") }));
  const api = {
    subscribe: () => () => {},
    listWorkspaces: async () => workspaces,
    listSessions: async () => [],
    watchStatuses: async () => [],
    capabilities: async () => SHARES,
    getGolden: async () => ({ head: null, versions: [] }),
    placesList: async () => ({ places: [], adds: [] }),
    projectsList: async () => projects,
    projectsAdd: async () => project("pr_new", "new"),
    projectsRemove: async () => {},
    workspacesLanding: async () => landing,
    createWorkspace: create,
    daemon: { open: () => () => {} },
  } as unknown as Api;
  useStore.setState({
    api,
    conn: "live",
    ready: true,
    projectsRead: true,
    workspaces,
    projects,
    statuses: {},
    sessions: {},
    launches: {},
    creations: [],
    places: [],
    landings: Object.fromEntries(projects.map(p => [p.id, landing])),
    selectedId: null,
    selectedThreadId: null,
    projectHome: null,
    projectsRefused: null,
    preferences: { ...DEFAULT_PREFERENCES, labs: true },
  } as never);
  render(
    <SidebarProvider defaultOpen>
      <WorkspaceSidebar />
    </SidebarProvider>,
  );
  return { create };
}

/** Every project row the sidebar drew, in order, by its name with the count beside it once its row is shut. */
const headers = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-row-id^=project\\:]")].map(row => `${row.querySelector("[data-project-name]")!.textContent}${row.querySelector("[data-project-count]")?.textContent ?? ""}`);
const rowIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map(row => row.dataset["rowId"] ?? "");
const rowOf = (text: string): HTMLElement => screen.getByText(text).closest<HTMLElement>("[data-sidebar-row]")!;
const depthOf = (text: string): number => Number(rowOf(text).dataset["depth"]);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useStore.setState({ api: null, projects: [], workspaces: [], landings: {} } as never);
});

describe("the sidebar under the four nouns", () => {
  it("draws one row per project with its workspaces one step in under it, opens its home on a click, shuts on the next and carries the count while shut", async () => {
    mount({ projects: [project("pr_1", "spoo"), project("pr_2", "wsp")], workspaces: [workspace("ws_a", "pricing page", "pr_1"), workspace("ws_b", "webhook retries", "pr_1")] });
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    expect(headers()).toEqual(["spoo", "wsp"]);
    expect(screen.queryByLabelText("Workspaces")).toBeNull();
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "ws:ws_b", "project:pr_2"]);
    expect(depthOf("spoo")).toBe(0);
    expect(depthOf("pricing page")).toBe(1);
    // A project row is two lines, its computer over its name, sentence case, no caps and no letter-spacing.
    expect(rowOf("spoo").className).toContain("h-13");
    expect(rowOf("spoo").querySelector("[data-project-computer]")!.textContent).toBe(hereWord(true));
    expect(rowOf("spoo").className).not.toMatch(/uppercase|tracking-/);
    expect(rowOf("spoo").querySelector("[data-project-name]")!.className).not.toMatch(/uppercase|tracking-/);
    // The count rides the row while its children are shut, so a shut project still says how much it holds.
    fireEvent.click(rowOf("spoo"));
    expect(useStore.getState().projectHome).toBe("pr_1");
    expect(headers()[0]).toBe("spoo");
    fireEvent.click(rowOf("spoo"));
    await waitFor(() => expect(headers()[0]).toBe("spoo2"));
    expect(rowIds()).toEqual(["project:pr_1", "project:pr_2"]);
  });

  it("says a project has no workspaces yet as one leaf under its row, and its plus opens the dialog with that project picked", async () => {
    mount({ projects: [project("pr_1", "spoo"), project("pr_2", "wsp")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    const leaf = screen.getByText(PROJECT_WORDS.noWorkspaces);
    expect(leaf.closest("li")!.parentElement!.previousElementSibling!.querySelector("[data-row-id='project:pr_2']")).not.toBeNull();
    expect(leaf.className).toContain("h-9");
    expect(leaf.className).toContain("px-2");
    // A sentence with a period is read, not glanced at: the sans in a quiet ink, never the mono.
    expect(leaf.className).toContain("text-[13px]");
    expect(leaf.className).toContain("text-muted-foreground");
    expect(leaf.className).not.toContain("font-mono");
    const plus = [...document.querySelectorAll<HTMLElement>(`[data-k=new-workspace]`)].find(el => el.dataset["project"] === "pr_2")!;
    // The plus sits in the row's frame and reads at rest as nothing at every width: the hover and the keyboard focus lift it.
    expect(plus.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(plus.className).toContain("group-hover/menu-item:opacity-100");
    expect(plus.getAttribute("aria-label")).toBe(NEW_WORKSPACE);
    fireEvent.click(plus);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(NEW_WORKSPACE);
    // Two projects are a segmented control, and the one whose plus was pressed is the checked segment.
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_2]")!.getAttribute("aria-checked")).toBe("true");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_1]")!.getAttribute("aria-checked")).toBe("false");
  });

  it("records another project from the foot of the switcher's menu, which opens the Add a project dialog, and from nowhere else at rest", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [] });
    await waitFor(() => expect(screen.getByText("spoo")).toBeDefined());
    expect(screen.queryByText(PROJECT_WORDS.add)).toBeNull();
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=project-switcher]")!);
    fireEvent.click(await screen.findByText(PROJECT_WORDS.add));
    await waitFor(() => expect(document.querySelector("[data-k=add-project]")).not.toBeNull());
    expect(screen.getByRole("dialog", { name: PROJECT_WORDS.add })).toBeDefined();
  });

  it("offers no Spaces row and no look action in a row's menu, whatever the preferences record says", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    expect(document.body.textContent).not.toContain("Spaces");
    expect(document.querySelector("[data-space-icon]")).toBeNull();
    // The registry itself no longer carries them, so no surface can offer one: no entry is held back by a flag.
    expect(workspaceActions.map(action => action.id)).not.toContain("icon");
    expect(workspaceActions.map(action => action.id)).not.toContain("theme");
    expect(workspaceActions.some(action => "labs" in action)).toBe(false);
  });

  it("draws a workspace an agent forked one step in under the thread that forked it, inside that thread's own item", async () => {
    const lead = workspace("ws_a", "pricing page", "pr_1");
    const forked = { ...workspace("ws_fork", "pricing table", "pr_1"), parentThreadId: "th_lead" };
    mount({ projects: [project("pr_1", "spoo")], workspaces: [lead, forked] });
    await act(async () => {
      useStore.setState({
        sessions: {
          ws_a: [{ id: "s_lead", workspaceId: "ws_a", threadId: "th_lead", harness: "claude", status: "running", prompt: "move the pricing table", startedBy: "person" }],
          ws_fork: [{ id: "s_child", workspaceId: "ws_fork", threadId: "th_child", harness: "claude", status: "running", prompt: "write the migration", startedBy: "agent", parentThreadId: "th_lead" }],
        },
      } as never);
    });
    await waitFor(() => expect(screen.getByText("move the pricing table")).toBeDefined());
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:th_lead", "ws:ws_fork", "thread:th_child"]);
    expect([depthOf("spoo"), depthOf("pricing page"), depthOf("move the pricing table"), depthOf("pricing table"), depthOf("write the migration")]).toEqual([0, 1, 2, 3, 4]);
    // Real nesting: the fork's block is a child of the thread's list item, so the rails can be drawn per item.
    const threadItem = rowOf("move the pricing table").closest("li[data-thread-item]")!;
    expect(threadItem.contains(rowOf("pricing table"))).toBe(true);
    expect(threadItem.contains(rowOf("write the migration"))).toBe(true);
    // Its row carries the same two lines a top-level row does, off its own record: the name and the branch.
    const row = rowOf("pricing table");
    expect(row.querySelector("[data-workspace-meta]")!.textContent).toBe("agent/pricing-page");
    expect(row.querySelector("[data-workspace-made-of]")).toBeNull();
  });

  it("keeps that forked workspace's row in its project's list whenever the thread that forked it is not drawn", async () => {
    const lead = workspace("ws_a", "pricing page", "pr_1");
    const forked = { ...workspace("ws_fork", "pricing table", "pr_1"), parentThreadId: "th_lead" };
    /** The opener settled long enough ago to sit in the archive, which is shut; the fork's own thread still runs. */
    const settledLongAgo = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
    mount({ projects: [project("pr_1", "spoo")], workspaces: [lead, forked] });
    await act(async () => {
      useStore.setState({
        sessions: {
          ws_a: [{ id: "s_lead", workspaceId: "ws_a", threadId: "th_lead", harness: "claude", status: "completed", prompt: "move the pricing table", startedBy: "person", startedAt: settledLongAgo, endedAt: settledLongAgo }],
          ws_fork: [{ id: "s_child", workspaceId: "ws_fork", threadId: "th_child", harness: "claude", status: "running", prompt: "write the migration", startedBy: "agent", parentThreadId: "th_lead" }],
        },
      } as never);
    });
    // The opener is in the shut archive, so no thread row carries it; the fork stands in the project's own list
    // with its own thread under it, where the plain rule puts it.
    await waitFor(() => expect(rowIds()).toContain("ws:ws_fork"));
    // The archive's fold alone, shut over the opener, since the shelf has no row of its own; then the fork's row.
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "archived:ws_a", "ws:ws_fork", "thread:th_child"]);
    expect(screen.queryByText("move the pricing table")).toBeNull();
    expect(screen.getByText("pricing table")).toBeDefined();
    expect(depthOf("pricing table")).toBe(1);
  });

  it("keeps it in the list while the opener's own workspace is collapsed, and nests it again when that opens", async () => {
    const lead = workspace("ws_a", "pricing page", "pr_1");
    const forked = { ...workspace("ws_fork", "pricing table", "pr_1"), parentThreadId: "th_lead" };
    mount({ projects: [project("pr_1", "spoo")], workspaces: [lead, forked] });
    await act(async () => {
      useStore.setState({
        sessions: {
          ws_a: [{ id: "s_lead", workspaceId: "ws_a", threadId: "th_lead", harness: "claude", status: "running", prompt: "move the pricing table", startedBy: "person" }],
          ws_fork: [{ id: "s_child", workspaceId: "ws_fork", threadId: "th_child", harness: "claude", status: "running", prompt: "write the migration", startedBy: "agent", parentThreadId: "th_lead" }],
        },
      } as never);
    });
    await waitFor(() => expect(screen.getByText("move the pricing table")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Collapse pricing page"));
    await waitFor(() => expect(screen.queryByText("move the pricing table")).toBeNull());
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "ws:ws_fork", "thread:th_child"]);
    fireEvent.click(screen.getByLabelText("Expand pricing page"));
    await waitFor(() => expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:th_lead", "ws:ws_fork", "thread:th_child"]));
  });

  it("keeps it in the list once the opener thread is forgotten, so no workspace the host holds loses its row", async () => {
    const lead = workspace("ws_a", "pricing page", "pr_1");
    const forked = { ...workspace("ws_fork", "pricing table", "pr_1"), parentThreadId: "th_lead" };
    mount({ projects: [project("pr_1", "spoo")], workspaces: [lead, forked] });
    await act(async () => {
      useStore.setState({
        sessions: {
          ws_a: [],
          ws_fork: [{ id: "s_child", workspaceId: "ws_fork", threadId: "th_child", harness: "claude", status: "running", prompt: "write the migration", startedBy: "agent", parentThreadId: "th_lead" }],
        },
      } as never);
    });
    await waitFor(() => expect(screen.getByText("write the migration")).toBeDefined());
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "ws:ws_fork", "thread:th_child"]);
  });
});
