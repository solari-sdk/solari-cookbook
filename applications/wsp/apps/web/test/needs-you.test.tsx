// SPDX-License-Identifier: AGPL-3.0-only
// What the app does with the job's needsYou field beyond the sidebar's row:
// the tab or window title leads with the mark while a need stands, and each
// need is said once outside the app on this shell's own road, and a machine
// that came up while the person looked away is said on that same road. Both
// roads run here against a stubbed Notification and a stubbed bridge; nothing
// real is shown and nothing makes a sound.
import { act, render } from "@testing-library/react";
import { NEEDS_YOU, askingLine, initNeedsYouLine, workspaceAwakeLine, type InitNeedsYou } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { useHostNotices } from "../src/notices/hostNotices.js";
import { askToNotify, needsYouRoad, resetAskedToNotify } from "../src/shell/needsYou.js";
import { clearNotices, lastNotice } from "./notice-text.js";

const NEED: InitNeedsYou = { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 };

/** A Notification that records what it was built with and hands its click back. */
class FakeNotification {
  static built: { title: string; body: string; silent?: boolean }[] = [];
  static permission: NotificationPermission = "granted";
  static asked = 0;
  static requestPermission = vi.fn(async () => {
    FakeNotification.asked += 1;
    return FakeNotification.permission;
  });
  onclick: (() => void) | null = null;
  closed = 0;
  constructor(title: string, options?: { body?: string; silent?: boolean }) {
    FakeNotification.built.push({ title, body: options?.body ?? "", ...(options?.silent !== undefined ? { silent: options.silent } : {}) });
    FakeNotification.last = this;
  }
  static last: FakeNotification | undefined;
  close(): void {
    this.closed += 1;
  }
}

let hidden = true;
beforeEach(() => {
  FakeNotification.built = [];
  FakeNotification.permission = "granted";
  FakeNotification.asked = 0;
  FakeNotification.last = undefined;
  FakeNotification.requestPermission.mockClear();
  hidden = true;
  resetAskedToNotify();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal("Notification", FakeNotification);
  document.title = "wsp";
  useStore.setState({ api: null, initJob: null, settingsOpen: false });
  clearNotices();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.wsp;
});

/** The store bound to an api whose only job is to hand events back to the test. */
function bindEvents(): (e: ProtocolEvent) => void {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api = {
    listWorkspaces: vi.fn(async () => []),
    watchStatuses: vi.fn(async () => []),
    capabilities: vi.fn(async () => ({ upgrade: false, snapshot: false })),
    getGolden: vi.fn(async () => ({ versions: [] })),
    subscribe: (fn: (e: ProtocolEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as Api;
  useStore.getState().bind(api);
  return e => listeners.forEach(fn => fn(e));
}

function Harness() {
  useHostNotices();
  return null;
}

const JOB = { id: "init_1", road: "manual" as const, phase: "signing-in" as const, keys: { solari: true }, step: 0, stoppable: true, screens: [], rows: [], progress: { done: 1, total: 2 }, log: [] };

describe("the title while a build waits on the person", () => {
  it("leads with the mark while the job's need stands, drops it when the need goes, and never doubles it", () => {
    render(<Harness />);
    expect(document.title).toBe("wsp");
    act(() => useStore.setState({ initJob: { ...JOB, needsYou: NEED } }));
    expect(document.title).toBe("• wsp");
    // A second view of the same standing need leaves one mark, not two.
    act(() => useStore.setState({ initJob: { ...JOB, needsYou: { ...NEED, what: "sign in to Claude Code login" } } }));
    expect(document.title).toBe("• wsp");
    act(() => useStore.setState({ initJob: JOB }));
    expect(document.title).toBe("wsp");
  });

  it("the wait ending takes the notice and the mark together, so no surface is left saying it alone", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED }));
    act(() => emit({ type: "init.job", job: { ...JOB, needsYou: NEED } }));
    expect([lastNotice(), document.title]).toEqual([initNeedsYouLine(NEED.what), "• wsp"]);
    // The row moved on: one view with no need on it drops the wait at once.
    act(() => emit({ type: "init.job", job: JOB }));
    expect([lastNotice(), document.title]).toEqual([null, "wsp"]);
    // And the job ending after a need that was never answered leaves nothing behind either.
    act(() => emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED }));
    act(() => emit({ type: "init.job", job: { ...JOB, phase: "done" } }));
    expect(document.title).toBe("wsp");
  });
});

