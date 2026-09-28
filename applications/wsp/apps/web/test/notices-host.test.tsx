// SPDX-License-Identifier: AGPL-3.0-only
// The host's events that become notices: each one said when its home is off
// screen and left alone when the person is already looking at it, the waits
// keyed until the event that closes them, and the noise said nowhere.
import { act, render } from "@testing-library/react";
import { askingLine, initNeedsYouLine, type InitJob, type PlaceView, type ReleaseView, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ABSENT_NOTICE_MS, HOST_NOTICE_WORDS, RELEASE_SAID_KEY, useHostNotices } from "../src/notices/hostNotices.js";
import { useNotices, type Notice } from "../src/notices/store.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { resetAskedToNotify } from "../src/shell/needsYou.js";

const WS: WorkspaceView = { id: "ws_1", name: "api", machineId: "m1", phase: "running", golden: "snap_g", createdAt: "2026-09-10T00:00:00Z", project: { id: "pr_api", name: "the-project", path: "/root", computer: "default" } };
const ROW: SessionView = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "running", threadId: "thr_1", prompt: "fix the login page" };
const BOX = { id: "pl_box", kind: "computer", name: "spoo", present: true } as unknown as PlaceView;
const JOB: InitJob = { id: "init_1", road: "manual", phase: "signing-in", keys: { solari: true }, step: 0, stoppable: true, screens: [], rows: [], progress: { done: 1, total: 2 }, log: [] };
const NEED = { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 };
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
const ENDED = { type: "session.end" as const, workspaceId: "ws_1", sessionId: "s1", turnId: "turn_1", threadId: "thr_1", exitCode: 1, sawResult: false };

const notices = (): Notice[] => useNotices.getState().notices;
const texts = (): string[] => notices().map(n => n.text);

let emit: (e: ProtocolEvent) => void;
let mounted: ReturnType<typeof render>;

function Harness() {
  useHostNotices();
  return null;
}

