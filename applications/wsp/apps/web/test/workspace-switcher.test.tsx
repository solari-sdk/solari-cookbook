// SPDX-License-Identifier: AGPL-3.0-only
// The hold-to-switch overlay: ctrl+tab with the key still down puts it up,
// tab and shift+tab walk it, letting the key go opens the highlighted
// workspace, Escape and a lost window leave everything where it was, and a
// tap is a walk of one followed by a release, which paints nothing. The cards
// read the sidebar's own order and threads, and carry three parts: the picture
// well, the workspace name and the open thread's title. In Spaces the same
// chord walks the last five threads opened in the space on screen: a hold
// shows them, letting go lands on the highlighted one, a tap is the thread
// before this one.
import { act, cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { deriveSidebarProjects } from "../src/adapt/index.js";
import { buildSwitcherCards } from "../src/components/switcher/switcherCards.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { ROW_META_CLASS } from "../src/sidebar/rowGrammar.js";
import { AppShell } from "../src/shell/AppShell.js";
import { onComposerFocusRequest } from "../src/shell/shellRequests.js";
import { loadPagePreviews, useWorkspacePreviews } from "../src/shell/workspacePreviews.js";
import { recentThreads, useThreadHistory } from "../src/shell/threadHistory.js";
import { releasesSwitchHold, stepSwitcherAt, SWITCHER_PAINT_DELAY_MS, useWorkspaceSwitcher } from "../src/shell/workspaceSwitcher.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices } from "./notice-text.js";

const CAPS = caps();

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running", createdAt = "2026-09-01T00:00:00Z"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase,
  golden: "snap_g",
  createdAt,
});

const session = (id: string, workspaceId: string, prompt: string, startedAt: number): SessionView => ({
  id,
  workspaceId,
  harness: "claude",
  status: "completed",
  prompt,
  startedBy: "person",
  startedAt,
  endedAt: startedAt + 60_000,
});

// Made in that order, so the sidebar draws them in it whatever the ids sort to, and the one turn any of them has
// run sits on the middle row, where it moves nothing.
const WORKSPACES = [view("ws_a", "api", "running", "2026-09-01T01:00:00Z"), view("ws_b", "web", "running", "2026-09-01T02:00:00Z"), view("ws_c", "old", "napping", "2026-09-01T03:00:00Z")];
const SESSIONS = [session("s1", "ws_b", "Bump the lockfile and run the gate.", Date.parse("2026-09-01T02:30:00Z"))];

function fakeApi(): Api {
  return {
    listWorkspaces: async () => WORKSPACES,
    getWorkspace: async id => WORKSPACES.find(w => w.id === id)!,
    createWorkspace: async () => WORKSPACES[0]!,
    watchStatuses: async () => [],
    forget: async () => {},
    nap: async id => WORKSPACES.find(w => w.id === id)!,
    wake: async id => WORKSPACES.find(w => w.id === id)!,
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s9", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => SESSIONS,
    subscribe: () => () => {},
    getGolden: async () => undefined,
  };
}

const tab = (mods: { shiftKey?: boolean } = {}) => fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true, ...mods });
/** The switch between spaces, as macOS spells it here; the platform is mocked to MacIntel for the file. */
const spaceArrow = (name: "ArrowLeft" | "ArrowRight") => fireEvent.keyDown(window, { key: name, code: name, metaKey: true, altKey: true });
const release = () => fireEvent.keyUp(window, { key: "Control" });
const releaseSpaceArrow = () => fireEvent.keyUp(window, { key: "Alt" });
const escape = () => fireEvent.keyDown(window, { key: "Escape", code: "Escape" });

/** The desktop shell, told apart by the bridge its preload puts on the page. */
const asDesktopShell = (bridge: Partial<Window["wsp"]> = {}): (() => void) => {
  window.wsp = bridge;
  return () => delete window.wsp;
};

