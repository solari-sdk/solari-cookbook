import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROC_SAMPLER_STARTED, SYS_SAMPLER_STARTED, SYS_SAMPLER_STOPPED, type WorkspaceKind } from "@wsp/protocol";
import { BTIME, fakePasswd, fakeProcTree, setListeners, writeProc, writeSys } from "./fake-proc.js";
import { daemonUnderTest, type DaemonUnderTest, type DaemonUnderTestArgs } from "./harness.js";
import { rejectedEvents } from "./wire-events.js";

const TOKEN = "ops-token";
const tmp = mkdtempSync(join(tmpdir(), "wsp-ops-"));
const inboxDir = mkdtempSync(join(tmpdir(), "wsp-ops-inbox-"));
const procRoot = fakeProcTree([{ pid: 1, comm: "init" }, { pid: 50, ppid: 1, comm: "node", ticks: [0, 0], cwd: "/root/app" }, { pid: 51, ppid: 50, comm: "sh" }]);
// The load the fake machine reports: 8000 kB with 6000 kB available reads as 2000 kB used.
writeSys(procRoot, { load1: 1.25, memTotalKb: 8000, memAvailableKb: 6000 });

interface WireMsg {
  id?: string | number | null;
  ok?: boolean;
  type?: string;
  [k: string]: unknown;
}

/** Every event frame any client in this file received, checked against the protocol at the end. */
const wire: WireMsg[] = [];

async function connect(port: number): Promise<{
  request: (op: string, params?: Record<string, unknown>) => Promise<WireMsg>;
  events: WireMsg[];
  close: () => void;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ id: 0, op: "auth", token: TOKEN }));
  const events: WireMsg[] = [];
  const pending = new Map<number, (m: WireMsg) => void>();
  let nextId = 1;
  ws.on("message", raw => {
    const m = JSON.parse(String(raw)) as WireMsg;
    if (typeof m.id === "number" && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    } else if (m.type) {
      events.push(m);
      wire.push(m);
    }
  });
  return {
    events,
    request: (op, params = {}) => {
      const id = nextId++;
      return new Promise(resolve => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, op, ...params }));
      });
    },
    close: () => ws.close(),
  };
}

let daemon: DaemonUnderTest;

