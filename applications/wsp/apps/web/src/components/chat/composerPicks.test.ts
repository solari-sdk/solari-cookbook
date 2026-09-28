// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { contextWindowsFor, type HarnessCatalog, type SessionView } from "@wsp/protocol";
import { effectivePicks, pickedFor, recordedPicks, resolveModel, runningPicks, startOptionsFrom, threadPicks } from "./composerPicks";

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.257",
  models: [
    { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] },
    { value: "claude-sonnet-5", label: "Sonnet 5", contextWindows: [] },
    { value: "claude-haiku-4-5", label: "Haiku", efforts: [], contextWindows: [] },
    { value: "claude-next", label: "Next", efforts: ["high"] },
  ],
  efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High", isDefault: true }],
  contextWindows: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }],
  permissionModes: [{ value: "plan", label: "Plan" }, { value: "bypassPermissions", label: "Bypass", isDefault: true }],
  steers: true,
  renames: true,
  images: true,
};

describe("resolveModel", () => {
  it("prefers the pick, then the model the thread is on, then the catalog's default", () => {
    expect(resolveModel(CLAUDE, { picked: "claude-sonnet-5", thread: "claude-haiku-4-5" })?.value).toBe("claude-sonnet-5");
    expect(resolveModel(CLAUDE, { picked: undefined, thread: "claude-haiku-4-5" })?.value).toBe("claude-haiku-4-5");
    expect(resolveModel(CLAUDE, { picked: undefined, thread: undefined })?.value).toBe("claude-opus-5");
  });

  it("a pick the catalog does not list still resolves, as an option named by its slug; no pick and no default is null", () => {
    expect(resolveModel(CLAUDE, { picked: "claude-old-3", thread: undefined })).toEqual({ value: "claude-old-3", label: "claude-old-3" });
    expect(resolveModel({ ...CLAUDE, models: [] }, { picked: undefined, thread: undefined })).toBeNull();
    const noDefault = { ...CLAUDE, models: CLAUDE.models.map(({ isDefault: _d, ...m }) => m) };
    expect(resolveModel(noDefault, { picked: undefined, thread: undefined })).toBeNull();
    expect(contextWindowsFor(noDefault, null)).toEqual([]);
    expect(startOptionsFrom(noDefault, { contextWindow: "1m" })).toEqual({});
  });
});

describe("runningPicks", () => {
  const session: SessionView = { id: "s1", workspaceId: "w", harness: "claude", status: "running", model: "claude-opus-5[1m]", effort: "high", permissionMode: "plan" };

  it("reads the CLI's 1M suffix off the announced model as the context window", () => {
    expect(runningPicks(session, true)).toEqual({ model: "claude-opus-5", contextWindow: "1m", effort: "high", permissionMode: "plan" });
    expect(runningPicks({ ...session, model: "claude-sonnet-5", contextWindow: "200k" }, true)).toEqual({ model: "claude-sonnet-5", contextWindow: "200k", effort: "high", permissionMode: "plan" });
  });

  it("is empty when no turn runs or the row is not running", () => {
    expect(runningPicks(session, false)).toEqual({});
    expect(runningPicks({ ...session, status: "completed" }, true)).toEqual({});
    expect(runningPicks(null, true)).toEqual({});
  });
});

describe("recordedPicks", () => {
  const row = (id: string, picks: Partial<SessionView>): SessionView => ({ id, workspaceId: "w", harness: "claude", status: "completed", threadId: "t1", ...picks });

  it("takes each pick from the last turn that named one, since a resume records only what its send carried", () => {
    // The turn that opened the thread carries the marks the runtime filled in; the resume after it named an effort
    // and nothing else, so the access and the model the thread was opened at are still what it runs.
    const rows = [row("s1", { model: "claude-opus-5", effort: "high", permissionMode: "plan" }), row("s2", { effort: "low" })];
    expect(recordedPicks(rows)).toEqual({ model: "claude-opus-5", effort: "low", permissionMode: "plan" });
    expect(recordedPicks([])).toEqual({});
  });

  it("reads the model and the window it ran at off one row, never two, since the window rides inside the model", () => {
    expect(recordedPicks([row("s1", { model: "claude-opus-5[1m]" })])).toEqual({ model: "claude-opus-5", contextWindow: "1m" });
    expect(recordedPicks([row("s1", { model: "claude-opus-5", contextWindow: "200k" })])).toEqual({ model: "claude-opus-5", contextWindow: "200k" });
    // The later turn ran a model of its own at the window that model came with, so the earlier turn's 1M is gone
    // with the model it rode inside.
    const moved = [row("s1", { model: "claude-opus-5[1m]" }), row("s2", { model: "claude-sonnet-5" })];
    expect(recordedPicks(moved)).toEqual({ model: "claude-sonnet-5" });
  });
});

