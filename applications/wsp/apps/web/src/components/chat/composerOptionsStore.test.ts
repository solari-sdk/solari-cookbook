// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import { useComposerOptionsStore } from "./composerOptionsStore";

const KEY = useComposerOptionsStore.persist.getOptions().name!;

/** What another tab, an older build or a hand-edited profile can leave under this key. */
async function stored(state: unknown): Promise<ReturnType<typeof useComposerOptionsStore.getState>> {
  window.localStorage.setItem(KEY, JSON.stringify({ state, version: 1 }));
  await useComposerOptionsStore.persist.rehydrate();
  return useComposerOptionsStore.getState();
}

describe("the composer's picks as they come back off local storage", () => {
  afterEach(() => {
    window.localStorage.clear();
    useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} });
  });

  it("reads back the picks and the thread each of them was made in", async () => {
    const state = await stored({
      byWorkspaceId: { ws_a: { model: "claude-opus-5", contextWindow: "1m", effort: "low" } },
      pickedOn: { ws_a: { model: "t1", contextWindow: "t2", effort: "t3", permissionMode: "t4" } },
    });
    expect(state.byWorkspaceId).toEqual({ ws_a: { model: "claude-opus-5", contextWindow: "1m", effort: "low" } });
    // The access has no value here, only the thread it was picked on: its mode lives on the host's record.
    expect(state.pickedOn).toEqual({ ws_a: { model: "t1", contextWindow: "t2", effort: "t3", permissionMode: "t4" } });
  });

  it("drops a thread record of the wrong shape rather than handing the pickers a value that is not a thread", async () => {
    // Read on every hydrate, not only on a version change: one of these would otherwise reach pickedFor as a thread
    // key and decide which thread a pick belongs to.
    const odd = { ws_a: { model: 7 }, ws_b: { model: null }, ws_c: { model: "" }, ws_d: { model: { id: "t1" } }, ws_e: { model: "t2", effort: "t3", harness: "t4" } };
    // The harness is not a thread's to keep, so a thread stored under it is dropped with the malformed ones.
    expect((await stored({ byWorkspaceId: {}, pickedOn: odd })).pickedOn).toEqual({ ws_e: { model: "t2", effort: "t3" } });
    expect((await stored({ byWorkspaceId: {}, pickedOn: { ws_a: "t1" } })).pickedOn).toEqual({});
    expect((await stored({ byWorkspaceId: {}, pickedOn: "t1" })).pickedOn).toEqual({});
    expect((await stored({ byWorkspaceId: {} })).pickedOn).toEqual({});
    expect((await stored(null)).pickedOn).toEqual({});
  });

  it("a pick names the thread it was made in, each pick on its own, and nothing else is named", () => {
    const { pick } = useComposerOptionsStore.getState();
    pick("ws_a", "model", "claude-opus-5", "t1");
    expect(useComposerOptionsStore.getState().pickedOn).toEqual({ ws_a: { model: "t1" } });
    // The window is a pick of its own: it names the thread it was picked on and leaves the model's thread alone,
    // or a window picked here would carry a model picked somewhere else onto this thread.
    pick("ws_a", "contextWindow", "200k", "t2");
    expect(useComposerOptionsStore.getState().pickedOn).toEqual({ ws_a: { model: "t1", contextWindow: "t2" } });
    // The effort and the access are picks of a thread's too; the harness is not, so it names no thread.
    pick("ws_a", "effort", "low", "t3");
    pick("ws_a", "permissionMode", "plan", "t4");
    pick("ws_a", "harness", "codex", "t5");
    expect(useComposerOptionsStore.getState().pickedOn).toEqual({ ws_a: { model: "t1", contextWindow: "t2", effort: "t3", permissionMode: "t4" } });
    // The access mode itself is not kept here: the host's record holds it, and this store holds only its thread.
    expect(useComposerOptionsStore.getState().byWorkspaceId["ws_a"]?.permissionMode).toBeUndefined();
    // The same value picked again on the same thread changes nothing at all.
    const before = useComposerOptionsStore.getState();
    pick("ws_a", "model", "claude-opus-5", "t1");
    expect(useComposerOptionsStore.getState()).toBe(before);
    // The same value picked again on another thread still moves that pick, and only that pick.
    pick("ws_a", "model", "claude-opus-5", "t9");
    expect(useComposerOptionsStore.getState().pickedOn).toEqual({ ws_a: { model: "t9", contextWindow: "t2", effort: "t3", permissionMode: "t4" } });
    expect(useComposerOptionsStore.getState().byWorkspaceId).toEqual({ ws_a: { model: "claude-opus-5", contextWindow: "200k", effort: "low", harness: "codex" } });
  });
});
