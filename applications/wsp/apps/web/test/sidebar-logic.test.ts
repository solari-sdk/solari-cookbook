// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's pure logic: the copied t3code sort, search, traversal and
// pill rollup over wsp thread snapshots, plus our row labels and the
// new-workspace helpers.
import { describe, expect, it } from "vitest";
import { FREE_WORD, NO_LINGER_LINE, NO_NODE_LINE, OVER_SSH, THIS_COMPUTER, THREAD_ARCHIVE_MS, absentComputer, awayMsOf, kindWords, machineLacksShort, wakeAskingAgainLine, workspaceState, type ReachState, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../src/adapt/index.js";
import { RequestError } from "../src/protocol/client.js";
import { openedBy, threadTree, threadsOpenedBy, workspaceOf } from "../src/sidebar/threadTree.js";
import { explainCreateRefusal } from "../src/protocol/store.js";
import {
  foldArchivedThreads,
  isThreadArchived,
  isThreadWorking,
  resolveAdjacentThreadId,
  searchSidebarThreadsByTitle,
  nestSpawnedThreads,
  threadForest,
  sidebarThreadOrder,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
  splitSidebarThreads,
  topSidebarThread,
} from "../src/sidebar/Sidebar.logic.js";
import { absenceOf } from "../src/settings/places.js";
import { currentWorkspaceId } from "../src/adapt/workspaces.js";
import {
  compactTimeLabel,
  metaSentences,
  holdsStateWord,
  stateSlotWord,
  daemonGoneLine,
  whereWord,
  threadMetaWords,
  workspaceMetaLine,
} from "../src/sidebar/workspaceRows.js";
import { formatRelativeTimeLabel } from "../src/lib/timestampFormat.js";

const thread = (id: string, startedAt: string | null, endedAt: string | null = null) => ({ id, title: id, startedAt, endedAt });

describe("copied sort and search", () => {
  it("active threads sort newest start first, id as the tiebreak", () => {
    const sorted = sortThreadsForSidebar([
      thread("b", "2026-09-01T00:01:00Z"),
      thread("a", "2026-09-01T00:02:00Z"),
      thread("c", "2026-09-01T00:01:00Z"),
      thread("d", null),
    ]);
    expect(sorted.map(t => t.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("settled threads sort by when they ended, falling back to when they started", () => {
    const sorted = sortSettledThreadsForSidebar([
      thread("old", "2026-09-01T00:00:00Z", "2026-09-01T00:05:00Z"),
      thread("new", "2026-09-01T00:00:00Z", "2026-09-01T00:09:00Z"),
      thread("unstamped", "2026-09-01T00:07:00Z"),
    ]);
    expect(sorted.map(t => t.id)).toEqual(["new", "unstamped", "old"]);
  });

  it("title search is case-insensitive and keeps the input order; an empty query matches nothing", () => {
    const threads = [{ title: "Fix the port list" }, { title: "upgrade node" }, { title: "port forwarding" }];
    expect(searchSidebarThreadsByTitle(threads, "PORT").map(t => t.title)).toEqual(["Fix the port list", "port forwarding"]);
    expect(searchSidebarThreadsByTitle(threads, "  ")).toEqual([]);
  });
});

describe("the archive fold", () => {
  const NOW = Date.parse("2026-09-08T12:00:00Z");
  const idleFor = (id: string, ms: number) => thread(id, new Date(NOW - ms - 60_000).toISOString(), new Date(NOW - ms).toISOString());

  it("the threshold is the protocol's one word: a thread idle just under it stays on the shelf, one idle at it or past it archives", () => {
    expect(isThreadArchived(idleFor("just-under", THREAD_ARCHIVE_MS - 60_000), NOW)).toBe(false);
    expect(isThreadArchived(idleFor("exactly", THREAD_ARCHIVE_MS), NOW)).toBe(true);
    expect(isThreadArchived(idleFor("well-past", 3 * THREAD_ARCHIVE_MS), NOW)).toBe(true);
  });

  it("a thread with no readable timestamp has no idleness to measure, so it stays on the shelf", () => {
    expect(isThreadArchived(thread("blank", null, null), NOW)).toBe(false);
    expect(isThreadArchived(thread("malformed", "not a date", "also not a date"), NOW)).toBe(false);
  });

  it("the fold counts each side and keeps the order the shelf sorted them into", () => {
    const shelf = [idleFor("a", 60_000), idleFor("b", 2 * THREAD_ARCHIVE_MS), idleFor("c", 3 * 60_000), idleFor("d", 5 * THREAD_ARCHIVE_MS)];
    const { settled, archived } = foldArchivedThreads(shelf, NOW);
    expect(settled.map(t => t.id)).toEqual(["a", "c"]);
    expect(archived.map(t => t.id)).toEqual(["b", "d"]);
  });

  it("a thread that takes a new turn leaves the archive on its own: it is working, so the split never offers it to the fold", () => {
    const woken = { ...idleFor("woken", 5 * THREAD_ARCHIVE_MS), status: "running" as const };
    const stale = { ...idleFor("stale", 5 * THREAD_ARCHIVE_MS), status: "completed" as const };
    const { active, settled } = splitSidebarThreads([woken, stale]);
    expect(active.map(t => t.id)).toEqual(["woken"]);
    expect(foldArchivedThreads(settled, NOW).archived.map(t => t.id)).toEqual(["stale"]);
    // And once that turn settles, its fresh end stamp keeps it out of the archive with no flag to clear.
    const replied = { ...woken, status: "completed" as const, endedAt: new Date(NOW - 1_000).toISOString() };
    expect(isThreadArchived(replied, NOW)).toBe(false);
  });
});

describe("copied traversal and rollup", () => {
  it("walks the row ids and stops at the ends", () => {
    const ids = ["a", "b", "c"];
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: null, direction: "next" })).toBe("a");
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: null, direction: "previous" })).toBe("c");
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: "a", direction: "next" })).toBe("b");
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: "c", direction: "next" })).toBeNull();
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: "zz", direction: "next" })).toBeNull();
  });

  it("only a running turn is working; a thread waiting on the user is idle whatever its session says", () => {
    expect(isThreadWorking({ status: "running" })).toBe(true);
    expect(isThreadWorking({ status: "completed" })).toBe(false);
    expect(isThreadWorking({ status: "interrupted" })).toBe(false);
    expect(isThreadWorking({ status: "failed" })).toBe(false);
    expect(isThreadWorking({ status: "running", hasPendingApprovals: true })).toBe(false);
    expect(isThreadWorking({ status: "running", hasPendingUserInput: true })).toBe(false);
  });
});