const overlay = () => document.querySelector<HTMLElement>("[data-workspace-switcher]");
const cardIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-workspace-card]")].map(el => el.dataset["workspaceCard"]!);
const highlightedCard = (): string | null => document.querySelector<HTMLElement>("[data-workspace-card][aria-selected=true]")?.dataset["workspaceCard"] ?? null;
const card = (workspaceId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-workspace-card='${workspaceId}']`);
const cardText = (workspaceId: string, part: string): string =>
  document.querySelector<HTMLElement>(`[data-workspace-card='${workspaceId}'] [data-card-${part}]`)?.textContent ?? "";
const cardPartClass = (workspaceId: string, part: string): string =>
  document.querySelector<HTMLElement>(`[data-workspace-card='${workspaceId}'] [data-card-${part}]`)?.className ?? "";
/** The parts a card is built of, in the order it draws them; a child that is no named part reads as "?". */
const cardParts = (workspaceId: string): string[] =>
  [...(card(workspaceId)?.children ?? [])].map(el => el.getAttributeNames().find(name => name.startsWith("data-card-"))?.slice("data-card-".length) ?? "?");
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));

vi.setConfig({ testTimeout: 15_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true } });
  clearNotices();
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
  useWorkspacePreviews.setState({ images: {} });
  useWorkspaceSwitcher.getState().close();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mountShell(): Promise<void> {
  useStore.getState().bind(fakeApi());
  render(
    <AppShell>
      <div>center content</div>
    </AppShell>,
  );
  await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
  await waitFor(() => expect(useStore.getState().sessions["ws_b"]?.length).toBe(1));
}

/** The caret asks for one workspace from this call on; one left pending by an earlier test is dropped. */
const watchComposerFocus = (workspaceId: string): { asks: string[]; off: () => void } => {
  const asks: string[] = [];
  const off = onComposerFocusRequest(workspaceId, () => asks.push(workspaceId));
  asks.length = 0;
  return { asks, off };
};

describe("the workspace switcher overlay", () => {
  it("goes up on ctrl+tab while the key is held, one card per workspace in sidebar order, and selects nothing yet", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      expect(overlay()).toBeNull();
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardIds()).toEqual(["ws_a", "ws_b", "ws_c"]);
      expect(highlightedCard()).toBe("ws_b");
      expect(useStore.getState().selectedId).toBe("ws_a");
    } finally {
      restore();
    }
  });

  it("holds its paint back, so the state opens at once and the overlay only draws once the chord is really held", async () => {
    await mountShell();
    const restore = asDesktopShell();
    vi.useFakeTimers();
    try {
      act(() => {
        tab();
      });
      expect(useWorkspaceSwitcher.getState().open).toBe(true);
      expect(overlay()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS - 1);
      });
      expect(overlay()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(overlay()).not.toBeNull();
      expect(highlightedCard()).toBe("ws_b");
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("a tap that lets the hold go inside the delay never dims the app, and still switches", async () => {
    await mountShell();
    const restore = asDesktopShell();
    vi.useFakeTimers();
    try {
      // Each act flushes the render the step caused, so the paint timer is really running when the hold comes up.
      act(() => {
        tab();
      });
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS - 1);
      });
      expect(overlay()).toBeNull();
      act(() => {
        release();
      });
      expect(useStore.getState().selectedId).toBe("ws_b");
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS * 4);
      });
      expect(overlay()).toBeNull();
      expect(document.querySelector(".dialog-backdrop")).toBeNull();
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("a second step inside the delay does not push the paint further out", async () => {
    await mountShell();
    const restore = asDesktopShell();
    vi.useFakeTimers();
    try {
      act(() => {
        tab();
      });
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS - 20);
      });
      act(() => {
        tab();
      });
      expect(useWorkspaceSwitcher.getState().at).toBe(2);
      expect(overlay()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(20);
      });
      expect(overlay()).not.toBeNull();
      expect(highlightedCard()).toBe("ws_c");
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("walks forward on tab and back on shift+tab, wrapping at both ends over an order that does not move", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("ws_b"));
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("ws_c"));
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("ws_a"));
      tab({ shiftKey: true });
      await waitFor(() => expect(highlightedCard()).toBe("ws_c"));
      expect(cardIds()).toEqual(["ws_a", "ws_b", "ws_c"]);
      expect(useStore.getState().selectedId).toBe("ws_a");
    } finally {
      restore();
    }
  });

  it("commits on the hold being let go: the highlighted workspace opens and its composer is asked for the caret", async () => {
    await mountShell();
    const restore = asDesktopShell();
    const { asks, off } = watchComposerFocus("ws_c");
    try {
      tab();
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("ws_c"));
      release();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_c"));
      expect(overlay()).toBeNull();
      expect(asks).toEqual(["ws_c"]);
    } finally {
      off();
      restore();
    }
  });

  it("a tap is one step and a release, so it still switches at once", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      release();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
      expect(overlay()).toBeNull();
    } finally {
      restore();
    }
  });

  it("cancels on Escape, and the release that follows moves nothing", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("ws_c"));
      escape();
      await waitFor(() => expect(overlay()).toBeNull());
      expect(useStore.getState().selectedId).toBe("ws_a");
      release();
      await settle();
      expect(useStore.getState().selectedId).toBe("ws_a");
    } finally {
      restore();
    }
  });

  it("leaves when the window does, since a hold let go elsewhere never comes back here", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      fireEvent.blur(window);
      await waitFor(() => expect(overlay()).toBeNull());
      expect(useStore.getState().selectedId).toBe("ws_a");
    } finally {
      restore();
    }
  });

  it("in a browser tab the chord is the browser's, so no overlay goes up", async () => {
    await mountShell();
    tab();
    await settle();
    expect(overlay()).toBeNull();
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("carries the workspace name and the open thread's title in muted mono, and no cost, state word or open word", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      // A cost is ticking for this workspace while the overlay is up, and it reaches no card.
      act(() => {
        useStore.setState({ costs: { ws_b: { rateUsdPerHour: 0.35, accruedUsd: 1.2345, at: "2026-09-07T10:00:00Z" } } });
      });
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardText("ws_b", "name")).toBe("web");
      expect(cardText("ws_b", "thread")).toBe("Bump the lockfile and run the gate.");
      expect(cardText("ws_a", "thread")).toBe("No threads yet");
      // The name is sans at a row's weight; the thread's title is the muted mono line under it.
      expect(cardPartClass("ws_b", "name")).not.toContain("font-mono");
      expect(cardPartClass("ws_b", "name")).not.toContain("font-medium");
      expect(cardPartClass("ws_b", "thread")).toContain(ROW_META_CLASS);
      // Two parts here and no third, since this bridge answers for no picture, and the same two on every card.
      expect(cardParts("ws_b")).toEqual(["name", "thread"]);
      expect(document.querySelectorAll("[data-card-meta], [data-card-line]").length).toBe(0);
      expect(card("ws_a")?.textContent).toBe("apiNo threads yet");
      expect(card("ws_b")?.textContent).toBe("webBump the lockfile and run the gate.");
      expect(card("ws_c")?.textContent).toBe("oldNo threads yet");
    } finally {
      restore();
    }
  });

  it("draws the picture well above the name and the title where the shell can answer for one, and asks it to photograph the workspace being left", async () => {
    await mountShell();
    const capturePreview = vi.fn(async () => undefined);
    const workspacePreview = vi.fn(async (id: string) => (id === "ws_b" ? "data:image/png;base64,AAA" : undefined));
    const restore = asDesktopShell({ capturePreview, workspacePreview });
    try {
      tab();
      await waitFor(() => expect(document.querySelectorAll("[data-card-preview]").length).toBe(3));
      await waitFor(() => expect(document.querySelector<HTMLImageElement>("[data-workspace-card='ws_b'] img")?.src).toBe("data:image/png;base64,AAA"));
      expect(document.querySelector("[data-workspace-card='ws_a'] [data-card-preview]")?.textContent).toBe("no capture yet");
      expect(cardParts("ws_b")).toEqual(["preview", "name", "thread"]);
      release();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
      expect(capturePreview).toHaveBeenCalledWith("ws_a");
    } finally {
      restore();
    }
  });

  it("has no picture well where the bridge cannot answer for one, even in the desktop shell", async () => {
    await mountShell();
    const restore = asDesktopShell({ workspacePreview: async () => undefined });
    try {
      tab();
      await waitFor(() => expect(document.querySelectorAll("[data-card-preview]").length).toBe(3));
      escape();
      await waitFor(() => expect(overlay()).toBeNull());
    } finally {
      restore();
    }
    // The same shell without the call: the chord still reaches the page, and the cards are text alone.
    const bare = asDesktopShell();
    try {
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(document.querySelectorAll("[data-card-preview]").length).toBe(0);
    } finally {
      bare();
    }
  });
});

describe("loadPagePreviews", () => {
  it("keeps what the shell still answers for and drops what it has let go at its own cap", async () => {
    useWorkspacePreviews.setState({ images: { ws_a: "data:image/png;base64,OLD" } });
    const restore = asDesktopShell({ workspacePreview: async id => (id === "ws_b" ? "data:image/png;base64,NEW" : undefined) });
    try {
      await loadPagePreviews(["ws_a", "ws_b"]);
      expect(useWorkspacePreviews.getState().images).toEqual({ ws_b: "data:image/png;base64,NEW" });
    } finally {
      restore();
    }
  });

  it("touches nothing where the shell cannot answer at all", async () => {
    useWorkspacePreviews.setState({ images: { ws_a: "data:image/png;base64,OLD" } });
    await loadPagePreviews(["ws_a", "ws_b"]);
    expect(useWorkspacePreviews.getState().images).toEqual({ ws_a: "data:image/png;base64,OLD" });
  });
});

describe("the card the space arrows put up", () => {
  it("is the same card, and it ends on the option coming up rather than on the key the other chord holds", async () => {
    await mountShell();
    const restore = asDesktopShell();
    const { asks, off } = watchComposerFocus("ws_b");
    try {
      spaceArrow("ArrowRight");
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardIds()).toEqual(["ws_a", "ws_b", "ws_c"]);
      expect(highlightedCard()).toBe("ws_b");
      // The other switch chord's own hold is not this walk's, so letting it go leaves the card up.
      release();
      await settle();
      expect(useWorkspaceSwitcher.getState().open).toBe(true);
      releaseSpaceArrow();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
      expect(overlay()).toBeNull();
      expect(asks).toEqual(["ws_b"]);
    } finally {
      off();
      restore();
    }
  });

  it("walks back on the left arrow, and puts nothing up in a browser tab, which keeps that chord and the Tab pair", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      spaceArrow("ArrowLeft");
      await waitFor(() => expect(highlightedCard()).toBe("ws_c"));
      releaseSpaceArrow();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_c"));
    } finally {
      restore();
    }
    spaceArrow("ArrowLeft");
    tab();
    await settle();
    expect(useWorkspaceSwitcher.getState().open).toBe(false);
    expect(useStore.getState().selectedId).toBe("ws_c");
  });

  it("keeps Shift for the step back, so letting Shift go mid-walk commits nothing", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab({ shiftKey: true });
      await waitFor(() => expect(highlightedCard()).toBe("ws_c"));
      fireEvent.keyUp(window, { key: "Shift" });
      await settle();
      expect(useWorkspaceSwitcher.getState().open).toBe(true);
      expect(useStore.getState().selectedId).toBe("ws_a");
      release();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_c"));
    } finally {
      restore();
    }
  });

  it("is the same jump the Tab pair makes: the sidebar draws one body, so both chords walk the workspaces", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardIds()).toEqual(["ws_a", "ws_b", "ws_c"]);
      release();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
      spaceArrow("ArrowRight");
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardIds()).toEqual(["ws_a", "ws_b", "ws_c"]);
      releaseSpaceArrow();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_c"));
    } finally {
      restore();
    }
  });
});

describe("the thread switcher", () => {
  const thread = (id: string, title: string, minutesAgo: number): SessionView => ({ ...session(`s_${id}`, "ws_a", title, Date.now() - minutesAgo * 60_000), threadId: id });
  const SIX = [1, 2, 3, 4, 5, 6].map(n => thread(`thr_${n}`, `thread ${n}`, n));

  /** The walk as a person makes it: the mod arrows under the pair that walks the workspaces, held while the overlay
   * stands and landed on the hold coming up. Shift is no part of it here, since down and up are the two ways. */
  /** The hold of that chord let go, which is what commits the walk: Alt, as the workspace arrows commit on. */
  const releaseThread = (): void => {
    fireEvent.keyUp(window, { key: "Alt" });
  };
  const threadStep = (mods: { shiftKey?: boolean } = {}): void => {
    fireEvent.keyDown(window, { key: mods.shiftKey === true ? "ArrowUp" : "ArrowDown", code: mods.shiftKey === true ? "ArrowUp" : "ArrowDown", metaKey: true, altKey: true });
  };

  async function mountThreads(threads: SessionView[]): Promise<() => void> {
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true } });
    useThreadHistory.setState({ recent: [] });
    useStore.getState().bind({ ...fakeApi(), listSessions: async () => threads });
    render(
      <AppShell>
        <div>center content</div>
      </AppShell>,
    );
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
    await waitFor(() => expect(useStore.getState().sessions["ws_a"]?.length).toBe(threads.length));
    return asDesktopShell();
  }
  const visit = (threadId: string): void => {
    act(() => useStore.getState().select("ws_a", threadId));
  };
  const threadCards = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-thread-card]")].map(el => el.dataset["threadCard"]!);
  const highlightedThread = (): string | null => document.querySelector<HTMLElement>("[data-thread-card][aria-selected=true]")?.dataset["threadCard"] ?? null;

  it("held, the walk puts up the last five threads opened, the open one first and the one before it highlighted; tab walks on and letting go lands there", async () => {
    const restore = await mountThreads(SIX);
    try {
      for (const id of ["thr_6", "thr_5", "thr_4", "thr_3", "thr_2", "thr_1"]) visit(id);
      threadStep();
      await waitFor(() => expect(overlay()).not.toBeNull());
      // Five cards, most recent first, and no picture well on any: the threads all share one page.
      expect(threadCards()).toEqual(["thr_1", "thr_2", "thr_3", "thr_4", "thr_5"]);
      expect(document.querySelectorAll("[data-card-preview]")).toHaveLength(0);
      expect(highlightedThread()).toBe("thr_2");
      expect(document.querySelector("[data-thread-card='thr_2'] [data-card-name]")?.textContent).toBe("thread 2");
      expect(document.querySelector("[data-thread-card='thr_2'] [data-card-thread]")?.textContent).toBe("Claude Code, the-project, you");
      // Nothing moves until the hold is let go.
      expect(useStore.getState().selectedThreadId).toBe("thr_1");
      threadStep();
      await waitFor(() => expect(highlightedThread()).toBe("thr_3"));
      threadStep({ shiftKey: true });
      await waitFor(() => expect(highlightedThread()).toBe("thr_2"));
      threadStep();
      threadStep();
      await waitFor(() => expect(highlightedThread()).toBe("thr_4"));
      releaseThread();
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("thr_4"));
      expect(useStore.getState().selectedId).toBe("ws_a");
      expect(overlay()).toBeNull();
    } finally {
      restore();
    }
  });

  it("a tap switches to the thread before this one, and a second tap comes back, without the overlay ever painting", async () => {
    const restore = await mountThreads(SIX);
    vi.useFakeTimers();
    try {
      visit("thr_3");
      visit("thr_5");
      act(() => {
        threadStep();
      });
      act(() => {
        releaseThread();
      });
      expect(useStore.getState().selectedThreadId).toBe("thr_3");
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS * 2);
      });
      expect(overlay()).toBeNull();
      act(() => {
        threadStep();
      });
      act(() => {
        releaseThread();
      });
      expect(useStore.getState().selectedThreadId).toBe("thr_5");
      // Shift and a tap is the far end of the five.
      act(() => {
        threadStep({ shiftKey: true });
      });
      act(() => {
        releaseThread();
      });
      expect(useStore.getState().selectedThreadId).not.toBe("thr_5");
      expect(useStore.getState().selectedThreadId).not.toBe("thr_3");
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("with no thread open, as right after a workspace switch, a tap lands on the most recently opened thread and the hold starts there; Shift starts at the far end", async () => {
    const restore = await mountThreads(SIX);
    try {
      visit("thr_3");
      visit("thr_5");
      // The workspace alone, the way goToWorkspace leaves it after a switch between workspaces.
      act(() => useStore.getState().select("ws_a"));
      expect(useStore.getState().selectedThreadId).toBeNull();
      threadStep();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(threadCards()).toEqual(["thr_5", "thr_3", "thr_1", "thr_2", "thr_4"]);
      expect(highlightedThread()).toBe("thr_5");
      releaseThread();
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("thr_5"));
      act(() => useStore.getState().select("ws_a"));
      threadStep({ shiftKey: true });
      releaseThread();
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("thr_4"));
    } finally {
      restore();
    }
  });

  it("threads never opened follow the ones that were, in the sidebar's order, and one thread alone puts nothing up", async () => {
    const restore = await mountThreads(SIX.slice(0, 3));
    try {
      visit("thr_2");
      threadStep();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(threadCards()).toEqual(["thr_2", "thr_1", "thr_3"]);
      escape();
      await waitFor(() => expect(overlay()).toBeNull());
      expect(recentThreads([], [], null)).toEqual([]);
    } finally {
      restore();
    }
    cleanup();
    const alone = await mountThreads(SIX.slice(0, 1));
    try {
      visit("thr_1");
      threadStep();
      await settle();
      expect(useWorkspaceSwitcher.getState().open).toBe(false);
      expect(useStore.getState().selectedThreadId).toBe("thr_1");
    } finally {
      alone();
    }
  });
});

describe("stepSwitcherAt", () => {
  it("wraps at both ends and always moves, since the key has to answer once the overlay is up", () => {
    expect(stepSwitcherAt(3, 0, 1)).toBe(1);
    expect(stepSwitcherAt(3, 2, 1)).toBe(0);
    expect(stepSwitcherAt(3, 0, -1)).toBe(2);
    expect(stepSwitcherAt(1, 0, 1)).toBe(0);
    expect(stepSwitcherAt(0, 0, 1)).toBe(0);
  });
});

describe("releasesSwitchHold", () => {
  it("ends the walk on a key the chord that opened it was holding, and on nothing else", () => {
    expect(releasesSwitchHold({ open: true, hold: ["Control"] }, "Control")).toBe(true);
    expect(releasesSwitchHold({ open: true, hold: ["Alt"] }, "Alt")).toBe(true);
    expect(releasesSwitchHold({ open: true, hold: ["Control"] }, "Alt")).toBe(false);
    expect(releasesSwitchHold({ open: true, hold: ["Control"] }, "Shift")).toBe(false);
    expect(releasesSwitchHold({ open: false, hold: ["Control"] }, "Control")).toBe(false);
  });
});

describe("buildSwitcherCards", () => {
  const projects = deriveSidebarProjects({ workspaces: WORKSPACES, sessions: { ws_b: SESSIONS } });

  it("keeps the order it is given, drops an id the snapshot no longer holds, and carries the three parts alone", () => {
    const cards = buildSwitcherCards({ projects, targets: ["ws_c", "ws_gone", "ws_a"].map(workspaceId => ({ workspaceId, threadId: null })), images: {}, currentId: "ws_a", pinnedThreadId: null });
    expect(cards.map(c => c.workspaceId)).toEqual(["ws_c", "ws_a"]);
    expect(Object.keys(cards[0]!)).toEqual(["workspaceId", "threadId", "name", "threadTitle", "image"]);
  });

  it("names the thread the sidebar draws at the top of the workspace, not the first row the fold happens to hand back", () => {
    const older = session("s_old", "ws_a", "The oldest thread.", Date.parse("2026-09-01T01:00:00Z"));
    const working = { ...session("s_new", "ws_a", "The working thread.", Date.parse("2026-09-01T02:00:00Z")), status: "running" as const, endedAt: undefined };
    const snapshot = deriveSidebarProjects({ workspaces: WORKSPACES, sessions: { ws_a: [older, working] } });
    const cards = buildSwitcherCards({ projects: snapshot, targets: [{ workspaceId: "ws_a", threadId: null }], images: {}, currentId: null, pinnedThreadId: null });
    expect(cards[0]?.threadTitle).toBe("The working thread.");
  });

  it("takes the thread the sidebar pins over the top one, for the workspace the pin belongs to", () => {
    const older = session("s_old", "ws_a", "The oldest thread.", Date.parse("2026-09-01T01:00:00Z"));
    const newer = session("s_new", "ws_a", "The newest thread.", Date.parse("2026-09-01T02:00:00Z"));
    const snapshot = deriveSidebarProjects({ workspaces: WORKSPACES, sessions: { ws_a: [older, newer] } });
    const pinned = buildSwitcherCards({ projects: snapshot, targets: [{ workspaceId: "ws_a", threadId: null }], images: {}, currentId: "ws_a", pinnedThreadId: "s_old" });
    expect(pinned[0]?.threadTitle).toBe("The oldest thread.");
    const elsewhere = buildSwitcherCards({ projects: snapshot, targets: [{ workspaceId: "ws_a", threadId: null }], images: {}, currentId: "ws_b", pinnedThreadId: "s_old" });
    expect(elsewhere[0]?.threadTitle).toBe("The newest thread.");
  });

  it("a thread target is a card of the thread's title over where it came from, with no picture well, and a thread that has gone leaves none", () => {
    const thread = { ...session("s_t", "ws_a", "The thread.", Date.parse("2026-09-01T02:00:00Z")), threadId: "thr_t", startedBy: "cli" as const };
    const snapshot = deriveSidebarProjects({ workspaces: WORKSPACES, sessions: { ws_a: [thread] } });
    const cards = buildSwitcherCards({ projects: snapshot, targets: [{ workspaceId: "ws_a", threadId: "thr_t" }, { workspaceId: "ws_a", threadId: "thr_gone" }], images: { ws_a: "data:image/png;base64,AAA" }, currentId: "ws_a", pinnedThreadId: null });
    expect(cards).toEqual([{ workspaceId: "ws_a", threadId: "thr_t", name: "The thread.", threadTitle: "Claude Code, the-project, cli", image: null }]);
  });
});
