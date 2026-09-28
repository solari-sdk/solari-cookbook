// SPDX-License-Identifier: AGPL-3.0-only
// Where the panes are rooted: the thread's folder as it moves, unless pinned.
import { beforeEach, describe, expect, it } from "vitest";
import { folderCrumbs, parentWithin, rootOf, rootsOf, selectRoot, threadStart, useRootStore } from "../src/files/root.js";

const WS = "ws_root";
const root = () => selectRoot(useRootStore.getState().byWorkspaceId, WS, ["/root"]);

beforeEach(() => useRootStore.setState({ byWorkspaceId: {} }));

describe("pane root", () => {
  it("is the daemon root until a thread names a folder, then follows every change", () => {
    expect(selectRoot({}, WS, [])).toBeNull();
    expect(root()).toBe("/root");
    useRootStore.getState().follow(WS, "/root/app");
    expect(root()).toBe("/root/app");
    useRootStore.getState().follow(WS, "/root/app/packages/web");
    expect(root()).toBe("/root/app/packages/web");
    expect(selectRoot(useRootStore.getState().byWorkspaceId, "ws_other", ["/root"])).toBe("/root");
  });

  it("stays where it was pinned while the thread moves, and follows again when unpinned", () => {
    useRootStore.getState().follow(WS, "/root/app");
    useRootStore.getState().pin(WS, "/root/app/docs");
    expect(root()).toBe("/root/app/docs");
    useRootStore.getState().follow(WS, "/root/elsewhere");
    expect(root()).toBe("/root/app/docs");
    expect(useRootStore.getState().byWorkspaceId[WS]!.followed).toBe("/root/elsewhere");
    useRootStore.getState().unpin(WS);
    expect(root()).toBe("/root/elsewhere");
  });

  it("does not produce a new state for a folder already followed", () => {
    useRootStore.getState().follow(WS, "/root/app");
    const before = useRootStore.getState().byWorkspaceId;
    useRootStore.getState().follow(WS, "/root/app");
    expect(useRootStore.getState().byWorkspaceId).toBe(before);
  });
});

describe("the agent's shell folder", () => {
  it("roots the panes over the thread's folder, and clears when the thread does", () => {
    useRootStore.getState().follow(WS, "/root");
    useRootStore.getState().shell(WS, "/root/2048");
    expect(root()).toBe("/root/2048");
    expect(useRootStore.getState().byWorkspaceId[WS]!.followed).toBe("/root");
    useRootStore.getState().shell(WS, null);
    expect(root()).toBe("/root");
  });

  it("loses to the pin, and is ignored outside the daemon's root", () => {
    useRootStore.getState().follow(WS, "/root");
    useRootStore.getState().pin(WS, "/root/docs");
    useRootStore.getState().shell(WS, "/root/2048");
    expect(root()).toBe("/root/docs");
    useRootStore.getState().unpin(WS);
    expect(root()).toBe("/root/2048");
    useRootStore.getState().shell(WS, "/tmp/scratch");
    expect(root()).toBe("/root");
    expect(selectRoot(useRootStore.getState().byWorkspaceId, WS, ["/"])).toBe("/tmp/scratch");
  });

  it("does not produce a new state for a shell folder already held", () => {
    useRootStore.getState().shell(WS, "/root/2048");
    const before = useRootStore.getState().byWorkspaceId;
    useRootStore.getState().shell(WS, "/root/2048");
    expect(useRootStore.getState().byWorkspaceId).toBe(before);
  });
});

describe("the folder chosen for the next thread", () => {
  it("is held per workspace until a project pick clears it, and moves the panes with it; a chosen folder is what the start names as cwd", () => {
    expect((useRootStore.getState().byWorkspaceId[WS] ?? { chosen: null }).chosen).toBeNull();
    useRootStore.getState().choose(WS, "/root/app");
    expect(useRootStore.getState().byWorkspaceId[WS]!.chosen).toBe("/root/app");
    expect(root()).toBe("/root/app");
    expect(threadStart("/root/app")).toEqual({ cwd: "/root/app" });
    useRootStore.getState().unchoose(WS);
    expect(useRootStore.getState().byWorkspaceId[WS]!.chosen).toBeNull();
    // A workspace holds one project, so a start that chose no folder names none and the runtime opens there.
    expect(threadStart(null)).toEqual({});
  });
});