describe("threadPicks", () => {
  const opened: SessionView = { id: "s1", workspaceId: "w", harness: "claude", status: "completed", model: "claude-opus-5[1m]", effort: "high", permissionMode: "plan" };

  it("keeps the model the thread's last start recorded once no turn runs, even one this list does not carry", () => {
    expect(threadPicks({ running: false, model: "claude-fable-5-1" }, [])).toEqual({ model: "claude-fable-5-1" });
    expect(threadPicks({ running: false, model: "claude-opus-5[1m]" }, [])).toEqual({ model: "claude-opus-5", contextWindow: "1m" });
    expect(threadPicks({ running: false, model: null }, [])).toEqual({});
  });

  it("the running turn's own values win, since a turn on the machine is what the pickers stand for while it streams", () => {
    const running: SessionView = { ...opened, status: "running" };
    // The running turn is read off this thread's own rows, the last of them, so the turn in front of the person is
    // the one the pickers stand for and no other row of the workspace can be it.
    const earlier: SessionView = { ...opened, id: "s0", model: "claude-sonnet-5", effort: "low", permissionMode: "bypassPermissions" };
    expect(threadPicks({ running: true, model: "claude-sonnet-5" }, [earlier, running])).toEqual({ model: "claude-opus-5", contextWindow: "1m", effort: "high", permissionMode: "plan" });
    expect(threadPicks({ running: true, model: "claude-fable-5-1" }, [running])).toEqual({ model: "claude-opus-5", contextWindow: "1m", effort: "high", permissionMode: "plan" });
    expect(threadPicks({ running: true, model: "claude-fable-5-1" }, [{ ...running, model: undefined }])).toEqual({ model: "claude-fable-5-1", effort: "high", permissionMode: "plan" });
  });

  it("the pick shows that model and a send with no pick change carries it, never the catalog's default", () => {
    const thread = threadPicks({ running: false, model: "claude-sonnet-5" }, []);
    expect(effectivePicks(CLAUDE, { picked: {}, thread }).model).toBe("claude-sonnet-5");
    expect(startOptionsFrom(CLAUDE, {}, thread)).toEqual({ model: "claude-sonnet-5" });
    // A picked model still wins, and a thread on the 1M window keeps it rather than resuming at 200k.
    expect(startOptionsFrom(CLAUDE, { model: "claude-next" }, thread)).toEqual({ model: "claude-next" });
    expect(startOptionsFrom(CLAUDE, {}, { model: "claude-opus-5", contextWindow: "1m" })).toEqual({ model: "claude-opus-5", contextWindow: "1m" });
    // A thread with no start behind it sends nothing, so the runtime fills the catalog's default for the new thread.
    expect(startOptionsFrom(CLAUDE, {}, {})).toEqual({});
  });

  it("the access the transcript's record carries stands under the rows, and alone where the rows are gone", () => {
    // A thread whose rows fell off the runtime's cap has its record on its transcript and nothing else.
    expect(threadPicks({ running: false, model: "claude-opus-5", permissionMode: "plan" }, [])).toEqual({ model: "claude-opus-5", permissionMode: "plan" });
    // A row left is the fresher reading: an access pick moves the row along with the record, while the transcript
    // says what the last turn started at.
    const moved: SessionView = { ...opened, model: undefined, permissionMode: "bypassPermissions" };
    expect(threadPicks({ running: false, model: "claude-opus-5", permissionMode: "plan" }, [moved])).toEqual({ model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions" });
    expect(threadPicks({ running: false, model: "claude-opus-5", permissionMode: null }, [])).toEqual({ model: "claude-opus-5" });
  });

  it("between turns the effort and the access come off the thread's own rows, and the send carries them", () => {
    // The turn that opened this thread ran at high and plan; nothing has been picked anywhere, so those, and not the
    // catalog's marks, are what the pickers read and what the next send carries.
    const thread = threadPicks({ running: false, model: "claude-opus-5" }, [opened]);
    expect(thread).toEqual({ model: "claude-opus-5", contextWindow: "1m", effort: "high", permissionMode: "plan" });
    expect(effectivePicks(CLAUDE, { picked: {}, thread })).toEqual({ model: "claude-opus-5", effort: "high", contextWindow: "1m", permissionMode: "plan" });
    expect(startOptionsFrom(CLAUDE, {}, thread)).toEqual({ model: "claude-opus-5", contextWindow: "1m", effort: "high", permissionMode: "plan" });
    // A pick on this thread still wins over what it ran at.
    expect(startOptionsFrom(CLAUDE, { effort: "low", permissionMode: "bypassPermissions" }, thread)).toMatchObject({ effort: "low", permissionMode: "bypassPermissions" });
    // A value this harness's lists do not carry rides nothing, the same rule a model off the list is read by.
    const foreign = threadPicks({ running: false, model: "claude-opus-5" }, [{ ...opened, effort: "ultra", permissionMode: "read-only" }]);
    expect(startOptionsFrom(CLAUDE, {}, foreign)).toEqual({ model: "claude-opus-5", contextWindow: "1m" });
    // A thread with no turn behind it reads nothing off anyone else's rows.
    expect(threadPicks({ running: false, model: null }, [opened])).toEqual({});
  });

  it("a thread on a legacy model keeps it on a send, with no effort where that model takes none", () => {
    const withLegacy: HarnessCatalog = { ...CLAUDE, legacyModels: [{ value: "claude-opus-4-6", label: "Opus 4.6", efforts: [], contextWindows: [] }] };
    const thread = threadPicks({ running: false, model: "claude-opus-4-6" }, []);
    expect(resolveModel(withLegacy, { picked: undefined, thread: thread.model })?.label).toBe("Opus 4.6");
    expect(startOptionsFrom(withLegacy, {}, { ...thread, effort: "high" })).toEqual({ model: "claude-opus-4-6" });
  });

  it("a thread model this list does not carry is shown but not sent, since sessions.start would refuse it", () => {
    const thread = threadPicks({ running: false, model: "claude-fable-5-1" }, []);
    expect(effectivePicks(CLAUDE, { picked: {}, thread }).model).toBe("claude-fable-5-1");
    expect(resolveModel(CLAUDE, { picked: undefined, thread: thread.model })).toEqual({ value: "claude-fable-5-1", label: "claude-fable-5-1" });
    // Nothing rides, so the resume keeps the harness session on that model rather than the send being refused.
    expect(startOptionsFrom(CLAUDE, {}, thread)).toEqual({});
    // The window rides inside the model on claude's wire, so it never leaves without one: a frame carrying a window
    // alone is refused by the adapter with "contextWindow needs a model to ride on".
    expect(startOptionsFrom(CLAUDE, { contextWindow: "1m" }, thread)).toEqual({});
    expect(startOptionsFrom(CLAUDE, {}, { ...thread, contextWindow: "1m" })).toEqual({});
    // A model the person named still rides as named, listed or not: that is a pick, not a value inherited here.
    expect(startOptionsFrom(CLAUDE, { model: "claude-fable-5-1" }, thread)).toEqual({ model: "claude-fable-5-1" });
  });
});

describe("pickedFor", () => {
  const ran = { model: "claude-opus-5" };
  const unrun = { model: null };

  it("drops a model picked on another thread of this workspace, since a thread keeps the model it runs on", () => {
    // The picks are one record per workspace, so without this every thread here shows the last model picked on any
    // of them, and a send moves each of them onto it. An effort picked on this thread stands beside it.
    expect(pickedFor({ model: "claude-fable-5-1", effort: "low" }, ran, { model: "t9", effort: "t1" }, "t1")).toEqual({ effort: "low" });
    expect(pickedFor({ model: "claude-fable-5-1", effort: "low" }, ran, {}, "t1")).toEqual({});
  });

  it("keeps it for a thread that has not run and for the thread the pick was made on", () => {
    expect(pickedFor({ model: "claude-fable-5-1" }, unrun, { model: "t9" }, "t1")).toEqual({ model: "claude-fable-5-1" });
    expect(pickedFor({ model: "claude-fable-5-1" }, ran, { model: "t1" }, "t1")).toEqual({ model: "claude-fable-5-1" });
    expect(pickedFor({ effort: "low" }, ran, { effort: "t1" }, "t1")).toEqual({ effort: "low" });
  });

  it("drops an effort picked on another thread, since it would move this thread's reasoning on the next send", () => {
    // A thread that opened at high, with low picked on another thread of this workspace: unscoped, its button would
    // read low and its next send would run it at low without anyone touching its picker.
    const thread = threadPicks({ running: false, model: "claude-opus-5" }, [{ id: "s1", workspaceId: "w", harness: "claude", status: "completed", effort: "high" }]);
    const picked = pickedFor({ effort: "low" }, ran, { effort: "t9" }, "t1");
    expect(picked).toEqual({});
    expect(effectivePicks(CLAUDE, { picked, thread }).effort).toBe("high");
    expect(startOptionsFrom(CLAUDE, picked, thread)).toEqual({ model: "claude-opus-5", effort: "high" });
    // On the thread it was picked on, and on one that has not run, it stands.
    expect(pickedFor({ effort: "low" }, ran, { effort: "t1" }, "t1")).toEqual({ effort: "low" });
    expect(pickedFor({ effort: "low" }, unrun, { effort: "t9" }, "t1")).toEqual({ effort: "low" });
  });

  it("drops an access picked on another thread, since it would move this thread's permissions on the next send", () => {
    // The access is remembered on the host's record, one per workspace, so without this a mode picked on one thread
    // rides the next send of every other thread here.
    const thread = threadPicks({ running: false, model: "claude-opus-5" }, [{ id: "s1", workspaceId: "w", harness: "claude", status: "completed", permissionMode: "plan" }]);
    const picked = pickedFor({ permissionMode: "bypassPermissions" }, ran, { permissionMode: "t9" }, "t1");
    expect(picked).toEqual({});
    expect(effectivePicks(CLAUDE, { picked, thread }).permissionMode).toBe("plan");
    expect(startOptionsFrom(CLAUDE, picked, thread)).toEqual({ model: "claude-opus-5", permissionMode: "plan" });
    expect(pickedFor({ permissionMode: "bypassPermissions" }, ran, { permissionMode: "t1" }, "t1")).toEqual({ permissionMode: "bypassPermissions" });
    expect(pickedFor({ permissionMode: "bypassPermissions" }, unrun, { permissionMode: "t9" }, "t1")).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("drops a window picked on another thread, since it would drop this thread's own window on the next send", () => {
    // A thread that ran on opus at 1M, with 200k picked on another thread of this workspace: unscoped, its next send
    // would carry claude-opus-5 at 200k and drop this thread's context window without anyone touching its picker.
    const onOneM = threadPicks({ running: false, model: "claude-opus-5[1m]" }, []);
    const picked = pickedFor({ contextWindow: "200k" }, ran, { contextWindow: "t9" }, "t1");
    expect(picked).toEqual({});
    expect(startOptionsFrom(CLAUDE, picked, onOneM)).toEqual({ model: "claude-opus-5", contextWindow: "1m" });
    expect(effectivePicks(CLAUDE, { picked, thread: onOneM }).contextWindow).toBe("1m");
    // On the thread the window was picked on, and on one that has not run, it stands.
    expect(pickedFor({ contextWindow: "200k" }, ran, { contextWindow: "t1" }, "t1")).toEqual({ contextWindow: "200k" });
    expect(pickedFor({ contextWindow: "200k" }, unrun, { contextWindow: "t9" }, "t1")).toEqual({ contextWindow: "200k" });
  });

  it("reads each pick on its own thread, so no pick carries another onto this one", () => {
    // The window picked here and the model picked on another thread: the window stands and the model is dropped, or
    // picking a window here would move this thread onto a model nobody picked on it.
    expect(pickedFor({ model: "claude-fable-5-1", contextWindow: "200k" }, ran, { model: "t9", contextWindow: "t1" }, "t1")).toEqual({ contextWindow: "200k" });
    expect(pickedFor({ model: "claude-fable-5-1", contextWindow: "200k" }, ran, { model: "t1", contextWindow: "t9" }, "t1")).toEqual({ model: "claude-fable-5-1" });
    expect(pickedFor({ model: "claude-fable-5-1", contextWindow: "200k" }, ran, { model: "t1", contextWindow: "t1" }, "t1")).toEqual({ model: "claude-fable-5-1", contextWindow: "200k" });
    // The four together: each stands or falls on the thread it was picked on, and the harness, which is not a thread's
    // to keep, stands whichever thread it was picked on.
    const all = { harness: "claude", model: "claude-fable-5-1", contextWindow: "200k", effort: "low", permissionMode: "plan" };
    expect(pickedFor(all, ran, { model: "t1", contextWindow: "t9", effort: "t1", permissionMode: "t9" }, "t1")).toEqual({ harness: "claude", model: "claude-fable-5-1", effort: "low" });
    expect(pickedFor(all, ran, {}, "t1")).toEqual({ harness: "claude" });
  });

  it("the thread's own model is what the pickers show and what the send carries", () => {
    const picked = pickedFor({ model: "claude-fable-5-1" }, ran, { model: "t9" }, "t1");
    const thread = threadPicks({ running: false, model: "claude-opus-5" }, []);
    expect(effectivePicks(CLAUDE, { picked, thread }).model).toBe("claude-opus-5");
    expect(startOptionsFrom(CLAUDE, picked, thread)).toEqual({ model: "claude-opus-5" });
  });
});

describe("effectivePicks and startOptionsFrom", () => {
  it("shows the pick, else the running value, else the default, and drops a pick the model cannot take", () => {
    expect(effectivePicks(CLAUDE, { picked: {}, thread: {} })).toEqual({ model: "claude-opus-5", effort: "high", contextWindow: "1m", permissionMode: "bypassPermissions" });
    const picks = effectivePicks(CLAUDE, { picked: { effort: "low", contextWindow: "200k" }, thread: {} });
    expect(picks).toEqual({ model: "claude-opus-5", effort: "low", contextWindow: "200k", permissionMode: "bypassPermissions" });
    // Next takes only high, so the catalog's default survives the narrowing; Haiku takes none, so nothing is shown.
    expect(effectivePicks(CLAUDE, { picked: { model: "claude-next" }, thread: {} }).effort).toBe("high");
    const haiku = effectivePicks(CLAUDE, { picked: { model: "claude-haiku-4-5", effort: "high", contextWindow: "1m" }, thread: {} });
    expect(haiku).toEqual({ model: "claude-haiku-4-5", effort: null, contextWindow: null, permissionMode: "bypassPermissions" });
    const sonnet = effectivePicks(CLAUDE, { picked: { model: "claude-sonnet-5" }, thread: { effort: "low" } });
    expect(sonnet).toEqual({ model: "claude-sonnet-5", effort: "low", contextWindow: null, permissionMode: "bypassPermissions" });
  });

  it("only picks ride the wire, except that a context window brings the model it rides on", () => {
    expect(startOptionsFrom(CLAUDE, {})).toEqual({});
    expect(startOptionsFrom(CLAUDE, { effort: "high", permissionMode: "plan" })).toEqual({ effort: "high", permissionMode: "plan" });
    expect(startOptionsFrom(CLAUDE, { contextWindow: "1m" })).toEqual({ model: "claude-opus-5", contextWindow: "1m" });
    expect(startOptionsFrom(CLAUDE, { model: "claude-sonnet-5", contextWindow: "1m" })).toEqual({ model: "claude-sonnet-5" });
    expect(startOptionsFrom(CLAUDE, { model: "claude-haiku-4-5", effort: "high" })).toEqual({ model: "claude-haiku-4-5" });
    expect(startOptionsFrom(CLAUDE, { harness: "claude", model: "claude-old-3", effort: "low" })).toEqual({ harness: "claude", model: "claude-old-3", effort: "low" });
  });

  it("a remembered access mode this harness does not list shows the mode that will run, and is not sent as a pick", () => {
    // A pick is remembered per workspace and the harnesses' mode lists are disjoint, so this is what a claude thread
    // shows after an access was picked on codex: the list's own default, which is what the start will run.
    expect(effectivePicks(CLAUDE, { picked: { permissionMode: "read-only" }, thread: {} }).permissionMode).toBe("bypassPermissions");
    expect(startOptionsFrom(CLAUDE, { permissionMode: "read-only", effort: "high" })).toEqual({ effort: "high" });
    // The running turn's own value is read the same way: a mode off this list is not shown for it either.
    expect(effectivePicks(CLAUDE, { picked: {}, thread: { permissionMode: "read-only" } }).permissionMode).toBe("bypassPermissions");
    // A list with no default of its own has nothing to fall back to, so the picker shows nothing and sends nothing.
    const unmarked = { ...CLAUDE, permissionModes: CLAUDE.permissionModes.map(({ isDefault: _d, ...m }) => m) };
    expect(effectivePicks(unmarked, { picked: { permissionMode: "read-only" }, thread: {} }).permissionMode).toBeNull();
  });

  it("an effort or a window picked on another harness falls back the same way, one rule for the three", () => {
    expect(effectivePicks(CLAUDE, { picked: { effort: "ultra" }, thread: {} }).effort).toBe("high");
    expect(effectivePicks(CLAUDE, { picked: { contextWindow: "2m" }, thread: {} }).contextWindow).toBe("1m");
    expect(startOptionsFrom(CLAUDE, { effort: "ultra", contextWindow: "2m" })).toEqual({});
  });
});