const status = (over: Partial<WorkspaceStatus>): WorkspaceStatus => ({
  id: "ws_a", name: "api", machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap", createdAt: "2026-09-01T00:00:00Z",
  machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11, ...over,
});

describe("workspace row labels", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");

  /** A project as the adapter folds it from a status, with the record's phase behind it. */
  const project = (over: Partial<WorkspaceStatus>, view: Partial<WorkspaceView> = {}, threads: { asking: string | null }[] = []) => {
    const st = status(over);
    return {
      state: workspaceState({ phase: st.phase, machineState: st.machineState, reach: st.reach.state }),
      status: st,
      reach: st.reach.state,
      workspace: { ...st, ...view },
      threads: threads as unknown as SidebarProjectSnapshot["threads"],
    };
  };

  it("a thread stopped on a permission prompt puts what it is asking on the row's third line, ahead of the spend and of the helper's own note", () => {
    const asked = [{ asking: "Write out.txt in root (2 B)" }, { asking: null }];
    const line = (threads: { asking: string | null }[], over: Partial<WorkspaceStatus> = {}) =>
      workspaceMetaLine({ project: project(over, {}, threads), outOfMemory: undefined });
    expect(line(asked)).toBe("Write out.txt in root (2 B)");
    // Even while the helper has something to say: the prompt is the one thing on the row a person can answer now.
    expect(line(asked, { daemonNote: "updating the helper" })).toBe("Write out.txt in root (2 B)");
    // The oldest waiting thread's, so a second prompt never takes the line from the one that has waited longest.
    expect(line([{ asking: "Run: ls" }, ...asked])).toBe("Run: ls");
    // Nothing waiting and no branch on the record: the line is empty rather than a figure.
    expect(line([{ asking: null }])).toBe("");
    // The line is handed over whole: the slot's own width cuts it, and the whole sentence rides the row's title.
    const long = "Run: wsp --version && wsp host list && wsp workspaces";
    expect(line([{ asking: long }])).toBe(long);
  });

  it("what the runtime is doing to the machine's helper, or a drop with memory near full, takes the whole line", () => {
    const GiB = 1024 ** 3;
    expect(workspaceMetaLine({ project: project({ daemonNote: "updating the helper" }), outOfMemory: undefined })).toBe("updating the helper");
    expect(workspaceMetaLine({ project: project({}), outOfMemory: { used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.4 } })).toBe("out of memory, 3.6 of 3.9 GB");
    // Before a status arrives the record's own note is the line; a status without one says nothing about the helper.
    expect(workspaceMetaLine({ project: { ...project({}), status: null }, outOfMemory: undefined })).toBe("");
    expect(workspaceMetaLine({ project: { ...project({}, { daemonNote: "updating the helper" }), status: null }, outOfMemory: undefined })).toBe("updating the helper");
    // A status that arrived with no note of its own says nothing about the helper, whatever the record held.
    expect(workspaceMetaLine({ project: project({}, { daemonNote: "updating the helper" }), outOfMemory: undefined })).toBe("");
  });

  it("the state slot says nothing while running, since the row's own glyph says it, and the state's word otherwise", () => {
    const slot = (state: WorkspaceState, label: string, tone: "running" | "paused" | "neutral", pulse = false) =>
      stateSlotWord({ state, indicator: { label, tone, pulse }, workspace: project({}).workspace });
    expect(slot("running", "Running", "running")).toBe("");
    expect(slot("paused", "Paused", "paused")).toBe("Paused");
    expect(slot("gone", "Gone", "neutral")).toBe("Gone");
    expect(slot("waking", "Waking", "neutral", true)).toBe("Waking");
  });

  it("one rule says whether a word can stand in the slot at all, and the row's room and its word both read it", () => {
    const slot = (view: Partial<WorkspaceView>) => ({ ...project({}, view), indicator: { label: "Paused", tone: "paused" as const, pulse: false }, state: "paused" as const });
    const cloud = slot({ kind: "cloud" });
    const local = slot({ kind: "local" });
    const absent = { word: "No daemon", said: "this Mac's daemon is not running" } as Parameters<typeof stateSlotWord>[1];
    // A machine wsp drives holds a word; the folder worked in place holds none, and the room the row keeps for one
    // follows the same reading, so a row cannot keep width for a word that never comes.
    expect(holdsStateWord(cloud)).toBe(true);
    expect(stateSlotWord(cloud)).toBe("Paused");
    expect(holdsStateWord(local)).toBe(false);
    expect(stateSlotWord(local)).toBe("");
    // Whatever its kind, a row whose computer is not answering holds that computer's own word.
    expect(holdsStateWord(local, absent)).toBe(true);
    expect(stateSlotWord(local, absent)).toBe("No daemon");
  });

  it("a row says its daemon is gone on the meta line, whatever kind of machine it is", () => {
    const local = (reach: ReachState) => project({ reach: { state: reach } }, { kind: "local" });
    const line = (reach: ReachState) => workspaceMetaLine({ project: local(reach), outOfMemory: undefined });
    // The two are different facts: nothing answering on the port, and no daemon road at all.
    expect(line("no-daemon")).toBe("no daemon answering");
    // A machine with no daemon road at all says nothing here: the bare fact had no verb in it and named a thing
    // the person never installed, and where the machine said what it lacks that is the line instead.
    expect(line("unsupported")).toBe("");
    expect(line("reachable")).toBe("");
    // Its state word is still empty by design, which is why the line is where this goes.
    expect(stateSlotWord({ ...local("no-daemon"), indicator: { label: "Unreachable", tone: "neutral", pulse: false } })).toBe("");
    // What the runtime is doing to the daemon still leads: a note means an attempt is in flight.
    expect(workspaceMetaLine({ project: project({ reach: { state: "no-daemon" }, daemonNote: "updating the helper" }, { kind: "local" }), outOfMemory: undefined })).toBe("updating the helper");
    expect(daemonGoneLine("slow", kindWords("local"))).toBeUndefined();
    expect(daemonGoneLine(null, kindWords("local"))).toBeUndefined();
  });

  it("this computer's own daemon is read off its workspace's reach, and says so in every slot the row has", () => {
    const here = { id: "ws_m", name: "mac", machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "", createdAt: "2026-09-08T09:00:00Z", kind: "local" } as const;
    const silent = { ...status({ reach: { state: "unreachable" } }), kind: "local" as const };
    // The places list holds no link for the computer the host runs on, so the reading comes off the workspace.
    const reading = absenceOf([], here, silent, null)!;
    expect(reading.said).toBe("this Mac's daemon is not running");
    expect(reading.word).toBe("No daemon");
    // A probe that found the port dead rather than silence is the same daemon, not running.
    expect(absenceOf([], here, { ...silent, reach: { state: "no-daemon" } }, null)!.said).toBe(reading.said);
    expect(absenceOf([], here, { ...silent, reach: { state: "reachable" } }, null)).toBeNull();
    expect(absenceOf([], here, null, null)).toBeNull();
    // The row's slot and its third line then read that one reading, where they read nothing and free before.
    const row = project({ reach: { state: "unreachable" } }, { kind: "local" });
    expect(stateSlotWord({ ...row, indicator: { label: "Unreachable", tone: "neutral", pulse: false } }, reading)).toBe("No daemon");
    expect(workspaceMetaLine({ project: row, absent: reading, outOfMemory: undefined })).toBe("daemon not running, start it");
  });

  it("a fork whose daemon died says so too: Unreachable alone reads as a lost machine, and this one is fine", () => {
    const driven = (reach: ReachState) => project({ reach: { state: reach } });
    const line = (reach: ReachState) => workspaceMetaLine({ project: driven(reach), outOfMemory: undefined });
    expect(line("no-daemon")).toBe("no daemon answering");
    // Nothing else changed: a reach that says nothing about the daemon leaves the spend and the countdown alone.
    expect(line("reachable")).toBe("");
    expect(line("slow")).toBe("");
    // While the runtime is putting the daemon back, that is what the row says instead.
    expect(workspaceMetaLine({ project: project({ reach: { state: "no-daemon" }, daemonNote: "restarting the helper" }), outOfMemory: undefined })).toBe("restarting the helper");
    // Only the daemon that died crosses to a driven kind. A machine wsp forks is built with the road to a daemon,
    // so a fork's row saying there is none would be saying something that cannot be true of it.
    expect(line("unsupported")).toBe("");

    expect(daemonGoneLine("unsupported", kindWords("cloud"))).toBeUndefined();
    expect(daemonGoneLine("unsupported", kindWords("local"))).toBeUndefined();
    expect(daemonGoneLine("unsupported", kindWords("ssh"))).toBeUndefined();
    // The phrase a backend developer read as a status with no verb is on no row of any kind.
    for (const kind of ["cloud", "local", "ssh"] as const) {
      expect(daemonGoneLine("unsupported", kindWords(kind), NO_LINGER_LINE)).not.toBe("no daemon on it");
    }
  });

  it("a machine over ssh carries no figure on its row, and what the runtime is doing to its daemon still leads", () => {
    const over = (reach: ReachState) => project({ reach: { state: reach } }, { kind: "ssh" });
    const line = (reach: ReachState) => workspaceMetaLine({ project: over(reach), outOfMemory: undefined });
    // No figure of any kind reaches a row: a machine's shape and its cost are its computer's row in Settings.
    expect(line("reachable")).toBe("");
    // What the runtime is doing about its daemon still leads on both surfaces.
    expect(line("unsupported")).toBe("");
    expect(workspaceMetaLine({ project: project({ reach: { state: "unsupported" }, daemonNote: "updating the helper" }, { kind: "ssh" }), outOfMemory: undefined })).toBe("updating the helper");
    // This computer reads the same rule: what the machine said it lacks is the line, and nothing where it said nothing.
    expect(workspaceMetaLine({ project: project({ reach: { state: "unsupported" } }, { kind: "local" }), outOfMemory: undefined })).toBe("");
  });

  it("a machine that told the host what it lacks says that on its row, in the first clause of what it said", () => {
    const said = (why: string) =>
      workspaceMetaLine({ project: project({ reach: { state: "unsupported" }, daemonRefusedAt: { machineId: "ssh://dev@box:22", at: "2026-09-11T14:04:50.380Z", why } }, { kind: "ssh" }), outOfMemory: undefined });
    // Why, rather than the bare fact that none is there: the row cuts from the right, so it takes the head of the
    // sentence, which is what the machine has not got. Both refusals are written to fit it.
    expect(said(NO_NODE_LINE)).toBe("this machine has no Node 22");
    expect(said(NO_LINGER_LINE)).toBe("this login does not linger");
    // The whole sentence carries the command to type, which is at the end of it and no row would show; the
    // Machine tab is where it goes, and that is proved where that surface is rendered.
    expect(NO_LINGER_LINE).toContain("loginctl enable-linger");
    expect(machineLacksShort(NO_LINGER_LINE)).not.toContain("loginctl");
    // Nothing said, nothing on the line: the row has no fact to spend it on.
    expect(daemonGoneLine("unsupported", kindWords("ssh"))).toBeUndefined();
  });

  it("a workspace whose computer is not answering reads one state on the row: the word in the slot, the silence on line three, the whole sentence on its title", () => {
    const absent = absentComputer("old-laptop", awayMsOf({ lastSeenAt: new Date(now - 38 * 60_000).toISOString() }, now));
    const on = project({ reach: { state: "unreachable" } }, { kind: "cloud", machineId: "ctr_9f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, place: "p_oldlaptop" });
    // The computer's own silence outranks the row's word: the slot reads what the person can act on, which is the
    // computer, and a blank slot there was the row that said nothing beside readings of unreachable.
    expect(stateSlotWord({ ...on, indicator: { label: "Unreachable", tone: "neutral", pulse: false } }, absent)).toBe(absent!.word);
    expect(stateSlotWord({ ...on, indicator: { label: "Unreachable", tone: "neutral", pulse: false } }, null)).toBe("Unreachable");
    // Line three is the silence and what to do about it, and it takes the line ahead of everything else on the
    // row: nothing else there is known while that computer is not connected.
    const line = workspaceMetaLine({ project: on, absent, outOfMemory: undefined });
    expect(line).toBe("no answer 38 min, is it on?");
    expect(metaSentences({ project: on, absent, outOfMemory: undefined })[0]).toBe(line);
    // The whole sentence is one string every surface reads, and it never names the machine's id.
    expect(absent.sentence).toBe("old-laptop is not answering; it connects on its own when it is on");
    expect(absent.sentence).not.toContain("place:");
    expect(absent.sentence).not.toContain("daemon");
  });

  it("relative time: t3code's label, compacted for the row", () => {
    const threeMinutesAgo = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(formatRelativeTimeLabel(threeMinutesAgo)).toBe("3m ago");
    expect(compactTimeLabel(threeMinutesAgo)).toBe("3m");
    expect(compactTimeLabel(new Date().toISOString())).toBe("now");
    expect(compactTimeLabel(null)).toBe("");
  });
});

describe("new workspace helpers", () => {
  it("a concurrency refusal keeps the runtime's words, which name the machines holding the slots, under the cap title", () => {
    const line = "both machine slots are in use: first, t-cap. Pause one or wait for a nap.";
    const explained = explainCreateRefusal(new RequestError(line, "concurrency"));
    expect(explained.title).toMatch(/no more tasks/i);
    expect(explained.detail).toBe(line);
  });

  it("other failures keep their message under a plain title", () => {
    expect(explainCreateRefusal(new Error("no golden image yet"))).toEqual({
      title: "Could not create the task",
      detail: "no golden image yet",
    });
    expect(explainCreateRefusal("boom").detail).toBe("boom");
  });
});

describe("what a space walks", () => {
  const row = (id: string, status: "running" | "completed", startedAt: string) => ({ id, title: id, status, startedAt, endedAt: startedAt });

  it("orders a workspace's threads the way the sidebar draws them: the working rows, then the idle shelf", () => {
    const threads = [
      row("idle-old", "completed", "2026-09-01T00:01:00Z"),
      row("working-old", "running", "2026-09-01T00:02:00Z"),
      row("idle-new", "completed", "2026-09-01T00:09:00Z"),
      row("working-new", "running", "2026-09-01T00:08:00Z"),
    ];
    expect(sidebarThreadOrder(threads).map(t => t.id)).toEqual(["working-new", "working-old", "idle-new", "idle-old"]);
    expect(topSidebarThread(threads)?.id).toBe("working-new");
    expect(sidebarThreadOrder([])).toEqual([]);
    expect(topSidebarThread([])).toBeNull();
  });

  it("draws a thread an agent spawned under the thread that spawned it, in the order it holds otherwise", () => {
    const spawned = (id: string, startedAt: string, parentThreadId?: string) => ({ ...row(id, "running", startedAt), ...(parentThreadId !== undefined ? { parentThreadId } : {}) });
    const threads = [
      spawned("lead", "2026-09-01T00:01:00Z"),
      spawned("other", "2026-09-01T00:09:00Z"),
      spawned("builder-b", "2026-09-01T00:03:00Z", "lead"),
      spawned("builder-a", "2026-09-01T00:04:00Z", "lead"),
      spawned("deeper", "2026-09-01T00:05:00Z", "builder-a"),
    ];
    // The sort puts the newest first; the tree then pulls each thread's own under it, keeping that order inside.
    expect(sidebarThreadOrder(threads).map(t => t.id)).toEqual(["other", "lead", "builder-a", "deeper", "builder-b"]);
    // A parent that is not in this list leaves the row where the sort put it rather than dropping it.
    expect(nestSpawnedThreads([spawned("orphan", "2026-09-01T00:01:00Z", "gone")]).map(t => t.id)).toEqual(["orphan"]);
    // A row naming itself as its own parent is drawn once, not forever, and two rows naming each other are both
    // drawn: a thread the sidebar leaves out is a thread nobody can reach.
    expect(nestSpawnedThreads([spawned("loop", "2026-09-01T00:01:00Z", "loop")]).map(t => t.id)).toEqual(["loop"]);
    const pair = [spawned("a", "2026-09-01T00:01:00Z", "b"), spawned("b", "2026-09-01T00:02:00Z", "a")];
    expect(nestSpawnedThreads(pair).map(t => t.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps the tree itself beside that order: each thread with the ones its agent opened under it, as deep as it went", () => {
    const spawned = (id: string, startedAt: string, parentThreadId?: string) => ({ ...row(id, "running", startedAt), ...(parentThreadId !== undefined ? { parentThreadId } : {}) });
    const threads = [spawned("lead", "2026-09-01T00:01:00Z"), spawned("builder", "2026-09-01T00:03:00Z", "lead"), spawned("reviewer", "2026-09-01T00:05:00Z", "builder"), spawned("orphan", "2026-09-01T00:02:00Z", "gone")];
    const shape = (nodes: ReadonlyArray<{ thread: { id: string }; children: ReadonlyArray<unknown> }>): unknown => nodes.map(node => [node.thread.id, shape(node.children as ReadonlyArray<{ thread: { id: string }; children: ReadonlyArray<unknown> }>)]);
    expect(shape(threadForest(threads))).toEqual([
      ["lead", [["builder", [["reviewer", []]]]]],
      ["orphan", []],
    ]);
    // The flat order is the same tree read top to bottom, so the two can never disagree.
    expect(nestSpawnedThreads(threads).map(t => t.id)).toEqual(["lead", "builder", "reviewer", "orphan"]);
  });

  it("shows the selected workspace, and the first in the sidebar's order while what is selected is not one", () => {
    const ids = ["ws_a", "ws_b"];
    expect(currentWorkspaceId(ids, "ws_b")).toBe("ws_b");
    expect(currentWorkspaceId(ids, null)).toBe("ws_a");
    expect(currentWorkspaceId(ids, "creating:1")).toBe("ws_a");
    expect(currentWorkspaceId([], "ws_a")).toBeNull();
  });
});

describe("the tree a thread's own threads make", () => {
  const thread = (id: string, workspaceId: string, parentThreadId: string | null): SidebarThreadSnapshot => ({
    id,
    threadId: id,
    sessionId: `s_${id}`,
    workspaceId,
    title: id,
    status: "running",
    ran: true,
    startedAt: "2026-09-01T00:00:00Z",
    endedAt: null,
    indicator: { label: "Working", tone: "neutral", pulse: true },
    harness: "claude",
    startedBy: parentThreadId === null ? "person" : "agent",
    project: null,
    parentThreadId,
    asking: null,
    costUsd: null,
  });
  /** A workspace row as the tree reads it: its own threads, and the record, which says whether an agent forked it. */
  const project = (id: string, threads: SidebarThreadSnapshot[], parentThreadId?: string): SidebarProjectSnapshot =>
    ({ id, displayName: id, threads, workspace: { id, ...(parentThreadId === undefined ? {} : { parentThreadId }) } }) as unknown as SidebarProjectSnapshot;
  const drawn = (projects: SidebarProjectSnapshot[]) => threadTree(projects).map(group => [group.project.id, group.threads.map(t => t.id)]);

  it("puts a thread an agent opened on another workspace among its opener's rows, and takes it off the workspace it runs on", () => {
    const mac = project("mac", [thread("lead", "mac", null)]);
    const bench = project("bench", [thread("builder", "bench", "lead")]);
    expect(drawn([mac, bench])).toEqual([
      ["mac", ["lead", "builder"]],
      ["bench", []],
    ]);
  });

  it("follows the chain to the thread a person opened, however many workspaces it crosses", () => {
    const mac = project("mac", [thread("lead", "mac", null)]);
    const bench = project("bench", [thread("builder", "bench", "lead")]);
    const web = project("web", [thread("helper", "web", "builder")]);
    expect(drawn([mac, bench, web])).toEqual([
      ["mac", ["lead", "builder", "helper"]],
      ["bench", []],
      ["web", []],
    ]);
  });

  it("leaves a thread whose opener this window does not hold where it runs, and never loses one to a circle", () => {
    const mac = project("mac", [thread("orphan", "mac", "gone")]);
    const bench = project("bench", [thread("a", "bench", "b"), thread("b", "bench", "a")]);
    expect(drawn([mac, bench])).toEqual([
      ["mac", ["orphan"]],
      ["bench", ["a", "b"]],
    ]);
  });

  it("answers the threads one thread opened with the workspace each runs on, whichever workspace that is", () => {
    const mac = project("mac", [thread("lead", "mac", null), thread("near", "mac", "lead")]);
    const bench = project("bench", [thread("far", "bench", "lead"), thread("other", "bench", null)]);
    expect(threadsOpenedBy([mac, bench], "lead").map(({ thread: t, runs }) => [t.id, runs.id])).toEqual([
      ["near", "mac"],
      ["far", "bench"],
    ]);
    expect(threadsOpenedBy([mac, bench], "other")).toEqual([]);
    expect(workspaceOf([mac, bench], { workspaceId: "bench" })?.id).toBe("bench");
    expect(workspaceOf([mac, bench], { workspaceId: "nowhere" })).toBeUndefined();
  });

  it("answers the thread that opened one, with the workspace that one runs on, and nothing where there is none to reach", () => {
    const mac = project("mac", [thread("lead", "mac", null)]);
    const bench = project("bench", [thread("far", "bench", "lead")]);
    const opener = openedBy([mac, bench], { parentThreadId: "lead" });
    expect([opener?.thread.id, opener?.runs.id]).toEqual(["lead", "mac"]);
    expect(openedBy([mac, bench], { parentThreadId: null })).toBeUndefined();
    // An opener on a workspace this window was never given is one no click could reach, so it is not named either.
    expect(openedBy([bench], { parentThreadId: "lead" })).toBeUndefined();
  });
});

describe("a thread row's words", () => {
  const spawned = { parentThreadId: "th_lead", project: "spoo", startedBy: "agent" as const };
  const own = { parentThreadId: null, project: "spoo", startedBy: "person" as const };
  const runs = (over: Partial<WorkspaceStatus>, view: Partial<WorkspaceView> = {}) => ({ status: status(over), workspace: { ...status(over), ...view } });

  it("a spawned row holds its workspace where a top row holds the project, and drops it when it is the row it is drawn under", () => {
    expect(threadMetaWords(spawned, { workspace: "spoo-bench", where: "ascii" }, "spoo-fix")).toEqual(["spoo-bench", "ascii"]);
    expect(threadMetaWords(spawned, { workspace: "spoo-fix", where: "hetzner" }, "spoo-fix")).toEqual(["hetzner"]);
  });

  it("a row a person or the command line opened keeps the project and who opened it, and never names a workspace", () => {
    expect(threadMetaWords(own, { workspace: "spoo-fix", where: "hetzner" }, "spoo-fix")).toEqual(["spoo", "you"]);
    expect(threadMetaWords({ ...own, startedBy: "cli" }, { workspace: "spoo-bench", where: "ascii" }, "spoo-fix")).toEqual(["spoo", "cli"]);
    expect(threadMetaWords({ ...own, project: null }, { workspace: "spoo-fix", where: "hetzner" }, "spoo-fix")).toEqual(["you"]);
  });

  it("where a workspace runs: the provider the record carries, the kind's own word where it has one, and the name wsp holds for the machine where it has neither", () => {
    expect(whereWord(runs({}, { kind: "local" }))).toBe(THIS_COMPUTER);
    // A fork runs at the provider its own record names, never the opaque id that provider minted for the machine,
    // and never a word read off the kind: this host is wired to one provider of several and only the record says which.
    expect(whereWord(runs({ machineId: "sb_9f2c1d8a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "solari" }))).toBe("solari");
    expect(whereWord(runs({ machineId: "bx_4c11e0", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "box" }))).toBe("box");
    expect(whereWord(runs({ machineId: "wsp-api", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "docker" }))).toBe("docker");
    // A record from before the provider rode the wire says what the machine is; the id the provider minted for it
    // names nothing to the person reading the row, and no row anywhere shows one.
    expect(whereWord(runs({ machineId: "sb_9f2c1d8a" }))).toBe("a provider");
    expect(whereWord(runs({ machineId: "dev@box" }, { kind: "ssh" }))).toBe("dev@box");
    expect(whereWord({ status: null, workspace: { ...status({}), kind: "ssh", machineId: "m_recorded" } })).toBe("m_recorded");
  });
});

