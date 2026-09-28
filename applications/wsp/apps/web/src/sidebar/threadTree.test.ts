// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { ProjectView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { forkedWorkspaces, nestedWorkspaces, projectGroups, threadTree } from "./threadTree";

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

const thread = (id: string, workspaceId: string, parentThreadId: string | null = null): SidebarThreadSnapshot =>
  ({ id, threadId: id, sessionId: `s_${id}`, workspaceId, title: id, status: "running", parentThreadId, asking: null }) as unknown as SidebarProjectSnapshot["threads"][number];

const row = (id: string, projectId: string, threads: SidebarThreadSnapshot[] = [], parentThreadId?: string): SidebarProjectSnapshot =>
  ({
    id,
    displayName: id,
    threads,
    workspace: { id, project: { id: projectId, name: projectId, path: "/root", computer: "here" }, ...(parentThreadId === undefined ? {} : { parentThreadId }) },
  }) as unknown as SidebarProjectSnapshot;

describe("the projects the sidebar draws", () => {
  it("keeps the host's own order, holds every project's workspaces under it, and keeps a project nobody has started work on", () => {
    const groups = projectGroups([project("pr_1", "spoo"), project("pr_2", "wsp")], [row("ws_a", "pr_1"), row("ws_b", "pr_1")]);
    expect(groups.map(g => [g.project.name, g.workspaces.map(w => w.id)])).toEqual([
      ["spoo", ["ws_a", "ws_b"]],
      ["wsp", []],
    ]);
  });

  it("keeps a workspace whose project the host's list has not answered for, off the record the row itself carries", () => {
    const groups = projectGroups([], [row("ws_a", "pr_1")]);
    expect(groups.map(g => [g.project.id, g.workspaces.map(w => w.id)])).toEqual([["pr_1", ["ws_a"]]]);
  });

  it("leaves a workspace an agent forked out of the project's own list while the thread that forked it has a row", () => {
    const rows = [row("ws_a", "pr_1", [thread("lead", "ws_a")]), row("ws_fork", "pr_1", [], "lead")];
    const nested = nestedWorkspaces(rows, [{ workspace: "ws_a", threads: ["lead"] }, { workspace: "ws_fork", threads: [] }]);
    expect([...nested]).toEqual(["ws_fork"]);
    expect(projectGroups([project("pr_1", "spoo")], rows, nested).map(g => g.workspaces.map(w => w.id))).toEqual([["ws_a"]]);
    expect(forkedWorkspaces(rows, "lead", nested).map(w => w.id)).toEqual(["ws_fork"]);
    expect(forkedWorkspaces([row("ws_a", "pr_1")], "lead", nested)).toEqual([]);
  });
});

describe("a workspace an agent forked has one row whatever is shut", () => {
  const lead = () => row("ws_a", "pr_1", [thread("lead", "ws_a")]);
  const fork = () => row("ws_fork", "pr_1", [thread("builder", "ws_fork", "lead")], "lead");
  /** Where the rows stand: the project's own list, and the forks that nest under a thread. */
  const stands = (shown: { workspace: string; threads: string[] }[]) => {
    const rows = [lead(), fork()];
    const nested = nestedWorkspaces(rows, shown);
    return {
      list: projectGroups([project("pr_1", "spoo")], rows, nested).flatMap(g => g.workspaces.map(w => w.id)),
      under: forkedWorkspaces(rows, "lead", nested).map(w => w.id),
    };
  };

  it("nests under its opener while that thread's row is drawn", () => {
    expect(stands([{ workspace: "ws_a", threads: ["lead"] }, { workspace: "ws_fork", threads: ["builder"] }])).toEqual({ list: ["ws_a"], under: ["ws_fork"] });
  });

  it("stands in its project's list while the opener's shelf is shut over it", () => {
    // The opener settled and the shelf holding it is shut: the body draws no row for it.
    expect(stands([{ workspace: "ws_a", threads: [] }, { workspace: "ws_fork", threads: ["builder"] }])).toEqual({ list: ["ws_a", "ws_fork"], under: [] });
  });

  it("stands in the list while the opener sits in a shut archive", () => {
    expect(stands([{ workspace: "ws_a", threads: [] }])).toEqual({ list: ["ws_a", "ws_fork"], under: [] });
  });

  it("stands in the list once the opener is forgotten, which leaves no thread to nest under", () => {
    const rows = [row("ws_a", "pr_1", []), fork()];
    const nested = nestedWorkspaces(rows, [{ workspace: "ws_a", threads: [] }, { workspace: "ws_fork", threads: ["builder"] }]);
    expect(nested.size).toBe(0);
    expect(projectGroups([project("pr_1", "spoo")], rows, nested).flatMap(g => g.workspaces.map(w => w.id))).toEqual(["ws_a", "ws_fork"]);
  });

  it("stands in the list while the opener's own workspace is collapsed", () => {
    expect(stands([{ workspace: "ws_a", threads: [] }, { workspace: "ws_fork", threads: [] }])).toEqual({ list: ["ws_a", "ws_fork"], under: [] });
  });

  it("falls back with its own fork behind it: a fork of a fork whose chain is broken stands in the list too", () => {
    const rows = [lead(), fork(), row("ws_deep", "pr_1", [], "builder")];
    // Nothing of the lead's threads is drawn, so neither the fork nor the fork's own fork can nest.
    const shut = nestedWorkspaces(rows, [{ workspace: "ws_a", threads: [] }, { workspace: "ws_fork", threads: ["builder"] }, { workspace: "ws_deep", threads: [] }]);
    expect(projectGroups([project("pr_1", "spoo")], rows, shut).flatMap(g => g.workspaces.map(w => w.id))).toEqual(["ws_a", "ws_fork", "ws_deep"]);
    // With the chain drawn, both nest: the fork under the lead's thread and the deep one under the fork's.
    const open = nestedWorkspaces(rows, [{ workspace: "ws_a", threads: ["lead"] }, { workspace: "ws_fork", threads: ["builder"] }, { workspace: "ws_deep", threads: [] }]);
    expect([...open].sort()).toEqual(["ws_deep", "ws_fork"]);
    expect(projectGroups([project("pr_1", "spoo")], rows, open).flatMap(g => g.workspaces.map(w => w.id))).toEqual(["ws_a"]);
  });
});

describe("the threads of a workspace an agent forked", () => {
  it("stay on that workspace rather than joining the rows of the workspace the forking thread runs on", () => {
    const lead = row("ws_a", "pr_1", [thread("lead", "ws_a")]);
    const forked = row("ws_fork", "pr_1", [thread("builder", "ws_fork", "lead")], "lead");
    expect(threadTree([lead, forked]).map(group => [group.project.id, group.threads.map(t => t.id)])).toEqual([
      ["ws_a", ["lead"]],
      ["ws_fork", ["builder"]],
    ]);
  });

  it("while a thread an agent opened on another workspace that is not a fork still joins its opener's rows", () => {
    const lead = row("ws_a", "pr_1", [thread("lead", "ws_a")]);
    const other = row("ws_b", "pr_1", [thread("helper", "ws_b", "lead")]);
    expect(threadTree([lead, other]).map(group => [group.project.id, group.threads.map(t => t.id)])).toEqual([
      ["ws_a", ["lead", "helper"]],
      ["ws_b", []],
    ]);
  });
});
