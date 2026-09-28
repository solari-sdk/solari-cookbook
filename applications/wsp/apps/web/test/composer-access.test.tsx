// SPDX-License-Identifier: AGPL-3.0-only
// Which catalog answers the access pick for a workspace. Which mode a thread
// starts at is a fact about the kind of workspace it runs on: this computer and
// a fork wsp made run every action, a computer somebody owns asks first. The
// host-wide table was read against no workspace, so it answers the models and
// the efforts for a workspace whose own catalog is still on the way and answers
// no access at all, and the composer's defaults button carries no access until
// the workspace has spoken.
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceAccess, type HarnessCatalog, type WorkspaceView } from "@wsp/protocol";
import { harnessCatalog } from "@wsp/runtime";
import { catalogIn, catalogsIn, useStore } from "../src/protocol/store.js";
import { effectivePicks } from "../src/components/chat/composerPicks.js";
import { ComposerOptionPickers } from "../src/components/chat/ComposerOptionPickers.js";
import type { ChatThreadHandle, ChatThreadView } from "../src/components/chat/useChatThread.js";

const WS = "ws_a";

/** The runtime's own table, which is what the host answers before any machine has been asked. */
const TABLE = harnessCatalog("claude")!;
/** The same table as the runtime hands it out for a workspace on this computer, and for one on a computer the
 * person owns, where a thread asks before it acts. */
const THIS_MAC = workspaceAccess(TABLE, "local");
const OWN_BOX = workspaceAccess(TABLE, "ssh");
/** And for a machine wsp forked, where the pick that asks nothing names no computer of theirs. */
const FORK = workspaceAccess(TABLE, "cloud");

interface Catalogs {
  harnesses: HarnessCatalog[];
  harnessesByWorkspace: Record<string, HarnessCatalog[]>;
}

const store = (byWorkspace?: HarnessCatalog[]): Catalogs => ({ harnesses: [TABLE], harnessesByWorkspace: byWorkspace === undefined ? {} : { [WS]: byWorkspace } });

/** What the access button would read: the pick the composer resolves off the catalog answering for this workspace. */
const access = (catalogs: Catalogs): string | null => {
  const catalog = catalogIn(catalogs, WS, "claude");
  return catalog === null ? null : effectivePicks(catalog, { picked: {}, thread: {} }).permissionMode;
};

describe("the access pick reads the workspace's own catalog and no other", () => {
  it("has no value for a workspace whose catalog has not arrived", () => {
    expect(access(store())).toBeNull();
    // The guard the composer draws the button behind, so there is no button to click either.
    expect(catalogIn(store(), WS, "claude")?.permissionModes).toEqual([]);
    // Everything the table does answer without a machine still reads, so the rest of the row is unchanged.
    expect(catalogIn(store(), WS, "claude")?.models).toEqual(TABLE.models);
    expect(catalogIn(store(), WS, "claude")?.efforts).toEqual(TABLE.efforts);
  });

  it("reads Bypass on this computer, where the person asked for no prompts", () => {
    expect(access(store([THIS_MAC]))).toBe("bypassPermissions");
  });

  it("reads Default on a computer the person owns and works on", () => {
    expect(access(store([OWN_BOX]))).toBe("default");
  });

  it("reads what a fork's own catalog marks", () => {
    expect(access(store([FORK]))).toBe("bypassPermissions");
  });

  it("hands back one array per reading, so the composer's selector settles", () => {
    const catalogs = store();
    expect(catalogsIn(catalogs, WS)).toBe(catalogsIn(catalogs, WS));
  });
});

const view: ChatThreadView = {
  entries: [],
  turns: [],
  latestTurn: null,
  running: false,
  activeTurnStartedAt: null,
  settled: null,
  cwd: null,
  shellCwd: null,
  harness: null,
  model: null,
  agent: null,
  permissionMode: null,
};

const handle = { view, hydrated: true, busy: false, sending: false, fresh: true, resume: null, thread: "t1", threadKey: "t1", named: null } as unknown as ChatThreadHandle;

const WORKSPACE: WorkspaceView = { id: WS, name: "api", machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };

const accessButton = () => document.querySelector<HTMLElement>('[data-composer-picker="access"]');

describe("the composer's access button", () => {
  afterEach(() => act(() => useStore.setState({ harnesses: [], harnessesByWorkspace: {}, workspaces: [], sessions: {} })));

  it("is not drawn at all until the workspace's catalog lands, and then reads what that workspace starts a thread at", () => {
    act(() => useStore.setState({ harnesses: [TABLE], harnessesByWorkspace: {}, workspaces: [WORKSPACE], sessions: {} }));
    const drawn = render(<ComposerOptionPickers workspaceId={WS} thread={handle} onPickAccess={() => {}} onOtherFolder={() => {}} />);
    // The model button is there, so the row is drawn and it is the access one alone that is missing.
    expect(document.querySelector('[data-composer-picker="model"]')).not.toBeNull();
    expect(accessButton()?.dataset["access"]).toBeUndefined();

    act(() => useStore.setState({ harnessesByWorkspace: { [WS]: [THIS_MAC] } }));
    expect(accessButton()?.dataset["access"]).toBe("bypassPermissions");
    // The button wears the CLI's own short word; the machine it names is read in the menu.
    expect(accessButton()?.textContent).toBe("Bypass");
    drawn.unmount();
  });
});
