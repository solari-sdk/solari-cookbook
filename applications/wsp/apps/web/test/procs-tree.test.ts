// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { ProcEntry } from "@wsp/protocol";
import { compactBytes } from "@wsp/protocol";
import { procLabel, procTable, type ProcThread } from "../src/components/procs/tree.js";

const proc = (pid: number, ppid: number, comm: string, extra: Partial<ProcEntry> = {}): ProcEntry => ({
  pid,
  ppid,
  user: "root",
  state: "S",
  comm,
  cmdline: comm,
  cpu: 0,
  rss: 0,
  startedAt: 0,
  ...extra,
});

const procs: ProcEntry[] = [
  proc(1, 0, "init"),
  proc(40, 1, "node", { cpu: 3, rss: 300, cmdline: "node daemon.js" }),
  proc(41, 40, "bash", { cpu: 1, rss: 50, pty: "pty_1" }),
  proc(42, 40, "claude", { cpu: 30, rss: 900 }),
  proc(50, 1, "nginx", { cpu: 2, rss: 400 }),
  // An orphan whose parent was cut by the daemon's cap roots itself.
  proc(77, 9999, "cron", { cpu: 0, rss: 10 }),
];

const flat = (table: ReturnType<typeof procTable>) => table.rest.map(r => [r.proc.pid, r.depth]);

describe("procTable", () => {
  it("nests by ppid with siblings sorted by cpu, ties by pid, orphans at the root", () => {
    expect(flat(procTable(procs, "cpu", ""))).toEqual([
      [1, 0],
      [40, 1],
      [42, 2],
      [41, 2],
      [50, 1],
      [77, 0],
    ]);
  });

  it("sorting by mem reorders siblings, not the tree", () => {
    expect(procTable(procs, "mem", "").rest.map(r => r.proc.pid)).toEqual([77, 1, 50, 40, 42, 41]);
  });

  it("a filter keeps every match under its own parents, matching pid, comm, cmdline and user", () => {
    // nginx matches; init is its parent and stays above it, at the depth it always had.
    expect(flat(procTable(procs, "cpu", "ngin"))).toEqual([
      [1, 0],
      [50, 1],
    ]);
    expect(flat(procTable(procs, "cpu", "42"))).toEqual([
      [1, 0],
      [40, 1],
      [42, 2],
    ]);
    expect(procTable(procs, "mem", "DAEMON.JS").rest.map(r => r.proc.pid)).toEqual([1, 40]);
    expect(procTable(procs, "cpu", "root").rest.map(r => r.proc.pid)).toEqual([1, 40, 42, 41, 50, 77]);
    expect(procTable(procs, "cpu", "nothing here").rest).toEqual([]);
  });
});

describe("procTable with this workspace's threads", () => {
  // Two threads of this workspace, each the shell the host started for a turn, with the agent and its tools under it.
  const own: ProcEntry[] = [
    ...procs,
    proc(100, 40, "bash", { cpu: 1, rss: 20, cmdline: "bash -c claude -p docs" }),
    proc(101, 100, "claude", { cpu: 40, rss: 800, cmdline: "claude --settings {} -p docs" }),
    proc(102, 101, "rg", { cpu: 5, rss: 30, cmdline: "rg needle" }),
    proc(200, 40, "bash", { cpu: 1, rss: 20, cmdline: "bash -c claude -p tests" }),
    proc(201, 200, "claude", { cpu: 10, rss: 700, cmdline: "claude --settings {} -p tests" }),
  ];
  const threads: ProcThread[] = [
    { threadId: "th_docs", title: "the docs agent", pid: 100 },
    { threadId: "th_tests", title: "the tests agent", pid: 200 },
  ];

  it("gives each thread its own tree, nested, and leaves those processes out of the rest", () => {
    const table = procTable(own, "cpu", "", threads);
    expect(table.threads.map(t => t.thread.title)).toEqual(["the docs agent", "the tests agent"]);
    expect(table.threads[0]!.rows.map(r => [r.proc.pid, r.depth])).toEqual([
      [100, 0],
      [101, 1],
      [102, 2],
    ]);
    expect(table.threads[1]!.rows.map(r => [r.proc.pid, r.depth])).toEqual([
      [200, 0],
      [201, 1],
    ]);
    // The rest is the computer without those two trees; nothing is counted twice.
    expect(table.rest.map(r => r.proc.pid)).toEqual([1, 40, 42, 41, 50, 77]);
  });

  it("a thread whose process is not in the snapshot has no tree", () => {
    const table = procTable(own.filter(p => p.pid !== 200 && p.pid !== 201), "cpu", "", threads);
    expect(table.threads.map(t => t.thread.threadId)).toEqual(["th_docs"]);
  });

  it("the filter reads the threads' trees too, keeping matches under their parents and dropping a thread with none", () => {
    const table = procTable(own, "cpu", "docs", threads);
    expect(table.threads.map(t => t.thread.threadId)).toEqual(["th_docs"]);
    expect(table.threads[0]!.rows.map(r => r.proc.pid)).toEqual([100, 101]);
    expect(table.rest).toEqual([]);
  });
});

describe("procLabel", () => {
  const titles = new Map([["pty_1", "zsh"]]);
  it("names the daemon, a pty shell by its tab and the harness by its comm", () => {
    expect(procLabel(procs[1]!, 40, titles)).toBe("daemon");
    expect(procLabel(procs[2]!, 40, titles)).toBe("terminal zsh");
    expect(procLabel(procs[2]!, 40, new Map())).toBe("terminal");
    expect(procLabel(procs[3]!, 40, titles)).toBe("agent");
    expect(procLabel(procs[4]!, 40, titles)).toBeNull();
    // Any catalog agent is named by the command its entry puts on PATH.
    expect(procLabel(proc(43, 40, "codex"), 40, titles)).toBe("agent");
  });
});

describe("compactBytes", () => {
  it("one unit, no more than three significant digits", () => {
    expect(compactBytes(0)).toBe("0");
    expect(compactBytes(900)).toBe("900");
    expect(compactBytes(12 * 1024)).toBe("12K");
    expect(compactBytes(1.5 * 1024 ** 2)).toBe("1.5M");
    expect(compactBytes(123.4 * 1024 ** 2)).toBe("123M");
    expect(compactBytes(2.25 * 1024 ** 3)).toBe("2.3G");
  });
});