describe("a browser tab's road out of the app", () => {
  it("asks for leave on a press, at most once a page, and never on load", () => {
    render(<Harness />);
    FakeNotification.permission = "default";
    expect(FakeNotification.asked).toBe(0);
    // The press that opens the setup is the gesture a browser wants; a second press asks nothing again.
    askToNotify();
    expect(FakeNotification.asked).toBe(1);
    askToNotify();
    expect(FakeNotification.asked).toBe(1);
  });

  it("a build already running when the page loaded asks too, since that page saw no press, and the answer already given is not asked for again", () => {
    const emit = bindEvents();
    render(<Harness />);
    FakeNotification.permission = "default";
    emit({ type: "init.job", job: { ...JOB, phase: "answering", rows: [], progress: { done: 0, total: 0 } } });
    expect(FakeNotification.asked, "the screens are not a build").toBe(0);
    emit({ type: "init.job", job: { ...JOB, phase: "building" } });
    expect(FakeNotification.asked).toBe(1);
    emit({ type: "init.job", job: { ...JOB, phase: "signing-in" } });
    expect(FakeNotification.asked).toBe(1);
    // Leave already granted or refused is never asked about again, whatever fires ready.
    resetAskedToNotify();
    FakeNotification.permission = "denied";
    askToNotify();
    expect(FakeNotification.asked).toBe(1);
  });

  it("a shell that owns its own notifications is never asked for the browser's leave", () => {
    window.wsp = { needsYou: () => {}, onNeedsYouOpen: () => () => {} };
    FakeNotification.permission = "default";
    askToNotify();
    expect(FakeNotification.asked).toBe(0);
  });

  it("says the need with the app's name and no sound while the tab is hidden, and a click focuses the tab and opens Computers, where the build's card is", () => {
    const emit = bindEvents();
    render(<Harness />);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: "sign in to GitHub CLI login", silent: true }]);
    expect(useStore.getState().settingsOpen).toBe(false);
    FakeNotification.last!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(FakeNotification.last!.closed).toBe(1);
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "computers" });
    focus.mockRestore();
  });

  it("says nothing while the tab is the one in front of the person, and nothing without permission", () => {
    const emit = bindEvents();
    render(<Harness />);
    hidden = false;
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(FakeNotification.built).toEqual([]);
    hidden = true;
    FakeNotification.permission = "denied";
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(FakeNotification.built).toEqual([]);
  });
});


describe("a thread stopped on a permission prompt while the person looked away", () => {
  const ASKED = {
    type: "session.permission" as const,
    workspaceId: "ws_1",
    sessionId: "s1",
    turnId: "turn_1",
    threadId: "thr_1",
    askId: "ask_1",
    toolName: "Bash",
    detail: "Check wsp version",
    input: '{"command":"wsp --version"}',
    options: [{ id: "allow", label: "Allow", effect: "allow" as const }],
  };

  it("says what the thread is waiting on, on the same road as a build's need, and a click opens that thread", () => {
    const emit = bindEvents();
    render(<Harness />);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    act(() => emit(ASKED));
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: askingLine(ASKED), silent: true }]);
    FakeNotification.last!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId]).toEqual(["ws_1", "thr_1"]);
    focus.mockRestore();
  });

  it("says nothing while the app is the thing in front of the person", () => {
    const emit = bindEvents();
    render(<Harness />);
    hidden = false;
    act(() => emit(ASKED));
    expect(FakeNotification.built).toEqual([]);
  });
});

describe("a machine that came up while the person looked away", () => {
  const WOKEN = { id: "ws_1", name: "b1", machineId: "m1", phase: "running" as const, golden: "snap_g", createdAt: "2026-09-10T00:00:00Z", project: { id: "pr_api", name: "the-project", path: "/root", computer: "default" } };

  it("says the workspace is awake on the same road as a build's need, and a click opens that workspace", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => useStore.setState({ workspaces: [WOKEN], selectedId: null }));
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    act(() => emit({ type: "workspace.woken", workspaceId: "ws_1", machineId: "m1", resurrected: false }));
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: workspaceAwakeLine("b1"), silent: true }]);
    FakeNotification.last!.onclick!();
    expect(focus).toHaveBeenCalled();
    // The click lands on the machine that came up, not on the build screen a need's click opens.
    expect([useStore.getState().selectedId, useStore.getState().settingsOpen]).toEqual(["ws_1", false]);
    focus.mockRestore();
  });

  it("says nothing while the app is the thing in front of the person", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => useStore.setState({ workspaces: [WOKEN] }));
    hidden = false;
    act(() => emit({ type: "workspace.woken", workspaceId: "ws_1", machineId: "m1", resurrected: false }));
    expect(FakeNotification.built).toEqual([]);
  });

  it("says nothing about a workspace this page never knew", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => emit({ type: "workspace.woken", workspaceId: "ws_gone", machineId: "m9", resurrected: false }));
    expect(FakeNotification.built).toEqual([]);
  });
});

describe("the desktop shell's road out of the app", () => {
  it("hands the need to the shell rather than showing anything itself, since only the shell can read its window's focus", () => {
    const said: InitNeedsYou[] = [];
    const handlers: (() => void)[] = [];
    window.wsp = {
      needsYou: need => said.push(need),
      onNeedsYouOpen: handler => {
        handlers.push(handler);
        return () => {};
      },
    };
    const emit = bindEvents();
    render(<Harness />);
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(said).toEqual([NEED]);
    // The browser's own notifications are never used where a shell owns them.
    expect(FakeNotification.built).toEqual([]);
    // The shell's click comes back over the bridge and opens Computers here.
    expect(useStore.getState().settingsOpen).toBe(false);
    handlers[0]!();
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "computers" });
  });

  it("a shell too old to take a need falls back to the browser's own road, so nothing is silently dropped", () => {
    window.wsp = { setTheme: () => {} };
    const road = needsYouRoad(() => {});
    road.say(NEED);
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: "sign in to GitHub CLI login", silent: true }]);
    road.close();
    expect(FakeNotification.last!.closed).toBe(1);
  });
});