beforeEach(async () => {
  window.localStorage.clear();
  vi.stubGlobal("Notification", undefined);
  resetAskedToNotify();
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api = {
    listWorkspaces: vi.fn(async () => [WS]),
    watchStatuses: vi.fn(async () => []),
    capabilities: vi.fn(async () => ({ upgrade: false, snapshot: false })),
    getGolden: vi.fn(async () => ({ versions: [] })),
    listSessions: vi.fn(async () => [ROW]),
    subscribe: (fn: (e: ProtocolEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as Api;
  useStore.setState({ api: null, initJob: null, settingsOpen: false, addComputerOpen: false, selectedId: null, selectedThreadId: null, freshThread: false, workspaces: [], sessions: {}, places: [], release: null });
  useStore.getState().bind(api);
  // The bind's own reads land first, then the page is put where each case starts: nothing selected.
  await act(async () => await new Promise(resolve => setTimeout(resolve, 0)));
  useStore.setState({ workspaces: [WS], sessions: { ws_1: [ROW] }, places: [BOX], selectedId: null, selectedThreadId: null });
  useSettingsStore.getState().go({ kind: "group", group: "appearance" });
  useSettingsStore.setState({ buildShown: null });
  act(() => useNotices.getState().clear());
  emit = e => act(() => listeners.forEach(fn => fn(e)));
  mounted = render(<Harness />);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as { __WSP__?: unknown }).__WSP__;
  act(() => useNotices.getState().clear());
});

const openThread = (): void => act(() => useStore.setState({ selectedId: "ws_1", selectedThreadId: "thr_1", settingsOpen: false }));
const remount = (): void => {
  mounted.unmount();
  act(() => useNotices.getState().clear());
  mounted = render(<Harness />);
};
const releaseView = (version: string): ReleaseView => ({ state: "read", latest: { version, tag: `v${version}`, url: `https://example.test/v${version}`, publishedAt: "2026-09-24T00:00:00Z" }, shape: "app" });
const openComputers = (): void => {
  act(() => {
    useStore.setState({ settingsOpen: true });
    useSettingsStore.getState().go({ kind: "group", group: "computers" });
  });
};

describe("a computer's install and its link", () => {
  it("an add that failed while Computers is not showing is an error with an Open onto Computers; showing, it is the sheet's to say", () => {
    emit({ type: "place.stage", addId: "a_1", step: "connect", state: "running" });
    emit({ type: "place.stage", addId: "a_1", step: "connect", state: "failed", note: "spoo names no user" });
    expect(notices()).toMatchObject([{ kind: "error", text: HOST_NOTICE_WORDS.notAdded("spoo names no user"), action: { word: "Open" } }]);
    act(() => notices()[0]!.action!.run());
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "computers" });

    act(() => useNotices.getState().clear());
    emit({ type: "place.stage", addId: "a_2", step: "connect", state: "failed", note: "spoo names no user" });
    expect(notices()).toEqual([]);
  });

  it("a join and a recipe that finished away are said done under the computer's name, and a recipe that failed is an error", () => {
    emit({ type: "place.stage", addId: "a_1", placeId: "pl_box", step: "join", state: "done", note: "engine none" });
    emit({ type: "place.stage", addId: "a_1", placeId: "pl_box", step: "provision", state: "failed", note: "node did not install" });
    emit({ type: "place.stage", addId: "a_2", placeId: "pl_box", step: "provision", state: "done" });
    expect(notices().map(n => [n.kind, n.text, n.where])).toEqual([
      ["done", HOST_NOTICE_WORDS.setUp("spoo"), "spoo"],
      ["error", HOST_NOTICE_WORDS.notSetUp("spoo", "node did not install"), "spoo"],
      ["done", HOST_NOTICE_WORDS.joined("spoo"), "spoo"],
    ]);
    // The Open lands on that computer's own page.
    act(() => notices()[0]!.action!.run());
    expect(useSettingsStore.getState().at).toEqual({ kind: "computer", id: "pl_box" });
  });

  it("a recipe that finished with rows failed is an error saying how many, with an Open onto that computer", () => {
    emit({ type: "place.stage", addId: "a_1", placeId: "pl_box", step: "provision", state: "done", note: "spoo: 1 installed: git;   x node: exit 1;   x uv: exit 2", failed: 2 });
    expect(notices().map(n => [n.kind, n.text, n.where])).toEqual([["error", HOST_NOTICE_WORDS.rowsFailed("spoo", 2), "spoo"]]);
    expect(texts()[0]).toBe("spoo: 2 rows of the recipe failed");
    act(() => notices()[0]!.action!.run());
    expect(useSettingsStore.getState().at).toEqual({ kind: "computer", id: "pl_box" });
  });

  it("a computer's own page showing keeps its steps off the toasts", () => {
    act(() => {
      useStore.setState({ settingsOpen: true });
      useSettingsStore.getState().go({ kind: "computer", id: "pl_box" });
    });
    emit({ type: "place.stage", addId: "a_1", placeId: "pl_box", step: "provision", state: "failed", note: "node did not install" });
    expect(notices()).toEqual([]);
  });

  it("a computer gone quiet is said after thirty seconds, once per absence, and a return before then says nothing", () => {
    vi.useFakeTimers();
    emit({ type: "place.absent", placeId: "pl_box" });
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_MS - 1));
    expect(notices()).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(notices()).toMatchObject([{ kind: "error", text: HOST_NOTICE_WORDS.away("spoo"), where: "spoo", action: { word: "Open" } }]);
    // The same absence said again is not a second notice.
    emit({ type: "place.absent", placeId: "pl_box" });
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_MS));
    expect(notices()).toHaveLength(1);

    act(() => useNotices.getState().clear());
    emit({ type: "place.present", placeId: "pl_box", from: "10.0.0.9" });
    emit({ type: "place.absent", placeId: "pl_box" });
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_MS / 2));
    emit({ type: "place.present", placeId: "pl_box", from: "10.0.0.9" });
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_MS));
    expect(notices()).toEqual([]);
  });

  it("a computer that came back and went quiet again is a new absence, said again", () => {
    vi.useFakeTimers();
    emit({ type: "place.absent", placeId: "pl_box" });
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_MS));
    emit({ type: "place.present", placeId: "pl_box", from: "10.0.0.9" });
    emit({ type: "place.absent", placeId: "pl_box" });
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_MS));
    expect(texts()).toEqual([HOST_NOTICE_WORDS.away("spoo"), HOST_NOTICE_WORDS.away("spoo")]);
  });

  it("an absence the runtime knows the reason for says that reason, even when a plain absence follows it", () => {
    vi.useFakeTimers();
    const said = "spoo can no longer boot the image: its kernel has no overlay filesystem";
    emit({ type: "place.absent", placeId: "pl_box", said });
    emit({ type: "place.absent", placeId: "pl_box" });
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_MS));
    expect(texts()).toEqual([said]);
  });

  it("an absence with Computers showing is the row's to say", () => {
    vi.useFakeTimers();
    openComputers();
    emit({ type: "place.absent", placeId: "pl_box" });
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_MS));
    expect(notices()).toEqual([]);
  });

  it("a computer removed while it was away leaves no timer behind", () => {
    vi.useFakeTimers();
    emit({ type: "place.absent", placeId: "pl_box" });
    expect(vi.getTimerCount()).toBe(1);
    emit({ type: "place.removed", placeId: "pl_box" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a computer removed while it was away is never said", () => {
    vi.useFakeTimers();
    emit({ type: "place.absent", placeId: "pl_box" });
    emit({ type: "place.removed", placeId: "pl_box" });
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_MS));
    expect(notices()).toEqual([]);
  });
});

