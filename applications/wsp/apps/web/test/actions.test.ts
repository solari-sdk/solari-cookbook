// SPDX-License-Identifier: AGPL-3.0-only
// One action registry per object kind: every entry carries its words, its
// enabled rule from the object's state, its keybinding and its handler, and
// the palette, the row buttons, the Machine tab and the context menus all
// read the same list. These tests pin the rules per kind and the shapes the
// menus are built from.
import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { goneRefusal, kindWords, machineWord, notAnsweringYet, ownDaemonDown, threadForgetRefusal, workspaceState, workspaceWord, type HarnessCatalog, type PlaceView, type SessionStatus, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { TERMINAL_WORDS, THREAD_WORDS, WORKSPACE_WORDS, terminalRefusedLine } from "../src/actions/format.js";
import { placeMenu } from "../src/actions/menuPlacement.js";
import { actionById, actionIfAny, resolveActions, toMenuItems } from "../src/actions/registry.js";
import { terminalActions, type TerminalVerbs } from "../src/actions/terminalActions.js";
import { threadActions, threadTarget, type ThreadTarget, type ThreadVerbs } from "../src/actions/threadActions.js";
import { workspaceActions, workspaceTarget, type WorkspaceTarget, type WorkspaceVerbs } from "../src/actions/workspaceActions.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { MAX_TERMINALS_PER_GROUP } from "../src/terminal/groups.js";

/** A target in one folded state, spelled as the phase, machine state and reach that fold to it. */
const workspace = (state: WorkspaceState, over: Partial<WorkspaceTarget> = {}): WorkspaceTarget => ({
  id: "ws_a",
  displayName: "api",
  machineId: "m_a",
  kind: "cloud",
  phase: state === "paused" ? "napping" : state === "unreachable" ? "running" : state,
  machineState: state === "gone" ? "gone" : null,
  reach: state === "gone" ? "gone" : state === "paused" ? "napping" : state === "unreachable" ? "unreachable" : "reachable",
  reason: null,
  wakeRefused: null,
  absent: null,
  ...over,
});

function workspaceVerbs(over: Partial<WorkspaceVerbs> = {}): WorkspaceVerbs {
  return {
    togglePhase: vi.fn(async () => {}),
    openTerminal: vi.fn(async () => {}),
    openBrowser: vi.fn(),
    newThread: vi.fn(),
    bringBack: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(),
    copyText: vi.fn(async () => {}),
    rebuild: vi.fn(async () => {}),
    restartDaemon: vi.fn(async () => {}),
    forget: vi.fn(),
    rename: vi.fn(),
    exportProject: vi.fn(),
    ...over,
  };
}

const enabled = (actions: ReturnType<typeof resolveActions>) => actions.filter(a => a.refusal === null).map(a => a.id);
const titles = (actions: ReturnType<typeof resolveActions>) => actions.map(a => a.title);

describe("workspace actions", () => {
  it("a running workspace offers pause, terminal, browser, new thread, bring back, the project trips, rename and copy id; fork, rebuild and forget carry their refusal", () => {
    const verbs = workspaceVerbs();
    const actions = resolveActions(workspaceActions, workspace("running"), verbs);
    // The rebuild, the start and the forget are roads out of a state this workspace is not in, so they are not
    // drawn at all: a row held with a reason a person cannot clear is furniture.
    expect(titles(actions)).toEqual([
      WORKSPACE_WORDS.pause,
      WORKSPACE_WORDS.newThread,
      WORKSPACE_WORDS.openTerminal,
      WORKSPACE_WORDS.openBrowser,
      WORKSPACE_WORDS.bringBack,
      WORKSPACE_WORDS.exportProject,
      WORKSPACE_WORDS.rename,
      WORKSPACE_WORDS.fork,
      WORKSPACE_WORDS.copyId,
      WORKSPACE_WORDS.delete,
    ]);
    expect(enabled(actions)).toEqual(["phase", "new-thread", "open-terminal", "open-browser", "bring-back", "export-project", "rename", "copy-id", "delete"]);
    expect(actionById(actions, "rename").refusal).toBeNull();
    // A workspace name is this computer's own record, so the box opens whatever the machine is doing.
    expect(actionById(resolveActions(workspaceActions, workspace("gone"), verbs), "rename").refusal).toBeNull();
    // A client with no rename verb says so rather than opening a box nothing would take.
    expect(actionById(resolveActions(workspaceActions, workspace("running"), workspaceVerbs({ rename: undefined })), "rename").refusal).toBe("This client cannot rename tasks");
    // The look actions are gone from the registry, so no surface can offer a picker for a colour or a glyph.
    expect(actions.map(action => action.id)).not.toContain("icon");
    expect(actions.map(action => action.id)).not.toContain("theme");
    expect(actionById(actions, "fork").refusal).toBe("Running a copy of a task is not in the runtime yet; make a second task of the same project from the plus on its row");
    expect(actionIfAny(actions, "rebuild")).toBeUndefined();
    expect(actionIfAny(actions, "forget")).toBeUndefined();
    expect(actionIfAny(actions, "start-daemon")).toBeUndefined();
  });

  it("pause and wake are one slot: the word follows the state, and the moving states refuse it with a word", () => {
    const verbs = workspaceVerbs();
    expect(actionById(resolveActions(workspaceActions, workspace("running"), verbs), "phase").title).toBe(WORKSPACE_WORDS.pause);
    expect(actionById(resolveActions(workspaceActions, workspace("unreachable"), verbs), "phase").title).toBe(WORKSPACE_WORDS.pause);
    const paused = actionById(resolveActions(workspaceActions, workspace("paused"), verbs), "phase");
    expect(paused.title).toBe(WORKSPACE_WORDS.wake);
    expect(paused.refusal).toBeNull();
    expect(actionById(resolveActions(workspaceActions, workspace("pausing"), verbs), "phase").refusal).toBe("Task is pausing; it can be woken once it is paused");
    // A waking workspace is the one moving state with something to offer: the stop on the host's own asking again.
    const waking = actionById(resolveActions(workspaceActions, workspace("waking"), verbs), "phase");
    expect(waking.title).toBe(WORKSPACE_WORDS.stopWake);
    expect(waking.refusal).toBeNull();
    expect(waking.rowLabel).toBe("Stop api");
    expect(actionById(resolveActions(workspaceActions, workspace("gone"), verbs), "phase").refusal).toBe(goneRefusal("wake"));
    // A machine wsp neither forked nor pays for is neither paused nor woken by wsp, so the slot is not there.
    expect(actionIfAny(resolveActions(workspaceActions, workspace("running", { kind: "local" }), verbs), "phase")).toBeUndefined();
  });

  it("this computer offers neither the machine verbs nor the fork, and keeps every verb that is about the work", () => {
    const mac = workspace("running", { kind: "local", displayName: "zingzy-mac" });
    const actions = resolveActions(workspaceActions, mac, workspaceVerbs());
    // Nothing here pauses, wakes, rebuilds or forks this computer, so the row offers none of it.
    expect(titles(actions)).toEqual([
      WORKSPACE_WORDS.newThread,
      WORKSPACE_WORDS.openTerminal,
      WORKSPACE_WORDS.openBrowser,
      WORKSPACE_WORDS.bringBack,
      WORKSPACE_WORDS.exportProject,
      WORKSPACE_WORDS.rename,
      WORKSPACE_WORDS.copyId,
      WORKSPACE_WORDS.delete,
    ]);
    expect(actionById(actions, "new-thread").refusal).toBeNull();
    expect(actionById(actions, "open-terminal").refusal).toBeNull();
    expect(actionById(actions, "copy-id").refusal).toBeNull();
    expect(actionById(actions, "delete").refusal).toBeNull();
    // The delete's hover says what it does to this kind's machine, in that kind's own words.
    expect(actionById(actions, "delete").hint).toBe(`Its ${kindWords("local").onDelete.asked}`);
  });

  it("the start of a daemon is drawn only where this host holds the process that is missing", () => {
    const reading = { word: "No daemon", said: "this Mac's daemon is not running", sentence: "this Mac's daemon is not running", line: "daemon not running, start it", start: "Start it" } as WorkspaceTarget["absent"];
    const down = resolveActions(workspaceActions, workspace("running", { kind: "local", absent: reading }), workspaceVerbs());
    expect(actionById(down, "start-daemon").refusal).toBeNull();
    expect(actionById(resolveActions(workspaceActions, workspace("running", { kind: "local", absent: reading }), workspaceVerbs({ restartDaemon: undefined })), "start-daemon").refusal).toBe("This client cannot start a daemon");
    expect(actionIfAny(resolveActions(workspaceActions, workspace("running", { kind: "local" }), workspaceVerbs()), "start-daemon")).toBeUndefined();
  });

  it("a gone workspace offers rebuild and forget and refuses the machine actions; a zombie offers rebuild alone; a client without the verbs says so", () => {
    const verbs = workspaceVerbs();
    const gone = resolveActions(workspaceActions, workspace("gone"), verbs);
    expect(enabled(gone)).toEqual(["rebuild", "rename", "copy-id", "forget"]);
    // The delete is the road for a machine that is still there; a gone one has only its record left to lose.
    expect(actionIfAny(gone, "delete")).toBeUndefined();
    expect(actionById(gone, "new-thread").refusal).toBe("New threads wait for the rebuild");
    expect(actionById(gone, "open-terminal").refusal).toBe(goneRefusal("open a terminal"));
    expect(actionById(gone, "open-browser").refusal).toBe(goneRefusal("preview"));
    const zombie = resolveActions(workspaceActions, workspace("unreachable", { reach: "zombie" }), verbs);
    expect(actionById(zombie, "rebuild").refusal).toBeNull();
    // A zombie is a machine that is still there, so the road out of it is the delete and not the forget.
    expect(actionIfAny(zombie, "forget")).toBeUndefined();
    expect(actionById(zombie, "delete").refusal).toBeNull();
    const bare = resolveActions(workspaceActions, workspace("gone"), workspaceVerbs({ rebuild: undefined, forget: undefined }));
    expect(actionById(bare, "rebuild").refusal).toBe("This client cannot rebuild tasks");
    expect(actionById(bare, "forget").refusal).toBe("This client cannot forget tasks");
    // Bringing a folder home: the machine must answer, and the client must have the folder ops; a browser tab
    // without them says so. Nothing imports any more: a project is recorded with wsp add and a workspace is one's copy.
    expect(actionById(zombie, "export-project").refusal).toBe("Projects wait for the rebuild");
    expect(actionById(resolveActions(workspaceActions, workspace("paused"), verbs), "export-project").refusal).toBeNull();
    const noTrips = resolveActions(workspaceActions, workspace("running"), workspaceVerbs({ exportProject: undefined }));
    expect(actionById(noTrips, "export-project").refusal).toBe("This client cannot export projects");
    expect(actionById(resolveActions(workspaceActions, workspace("paused"), verbs), "open-browser").refusal).toBe("Workspace is paused; wake it to preview");
    expect(actionById(resolveActions(workspaceActions, workspace("waking"), verbs), "open-browser").refusal).toBe("Workspace is waking; previews open when it is running");
  });

  it("every handler reaches its verb with the workspace, and copy id copies the machine id", async () => {
    const verbs = workspaceVerbs();
    const actions = resolveActions(workspaceActions, workspace("running"), verbs);
    await actionById(actions, "phase").run();
    await actionById(actions, "new-thread").run();
    await actionById(actions, "open-terminal").run();
    await actionById(actions, "open-browser").run();
    await actionById(actions, "bring-back").run();
    await actionById(actions, "copy-id").run();
    await actionById(actions, "export-project").run();
    expect(verbs.exportProject).toHaveBeenCalledWith("ws_a");
    expect(verbs.togglePhase).toHaveBeenCalledWith("ws_a");
    expect(verbs.newThread).toHaveBeenCalledWith("ws_a");
    expect(verbs.openTerminal).toHaveBeenCalledWith("ws_a");
    expect(verbs.openBrowser).toHaveBeenCalledWith("ws_a");
    expect(verbs.bringBack).toHaveBeenCalledWith("ws_a");
    expect(verbs.copyText).toHaveBeenCalledWith("m_a");
    const gone = resolveActions(workspaceActions, workspace("gone"), verbs);
    await actionById(gone, "rebuild").run();
    await actionById(gone, "forget").run();
    expect(verbs.rebuild).toHaveBeenCalledWith("ws_a");
    expect(verbs.forget).toHaveBeenCalledWith("ws_a");
  });

  it("a button on the object's own surface reads its word, its icon and its hover text from the entry, so a button never says two things", () => {
    const verbs = workspaceVerbs();
    const phaseOf = (state: WorkspaceState, over: Partial<WorkspaceTarget> = {}) => actionById(resolveActions(workspaceActions, workspace(state, over), verbs), "phase");
    expect([phaseOf("running").buttonWord, phaseOf("unreachable").buttonWord, phaseOf("paused").buttonWord, phaseOf("gone").buttonWord]).toEqual(["Pause", "Pause", "Wake", "Wake"]);
    expect([phaseOf("pausing").buttonWord, phaseOf("waking").buttonWord]).toEqual(["Pausing…", "Stop"]);
    expect([phaseOf("running").icon, phaseOf("paused").icon, phaseOf("waking").icon]).toEqual([PauseIcon, PlayIcon, SquareIcon]);
    expect(phaseOf("running").hint).toBe("Suspend the VM and keep the disk");
    expect(phaseOf("paused").hint).toBe("Boot the VM from its disk");
    expect(phaseOf("waking").hint).toBe("Stop asking the provider to wake this task");
    // A record that still says running while the provider holds the machine paused reads Wake, as its label does.
    const behind = phaseOf("running", { machineState: "paused" });
    expect([behind.buttonWord, behind.rowLabel, behind.title]).toEqual(["Wake", "Wake api", WORKSPACE_WORDS.wake]);
    const gone = resolveActions(workspaceActions, workspace("gone", { reason: "machine m_a is gone at the provider: Not found" }), verbs);
    expect(actionById(gone, "forget").buttonWord).toBe("Forget");
    expect(actionById(gone, "forget").hint).toBe("Its computer is gone; forget the task to drop it from this computer");
    expect(actionById(gone, "rebuild").buttonWord).toBe("Rebuild");
    expect(actionById(gone, "rebuild").hint).toBe("machine m_a is gone at the provider: Not found");
    expect(actionById(resolveActions(workspaceActions, workspace("unreachable", { reach: "zombie" }), verbs), "rebuild").hint).toBe("The task answers nothing; rebuild it from your image");
    expect(actionById(gone, "copy-id").buttonWord).toBeNull();
    expect(actionById(gone, "copy-id").hint).toBeNull();
  });

  it("one target builder serves every surface: the status's phase, machine state, reach and reason lead, the record fills in", () => {
    const view: WorkspaceView = { id: "ws_a", name: "api", machineId: "m_old", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z", gone: "the record's words" };
    const status: WorkspaceStatus = { ...view, machineId: "m_new", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "napping", machineState: "paused", reach: { state: "napping" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11, reason: "the status's words" };
    expect(workspaceTarget(view, status, [])).toEqual({ id: "ws_a", displayName: "api", kind: "cloud", machineId: "m_new", phase: "napping", machineState: "paused", reach: "napping", reason: "the status's words", wakeRefused: null, absent: null });
    expect(workspaceTarget(view, null, [])).toEqual({ id: "ws_a", displayName: "api", kind: "cloud", machineId: "m_old", phase: "running", machineState: null, reach: null, reason: "the record's words", wakeRefused: null, absent: null });
    // The record's own wake words ride apart from the reason, which the next status push replaces.
    expect(workspaceTarget({ ...view, wakeRefused: "the provider answered none of 31 resume requests over 30m" }, null, []).wakeRefused).toBe("the provider answered none of 31 resume requests over 30m");
    // A record from before local workspaces existed carries no kind and reads as a fork; one that does keeps it.
    expect(workspaceTarget({ ...view, kind: "local" }, null, []).kind).toBe("local");
    // The computer the host runs on carries the one reading of its own daemon, so a verb refused on it names the
    // part that is down; every other kind's silence is its computer's link and is read off the places list.
    const here = { ...view, kind: "local" as const };
    expect(workspaceTarget(here, { ...status, kind: "local", phase: "running", machineState: "running", reach: { state: "unreachable" } }, []).absent?.said).toBe("this Mac's daemon is not running");
    expect(workspaceTarget(here, { ...status, kind: "local", phase: "running", machineState: "running", reach: { state: "reachable" } }, []).absent).toBeNull();
    // A fork at a provider whose computer has stopped answering reads that computer's own sentence off the list,
    // which is the same door and not a second rule: the reading is null while nothing on the list is away.
    const laptop: PlaceView = { id: "pc_laptop", kind: "computer", name: "laptop", default: false, present: false };
    const answering: PlaceView = { ...laptop, present: true };
    const away = { ...view, kind: "cloud" as const, place: "pc_laptop" };
    expect(workspaceTarget(away, null, [answering]).absent).toBeNull();
    expect(workspaceTarget(away, null, [laptop]).absent?.said).toBe("laptop is not answering");
    expect(workspaceTarget(view, { ...status, phase: "running", machineState: "running", reach: { state: "unreachable" } }, []).absent).toBeNull();
  });

  it("refuses a preview on this computer in the computer's own sentence, never by calling it unreachable", () => {
    const here = workspace("unreachable", { kind: "local", absent: ownDaemonDown("this Mac") });
    const actions = resolveActions(workspaceActions, here, workspaceVerbs({ forget: vi.fn() }));
    expect(actionById(actions, "open-browser").refusal).toBe("this Mac's daemon is not running");
    for (const action of actions) expect(action.refusal ?? "").not.toMatch(/unreachable/i);
    // Neither road out of gone is drawn on a machine that is merely not answering: it is still there.
    expect(actionIfAny(actions, "forget")).toBeUndefined();
    const fork = resolveActions(workspaceActions, workspace("unreachable"), workspaceVerbs({ forget: vi.fn() }));
    expect(actionById(fork, "open-browser").refusal).toBe("Workspace is unreachable; previews open when the machine answers");
    expect(actionIfAny(fork, "forget")).toBeUndefined();
  });

  it("a paused machine the provider would not resume offers the rebuild beside the wake, with the record's own words on it", () => {
    const words = "the provider answered none of 31 resume requests over 30m; the work on this machine's disk stays with the provider, and a rebuild starts a new machine from the image";
    const target = workspace("paused", { wakeRefused: words });
    const actions = resolveActions(workspaceActions, target, workspaceVerbs());
    const rebuild = actionById(actions, "rebuild");
    expect(rebuild.refusal).toBeNull();
    expect(rebuild.hint).toBe(words);
    // The wake stands beside it: the fault is the provider's and may pass, so nothing takes the other road away.
    expect(actionById(actions, "phase").refusal).toBeNull();
    expect(actionById(actions, "phase").buttonWord).toBe("Wake");
    // The same machine before its wake ran out has nothing to rebuild, so the row is not drawn at all.
    expect(actionIfAny(resolveActions(workspaceActions, workspace("paused"), workspaceVerbs()), "rebuild")).toBeUndefined();
  });

  it("a workspace that is not answering offers neither road out of gone, and its row says the state that is so", () => {
    const actions = resolveActions(workspaceActions, workspace("unreachable"), workspaceVerbs());
    // A person read these four rows apart in one list, each naming a road that opens only once the machine is
    // gone; a machine that is merely not answering is not gone, so neither row is there to be read.
    expect(actionIfAny(actions, "rebuild")).toBeUndefined();
    expect(actionIfAny(actions, "forget")).toBeUndefined();
    expect(workspaceWord(workspaceState(workspace("unreachable")))).toBe("Unreachable");
    // A machine that does answer offers neither either, and the delete is the one road out of it.
    const running = resolveActions(workspaceActions, workspace("running"), workspaceVerbs());
    expect(actionIfAny(running, "rebuild")).toBeUndefined();
    expect(actionById(running, "delete").refusal).toBeNull();
  });
  it("the row buttons' labels name the workspace, and the keybindings come from the one table", () => {
    const actions = resolveActions(workspaceActions, workspace("gone"), workspaceVerbs());
    expect(actionById(actions, "forget").rowLabel).toBe("Forget api");
    expect(actionById(actions, "rebuild").rowLabel).toBe("Rebuild api");
    expect(actionById(actions, "new-thread").rowLabel).toBe("New thread in api");
    expect(actionById(actions, "phase").rowLabel).toBe("Wake api");
    expect(actionById(resolveActions(workspaceActions, workspace("running"), workspaceVerbs()), "phase").rowLabel).toBe("Pause api");
    expect(actionById(actions, "open-terminal").shortcutCommand).toBe("terminal.toggle");
    expect(actionById(actions, "new-thread").shortcutCommand).toBe("chat.new");
    expect(actionById(actions, "open-browser").shortcutCommand).toBe("preview.toggle");
    expect(actionById(actions, "copy-id").shortcutCommand).toBeUndefined();
  });
});

describe("thread actions", () => {
  /** The agent's row as its machine answered it: renames is the adapter's answer there, as steers is. */
  const row = (harness: string, over: Partial<HarnessCatalog> = {}): HarnessCatalog => ({
    harness,
    label: harness === "claude" ? "Claude Code" : harness,
    source: "harness",
    version: "2.1.263",
    models: [],
    efforts: [],
    contextWindows: [],
    permissionModes: [],
    steers: false,
    renames: true,
    images: true,
    ...over,
  });
  const thread = (
    status: SessionStatus,
    threadId: string | null = "thr_1",
    harness = "claude",
    machine: { catalog?: HarnessCatalog | null; state?: WorkspaceState; goneWords?: string } = {},
    ran = true,
  ): ThreadTarget =>
    threadTarget(
      { id: "thr_1", sessionId: "s1", threadId, workspaceId: "ws_a", harness, title: "fix the port list", status, ran, startedAt: null, endedAt: null, indicator: null, startedBy: "person", project: null, parentThreadId: null, asking: null, costUsd: null },
      { catalog: machine.catalog === undefined ? row(harness) : machine.catalog, state: machine.state ?? "running", ...(machine.goneWords !== undefined ? { goneWords: machine.goneWords } : {}) },
    );
  const threadVerbs = (over: Partial<ThreadVerbs> = {}): ThreadVerbs => ({ stop: vi.fn(async () => {}), rename: vi.fn(), forget: vi.fn(), copyText: vi.fn(async () => {}), ...over });

  it("a running thread offers stop, rename and copy link; forget carries the runtime's own refusal", async () => {
    const verbs = threadVerbs();
    const actions = resolveActions(threadActions, thread("running"), verbs);
    expect(titles(actions)).toEqual([THREAD_WORDS.stop, THREAD_WORDS.rename, THREAD_WORDS.copyLink, THREAD_WORDS.forget]);
    expect(enabled(actions)).toEqual(["stop", "rename", "copy-link"]);
    expect(actionById(actions, "forget").refusal).toBe(threadForgetRefusal("thr_1"));
    await actionById(actions, "stop").run();
    expect(verbs.stop).toHaveBeenCalledWith("s1");
    // The rename opens the name on the row the thread's own key names, which a new turn does not move.
    await actionById(actions, "rename").run();
    expect(verbs.rename).toHaveBeenCalledWith("thr_1");
  });

  it("a thread no turn ever ran on offers the forget, which names the thread and its workspace; a client without the verb says so", async () => {
    const verbs = threadVerbs();
    const never = thread("failed", "thr_1", "claude", {}, false);
    const actions = resolveActions(threadActions, never, verbs);
    expect(actionById(actions, "forget").refusal).toBeNull();
    await actionById(actions, "forget").run();
    expect(verbs.forget).toHaveBeenCalledWith({ threadId: "thr_1", workspaceId: "ws_a" });
    expect(actionById(resolveActions(threadActions, never, threadVerbs({ forget: undefined })), "forget").refusal).toBe("This client cannot forget a thread");
    // A row the runtime stamped no thread id on names nothing to forget.
    expect(actionById(resolveActions(threadActions, thread("completed", null, "claude", {}, false), threadVerbs()), "forget").refusal).toBe("This thread has no id yet");
  });

  it("a settled thread refuses stop; a client without the verb says so; a thread without an id has no link", () => {
    expect(actionById(resolveActions(threadActions, thread("completed"), threadVerbs()), "stop").refusal).toBe("Thread is not running");
    expect(actionById(resolveActions(threadActions, thread("running"), threadVerbs({ stop: undefined })), "stop").refusal).toBe("This client cannot stop a turn");
    expect(actionById(resolveActions(threadActions, thread("running", null), threadVerbs()), "copy-link").refusal).toBe("This thread has no id yet");
  });

  it("reads whether a name is kept off the agent's own catalog row, and a row the runtime's table stood in for is no answer", () => {
    const renameOf = (target: ThreadTarget, over: Partial<ThreadVerbs> = {}): string | null =>
      actionById(resolveActions(threadActions, target, threadVerbs(over)), "rename").refusal;
    expect(renameOf(thread("completed"))).toBeNull();
    expect(renameOf(thread("completed", "thr_1", "codex", { catalog: row("codex") }))).toBeNull();
    // The machine answered no for this agent: nothing offers the rename.
    expect(renameOf(thread("completed", "thr_1", "gemini", { catalog: row("gemini", { renames: false }) }))).toBe("Rename in Gemini CLI is not kept");
    // Nobody has asked that machine yet: the box opens and the runtime answers.
    expect(renameOf(thread("completed", "thr_1", "gemini", { catalog: row("gemini", { renames: false, source: "table" }) }))).toBeNull();
    expect(renameOf(thread("completed", "thr_1", "gemini", { catalog: null }))).toBeNull();
    // The agent keeps a name and this client has no row to edit: that is the client's own refusal.
    expect(renameOf(thread("completed"), { rename: undefined })).toBe("This client cannot rename a thread");
    // An agent that keeps none refuses whatever the client has.
    expect(renameOf(thread("completed", "thr_1", "gemini", { catalog: row("gemini", { renames: false }) }), { rename: undefined })).toBe("Rename in Gemini CLI is not kept");
  });

  it("a machine that is napping is woken by the rename itself, so only one that is gone refuses before the box opens", () => {
    const renameOf = (state: WorkspaceState, goneWords?: string): string | null =>
      actionById(resolveActions(threadActions, thread("completed", "thr_1", "claude", { state, ...(goneWords !== undefined ? { goneWords } : {}) }), threadVerbs()), "rename").refusal;
    expect(renameOf("paused")).toBeNull();
    expect(renameOf("waking")).toBeNull();
    expect(renameOf("unreachable")).toBeNull();
    expect(renameOf("gone")).toBe("Workspace machine is gone; rebuild it to rename");
    expect(renameOf("gone", "machine m1 is gone at the provider")).toBe("Workspace machine is gone; rebuild it to rename (machine m1 is gone at the provider)");
  });

  it("copy link writes the page's address for the thread", async () => {
    const verbs = threadVerbs();
    await actionById(resolveActions(threadActions, thread("completed"), verbs), "copy-link").run();
    expect(verbs.copyText).toHaveBeenCalledWith(`${window.location.origin}${window.location.pathname}#w/ws_a/t/thr_1`);
  });
});


describe("terminal actions", () => {
  const terminalVerbs = (over: Partial<TerminalVerbs> = {}): TerminalVerbs => ({
    copy: vi.fn(async () => {}),
    paste: vi.fn(async () => {}),
    clear: vi.fn(),
    split: vi.fn(),
    splitVertical: vi.fn(),
    newTerminal: vi.fn(),
    close: vi.fn(),
    ...over,
  });

  it("copy needs a selection, split needs room, paste needs a clipboard, and the chords come from the one table", async () => {
    const verbs = terminalVerbs();
    const actions = resolveActions(terminalActions, { hasSelection: false, atSplitLimit: false }, verbs);
    expect(titles(actions)).toEqual([TERMINAL_WORDS.copy, TERMINAL_WORDS.paste, TERMINAL_WORDS.clear, TERMINAL_WORDS.split, TERMINAL_WORDS.splitVertical, TERMINAL_WORDS.new, TERMINAL_WORDS.close]);
    expect(actionById(actions, "copy").refusal).toBe("Nothing is selected");
    expect(enabled(actions)).toEqual(["paste", "clear", "split", "split-vertical", "new", "close"]);
    const full = resolveActions(terminalActions, { hasSelection: true, atSplitLimit: true }, verbs);
    expect(actionById(full, "copy").refusal).toBeNull();
    expect(actionById(full, "split").refusal).toBe(`max ${MAX_TERMINALS_PER_GROUP} per group`);
    expect(actionById(full, "split-vertical").refusal).toBe(`max ${MAX_TERMINALS_PER_GROUP} per group`);
    expect(actionById(resolveActions(terminalActions, { hasSelection: false, atSplitLimit: false }, terminalVerbs({ paste: undefined })), "paste").refusal).toBe("The clipboard cannot be read here");
    const toolbar = resolveActions(terminalActions, { hasSelection: true, atSplitLimit: false }, terminalVerbs({ copy: undefined, clear: undefined }));
    expect(actionById(toolbar, "copy").refusal).toBe("No terminal is active");
    expect(actionById(toolbar, "clear").refusal).toBe("No terminal is active");
    expect(actionById(actions, "split").shortcutCommand).toBe("terminal.split");
    expect(actionById(actions, "new").shortcutCommand).toBe("terminal.new");
    for (const id of ["paste", "clear", "split", "split-vertical", "new", "close"]) await actionById(actions, id).run();
    await actionById(full, "copy").run();
    for (const verb of Object.values(verbs)) expect(verb).toHaveBeenCalledTimes(1);
  });
});

describe("a terminal the link refused", () => {
  it("says no terminal, on the workspace where the app holds its record, with the link's reason", () => {
    expect(terminalRefusedLine("api", "daemon unreachable")).toBe("No terminal on api: daemon unreachable");
    expect(terminalRefusedLine(undefined, "daemon unreachable")).toBe("No terminal: daemon unreachable");
  });
});

describe("menu items from actions", () => {
  it("carry the label, the group, the enabled bit, the refusal and the chord for the platform", () => {
    const items = toMenuItems(resolveActions(workspaceActions, workspace("paused"), workspaceVerbs()), DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" });
    expect(items.map(i => [i.id, i.label, i.group, i.enabled])).toEqual([
      ["phase", WORKSPACE_WORDS.wake, "state", true],
      ["new-thread", WORKSPACE_WORDS.newThread, "open", true],
      ["open-terminal", WORKSPACE_WORDS.openTerminal, "open", true],
      ["open-browser", WORKSPACE_WORDS.openBrowser, "open", false],
      ["bring-back", WORKSPACE_WORDS.bringBack, "project", false],
      ["export-project", WORKSPACE_WORDS.exportProject, "project", true],
      ["rename", WORKSPACE_WORDS.rename, "edit", true],
      ["fork", WORKSPACE_WORDS.fork, "edit", false],
      ["copy-id", WORKSPACE_WORDS.copyId, "copy", true],
      ["delete", WORKSPACE_WORDS.delete, "remove", true],
    ]);
    expect(items.find(i => i.id === "open-browser")?.refusal).toBe("Workspace is paused; wake it to preview");
    expect(items.find(i => i.id === "open-terminal")).toMatchObject({ shortcut: "⌘J", accelerator: "CommandOrControl+J" });
    expect(items.find(i => i.id === "new-thread")).toMatchObject({ shortcut: "⌘N", accelerator: "CommandOrControl+N" });
    expect(items.find(i => i.id === "phase")).not.toHaveProperty("shortcut");
    expect(items.find(i => i.id === "phase")).not.toHaveProperty("refusal");
    expect(items.find(i => i.id === "delete")?.destructive).toBe(true);
    const linux = toMenuItems(resolveActions(workspaceActions, workspace("paused"), workspaceVerbs()), DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux x86_64" });
    expect(linux.find(i => i.id === "open-terminal")).toMatchObject({ shortcut: "Ctrl+J", accelerator: "CommandOrControl+J" });
    // A terminal's chords are bound while a terminal has focus; read without that context they are nobody's.
    const terminal = resolveActions(terminalActions, { hasSelection: false, atSplitLimit: false }, { split: () => {}, splitVertical: () => {}, newTerminal: () => {}, close: () => {} });
    expect(toMenuItems(terminal, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }).find(i => i.id === "split")).not.toHaveProperty("shortcut");
    expect(toMenuItems(terminal, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel", context: { terminalFocus: true } }).find(i => i.id === "split")).toMatchObject({ shortcut: "⌘D", accelerator: "CommandOrControl+D" });
  });
});

describe("placing the in-app menu", () => {
  const viewport = { width: 1000, height: 600 };

  it("opens at the pointer when it fits", () => {
    expect(placeMenu({ x: 100, y: 200 }, { width: 180, height: 240 }, viewport)).toEqual({ left: 100, top: 200 });
  });

  it("flips left of the pointer and up from it when the edge is near, and never leaves the margin", () => {
    expect(placeMenu({ x: 900, y: 500 }, { width: 180, height: 240 }, viewport)).toEqual({ left: 720, top: 260 });
    expect(placeMenu({ x: 990, y: 590 }, { width: 2000, height: 2000 }, viewport)).toEqual({ left: 8, top: 8 });
  });
});