afterAll(async () => {
  await daemon?.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(inboxDir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

/** How many times the daemon logged one line. */
const logged = (d: DaemonUnderTest, line: string): number => d.log().filter(l => l === line).length;

describe("daemon ops: ports, manifest, inbox", () => {
  it("ports.watch replies with current ports and pushes open/close events", async () => {
    daemon = await daemonUnderTest({
      port: 0,
      token: TOKEN,
      procRoot,
      passwd: fakePasswd(),
      portsIntervalMs: 25,
      sysIntervalMs: 20,
      procIntervalMs: 20,
      inbox: inboxDir,
      inboxQuietMs: 150,
      inboxPollMs: 30,
      manifest: join(tmp, "manifest.json"),
      runDir: join(tmp, "run"),
      logDir: join(tmp, "logs"),
    });
    const c = await connect(daemon.port);
    const res = await c.request("ports.watch");
    expect(res.ok).toBe(true);
    expect(res["ports"]).toEqual([]);

    // The fake machine's node holds 8080 for a while: the daemon reads it off the tree's net/tcp and its fd table.
    setListeners(procRoot, [{ port: 8080, pid: 50 }]);
    await new Promise(r => setTimeout(r, 120));
    setListeners(procRoot, []);
    await new Promise(r => setTimeout(r, 120));

    expect(c.events).toContainEqual({ type: "port.open", port: 8080, pid: 50, process: "node", loopback: false });
    expect(c.events).toContainEqual(expect.objectContaining({ type: "port.close", port: 8080, pid: 50, process: "node", at: expect.any(String) }));
    c.close();
  });

  it("sys.watch streams one sampler's samples to every subscriber and stops it when the last socket closes", async () => {
    expect(logged(daemon, SYS_SAMPLER_STARTED)).toBe(0);
    const a = await connect(daemon.port);
    const b = await connect(daemon.port);
    expect((await a.request("sys.watch")).ok).toBe(true);
    expect((await b.request("sys.watch")).ok).toBe(true);
    const samples = (c: { events: WireMsg[] }) => c.events.filter(e => e.type === "sys.sample");
    // Both sockets saw the same stream, so the daemon ran one sampler, not one per socket. The second subscriber can
    // miss the sample the first was already sent, so the wait is for a sample both hold and not for a count each.
    const sample = await vi.waitFor(
      () => {
        const shared = samples(a).find(s => samples(b).some(t => t["at"] === s["at"]));
        expect(shared).toBeDefined();
        return shared!;
      },
      { timeout: 10_000, interval: 10 },
    );
    // The load and the memory are the fake tree's; the cpu is a delta between two reads of one stat file, and the
    // disk is the real volume under the daemon's root, so those two are numbers and not the tree's.
    expect(sample).toMatchObject({ type: "sys.sample", load1: 1.25, mem: { used: 2000 * 1024, total: 8000 * 1024 } });
    expect(sample["cpu"]).toBeTypeOf("number");
    expect((sample["disk"] as { total: number }).total).toBeGreaterThan(0);
    expect(typeof sample["at"]).toBe("number");
    expect(b.events).toContainEqual(sample);
    // Two watchers, one sampler: it started once and has not stopped.
    expect(logged(daemon, SYS_SAMPLER_STARTED)).toBe(1);
    expect(logged(daemon, SYS_SAMPLER_STOPPED)).toBe(0);

    a.close();
    // The close is a round trip the daemon has to read; the sampler the other socket holds keeps sampling for it.
    await new Promise(r => setTimeout(r, 60));
    const withOneLeft = samples(b).length;
    await vi.waitFor(() => expect(samples(b).length).toBeGreaterThan(withOneLeft), { timeout: 10_000, interval: 10 });
    expect(logged(daemon, SYS_SAMPLER_STOPPED)).toBe(0);

    b.close();
    // The last close stops the sampler, and a loaded box is slow to notice: the stop is the line the daemon logs,
    // and once it is there nothing starts it again.
    await vi.waitFor(() => expect(logged(daemon, SYS_SAMPLER_STOPPED)).toBe(1), { timeout: 10_000, interval: 10 });
    await new Promise(r => setTimeout(r, 80));
    expect(logged(daemon, SYS_SAMPLER_STARTED)).toBe(1);
  });

  it("proc.watch streams snapshots until proc.unwatch, proc.inspect reads one pid, proc.kill refuses the protected ones", async () => {
    const a = await connect(daemon.port);
    expect((await a.request("proc.watch")).ok).toBe(true);
    // A second watch on the same socket is not a second subscription.
    expect((await a.request("proc.watch")).ok).toBe(true);
    writeProc(procRoot, { pid: 50, ppid: 1, comm: "node", ticks: [4, 0], cwd: "/root/app" });
    const deadline = Date.now() + 2000;
    while (a.events.filter(e => e.type === "proc.snapshot").length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    const snaps = a.events.filter(e => e.type === "proc.snapshot") as { procs: { pid: number; ppid: number; cpu: number; cmdline: string }[]; daemon: number; total: number }[];
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(snaps[0]).toMatchObject({ daemon: daemon.pid, total: 3 });
    expect(snaps[0]!.procs.map(p => p.pid)).toEqual([1, 50, 51]);
    expect(snaps[0]!.procs[2]).toMatchObject({ ppid: 50, cmdline: "sh" });

    expect(await a.request("proc.inspect", { pid: 50 })).toMatchObject({ ok: true, pid: 50, cwd: "/root/app", ports: [], threads: 1, children: [51] });
    expect(await a.request("proc.inspect", { pid: "x" })).toMatchObject({ ok: false, code: "bad-request" });
    expect(await a.request("proc.inspect", { pid: 999_999 })).toMatchObject({ ok: false, code: "not-found" });
    // Above pid_max both ops refuse as bad-request; process.kill would otherwise throw a codeless error.
    expect(await a.request("proc.inspect", { pid: 2 ** 40 })).toMatchObject({ ok: false, code: "bad-request" });
    expect(await a.request("proc.kill", { pid: 2 ** 40, signal: "TERM" })).toMatchObject({ ok: false, code: "bad-request" });

    for (const pid of [1, daemon.pid, daemon.parentPid]) {
      expect(await a.request("proc.kill", { pid, signal: "TERM" })).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await a.request("proc.kill", { pid: 4_194_303, signal: "HUP" })).toMatchObject({ ok: false, code: "bad-request" });
    expect(await a.request("proc.kill", { pid: 4_194_303, signal: "KILL" })).toMatchObject({ ok: false, code: "not-found" });

    expect((await a.request("proc.unwatch")).ok).toBe(true);
    await new Promise(r => setTimeout(r, 60));
    const after = a.events.filter(e => e.type === "proc.snapshot").length;
    await new Promise(r => setTimeout(r, 80));
    expect(a.events.filter(e => e.type === "proc.snapshot").length).toBe(after);
    a.close();
  });

  it("an exited pty stops labelling its pid, so a stranger who reuses it carries no pty id", async () => {
    const a = await connect(daemon.port);
    const created = await a.request("pty.create", { shell: "bash", cols: 40, rows: 10 });
    expect(created.ok).toBe(true);
    const ptyId = created["ptyId"] as string;
    const pid = created["pid"] as number;
    // The fake tree stands in for /proc: this entry is whatever process holds the pid, alive or reused.
    writeProc(procRoot, { pid, ppid: 1, comm: "bash" });
    expect((await a.request("proc.watch")).ok).toBe(true);
    const labelled = () => a.events.filter(e => e.type === "proc.snapshot").flatMap(e => (e["procs"] as { pid: number; pty?: string }[]).filter(p => p.pid === pid));
    let deadline = Date.now() + 2000;
    while (labelled().length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    expect(labelled()[0]).toMatchObject({ pid, pty: ptyId });

    await a.request("pty.write", { ptyId, data: "exit\n" });
    deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const ptys = (await a.request("pty.list"))["ptys"] as { id: string; exited: boolean }[];
      if (ptys.find(p => p.id === ptyId)?.exited) break;
      await new Promise(r => setTimeout(r, 20));
    }
    expect((await a.request("pty.list"))["ptys"]).toContainEqual(expect.objectContaining({ id: ptyId, exited: true }));
    // The snapshot after the exit can be one the sampler had already built, so the wait is on a snapshot that dropped
    // the label rather than on the next one to arrive.
    const after = await vi.waitFor(
      () => {
        const last = labelled().at(-1)!;
        expect(last.pty).toBeUndefined();
        return last;
      },
      { timeout: 10_000, interval: 10 },
    );
    expect(after.pid).toBe(pid);

    expect((await a.request("proc.unwatch")).ok).toBe(true);
    rmSync(join(procRoot, String(pid)), { recursive: true, force: true });
    a.close();
  });

  it("manifest.record/get/restartScript round-trip over the wire", async () => {
    const c = await connect(daemon.port);
    const rec = await c.request("manifest.record", { cmd: "pnpm dev", cwd: "/root/app", port: 5173 });
    expect(rec.ok).toBe(true);
    expect(rec["entry"]).toMatchObject({ cmd: "pnpm dev", cwd: "/root/app", port: 5173 });

    const got = await c.request("manifest.get");
    expect(got["entries"]).toHaveLength(1);

    const script = await c.request("manifest.restartScript");
    expect(String(script["script"])).toContain("pnpm dev");
    expect(String(script["script"])).toContain("port_listening '1435'"); // 5173 in hex
    c.close();
  });

  it("inbox.watch pushes inbox.file once a dropped file settles", async () => {
    const c = await connect(daemon.port);
    const res = await c.request("inbox.watch");
    expect(res.ok).toBe(true);

    const file = join(inboxDir, "upload.bin");
    writeFileSync(file, "z".repeat(64));
    // FSEvents delivers the change with unbounded latency, so the assertion is
    // "settles eventually", never "settles within a fixed sleep".
    const settled = { type: "inbox.file", path: file, bytes: 64 };
    const deadline = Date.now() + 5000;
    while (!c.events.some(e => e.type === "inbox.file" && e.path === file) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(c.events).toContainEqual(settled);
    c.close();
  });

  it("inbox.rescan replays every existing file as an inbox.file event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-ops-rescan-"));
    writeFileSync(join(dir, "a.png"), "a".repeat(10));
    writeFileSync(join(dir, "b.bin"), "b".repeat(20));
    const d = await daemonUnderTest({ port: 0, token: TOKEN, inbox: dir, inboxQuietMs: 50, inboxPollMs: 25 });
    try {
      const c = await connect(d.port);
      // A file the watch has reported is mid-upload until its size holds still, and a rescan leaves those to the settle
      // sweep. FSEvents reports files written just before the watch started, so the count is waited on, not read once.
      await vi.waitFor(
        async () => {
          const res = await c.request("inbox.rescan");
          expect(res.ok).toBe(true);
          expect(res["count"]).toBe(2);
        },
        { timeout: 10_000, interval: 25 },
      );
      // WS ordering: both events land before the reply does
      expect(c.events).toContainEqual({ type: "inbox.file", path: join(dir, "a.png"), bytes: 10 });
      expect(c.events).toContainEqual({ type: "inbox.file", path: join(dir, "b.bin"), bytes: 20 });
      c.close();
    } finally {
      await d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nothing a pane asks for stays pending", () => {
  /** One daemon of its own per case, since each stands for a machine of a different kind. */
  async function withDaemon(args: DaemonUnderTestArgs, fn: (c: Awaited<ReturnType<typeof connect>>, d: DaemonUnderTest) => Promise<void>): Promise<void> {
    const d = await daemonUnderTest({ port: 0, token: TOKEN, ...args });
    const c = await connect(d.port);
    try {
      await fn(c, d);
    } finally {
      c.close();
      await d.close();
    }
  }

  it("a kind with no modules refuses both watches in the words the pane prints, rather than accepting a stream it never sends", async () => {
    // Every kind in the enum has a module today, so the guard is proved against a kind that is not one: a kind
    // added to the enum without a row here is what this refuses, and a pane prints the words rather than waiting.
    await withDaemon({ kind: "plan9" as WorkspaceKind }, async c => {
      for (const op of ["sys.watch", "proc.watch"]) {
        const res = await c.request(op);
        expect(res).toMatchObject({ ok: false, code: "unsupported" });
        expect(String(res["error"])).toMatch(/^not on this kind/);
      }
    });
  });

  it("a machine reached over ssh reads its own machine, since the daemon on it is the one a fork runs", async () => {
    // Its metrics module is the fork's own object, which this file's cloud cases already drive; what is proved
    // here is that the kind takes the watch at all rather than refusing it as a kind with no row.
    await withDaemon({ kind: "ssh", root: tmp, procRoot, procIntervalMs: 20 }, async c => {
      expect(await c.request("proc.watch")).toMatchObject({ ok: true });
    });
  });

  it("a metrics module that cannot read this machine refuses the watch with its own words, so no row sits at pending", async () => {
    // A /proc with nothing in it: the module names the file it could not read, and the pane prints that. The three
    // files are read at once, so which one the refusal names is the first to answer; the root is in all of them.
    const empty = mkdtempSync(join(tmpdir(), "wsp-ops-empty-proc-"));
    await withDaemon({ procRoot: empty }, async c => {
      const res = await c.request("sys.watch");
      expect(res.ok).toBe(false);
      expect(String(res["error"])).toContain(empty);
    });
    rmSync(empty, { recursive: true, force: true });
  });

  it("a processes module that cannot read this machine refuses the watch the same way", async () => {
    await withDaemon({ procRoot: join(tmp, "no-such-proc") }, async c => {
      const res = await c.request("proc.watch");
      expect(res.ok).toBe(false);
      expect(String(res["error"])).toContain("no-such-proc");
    });
  });

  it("a socket that goes while the probe is still reading takes no stream on, so nothing is left polling for it", async () => {
    // A FIFO where the tree's stat is: both probes block on it until the test feeds it, which is after the socket
    // went, so the read that was in flight when the client left is the one that lands on a closed socket.
    const root = fakeProcTree([{ pid: 1, comm: "init" }]);
    const stat = join(root, "stat");
    rmSync(stat);
    execFileSync("mkfifo", [stat]);
    await withDaemon({ procRoot: root, sysIntervalMs: 30, procIntervalMs: 30 }, async (c, d) => {
      void c.request("sys.watch");
      void c.request("proc.watch");
      await new Promise(r => setTimeout(r, 100));
      c.close();
      await new Promise(r => setTimeout(r, 100));
      // The write blocks until a reader holds the FIFO; a daemon that refused both watches before its probe would
      // never open it, and that is a failure with a cause, not a case held to its timeout.
      await Promise.race([
        writeFile(stat, `cpu  1 2 3 4 5 6 7 8 0 0\nbtime ${BTIME}\nprocesses 100\n`),
        new Promise((_, reject) => setTimeout(() => reject(new Error("no probe opened the FIFO: the daemon refused the watches before reading")), 5_000)),
      ]);
      // Well past several of the samplers' intervals: a sampler left running would have logged its start.
      await new Promise(r => setTimeout(r, 600));
      expect(d.log().filter(l => l === SYS_SAMPLER_STARTED || l === PROC_SAMPLER_STARTED)).toEqual([]);
    });
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  it("this computer's own kind answers both watches off its own host, with no /proc anywhere", async () => {
    // The /proc named here does not exist, which is what a Mac has: a daemon serving this computer must answer
    // without it, so a reading that arrives proves the host's own modules read it and not the guest's.
    await withDaemon({ kind: "local", workFolder: tmp, procRoot: join(tmp, "no-such-proc"), sysIntervalMs: 20, procIntervalMs: 20 }, async (c, d) => {
      expect((await c.request("sys.watch")).ok).toBe(true);
      expect((await c.request("proc.watch")).ok).toBe(true);
      const sample = await vi.waitFor(() => {
        const s = c.events.find(e => e.type === "sys.sample");
        expect(s).toBeDefined();
        return s!;
      }, { timeout: 10_000, interval: 20 });
      expect(sample["load1"]).toBeTypeOf("number");
      expect((sample["mem"] as { total: number }).total).toBeGreaterThan(0);
      expect((sample["disk"] as { total: number }).total).toBeGreaterThan(0);
      const snap = await vi.waitFor(() => {
        const e = c.events.find(f => f.type === "proc.snapshot");
        expect(e).toBeDefined();
        return e!;
      }, { timeout: 10_000, interval: 20 });
      expect((snap["procs"] as { pid: number }[]).some(p => p.pid === process.pid)).toBe(true);
      expect(snap["daemon"]).toBe(d.pid);
    });
  });
});

describe("wire", () => {
  it("every event the daemon pushed in this file is one the protocol parses", () => {
    expect(wire.length).toBeGreaterThan(0);
    expect(rejectedEvents(wire)).toEqual([]);
  });
});