describe("a thread's end, its prompts and its line to me", () => {
  it("a thread that died with no reply on a thread not open is an error naming it, and Open opens that thread", () => {
    emit(ENDED);
    expect(notices()).toMatchObject([{ kind: "error", text: HOST_NOTICE_WORDS.threadStopped("fix the login page", "exit 1"), where: "api", action: { word: "Open" } }]);
    act(() => notices()[0]!.action!.run());
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId]).toEqual(["ws_1", "thr_1"]);
  });

  it("the turn's own failure sentence is what the notice says, where the harness gave one", () => {
    emit({ type: "session.done", workspaceId: "ws_1", sessionId: "s1", turnId: "turn_1", threadId: "thr_1", result: { status: "failed", error: "claude exited 1 before it started" } });
    emit(ENDED);
    expect(texts()).toEqual([HOST_NOTICE_WORDS.threadStopped("fix the login page", "claude exited 1 before it started")]);
  });

  it("a turn somebody stopped is no failure, whatever its exit", () => {
    emit({ type: "session.done", workspaceId: "ws_1", sessionId: "s1", turnId: "turn_1", threadId: "thr_1", result: { status: "interrupted" } });
    emit({ ...ENDED, exitCode: null });
    expect(notices()).toEqual([]);
    // The next turn's failure on the same thread is still said: the stop was that turn's alone.
    emit({ ...ENDED, turnId: "turn_2" });
    expect(notices()).toHaveLength(1);
  });

  it("an end that is no failure, or one the runtime gave a reason for, says nothing; nor does one on the thread open", () => {
    emit({ ...ENDED, exitCode: 0 });
    emit({ ...ENDED, sawResult: true });
    emit({ ...ENDED, reason: "paused" });
    expect(notices()).toEqual([]);
    openThread();
    emit(ENDED);
    expect(notices()).toEqual([]);
  });

  it("a thread in the same workspace but not the one open is off screen", () => {
    act(() => useStore.setState({ selectedId: "ws_1", selectedThreadId: "thr_other" }));
    emit(ENDED);
    expect(notices()).toHaveLength(1);
  });

  it("an end naming no thread is off screen while another thread of its workspace is open, and on screen as the latest one", () => {
    const { threadId: _t, ...unthreaded } = ENDED;
    const { threadId: _r, ...bare } = ROW;
    act(() => useStore.setState({ sessions: { ws_1: [{ ...ROW, id: "s0", threadId: "thr_other" }, bare] }, selectedId: "ws_1", selectedThreadId: "thr_other" }));
    emit(unthreaded);
    expect(notices()).toHaveLength(1);
    act(() => useNotices.getState().clear());
    act(() => useStore.setState({ selectedThreadId: null }));
    emit(unthreaded);
    expect(notices()).toEqual([]);
  });

  it("a prompt on a thread not open waits under its key until the prompt closes", () => {
    emit(ASKED);
    expect(notices()).toMatchObject([{ kind: "waiting", text: askingLine(ASKED), where: "api", action: { word: "Open" } }]);
    expect(notices()[0]!.key).toBeDefined();
    emit({ type: "session.permission.closed", workspaceId: "ws_1", sessionId: "s1", turnId: "turn_1", threadId: "thr_1", askId: "ask_1", outcome: "allowed" });
    expect(notices()).toEqual([]);
  });

  it("a prompt whose turn was cut goes with the turn, and a prompt on the thread open is never a notice", () => {
    emit(ASKED);
    emit({ ...ENDED, exitCode: null, reason: "stopped" });
    expect(notices()).toEqual([]);
    openThread();
    emit(ASKED);
    expect(notices()).toEqual([]);
  });

  it("a line to me is a note with an Open onto its thread; a line to another thread, or to me on the thread open, says nothing", () => {
    const line = "thread c452d1e8 finished (completed, 8m 12s, $1.94): all green";
    const notify = { type: "session.notify" as const, workspaceId: "ws_1", sessionId: "s1", turnId: "turn_1", threadId: "thr_1", text: line };
    emit({ ...notify, notify: "thr_parent" });
    expect(notices()).toEqual([]);
    emit({ ...notify, notify: "me" });
    expect(notices()).toMatchObject([{ kind: "note", text: line, where: "api", action: { word: "Open" } }]);
    act(() => useNotices.getState().clear());
    openThread();
    emit({ ...notify, notify: "me" });
    expect(notices()).toEqual([]);
  });
});