describe("the browsable roots", () => {
  it("are the daemon's home and every project folder, home first and each once, and nothing before the hello", () => {
    expect(rootsOf(null, ["/Users/dev/wsp"])).toEqual([]);
    expect(rootsOf("/root", [])).toEqual(["/root"]);
    expect(rootsOf("/root", ["/Users/dev/wsp"])).toEqual(["/root", "/Users/dev/wsp"]);
    expect(rootsOf("/root", ["/root"])).toEqual(["/root"]);
    expect(rootsOf("/root", ["/root/work/proj", "/Users/dev/wsp", "/root/work/proj"])).toEqual(["/root", "/root/work/proj", "/Users/dev/wsp"]);
  });

  it("name the root a path sits in, the nearest when they nest, and none outside every root", () => {
    const roots = ["/root", "/Users/dev/wsp", "/root/work/proj"];
    expect(rootOf(roots, "/Users/dev/wsp/src/a.ts")).toBe("/Users/dev/wsp");
    expect(rootOf(roots, "/Users/dev/wsp")).toBe("/Users/dev/wsp");
    expect(rootOf(roots, "/root/work/proj/src")).toBe("/root/work/proj");
    expect(rootOf(roots, "/root/work")).toBe("/root");
    expect(rootOf(roots, "/Users/dev")).toBeNull();
    expect(rootOf(roots, "/Users/dev/wsp-other")).toBeNull();
  });

  it("name the folder above only while a root still holds it, so up stops at each root's edge", () => {
    const roots = ["/root", "/Users/dev/wsp"];
    expect(parentWithin(roots, "/root/app/lib")).toBe("/root/app");
    expect(parentWithin(roots, "/Users/dev/wsp/packages")).toBe("/Users/dev/wsp");
    expect(parentWithin(roots, "/root")).toBeNull();
    expect(parentWithin(roots, "/Users/dev/wsp")).toBeNull();
    expect(parentWithin(roots, "/tmp/scratch")).toBeNull();
    expect(parentWithin(["/"], "/")).toBeNull();
    expect(parentWithin(["/"], "/tmp")).toBe("/");
  });

  it("draw the shown folder as the root it sits in and one crumb per folder below it", () => {
    const roots = ["/root", "/Users/dev/wsp"];
    expect(folderCrumbs(roots, "/root")).toEqual([{ name: "/root", path: "/root" }]);
    expect(folderCrumbs(roots, "/root/app/lib")).toEqual([
      { name: "/root", path: "/root" },
      { name: "app", path: "/root/app" },
      { name: "lib", path: "/root/app/lib" },
    ]);
    expect(folderCrumbs(roots, "/Users/dev/wsp/packages")).toEqual([
      { name: "/Users/dev/wsp", path: "/Users/dev/wsp" },
      { name: "packages", path: "/Users/dev/wsp/packages" },
    ]);
    expect(folderCrumbs(roots, "/root/a//b")).toEqual([
      { name: "/root", path: "/root" },
      { name: "a", path: "/root/a" },
      { name: "b", path: "/root/a/b" },
    ]);
    // A folder no root holds is named once, as its own crumb; nothing above it is offered.
    expect(folderCrumbs(roots, "/tmp/scratch")).toEqual([{ name: "/tmp/scratch", path: "/tmp/scratch" }]);
    expect(folderCrumbs(["/"], "/tmp")).toEqual([{ name: "/", path: "/" }, { name: "tmp", path: "/tmp" }]);
  });

  it("let the agent's shell folder root the panes inside the imported project, as inside home", () => {
    useRootStore.getState().follow(WS, "/root");
    useRootStore.getState().shell(WS, "/Users/dev/wsp/packages");
    expect(root()).toBe("/root");
    expect(selectRoot(useRootStore.getState().byWorkspaceId, WS, ["/root", "/Users/dev/wsp"])).toBe("/Users/dev/wsp/packages");
  });
});
