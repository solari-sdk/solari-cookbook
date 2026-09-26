// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { THIS_COMPUTER, type Capabilities, type ProjectCopy, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { branchLine, madeOfLine, whereWord, workspaceMetaLine } from "./workspaceRows";

const workspace = (over: Partial<WorkspaceView>): WorkspaceView =>
  ({ id: "ws_1", name: "a", machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-12T00:00:00.000Z", ...over }) as WorkspaceView;

const copy = (over: Partial<ProjectCopy> = {}): ProjectCopy => ({
  road: "clonefile",
  path: "/Users/dev/spoo-pricing-page",
  source: "/Users/dev/spoo",
  base: "abc",
  branch: "agent/pricing-page",
  carried: "deps-and-config",
  ...over,
});

/** What a computer that copies by directory and shares its network says about itself, which is this Mac. */
const SHARES: Pick<Capabilities, "copies" | "ownNetwork"> = { copies: true, ownNetwork: false };
const OWN: Pick<Capabilities, "copies" | "ownNetwork"> = { copies: false, ownNetwork: true };

const row = (over: Partial<WorkspaceView>): Pick<SidebarProjectSnapshot, "workspace"> => ({ workspace: workspace(over) });

describe("what a workspace row says it is made of", () => {
  it("joins the copy word, the computer where it is not this one, and the ports word, all off the protocol's table", () => {
    expect(madeOfLine({ project: row({ copy: copy({ road: "worktree" }) }), landing: SHARES, computer: null })).toEqual(["a copy", "shares this Mac's ports"]);
    expect(madeOfLine({ project: row({ copy: copy(), portBase: 3100 }), landing: SHARES, computer: null })).toEqual(["a copy", "shares this Mac's ports, PORT 3100"]);
    expect(madeOfLine({ project: row({ copy: copy(), portBase: 3100 }), landing: OWN, computer: "spoo" })).toEqual(["a copy", "spoo", "own network"]);
  });

  it("says the network alone for a fork, which has no copy of a folder on any computer", () => {
    expect(madeOfLine({ project: row({}), landing: OWN, computer: "solari" })).toEqual(["solari", "own network"]);
  });

  it("says nothing about the network until the host has answered where this project lands", () => {
    expect(madeOfLine({ project: row({ copy: copy(), portBase: 3100 }), landing: null, computer: null })).toEqual(["a copy"]);
    expect(madeOfLine({ project: row({ copy: copy() }), landing: null, computer: "spoo" })).toEqual(["a copy", "spoo"]);
  });

  it("carries no figure of any kind: a machine's shape and its cost are its computer's row in Settings", () => {
    const line = madeOfLine({ project: row({ copy: copy(), portBase: 3100 }), landing: SHARES, computer: null });
    expect(line.join(" ")).not.toMatch(/\$|GB|cores|vCPU/);
  });
});

describe("the workspace row's third line", () => {
  const snapshot = (over: Partial<WorkspaceView>, threads: { asking: string | null }[] = [], status: Partial<WorkspaceStatus> | null = null) =>
    ({
      state: "running",
      status: status === null ? null : ({ ...workspace(over), machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0, ...status } as WorkspaceStatus),
      reach: "reachable",
      workspace: workspace(over),
      threads,
    }) as unknown as SidebarProjectSnapshot;

  it("is the branch the copy stands on where the record carries one, and empty where it carries none", () => {
    expect(branchLine(row({ copy: copy() }))).toBe("agent/pricing-page");
    expect(branchLine(row({}))).toBe("");
    expect(workspaceMetaLine({ project: snapshot({ copy: copy() }), outOfMemory: undefined })).toBe("agent/pricing-page");
    expect(workspaceMetaLine({ project: snapshot({}), outOfMemory: undefined })).toBe("");
  });

  it("gives the line to the one sentence a person is waiting on while there is one, and never to a figure", () => {
    const asked = [{ asking: "Write out.txt in root (2 B)" }];
    expect(workspaceMetaLine({ project: snapshot({ copy: copy() }, asked), outOfMemory: undefined })).toBe("Write out.txt in root (2 B)");
    expect(workspaceMetaLine({ project: snapshot({ copy: copy(), daemonNote: "updating the helper" }), outOfMemory: undefined })).toBe("updating the helper");
    expect(workspaceMetaLine({ project: snapshot({ copy: copy() }), outOfMemory: undefined })).not.toMatch(/\$|today|naps/);
  });
});

describe("where a row says a workspace runs", () => {
  it("reads the live record's provider, and the computer the host runs on in that machine's own words", () => {
    expect(whereWord({ workspace: workspace({ kind: "cloud", provider: "solari" }), status: null })).toBe("solari");
    expect(whereWord({ workspace: workspace({ kind: "local" }), status: null })).toBe(THIS_COMPUTER);
    expect(whereWord({ workspace: workspace({ kind: "local" }), status: { machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, facts: { os: "macOS 26.4" } } as WorkspaceStatus })).toBe("this Mac");
  });
});
