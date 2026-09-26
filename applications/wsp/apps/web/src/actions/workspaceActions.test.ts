// SPDX-License-Identifier: AGPL-3.0-only
// Two rows of the workspace registry. Bring back: work leaves a workspace
// through git, so the entry pushes the agent's branch and opens its pull
// request, and what comes back is the row's third line. Delete: the one road
// out of a workspace whose machine is still there, in that kind's own words.
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceView } from "@wsp/protocol";
import { actionById, resolveActions } from "./registry.js";
import { workspaceActions, workspaceTarget, type WorkspaceVerbs } from "./workspaceActions.js";
import { BRING_BACK_HINT, broughtBackRowLine, DELETE_HINT, WORKSPACE_WORDS } from "./format.js";
import { WHERE_WORDS } from "../settings/format.js";
import { workspaceMetaLine, workspaceMetaTitle } from "../sidebar/workspaceRows.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";

const workspace = (phase: WorkspaceView["phase"]): WorkspaceView =>
  ({ id: "ws_a", name: "pricing page", machineId: "m_a", phase, project: { id: "pr_1", name: "repo", path: "/root", computer: "here" }, createdAt: "t", kind: "cloud" }) as WorkspaceView;

const verbs = (over: Partial<WorkspaceVerbs> = {}): WorkspaceVerbs =>
  ({
    togglePhase: vi.fn(async () => {}),
    openTerminal: vi.fn(async () => {}),
    openBrowser: vi.fn(),
    newThread: vi.fn(),
    copyText: vi.fn(async () => {}),
    bringBack: vi.fn(async () => {}),
    ...over,
  }) as WorkspaceVerbs;

const entry = (phase: WorkspaceView["phase"], over: Partial<WorkspaceVerbs> = {}) =>
  actionById(resolveActions(workspaceActions, workspaceTarget(workspace(phase), null, []), verbs(over)), "bring-back");

const back = { branch: "agent/pricing-page", base: "main", ahead: 2, uncommitted: 0, stat: [] };

describe("bring back on the workspace row", () => {
  it("is in the registry under the project group, with its own words", () => {
    const action = entry("running");
    expect(action.title).toBe(WORKSPACE_WORDS.bringBack);
    expect(action.group).toBe("project");
    expect(action.rowLabel).toBe("Bring back pricing page");
    expect(action.hint).toBe(BRING_BACK_HINT);
  });

  it("runs the verb for its own workspace while the machine is running", async () => {
    const run = vi.fn(async () => {});
    const action = entry("running", { bringBack: run });
    expect(action.refusal).toBeNull();
    await action.run();
    expect(run).toHaveBeenCalledWith("ws_a");
  });

  it("is held with the roadless words on a client whose host carries no such request", () => {
    expect(entry("running", { bringBack: undefined }).refusal).toBe(WHERE_WORDS.notYet);
  });

  it("is held on a machine that is not running, in the words every machine action is held in", () => {
    expect(entry("napping").refusal).toBe("Workspace is paused; wake it to bring back");
  });

  it("says pull request in full on the row's third line, and what happened where there is none", () => {
    expect(broughtBackRowLine({ ...back, pr: { number: 12, url: "https://example/pr/12", state: "open", host: "github.com" } })).toBe("agent/pricing-page: pull request #12 open");
    // The honest half reads on the row; the host's own sentence for why is longer than any row and rides the hover.
    expect(broughtBackRowLine({ ...back, note: "no gh on this computer" })).toBe("agent/pricing-page pushed, no pull request");
    expect(broughtBackRowLine(back)).toBe("agent/pricing-page pushed");
  });

  it("stands on the row in place of the branch, and yields to the one sentence a person is waiting on", () => {
    const project = {
      state: "running",
      status: null,
      reach: null,
      threads: [],
      workspace: { ...workspace("running"), copy: { road: "clonefile", path: "/root-copy", branch: "agent/pricing-page" } },
    } as unknown as SidebarProjectSnapshot;
    const answer = { ...back, pr: { number: 12, url: "https://example/pr/12", state: "open" as const, host: "github.com" } };
    expect(workspaceMetaLine({ project, outOfMemory: undefined })).toBe("agent/pricing-page");
    expect(workspaceMetaLine({ project, outOfMemory: undefined, broughtBack: answer })).toBe("agent/pricing-page: pull request #12 open");
    const asking = { ...project, threads: [{ asking: "Write out.txt in root (2 B)" }] } as unknown as SidebarProjectSnapshot;
    expect(workspaceMetaLine({ project: asking, outOfMemory: undefined, broughtBack: answer })).toBe("Write out.txt in root (2 B)");
  });

  it("puts the host's own sentence for a push with no pull request on the row's hover, never in the line", () => {
    const project = {
      state: "running",
      status: null,
      reach: null,
      threads: [],
      workspace: { ...workspace("running"), copy: { road: "clonefile", path: "/root-copy", branch: "agent/pricing-page" } },
    } as unknown as SidebarProjectSnapshot;
    const note = "no signed-in command line for github.com is on this computer; the branch is pushed and the pull request waits for one";
    const pushed = { project, outOfMemory: undefined, broughtBack: { ...back, note } };
    expect(workspaceMetaLine(pushed)).toBe("agent/pricing-page pushed, no pull request");
    expect(workspaceMetaTitle(pushed)).toBe(`agent/pricing-page pushed, no pull request: ${note}`);
    // A line that is not a bring back's carries no note behind it.
    expect(workspaceMetaTitle({ project, outOfMemory: undefined })).toBe("agent/pricing-page");
  });
});

const deleteEntry = (phase: WorkspaceView["phase"], over: Partial<WorkspaceVerbs> = {}) =>
  actionById(resolveActions(workspaceActions, workspaceTarget(workspace(phase), null, []), verbs(over)), "delete");

describe("delete on the workspace row", () => {
  it("is a destructive row in the remove group whose hover says what goes with the machine", () => {
    const action = deleteEntry("running");
    expect(action.title).toBe(WORKSPACE_WORDS.delete);
    expect(action.group).toBe("remove");
    expect(action.destructive).toBe(true);
    expect(action.rowLabel).toBe("Delete pricing page");
    expect(action.hint).toBe(DELETE_HINT("cloud"));
  });

  it("names the copy that goes on a workspace that is a copy of a project folder", () => {
    const copied = { ...workspace("running"), kind: "local", copy: { road: "clonefile", path: "/Users/dev/repo-fix", source: "/Users/dev/repo", base: "0".repeat(40), branch: "main", carried: "deps-and-config" } } as WorkspaceView;
    const action = actionById(resolveActions(workspaceActions, workspaceTarget(copied, null, []), verbs()), "delete");
    expect(action.hint).toBe("Its copy at /Users/dev/repo-fix is removed and the project folder is left as it is");
  });

  it("opens the confirmation for its own workspace, and says so on a client that cannot delete", async () => {
    const open = vi.fn();
    const action = deleteEntry("running", { deleteWorkspace: open });
    expect(action.refusal).toBeNull();
    await action.run();
    expect(open).toHaveBeenCalledWith("ws_a");
    expect(deleteEntry("running", { deleteWorkspace: undefined }).refusal).toBe("This client cannot delete tasks");
  });
});
