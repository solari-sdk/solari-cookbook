// SPDX-License-Identifier: AGPL-3.0-only
// The per-workspace terminal model against the real daemon: the binary on
// loopback, the reach client as the wire. No component renders here; the
// surfaces over this model have their own suites.
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";
import { boot, teardown, WS_ID } from "./terminal-harness.js";

afterEach(async () => {
  await teardown();
});

/** A pty.list entry as the daemon reports it. */
const pty = (id: string, exited = false) => ({ id, pid: 1, cols: 80, rows: 24, exited });

describe("WorkspaceTerminals", () => {
  it("replays scrollback into a sink bound after the output happened", async () => {
    const { wt } = await boot();
    const tab = await wt.open({ shell: "/bin/sh" });
    wt.write(tab.ptyId, "echo replay-mark-$((40 + 2))\r");

    const live: string[] = [];
    const un1 = wt.bind(tab.ptyId, { data: d => live.push(d), reset: () => {} });
    await waitFor(() => expect(live.join("")).toContain("replay-mark-42"), { timeout: 10_000 });
    un1();

    // A sink bound later gets the same bytes back from the mirror, synchronously.
    const replayed: string[] = [];
    const un2 = wt.bind(tab.ptyId, { data: d => replayed.push(d), reset: () => {} });
    expect(replayed.join("")).toContain("replay-mark-42");
    un2();
  }, 15_000);

  it("resize propagates to the daemon pty", async () => {
    const { wt, ptys } = await boot();
    const tab = await wt.open({ shell: "/bin/sh" });
    wt.resize(tab.ptyId, 100, 40);
    await waitFor(async () => {
      const p = (await ptys()).find(x => x.id === tab.ptyId);
      expect(p).toMatchObject({ cols: 100, rows: 40 });
    });
  }, 15_000);

  it("unbinding keeps the pty alive; close kills it", async () => {
    const { wt, ptys } = await boot();
    const tab = await wt.open({ shell: "/bin/sh" });
    const un = wt.bind(tab.ptyId, { data: () => {}, reset: () => {} });
    un();
    expect(await ptys()).toHaveLength(1);
    expect((await ptys())[0]!.exited).toBe(false);

    await wt.close(tab.ptyId);
    expect(await ptys()).toHaveLength(0);
    expect(wt.tabs()).toHaveLength(0);
  }, 15_000);

  it("marks the tab exited when the pty's process ends", async () => {
    const { wt } = await boot();
    const tab = await wt.open({ shell: "/bin/sh" });
    const seen: string[] = [];
    const un = wt.bind(tab.ptyId, { data: d => seen.push(d), reset: () => {} });
    wt.write(tab.ptyId, "exit\r");
    await waitFor(() => expect(wt.tabs()[0]).toMatchObject({ exited: true }), { timeout: 10_000 });
    expect(seen.join("")).toContain("[process exited]");
    un();
  }, 15_000);

  it("a pty that cannot re-attach is marked lost while the rest still re-attach", async () => {
    const attaches: string[] = [];
    let nextPty = 1;
    let reattaching = false;
    const wire: TerminalWire = {
      request: async (op, params = {}) => {
        if (op === "pty.create") return { ok: true, ptyId: `p${nextPty++}` };
        if (op === "pty.attach") {
          if (reattaching && params["ptyId"] === "p1") throw new Error("no such pty: p1");
          attaches.push(String(params["ptyId"]));
        }
        return { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await wt.open();
    await wt.open();
    attaches.length = 0;
    reattaching = true;

    wt.feedStatus("connecting");
    wt.feedStatus("live");
    await waitFor(() => expect(attaches).toEqual(["p2"])); // p1 failed, p2 still re-attached
    expect(wt.tabs().find(t => t.ptyId === "p1")).toMatchObject({ exited: true, lost: true });
    expect(wt.tabs().find(t => t.ptyId === "p2")).toMatchObject({ exited: false, lost: false });
    const seen: string[] = [];
    wt.bind("p1", { data: d => seen.push(d), reset: () => {} })();
    expect(seen.join("")).toContain("[This shell ended when the daemon holding it stopped]");
  });

  it("a connection dying mid-reattach does not mark ptys lost", async () => {
    let nextPty = 1;
    const attaches: string[] = [];
    let pendingReject: ((e: Error) => void) | null = null;
    let deferNext = false;
    const wire: TerminalWire = {
      request: (op, params = {}) => {
        if (op === "pty.create") return Promise.resolve({ ok: true, ptyId: `p${nextPty++}` });
        if (op === "pty.attach") {
          attaches.push(String(params["ptyId"]));
          if (deferNext) {
            deferNext = false;
            return new Promise((_, reject) => {
              pendingReject = reject;
            });
          }
        }
        return Promise.resolve({ ok: true });
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await wt.open();
    await wt.open();
    attaches.length = 0;

    deferNext = true; // p1's re-attach hangs until the socket death rejects it
    wt.feedStatus("connecting");
    wt.feedStatus("live");
    await waitFor(() => expect(pendingReject).not.toBeNull());
    wt.feedStatus("connecting"); // the connection died again mid-ritual
    pendingReject!(new Error("connection lost"));
    await new Promise(r => setTimeout(r, 25));
    expect(attaches).toEqual(["p1"]); // the ritual stopped, p2 was not attempted
    expect(wt.tabs().every(t => !t.exited)).toBe(true); // nobody wrongly marked lost

    wt.feedStatus("live"); // recovery: the next live transition re-runs the full ritual
    await waitFor(() => expect(attaches).toEqual(["p1", "p1", "p2"]));
  });

  it("live is reported only after the daemon's ptys are listed and attached; adopted ptys are tabs with their replay, none is created", async () => {
    const ops: { op: string; params: Record<string, unknown> }[] = [];
    const wire: TerminalWire = {
      request: async (op, params = {}) => {
        ops.push({ op, params });
        if (op === "pty.list") return { ok: true, ptys: [pty("p1"), pty("p2", true)] };
        // The daemon pushes the scrollback replay, then pty.exit for a dead pty, before it answers the attach.
        if (op === "pty.attach") {
          const ptyId = String(params["ptyId"]);
          wt.feedEvent({ type: "pty.data", ptyId, data: `replay:${ptyId}` });
          if (ptyId === "p2") wt.feedEvent({ type: "pty.exit", ptyId, exitCode: 0 });
        }
        return { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    let statusChanges = 0;
    wt.onStatus(() => statusChanges++);
    wt.feedStatus("live");
    expect(wt.status()).toBe("opening");
    expect(wt.everOpened()).toBe(false);
    await waitFor(() => expect(wt.status()).toBe("live"));
    expect(statusChanges).toBe(1);
    expect(ops.map(o => o.op)).toEqual(["pty.list", "pty.attach", "pty.attach"]);
    expect(wt.tabs()).toEqual([
      { ptyId: "p1", title: "shell", exited: false, lost: false },
      { ptyId: "p2", title: "shell", exited: true, lost: false },
    ]);
    expect(wt.activeId()).toBe("p1");
    const replayed: string[] = [];
    wt.bind("p1", { data: d => replayed.push(d), reset: () => {} })();
    expect(replayed).toEqual(["replay:p1"]);
    // The dead pty shows its replay and exactly one exit line.
    const dead: string[] = [];
    wt.bind("p2", { data: d => dead.push(d), reset: () => {} })();
    expect(dead.join("")).toBe("replay:p2\r\n[process exited]\r\n");
    // The first tab is what ensureOpen hands out, so a first-open consumer creates nothing; and adoption counts as
    // having opened, so the center tab never auto-opens after the last adopted pty is closed.
    await expect(wt.ensureOpen()).resolves.toMatchObject({ ptyId: "p1" });
    expect(ops.some(o => o.op === "pty.create")).toBe(false);
    expect(wt.everOpened()).toBe(true);
  });

  it("an adopted pty the list says has exited gets the exit line even when no pty.exit arrives during attach", async () => {
    const wire: TerminalWire = {
      request: async op => (op === "pty.list" ? { ok: true, ptys: [pty("p1", true)] } : { ok: true }),
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await waitFor(() => expect(wt.status()).toBe("live"));
    expect(wt.tabs()).toEqual([{ ptyId: "p1", title: "shell", exited: true, lost: false }]);
    const seen: string[] = [];
    wt.bind("p1", { data: d => seen.push(d), reset: () => {} })();
    expect(seen.join("")).toBe("\r\n[process exited]\r\n");
    // A late pty.exit for it is not a second line.
    wt.feedEvent({ type: "pty.exit", ptyId: "p1", exitCode: 0 });
    wt.bind("p1", { data: d => seen.push(d), reset: () => {} })();
    expect(seen.join("")).toBe("\r\n[process exited]\r\n\r\n[process exited]\r\n");
  });

  it("a pty.list reply this build does not understand adopts nothing and still reports live", async () => {
    const wire: TerminalWire = {
      request: async op => (op === "pty.list" ? { ok: true, ptys: [{ id: "p1", exited: false }] } : { ok: true }),
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await waitFor(() => expect(wt.status()).toBe("live"));
    expect(wt.tabs()).toEqual([]);
  });

  it("a status change mid-adoption still lists the ptys adopted so far as tabs, and the next live keeps them", async () => {
    let releaseAttach: ((v: Record<string, unknown>) => void) | null = null;
    let listed = [pty("p1"), pty("p2")];
    const attaches: string[] = [];
    const wire: TerminalWire = {
      request: (op, params = {}) => {
        if (op === "pty.list") return Promise.resolve({ ok: true, ptys: listed });
        if (op === "pty.attach") {
          attaches.push(String(params["ptyId"]));
          if (params["ptyId"] === "p2" && releaseAttach === null) return new Promise(resolve => { releaseAttach = resolve; });
        }
        return Promise.resolve({ ok: true });
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await waitFor(() => expect(releaseAttach).not.toBeNull());
    wt.feedStatus("connecting");
    releaseAttach!({ ok: true });
    await new Promise(r => setTimeout(r, 25));
    expect(wt.status()).toBe("connecting");
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]);

    // p2 was killed meanwhile: the relive re-attaches p1 and adopts nothing new, and p1 is still a tab.
    listed = [pty("p1")];
    attaches.length = 0;
    wt.feedStatus("live");
    await waitFor(() => expect(wt.status()).toBe("live"));
    expect(attaches).toEqual(["p1"]);
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]);
    await expect(wt.ensureOpen()).resolves.toMatchObject({ ptyId: "p1" });
  });

  it("a refused pty.list still reports live; a pty gone between list and attach is not adopted", async () => {
    let refuseList = true;
    const wire: TerminalWire = {
      request: async (op, params = {}) => {
        if (op === "pty.list") {
          if (refuseList) throw new Error("connection lost");
          return { ok: true, ptys: [pty("p1"), pty("p_gone")] };
        }
        if (op === "pty.attach" && params["ptyId"] === "p_gone") throw new Error("no such pty: p_gone");
        return { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await waitFor(() => expect(wt.status()).toBe("live"));
    expect(wt.tabs()).toEqual([]);

    refuseList = false;
    wt.feedStatus("connecting");
    wt.feedStatus("live");
    await waitFor(() => expect(wt.status()).toBe("live"));
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]);
  });

  it("a status change during adoption cancels it: the stale transition never reports live", async () => {
    let releaseList: ((v: Record<string, unknown>) => void) | null = null;
    const wire: TerminalWire = {
      request: (op) => {
        if (op === "pty.list") return new Promise(resolve => { releaseList = resolve; });
        return Promise.resolve({ ok: true });
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await waitFor(() => expect(releaseList).not.toBeNull());
    wt.feedStatus("reauth-needed");
    releaseList!({ ok: true, ptys: [pty("p1")] });
    await new Promise(r => setTimeout(r, 25));
    expect(wt.status()).toBe("reauth-needed");
    expect(wt.tabs()).toEqual([]);
  });

  it("a status change while an adopted pty's attach is in flight drops it: no tab, no live", async () => {
    let releaseAttach: ((v: Record<string, unknown>) => void) | null = null;
    const wire: TerminalWire = {
      request: (op) => {
        if (op === "pty.list") return Promise.resolve({ ok: true, ptys: [pty("p1")] });
        if (op === "pty.attach") return new Promise(resolve => { releaseAttach = resolve; });
        return Promise.resolve({ ok: true });
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await waitFor(() => expect(releaseAttach).not.toBeNull());
    wt.feedStatus("reauth-needed");
    releaseAttach!({ ok: true });
    await new Promise(r => setTimeout(r, 25));
    expect(wt.tabs()).toEqual([]);
    expect(wt.status()).toBe("reauth-needed");
  });

  it("an exited pty whose attach is cut after its pty.exit arrived leaves no ghost tab, now or at the next live", async () => {
    let rejectAttach: ((e: Error) => void) | null = null;
    let listed = [pty("p2", true)];
    const wire: TerminalWire = {
      request: (op, params = {}) => {
        if (op === "pty.list") return Promise.resolve({ ok: true, ptys: listed });
        if (op === "pty.attach" && rejectAttach === null) {
          // The daemon's order for a dead pty: scrollback, then pty.exit, then the reply (here the socket dies first).
          const ptyId = String(params["ptyId"]);
          wt.feedEvent({ type: "pty.data", ptyId, data: "$ exit\r\n" });
          wt.feedEvent({ type: "pty.exit", ptyId, exitCode: 0 });
          return new Promise((_, reject) => { rejectAttach = reject; });
        }
        return Promise.resolve({ ok: true });
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await waitFor(() => expect(rejectAttach).not.toBeNull());
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p2"]); // published by the exit, mid-attach
    wt.feedStatus("connecting");
    rejectAttach!(new Error("connection lost"));
    await new Promise(r => setTimeout(r, 25));
    expect(wt.tabs()).toEqual([]);

    listed = []; // killed meanwhile
    wt.feedStatus("live");
    await waitFor(() => expect(wt.status()).toBe("live"));
    expect(wt.tabs()).toEqual([]);
    await wt.close("p2");
    expect(wt.tabs()).toEqual([]);
  });

  it("a reconnect re-attaches every pty and resets bound sinks", async () => {
    const ops: string[] = [];
    let nextPty = 1;
    const wire: TerminalWire = {
      request: async op => {
        ops.push(op);
        return op === "pty.create" ? { ok: true, ptyId: `p${nextPty++}` } : { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    const a = await wt.open();
    await wt.open();
    wt.feedEvent({ type: "pty.data", ptyId: a.ptyId, data: "pre-cut output" });

    let resets = 0;
    const un = wt.bind(a.ptyId, { data: () => {}, reset: () => resets++ });
    ops.length = 0;
    wt.feedStatus("connecting");
    wt.feedStatus("live");
    await waitFor(() => expect(ops.filter(o => o === "pty.attach")).toHaveLength(2));
    expect(resets).toBe(1);

    // The mirror was invalidated: replay now comes from the daemon, not from us.
    const late: string[] = [];
    wt.bind(a.ptyId, { data: d => late.push(d), reset: () => {} })();
    expect(late).toEqual([]);
    un();
  });
});