describe("the image build", () => {
  it("a need waits under its key with an Open onto Computers when its job names no place, and ends when a view carries no need or another one", () => {
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(notices()).toMatchObject([{ kind: "waiting", text: initNeedsYouLine(NEED.what), action: { word: "Open" } }]);
    // A view of the same standing need leaves it.
    emit({ type: "init.job", job: { ...JOB, needsYou: NEED } });
    expect(notices()).toHaveLength(1);
    act(() => notices()[0]!.action!.run());
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "computers" });
    act(() => useStore.setState({ settingsOpen: false }));
    emit({ type: "init.job", job: JOB });
    expect(notices()).toEqual([]);

    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    emit({ type: "init.job", job: { ...JOB, needsYou: { what: "sign in to Claude Code login", since: NEED.since + 1 } } });
    expect(notices()).toEqual([]);
  });

  it("a need the host no longer holds on a fresh read goes too", () => {
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    act(() => useStore.setState({ initJob: { ...JOB, phase: "done" } }));
    expect(notices()).toEqual([]);
  });

  it("a build that failed or sealed while its page was not showing is said once per job", () => {
    emit({ type: "init.job", job: { ...JOB, phase: "failed", error: "the provider ran out of machines" } });
    emit({ type: "init.job", job: { ...JOB, phase: "failed", error: "the provider ran out of machines" } });
    emit({ type: "init.job", job: { ...JOB, id: "init_2", phase: "done", golden: { version: 3 } } });
    emit({ type: "init.job", job: { ...JOB, id: "init_2", phase: "done", golden: { version: 3 } } });
    expect(notices().map(n => [n.kind, n.text])).toEqual([
      ["done", HOST_NOTICE_WORDS.imageSealed(3)],
      ["error", HOST_NOTICE_WORDS.imageNotBuilt("the provider ran out of machines")],
    ]);
  });

  it("a need with its build's own page showing is the page's to say; leaving that page says it with an Open back onto it, and coming back ends it", () => {
    const job: InitJob = { ...JOB, place: { id: "pl_box", name: "spoo" }, needsYou: NEED };
    act(() => {
      useStore.setState({ initJob: job, settingsOpen: true });
      useSettingsStore.getState().go({ kind: "computer", id: "pl_box" });
      useSettingsStore.getState().showBuild("pl_box");
    });
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(notices()).toEqual([]);
    // Computers is showing, but not the build: the list draws no sign-in.
    act(() => {
      useSettingsStore.getState().hideBuild("pl_box");
      useSettingsStore.getState().go({ kind: "group", group: "computers" });
    });
    expect(notices()).toMatchObject([{ kind: "waiting", text: initNeedsYouLine(NEED.what), action: { word: "Open" } }]);
    act(() => notices()[0]!.action!.run());
    expect(useSettingsStore.getState().at).toEqual({ kind: "computer", id: "pl_box" });
    act(() => useSettingsStore.getState().showBuild("pl_box"));
    expect(notices()).toEqual([]);
  });

  it("a need arriving with another page up waits with an Open onto the build's page", () => {
    act(() => useStore.setState({ initJob: { ...JOB, place: { id: "pl_box", name: "spoo" } } }));
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    act(() => notices()[0]!.action!.run());
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "computer", id: "pl_box" });
  });

  it("a build that ended with its page showing says nothing; one that failed away opens that page", () => {
    const placed: InitJob = { ...JOB, place: { id: "pl_box", name: "spoo" } };
    act(() => {
      useStore.setState({ settingsOpen: true });
      useSettingsStore.getState().go({ kind: "computer", id: "pl_box" });
      useSettingsStore.getState().showBuild("pl_box");
    });
    emit({ type: "init.job", job: { ...placed, phase: "failed", error: "boom" } });
    expect(notices()).toEqual([]);
    act(() => {
      useSettingsStore.getState().hideBuild("pl_box");
      useStore.setState({ settingsOpen: false });
    });
    emit({ type: "init.job", job: { ...placed, id: "init_2", phase: "failed", error: "boom" } });
    expect(notices().map(n => n.text)).toEqual([HOST_NOTICE_WORDS.imageNotBuilt("boom")]);
    act(() => notices()[0]!.action!.run());
    expect(useSettingsStore.getState().at).toEqual({ kind: "computer", id: "pl_box" });
  });

  it("a build that was cancelled says nothing", () => {
    emit({ type: "init.job", job: { ...JOB, phase: "cancelled" } });
    expect(notices()).toEqual([]);
  });
});

describe("a workspace gone and a newer release", () => {
  it("a workspace gone at the provider while another is selected is an error; selected, it says nothing", () => {
    emit({ type: "workspace.gone", workspaceId: "ws_1", machineId: "m1", reason: "the provider no longer knows m1" });
    expect(notices()).toMatchObject([{ kind: "error", text: HOST_NOTICE_WORDS.gone("api", "the provider no longer knows m1"), where: "api", action: { word: "Open" } }]);
    act(() => useNotices.getState().clear());
    act(() => useStore.setState({ selectedId: "ws_1" }));
    emit({ type: "workspace.gone", workspaceId: "ws_1", machineId: "m1", reason: "the provider no longer knows m1" });
    expect(notices()).toEqual([]);
  });

  it("a thread the runtime ended because its machine went is one notice, the machine's", () => {
    emit({ ...ENDED, exitCode: null, reason: "the provider no longer knows m1" });
    emit({ type: "workspace.gone", workspaceId: "ws_1", machineId: "m1", reason: "the provider no longer knows m1" });
    expect(texts()).toEqual([HOST_NOTICE_WORDS.gone("api", "the provider no longer knows m1")]);
  });

  it("a version said once is not said again by the next page, a newer one is, and About showing counts as said", () => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { version: "0.1.0" };
    act(() => useStore.setState({ release: releaseView("0.2.0") }));
    expect(texts()).toEqual([HOST_NOTICE_WORDS.released("0.2.0")]);
    remount();
    expect(notices()).toEqual([]);
    act(() => useStore.setState({ release: releaseView("0.3.0") }));
    expect(texts()).toEqual([HOST_NOTICE_WORDS.released("0.3.0")]);

    act(() => {
      useStore.setState({ settingsOpen: true });
      useSettingsStore.getState().go({ kind: "group", group: "about" });
    });
    act(() => useStore.setState({ release: releaseView("0.4.0") }));
    act(() => useStore.setState({ settingsOpen: false }));
    remount();
    expect(notices()).toEqual([]);
  });

  it("a stored value that is no version, or a storage that throws, still says the release", () => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { version: "0.1.0" };
    mounted.unmount();
    window.localStorage.setItem(RELEASE_SAID_KEY, "<script>0.2.0");
    act(() => useStore.setState({ release: releaseView("0.2.0") }));
    mounted = render(<Harness />);
    expect(texts()).toEqual([HOST_NOTICE_WORDS.released("0.2.0")]);

    mounted.unmount();
    act(() => useNotices.getState().clear());
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    act(() => useStore.setState({ release: releaseView("0.5.0") }));
    mounted = render(<Harness />);
    expect(texts()).toEqual([HOST_NOTICE_WORDS.released("0.5.0")]);
    get.mockRestore();
    set.mockRestore();
  });

  it("a release above the running host is one note per version, with Get onto its page", () => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { version: "0.1.0" };
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const view = (version: string): ReleaseView => ({ state: "read", latest: { version, tag: `v${version}`, url: `https://example.test/v${version}`, publishedAt: "2026-09-24T00:00:00Z" }, shape: "app" });
    act(() => useStore.setState({ release: view("0.1.0") }));
    expect(notices()).toEqual([]);
    act(() => useStore.setState({ release: view("0.2.0") }));
    act(() => useStore.setState({ release: { ...view("0.2.0"), checkedAt: "2026-09-24T01:00:00Z" } }));
    expect(notices()).toMatchObject([{ kind: "note", text: HOST_NOTICE_WORDS.released("0.2.0"), action: { word: "Get" } }]);
    act(() => notices()[0]!.action!.run());
    expect(open).toHaveBeenCalledWith("https://example.test/v0.2.0", "_blank", "noopener,noreferrer");
    // About showing says it there instead.
    act(() => {
      useStore.setState({ settingsOpen: true });
      useSettingsStore.getState().go({ kind: "group", group: "about" });
    });
    act(() => useStore.setState({ release: view("0.3.0") }));
    expect(notices()).toHaveLength(1);
    open.mockRestore();
  });
});

describe("the noise", () => {
  it("presence, naps, wakes, forwards, projects, creates and image stages are said nowhere", () => {
    emit({ type: "place.present", placeId: "pl_box", from: "10.0.0.9" });
    emit({ type: "workspace.napped", workspaceId: "ws_1" });
    emit({ type: "workspace.woken", workspaceId: "ws_1", machineId: "m1", resurrected: false });
    emit({ type: "forward.open", forward: { workspaceId: "ws_1", port: 3000, localPort: 3000 } } as unknown as ProtocolEvent);
    emit({ type: "project.removed", projectId: "pr_api" } as unknown as ProtocolEvent);
    emit({ type: "workspace.created", workspace: WS });
    emit({ type: "golden.stage", stage: "building", message: "building" } as unknown as ProtocolEvent);
    emit({ type: "place.stage", addId: "a_1", step: "wsp", state: "running" });
    emit({ type: "place.stage", addId: "a_1", step: "wsp", state: "done" });
    expect(notices()).toEqual([]);
  });
});
