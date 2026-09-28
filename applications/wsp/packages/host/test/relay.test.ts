// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BROWSER_SHIM_PATH, type GoldenManifest, type Machine } from "@wsp/engine";
import { DAEMON_TOKEN_PATH, type DaemonResponse, type ForwardEvent } from "@wsp/protocol";
import { copyKey, DAEMON_TOKEN_SET, createRuntime, memoryStore, type Clock, type GoldenRecipe, type GuestOpening, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProcTree } from "../../daemon/test/fake-proc.js";
import { daemonUnderTest, machineDaemonToken, type DaemonUnderTest } from "../../daemon/test/harness.js";
import { CLOUD_PLACE, DAEMON_CONNECT_TIMEOUT_MS, OPEN_SHIM_PATH, connectDaemonSocket, openShimScript, type ConnectOptions, type DaemonSocket } from "../src/doctor.js";
import { guestDoor } from "../src/guest.js";
import { CALLBACK_HOLD_MAX_BYTES, CALLBACK_HOLD_MAX_CONNS, CALLBACK_HOLD_MS, FORWARD_IDLE_MS, FORWARD_MAX_PER_TARGET, REDIAL_CEILING_MS, RELAY_CAP_MS, RELAY_MIN_PORT, RELAY_WINDOW_MS, startCallbackRelay, type CallbackRelay } from "../src/relay.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { createOn, projectOn } from "./verbs-fixture.js";

runsFromItsOwnFolder();

const execFileAsync = promisify(execFile);
const TOKEN = "0123456789abcdef".repeat(2);
const MACHINE_TOKEN = machineDaemonToken(TOKEN, "m1");
const GOLDEN: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_gold", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } }],
};
const AUTH = (port: number): string => `https://dash.example.com/oauth2/auth?client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A${port}%2Foauth%2Fcallback&state=S`;
const DEVICE = "https://github.com/login/device";

function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void; t: number } {
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const clock = {
    t: start,
    now: () => clock.t,
    schedule(fn: () => void, ms: number) {
      const entry = { at: clock.t + ms, fn, live: true };
      timers.push(entry);
      return () => {
        entry.live = false;
      };
    },
    advance(ms: number) {
      const until = clock.t + ms;
      for (;;) {
        const due = timers.filter(x => x.live && x.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.t = due.at;
        due.live = false;
        due.fn();
      }
      clock.t = until;
    },
  };
  return clock;
}

interface FakeLink extends DaemonSocket {
  ops: { op: string; extra: Record<string, unknown> }[];
  /** What ports.watch answers as the guest's current listeners. */
  ports: number[];
  /** When set, tunnel.open is refused the way a guest with nothing listening refuses it. */
  refuseTunnels: boolean;
  emit(event: Record<string, unknown>): void;
  drop(): void;
}

/** A daemon socket the test drives: records ops, answers ok, pushes events. */
function fakeConnect(): {
  connect(o: ConnectOptions): Promise<DaemonSocket>;
  links: FakeLink[];
  targets: string[];
  refuseDials: boolean;
  slowDial?: () => Promise<void>;
  pushDuringDial?: Record<string, unknown>;
  slowWatch?: () => Promise<void>;
  slowGuestWatch?: () => Promise<void>;
} {
  const links: FakeLink[] = [];
  const targets: string[] = [];
  const fake = {
    links,
    targets,
    /** When set, every dial fails the way an edge that is down fails it. */
    refuseDials: false,
    /** When set, a dial waits on it after it is counted in targets, the way a slow edge holds the connect open. */
    slowDial: undefined as (() => Promise<void>) | undefined,
    /** When set, the daemon pushes this event while the dial is still open. The real one pushes to a socket the
     * moment it has authed it, which is before this promise resolves and before any caller can have recorded it. */
    pushDuringDial: undefined as Record<string, unknown> | undefined,
    /** When set, the ports.watch reply waits on it, the way the real one waits on the daemon's own port poll. */
    slowWatch: undefined as (() => Promise<void>) | undefined,
    /** The same for guest.watch, which is the second of the two round trips a fresh socket makes before the daemon
     * hands it this machine's sessions. */
    slowGuestWatch: undefined as (() => Promise<void>) | undefined,
    async connect(o: ConnectOptions): Promise<DaemonSocket> {
      if (fake.refuseDials) throw new Error("connect ECONNREFUSED edge");
      targets.push(o.url);
      if (fake.slowDial) await fake.slowDial();
      let resolveClosed: (c: number) => void = () => {};
      const closed = new Promise<number>(r => (resolveClosed = r));
      let open = true;
      const link: FakeLink = {
        ops: [],
        ports: [],
        refuseTunnels: false,
        async op(op, extra = {}) {
          link.ops.push({ op, extra });
          if (op === "tunnel.open" && link.refuseTunnels) throw new Error("connect ECONNREFUSED 127.0.0.1");
          if (op === "ports.watch") {
            if (fake.slowWatch) await fake.slowWatch();
            return { ok: true, ports: link.ports.map(port => ({ port, pid: null, inode: port, uid: 0, loopback: true })) };
          }
          if (op === "guest.watch" && fake.slowGuestWatch) await fake.slowGuestWatch();
          return { ok: true };
        },
        close() {
          open = false;
          resolveClosed(1000);
        },
        closed,
        beats: 0,
        get open() {
          return open;
        },
        emit: event => o.onEvent?.(event),
        drop() {
          open = false;
          resolveClosed(1006);
        },
      };
      links.push(link);
      const early = fake.pushDuringDial;
      if (early !== undefined) {
        fake.pushDuringDial = undefined;
        link.emit(early);
      }
      return link;
    },
  };
  return fake;
}

/** Machines answer as a guest with a daemon: a preview route to `guestUrl` and the token file. */
function relayRuntime(guestUrl: string, goldenRecipe?: GoldenRecipe): { rt: Runtime; backend: StubBackend } {
  const backend = stubBackend();
  backend.execImpl = (_m, cmd) => (cmd.includes(DAEMON_TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
  const create = backend.create.bind(backend);
  backend.create = async spec => {
    const m: Machine = await create(spec);
    m.previewUrl = async () => ({ url: guestUrl, token: "pt", expiresAt: Date.now() + 3_600_000 });
    return m;
  };
  const store = memoryStore();
  void store.put("goldens", copyKey("default", "default"), GOLDEN);
  // A wake pings the daemon through the preview route; nothing answers on guest.test, so the wait is kept short.
  backend.lifecycle.budgets.daemonAnswersMs = 100;
  return { rt: createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, ...(goldenRecipe !== undefined ? { goldenRecipe } : {}) }), backend };
}

/** Ports this file has handed out, none of them twice: the kernel hands an ephemeral port back out while it is free
 * (a repeat in 3 of 100 draws of 17 ports), and the relay folds a second event for a port it already forwards into
 * that one forward, so a test whose ports collide waits for a row that never comes. */
const handedOut = new Set<number>();

async function freePort(): Promise<number> {
  // Each candidate stays bound until a fresh one comes, so the kernel cannot answer with one it just offered.
  const holding: Server[] = [];
  try {
    for (;;) {
      const s = createServer();
      holding.push(s);
      await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
      const port = (s.address() as { port: number }).port;
      if (!handedOut.has(port)) {
        handedOut.add(port);
        return port;
      }
    }
  } finally {
    for (const s of holding) await new Promise<void>(r => s.close(() => r()));
  }
}

/** A port this test holds on ::1 alone and saw free on 127.0.0.1, so the relay's bind on that family is its own to release. */
async function heldOnOneFamily(): Promise<{ server: Server; port: number }> {
  for (let tries = 0; tries < 20; tries++) {
    const port = await freePort();
    const server = createServer();
    const held = await new Promise<boolean>(resolve => {
      server.once("error", () => resolve(false));
      server.listen(port, "::1", () => resolve(true));
    });
    if (held) return { server, port };
  }
  throw new Error("no port free on both 127.0.0.1 and ::1 in 20 tries");
}

/** A port a guest listener can hold on 127.0.0.1 while the relay binds the same number on [::1]. The kernel picks
 * ephemeral ports per family, so a port free on one says nothing about the other, and a relay refused on its own
 * family logs the refusal and opens no forward at all: the wait for that forward then never comes true. */
async function freeOnBothLoopbacks(): Promise<number> {
  const { server, port } = await heldOnOneFamily();
  await new Promise<void>(r => server.close(() => r()));
  return port;
}

/** Polls until the condition holds. The failure carries the predicate's own source and, where a caller passes one,
 * what the relay had said by then, since a wait that reports only that it timed out costs a rerun to place and the
 * reruns are where these flakes are read from. */
async function until(cond: () => boolean, ms = 3000, said?: () => readonly string[]): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      const heard = said === undefined ? "" : `; the relay had said: ${JSON.stringify(said())}`;
      throw new Error(`waited ${ms}ms and this never came true: ${cond.toString()}${heard}`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

function dial(port: number, host = "127.0.0.1"): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect({ port, host });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

function refused(port: number, host = "127.0.0.1"): Promise<boolean> {
  return dial(port, host).then(
    s => {
      s.destroy();
      return false;
    },
    (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED",
  );
}

describe("the shim the host ships", () => {
  it("names the path the engine's seal probe reads", () => {
    expect(BROWSER_SHIM_PATH).toBe(OPEN_SHIM_PATH);
  });
});

describe("callback relay over a fake daemon link", () => {
  let relay: CallbackRelay | undefined;
  const servers: Server[] = [];
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  });

  async function setup(
    o: {
      window?: number;
      cap?: number;
      autoOpen?: boolean | (() => boolean);
      guestPorts?: number[];
      jitter?: number;
      openLine?: (workspace: string, hostname: string, url: string) => string;
      duringDial?: Record<string, unknown>;
      watchMs?: number;
    } = {},
  ) {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    fake.pushDuringDial = o.duringDial;
    if (o.watchMs !== undefined) fake.slowWatch = () => new Promise(r => setTimeout(r, o.watchMs));
    const guestPorts = o.guestPorts ?? [];
    const clock = fakeClock();
    const opened: string[] = [];
    const lines: string[] = [];
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async url => {
        opened.push(url);
        return true;
      },
      log: l => lines.push(l),
      clock,
      connect: async c => {
        const l = (await fake.connect(c)) as FakeLink;
        l.ports = guestPorts;
        return l;
      },
      ...(o.window !== undefined ? { windowMs: o.window } : {}),
      ...(o.cap !== undefined ? { capMs: o.cap } : {}),
      ...(o.autoOpen ? { autoOpen: typeof o.autoOpen === "function" ? o.autoOpen : () => true } : {}),
      ...(o.openLine !== undefined ? { openLine: o.openLine } : {}),
      jitter: () => o.jitter ?? 0,
    });
    await until(() => fake.links.length >= 1);
    const link = fake.links[0]!;
    await until(() => link.ops.some(x => x.op === "ports.watch"));
    return { rt, fake, clock, opened, lines, ws, link };
  }

  /** wsp init's shape: one workspace plus the builder the wizard prepared, both linked. */
  async function setupWithBuilder() {
    const { rt } = relayRuntime("http://guest.test", { setup: "true", smoke: "true", cpu: 2, memMb: 4096 });
    const fake = fakeConnect();
    const opened: string[] = [];
    const lines: string[] = [];
    await createOn(rt, { golden: "snap_gold", name: "task-1" });
    const builder = await rt.golden.prepare({ name: "default" });
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async url => {
        opened.push(url);
        return true;
      },
      log: l => lines.push(l),
      clock: fakeClock(),
      connect: fake.connect,
      autoOpen: () => true,
      builder,
    });
    return { rt, fake, opened, lines };
  }

  it("takes the guest sessions on each machine it links, hands their frames to the door and answers back down the link", async () => {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });
    const heard: { workspaceId: string; type: string }[] = [];
    const dropped: string[] = [];
    const guest = {
      event: (link: { workspaceId: string; request(op: string, params: Record<string, unknown>): Promise<unknown> }, e: { type: string; session?: string }) => {
        heard.push({ workspaceId: link.workspaceId, type: e.type });
        if (e.type === "guest.opened") void link.request("guest.reply", { session: e.session, message: { exit: 0 } });
      },
      closeAll: (workspaceId: string) => dropped.push(workspaceId),
    };
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, clock: fakeClock(), connect: fake.connect, guest });
    await until(() => fake.links.length >= 1);
    const link = fake.links[0]!;
    // The watch goes on the one socket the host holds into a running workspace, after the port watch that seeds it.
    await until(() => link.ops.some(x => x.op === "guest.watch"));
    expect(link.ops.map(x => x.op)).toEqual(["ports.watch", "guest.watch"]);

    link.emit({ type: "guest.opened", session: "g0", life: "life-1", kind: "cli", token: "dev-1.tok", argv: ["threads"], cwd: "/root" });
    link.emit({ type: "guest.message", session: "g0", message: { n: 1 } });
    link.emit({ type: "guest.closed", session: "g0" });
    await until(() => heard.length === 3);
    expect(heard).toEqual([ws.id, ws.id, ws.id].map((workspaceId, at) => ({ workspaceId, type: ["guest.opened", "guest.message", "guest.closed"][at]! })));
    await until(() => link.ops.some(x => x.op === "guest.reply"));
    expect(link.ops.find(x => x.op === "guest.reply")!.extra).toEqual({ session: "g0", message: { exit: 0 } });

    // The workspace goes; so does every session that was riding its link.
    await rt.workspaces.delete(ws.id);
    await until(() => dropped.includes(ws.id));
  });

  it("keeps a guest session across a nap, so the open the machine names on the redial runs its kind module once", async () => {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });
    const token = (await rt.devices.mint("thread t1", { kind: "thread", threadId: "t1", workspaceId: ws.id, rootThreadId: "t1" }, Date.now())).deviceToken;
    let runs = 0;
    const kind = {
      open: (o: GuestOpening) => {
        runs++;
        return { message: (m: unknown) => o.reply(m), close: () => undefined };
      },
    };
    const guest = guestDoor({
      authorize: t => rt.devices.match(t).then(device => (device === undefined ? undefined : { kind: "device", device })),
      hostUrl: () => "http://127.0.0.1:1",
      kinds: { mcp: kind, cli: kind },
    });
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, clock: fakeClock(), connect: fake.connect, guest, retryMs: 1, jitter: () => 0 });
    await until(() => fake.links.length >= 1);
    const first = fake.links[0]!;
    await until(() => first.ops.some(x => x.op === "guest.watch"));
    const open = { type: "guest.opened", session: "g0", life: "life-1", kind: "cli", token, argv: ["new", "beta"], cwd: "/root" };
    first.emit(open);
    await until(() => runs === 1);

    // The machine naps and wakes inside the span its daemon holds a session for: the process inside it is still
    // waiting on the line it ran, so the socket that watches next is named that session again. Running the line a
    // second time here is a second wsp new.
    await rt.workspaces.nap(ws.id);
    await until(() => !first.open);
    await rt.workspaces.wake(ws.id);
    await until(() => fake.links.length >= 2);
    const second = fake.links[1]!;
    await until(() => second.ops.some(x => x.op === "guest.watch"));
    second.emit(open);
    second.emit({ type: "guest.message", session: "g0", message: { n: 1 } });

    // The session it held answers down the link that came back, and nothing opened it twice.
    await until(() => second.ops.some(x => x.op === "guest.reply"));
    expect(second.ops.find(x => x.op === "guest.reply")!.extra).toEqual({ session: "g0", message: { n: 1 } });
    expect(runs).toBe(1);
  });

  it("holds a workspace whose computer answers for it over the runtime's own channel: the guest watch alone, no dial, and its own sessions", async () => {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });
    const frames: Record<string, unknown>[] = [];
    let push: (event: Record<string, unknown>) => void = () => {};
    // The runtime says which road a workspace is on; here it is the channel over the computer's own link, which
    // dials nothing and keeps no ports of its own.
    const served: Runtime = {
      ...rt,
      workspaces: {
        ...rt.workspaces,
        servedByItsComputer: async () => true,
        daemonChannel: async () => {
          throw new Error("a client's channel carries no guest op");
        },
        guestChannel: async (_id, onEvent) => {
          push = onEvent;
          let end: (gone: { code: number; reason: string }) => void = () => {};
          return {
            send: async frame => {
              frames.push(frame);
              return { id: null, ok: true } as DaemonResponse;
            },
            close: () => end({ code: 1000, reason: "closed here" }),
            closed: new Promise<{ code: number; reason: string }>(r => (end = r)),
          };
        },
      },
    };
    const heard: { workspaceId: string; type: string }[] = [];
    const guest = {
      event: (link: { workspaceId: string; request(op: string, params: Record<string, unknown>): Promise<unknown> }, e: { type: string; session?: string }) => {
        heard.push({ workspaceId: link.workspaceId, type: e.type });
        if (e.type === "guest.opened") void link.request("guest.reply", { session: e.session, message: { exit: 0 } });
      },
      closeAll: () => {},
    };
    relay = startCallbackRelay({ runtime: served, openUrl: async () => true, log: () => {}, clock: fakeClock(), connect: fake.connect, guest });

    await until(() => frames.length > 0);
    expect(frames.map(f => f["op"])).toEqual(["guest.watch"]);
    expect(fake.targets).toEqual([]);

    // The computer stamps the workspace a session was opened inside on every frame it relays; another workspace's
    // is that workspace's link to answer and never reaches this door.
    const session = { type: "guest.opened", life: "life-1", kind: "cli", token: "dev-1.tok", argv: ["threads"], cwd: "/root" };
    push({ ...session, session: "g0", machineId: "another-workspace" });
    push({ ...session, session: "g1", machineId: ws.machineId });
    await until(() => heard.length > 0);
    expect(heard).toEqual([{ workspaceId: ws.id, type: "guest.opened" }]);
    await until(() => frames.some(f => f["op"] === "guest.reply"));
    expect(frames.find(f => f["op"] === "guest.reply")).toMatchObject({ session: "g1", message: { exit: 0 } });
  });

  it("drops the sessions of a workspace deleted while it napped, which holds no link for their end to ride", async () => {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });
    const dropped: (string | undefined)[] = [];
    const guest = { event: () => undefined, closeAll: (workspaceId?: string) => dropped.push(workspaceId) };
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, clock: fakeClock(), connect: fake.connect, guest });
    await until(() => fake.links.length >= 1);
    await until(() => fake.links[0]!.ops.some(x => x.op === "guest.watch"));

    // The nap keeps them: the machine holds its sessions and names them to whichever socket watches after the wake.
    await rt.workspaces.nap(ws.id);
    await until(() => !fake.links[0]!.open);
    expect(dropped).toEqual([]);

    // The delete finds no link to carry the end, and the rows are the workspace's rather than the link's.
    await rt.workspaces.delete(ws.id);
    await until(() => dropped.includes(ws.id));
  });

  it("drops every session it holds when the host closes, a napped workspace's with the rest", async () => {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });
    const dropped: (string | undefined)[] = [];
    const guest = { event: () => undefined, closeAll: (workspaceId?: string) => dropped.push(workspaceId) };
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, clock: fakeClock(), connect: fake.connect, guest });
    await until(() => fake.links.length >= 1);
    await until(() => fake.links[0]!.ops.some(x => x.op === "guest.watch"));
    await rt.workspaces.nap(ws.id);
    await until(() => !fake.links[0]!.open);

    await relay.close();
    relay = undefined;
    expect(dropped).toEqual([undefined]);
  });

  it("holds a frame that goes down while the link is between sockets, and sends it on the one that lands", async () => {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    await createOn(rt, { golden: "snap_gold", name: "task-1" });
    let answer: ((op: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;
    const guest = {
      event: (link: { request(op: string, params: Record<string, unknown>): Promise<unknown> }) => (answer = link.request),
      closeAll: () => {},
    };
    const clock = fakeClock();
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, clock, connect: fake.connect, guest, retryMs: 1, jitter: () => 0 });
    await until(() => fake.links.length >= 1);
    const first = fake.links[0]!;
    await until(() => first.ops.some(x => x.op === "guest.watch"));
    first.emit({ type: "guest.opened", session: "g0", life: "life-1", kind: "cli", token: "t", argv: ["threads"], cwd: "/root" });
    await until(() => answer !== undefined);

    // The edge sweeps the socket; the machine sees no redial, so a row it is streaming has to wait rather than
    // fail into a rejection nobody reads. The wait below lets the link's loop see the close and drop the socket.
    first.drop();
    await new Promise(resolve => setTimeout(resolve, 20));
    let landed = false;
    const sending = answer!("guest.reply", { session: "g0", message: { exit: 0 } }).then(() => (landed = true));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(landed, "the frame waits for the next socket instead of failing").toBe(false);

    clock.advance(10_000);
    await until(() => fake.links.length >= 2);
    const second = fake.links[1]!;
    await until(() => second.ops.some(x => x.op === "guest.watch"));
    await sending;
    expect(second.ops.find(x => x.op === "guest.reply")!.extra).toEqual({ session: "g0", message: { exit: 0 } });
    // And it went out after the watch, so the daemon was already handing this machine's sessions to that socket.
    expect(second.ops.map(x => x.op)).toEqual(["ports.watch", "guest.watch", "guest.reply"]);
  });

  it("holds a frame that goes down while the fresh socket is still watching, so none reaches it ahead of the watch", async () => {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    await createOn(rt, { golden: "snap_gold", name: "task-1" });
    let answer: ((op: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;
    const guest = {
      event: (link: { request(op: string, params: Record<string, unknown>): Promise<unknown> }) => (answer = link.request),
      closeAll: () => {},
    };
    const clock = fakeClock();
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, clock, connect: fake.connect, guest, retryMs: 1, jitter: () => 0 });
    await until(() => fake.links.length >= 1);
    const first = fake.links[0]!;
    await until(() => first.ops.some(x => x.op === "guest.watch"));
    first.emit({ type: "guest.opened", session: "g0", life: "life-1", kind: "cli", token: "t", argv: ["threads"], cwd: "/root" });
    await until(() => answer !== undefined);

    // The redial's watch is held open, so what follows runs inside the window between the socket landing and the
    // daemon handing it this machine's sessions. A frame that took the socket there would come back refused as not
    // the watcher, and the door swallows that rejection.
    let watching: (() => void) | undefined;
    fake.slowGuestWatch = () => new Promise<void>(go => (watching = go));
    first.drop();
    await new Promise(resolve => setTimeout(resolve, 20));
    clock.advance(10_000);
    await until(() => fake.links.length >= 2 && watching !== undefined);
    const second = fake.links[1]!;

    let landed = false;
    const sending = answer!("guest.reply", { session: "g0", message: { exit: 0 } }).then(() => (landed = true));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(landed, "the frame waits for the watch rather than going out ahead of it").toBe(false);
    expect(second.ops.map(x => x.op)).toEqual(["ports.watch", "guest.watch"]);

    fake.slowGuestWatch = undefined;
    watching!();
    await sending;
    // It went out after both watches, so the daemon was already handing this machine's sessions to that socket.
    expect(second.ops.map(x => x.op)).toEqual(["ports.watch", "guest.watch", "guest.reply"]);
  });

  it("holds the link open for the guest road on a host whose backend forwards no ports at all", async () => {
    const { rt, backend } = relayRuntime("http://guest.test");
    backend.capabilities.callbackRelay = false;
    const fake = fakeConnect();
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });
    const heard: { workspaceId: string; type: string }[] = [];
    const guest = {
      event: (link: { workspaceId: string; request(op: string, params: Record<string, unknown>): Promise<unknown> }, e: { type: string; session?: string }) => {
        heard.push({ workspaceId: link.workspaceId, type: e.type });
        if (e.type === "guest.opened") void link.request("guest.reply", { session: e.session, message: { stream: "out", text: "rows\n" } });
      },
      closeAll: () => {},
    };
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, clock: fakeClock(), connect: fake.connect, guest });
    await until(() => fake.links.length >= 1);
    const link = fake.links[0]!;
    await until(() => link.ops.some(x => x.op === "guest.watch"));
    link.emit({ type: "guest.opened", session: "g0", life: "life-1", kind: "cli", token: "t", argv: ["threads"], cwd: "/root" });
    await until(() => heard.length > 0);
    expect(heard).toEqual([{ workspaceId: ws.id, type: "guest.opened" }]);
    // And the host's answer goes back down that same link, which is the whole of what a fork's wsp waits on.
    await until(() => link.ops.some(x => x.op === "guest.reply"));
    expect(link.ops.find(x => x.op === "guest.reply")!.extra).toEqual({ session: "g0", message: { stream: "out", text: "rows\n" } });
    // Nothing is forwarded there: a printed local URL opens no listener on this computer.
    link.emit({ type: "localhost.url", port: 5173 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(relay.forwards()).toEqual([]);
  });

  it("leaves the guest road off where no door was given, so a link with nobody to serve a session asks for none", async () => {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    await createOn(rt, { golden: "snap_gold", name: "task-1" });
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, clock: fakeClock(), connect: fake.connect });
    await until(() => fake.links.length >= 1);
    await until(() => fake.links[0]!.ops.some(x => x.op === "ports.watch"));
    expect(fake.links[0]!.ops.map(x => x.op)).toEqual(["ports.watch"]);
  });

  it("an event pushed while the dial is still open is acted on once the socket is recorded, not dropped", async () => {
    const port = await freePort();
    // The daemon pushes to a socket the moment it has authed it. That is before the dial's promise resolves here,
    // so the link has no socket recorded yet and the event has nowhere to be acted on until it does.
    // The reply waits, the way the real one waits on the daemon's port poll, so a forward opened ahead of resume
    // would be there for resume to read: that is the window the line came out of. The reply also names the port as
    // one the guest listens on, and the forward reading that is the one sign from out here that resume went through.
    const { lines, opened, ws } = await setup({
      autoOpen: true,
      guestPorts: [port],
      duringDial: { type: "browser.open", url: AUTH(port), port },
      watchMs: 300,
    });
    await until(() => relay!.forwards().length === 1, 5000, () => lines);
    expect(relay!.forwards()).toMatchObject([{ targetId: ws.id, port, kind: "callback" }]);
    expect(opened).toEqual([AUTH(port)]);
    expect(lines.filter(l => l.includes("forwarding localhost:"))).toEqual([
      `task-1: forwarding localhost:${port} on this computer to the workspace for the sign-in callback (while the workspace listens, 15 min at most)`,
    ]);
    expect(await refused(port)).toBe(false);
    // The forward opens after resume, which therefore had nothing to resume: nobody is told a link is back that
    // was never away. Read once the forward has the guest's listener, which is resume's own doing on the other road.
    await until(() => relay!.forwards()[0]?.listener === true, 5000, () => lines);
    expect(lines.filter(l => l.includes("the daemon link is back"))).toEqual([]);
  }, 15_000);

  it("a hook of this relay's caller that throws on a queued event says so and leaves the link it arrived on up", async () => {
    const port = await freePort();
    let asked = 0;
    const { fake, lines, link } = await setup({
      duringDial: { type: "browser.open", url: AUTH(port), port },
      autoOpen: () => {
        asked++;
        throw new Error("the opener said no");
      },
    });
    expect(asked).toBe(1);
    expect(lines).toEqual(["task-1: an event from the workspace could not be handled (the opener said no)"]);
    // The throw is the caller's, not the machine's: the socket the event arrived on is still the link's.
    expect(link.open).toBe(true);
    expect(fake.links).toHaveLength(1);
    expect(relay!.forwards()).toEqual([]);
  });

  it("a url the guest printed during the same dial is kept too: the queue is every event kind, not the sign-in one", async () => {
    const port = await freePort();
    const { lines } = await setup({ duringDial: { type: "localhost.url", port } });
    await until(() => relay!.forwards().length === 1, 5000, () => lines);
    expect(relay!.forwards()).toMatchObject([{ port, kind: "url" }]);
  }, 15_000);

  it("by default browser.open opens nothing here: one line says a page is ready, and the port is forwarded at once", async () => {
    const { opened, lines, link, ws } = await setup();
    link.emit({ type: "browser.open", url: DEVICE });
    await until(() => lines.length === 1);
    expect(lines).toEqual(["task-1: a sign-in page for github.com is ready; open it from the app"]);
    expect(opened).toEqual([]);
    expect(relay!.forwards()).toEqual([]);
    const port = await freePort();
    link.emit({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()).toMatchObject([{ targetId: ws.id, port }]);
    expect(opened).toEqual([]);
    // The hostname is in the line by ruling; the path and query (the flow's state) never are.
    expect(lines.join("\n")).not.toMatch(/login\/device|redirect_uri|state=/);
  });

  it("the line logged when nothing opens comes from the openLine hook when one is given, told the page's URL too", async () => {
    const urls: string[] = [];
    const { lines, link } = await setup({ openLine: (workspace, hostname, url) => (urls.push(url), `${workspace}: press o on the link above to open ${hostname} here`) });
    link.emit({ type: "browser.open", url: DEVICE });
    await until(() => lines.length === 1);
    expect(lines).toEqual(["task-1: press o on the link above to open github.com here"]);
    expect(urls).toEqual([DEVICE]);
  });

  it("autoOpen is asked with the target, the page's URL and its callback port, so a caller can decline one it already opened or keep one for a later o", async () => {
    const asked: [string, string, number | undefined][] = [];
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const opened: string[] = [];
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async url => (opened.push(url), true),
      log: () => {},
      clock: fakeClock(),
      connect: fake.connect,
      autoOpen: (id, url, port) => (asked.push([id, url, port]), url !== DEVICE),
      jitter: () => 0,
    });
    await until(() => fake.links.length >= 1);
    const link = fake.links[0]!;
    await until(() => link.ops.some(x => x.op === "ports.watch"));
    const port = await freePort();
    link.emit({ type: "browser.open", url: DEVICE });
    link.emit({ type: "browser.open", url: "https://auth.example.com/device" });
    link.emit({ type: "browser.open", url: AUTH(port), port });
    await until(() => opened.length === 2);
    expect(asked).toEqual([[ws.id, DEVICE, undefined], [ws.id, "https://auth.example.com/device", undefined], [ws.id, AUTH(port), port]]);
    expect(opened).toEqual(["https://auth.example.com/device", AUTH(port)]);
  });

  it("with autoOpen on, browser.open opens the URL on this computer and logs the workspace, never the URL", async () => {
    const { opened, lines, link } = await setup({ autoOpen: true });
    link.emit({ type: "browser.open", url: DEVICE });
    await until(() => opened.length === 1);
    expect(opened).toEqual([DEVICE]);
    await until(() => lines.some(l => l.includes("opened a sign-in page")));
    expect(lines).toContain("task-1: opened a sign-in page in your browser");
    expect(lines.join("\n")).not.toContain("github.com");
    expect(relay!.forwards()).toEqual([]);
  });

  it("a URL naming a port forwards it on both loopback families and tunnels bytes both ways", async () => {
    const { opened, lines, link, ws } = await setup({ autoOpen: true });
    const port = await freePort();
    link.emit({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.forwards().length === 1);
    expect(opened).toEqual([AUTH(port)]);
    await until(() => lines.some(l => l.includes("opened a sign-in page")));
    expect(lines).toContain("task-1: opened a sign-in page in your browser; it returns to the machine on its own");
    expect(relay!.forwards()).toMatchObject([{ targetId: ws.id, port }]);
    expect(lines.find(l => l.includes("forwarding"))).toBe(
      `task-1: forwarding localhost:${port} on this computer to the workspace for the sign-in callback (while the workspace listens, 15 min at most)`,
    );

    const v6 = await dial(port, "::1");
    v6.destroy();
    const c = await dial(port);
    await until(() => link.ops.filter(x => x.op === "tunnel.open").length === 2);
    const opens = link.ops.filter(x => x.op === "tunnel.open");
    expect(opens.at(-1)!.extra).toMatchObject({ port });
    const tunnelId = opens.at(-1)!.extra["tunnelId"] as string;
    c.write("GET /oauth/callback?code=abc HTTP/1.1\r\n\r\n");
    await until(() => link.ops.some(x => x.op === "tunnel.write"));
    const write = link.ops.find(x => x.op === "tunnel.write")!;
    expect(Buffer.from(write.extra["data"] as string, "base64").toString()).toBe("GET /oauth/callback?code=abc HTTP/1.1\r\n\r\n");
    expect(write.extra["tunnelId"]).toBe(tunnelId);

    const got: Buffer[] = [];
    c.on("data", d => got.push(d));
    const ended = new Promise<void>(r => c.once("end", () => r()));
    link.emit({ type: "tunnel.data", tunnelId, data: Buffer.from("HTTP/1.1 200 OK\r\n\r\nsigned in").toString("base64") });
    link.emit({ type: "tunnel.end", tunnelId });
    await ended;
    expect(Buffer.concat(got).toString()).toBe("HTTP/1.1 200 OK\r\n\r\nsigned in");
    await until(() => link.ops.some(x => x.op === "tunnel.close" && x.extra["tunnelId"] === tunnelId));
    // The URL stays out of every line.
    expect(lines.join("\n")).not.toContain("dash.example.com");
  });

  it("callback.port after a portless open forwards that port", async () => {
    const { link, ws } = await setup();
    const port = await freePort();
    link.emit({ type: "browser.open", url: DEVICE });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()).toMatchObject([{ targetId: ws.id, port }]);
  });

  it("opens nothing and forwards nothing for a URL that is not http(s), with one line each", async () => {
    const { opened, lines, link } = await setup({ autoOpen: true });
    const port = await freePort();
    const bad = ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "\\\\host\\share"];
    for (const url of bad) link.emit({ type: "browser.open", url, port });
    await until(() => lines.length === bad.length);
    expect(lines).toEqual(bad.map(() => "task-1: ignored a sign-in page that is not an http(s) link"));
    expect(opened).toEqual([]);
    expect(relay!.forwards()).toEqual([]);
    expect(await refused(port)).toBe(true);
    link.emit({ type: "browser.open", url: "HTTPS://GITHUB.COM/LOGIN/DEVICE" });
    await until(() => opened.length === 1);
    expect(opened).toEqual(["HTTPS://GITHUB.COM/LOGIN/DEVICE"]);
  });

  it("browser.open and callback.port for the same port in one tick make one forward and no false refusal", async () => {
    const { lines, link } = await setup();
    const port = await freePort();
    link.emit({ type: "browser.open", url: AUTH(port), port });
    link.emit({ type: "callback.port", port });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    await new Promise(r => setTimeout(r, 100));
    expect(lines.filter(l => l.includes("forwarding localhost")).length).toBe(1);
    expect(lines.some(l => l.includes("already in use"))).toBe(false);
    expect(relay!.forwards().length).toBe(1);
  });

  it("a callback the workspace refuses gets a 502 with one sentence, and one line without the URL", async () => {
    const { lines, link } = await setup();
    const port = await freePort();
    link.refuseTunnels = true;
    link.emit({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.forwards().length === 1);
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=abc`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(`The sign-in callback reached this computer, but nothing on workspace task-1 answered on port ${port}.\n`);
    await until(() => lines.some(l => l.includes("nothing on the workspace answered")));
    expect(lines).toContain(`task-1: the sign-in callback on port ${port} reached this computer but nothing on the workspace answered`);
    expect(lines.join("\n")).not.toMatch(/redirect_uri|state=|oauth2/);
  });

  it("a port outside 1024..65535, and an open with no run named, are refused with one line and never end the process", async () => {
    const { lines, link } = await setup();
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      for (const port of [70000, 65536, 1.5, -1, 0]) link.emit({ type: "callback.port", port });
      link.emit({ type: "browser.open", url: AUTH(70000), port: 70000 });
      // A daemon from before a session carried the run that named it: the open cannot be read here, and the
      // process inside the machine is waiting on an answer, so the drop is said rather than silent.
      link.emit({ type: "guest.opened", session: "g0", kind: "cli", token: "t", argv: ["threads"], cwd: "/root" });
      await new Promise(r => setTimeout(r, 200));
      expect(rejections).toEqual([]);
      expect(relay!.forwards()).toEqual([]);
      expect(lines).toEqual([
        ...[70000, 65536, 1.5, -1, 0].map(() => "task-1: ignored a malformed callback.port event from the workspace"),
        "task-1: ignored a malformed browser.open event from the workspace",
        "task-1: ignored a malformed guest.opened event from the workspace",
      ]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    link.emit({ type: "callback.port", port: 8976 });
    await until(() => relay!.forwards().length === 1 || lines.some(l => l.includes("8976")));
  });

  it("a newcomer this computer cannot bind leaves the working forward alone", async () => {
    const { lines, link } = await setup();
    const a = await freePort();
    link.emit({ type: "callback.port", port: a });
    await until(() => relay!.forwards().length === 1);
    const taken = createServer();
    servers.push(taken);
    await new Promise<void>(r => taken.listen(0, "127.0.0.1", r));
    const b = (taken.address() as { port: number }).port;
    link.emit({ type: "callback.port", port: b });
    await until(() => lines.some(l => l.includes(`port ${b} is already in use`)));
    expect(relay!.forwards()).toMatchObject([{ port: a }]);
    const c = await dial(a);
    await until(() => link.ops.some(x => x.op === "tunnel.open" && x.extra["port"] === a));
    c.destroy();
    expect(lines.some(l => l.includes(`stopped forwarding localhost:${a}`))).toBe(false);
  });

  it("a link replaced while a bind is in flight leaves no stale entry: the next event for that port forwards it", async () => {
    const { fake, clock, link } = await setup();
    const port = await freePort();
    link.emit({ type: "callback.port", port });
    link.drop();
    await new Promise(r => setTimeout(r, 100));
    expect(relay!.forwards()).toEqual([]);
    expect(await refused(port)).toBe(true);
    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    await until(() => fake.links[1]!.ops.some(x => x.op === "ports.watch"));
    fake.links[1]!.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
  });

  it("a URL with whitespace, a control character or over the length cap is refused on the host, not only in the guest", async () => {
    const { opened, lines, link } = await setup({ autoOpen: true });
    const bad = ["https://x.test/a b", "https://x.test/a\nb", `https://x.test/${"a".repeat(9000)}`];
    for (const url of bad) link.emit({ type: "browser.open", url });
    await until(() => lines.length === bad.length);
    expect(lines).toEqual(bad.map(() => "task-1: ignored a sign-in page that is not an http(s) link"));
    expect(opened).toEqual([]);
  });

  it("a URL that matches the scheme rule but does not parse is ignored with one line, and nothing throws", async () => {
    const { opened, lines, link } = await setup();
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onRejection);
    try {
      for (const url of ["https://%", "https://[::1", "https://exa%mple.com/x"]) link.emit({ type: "browser.open", url });
      await until(() => lines.length === 3);
      expect(lines).toEqual(Array(3).fill("task-1: ignored a sign-in page that is not an http(s) link"));
      expect(opened).toEqual([]);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onRejection);
    }
  });

  it("refuses ports below 1024 and ports this computer already uses, each with one clear line", async () => {
    const { lines, link } = await setup();
    link.emit({ type: "callback.port", port: 80 });
    await until(() => lines.some(l => l.includes("malformed")));
    expect(lines).toContain("task-1: ignored a malformed callback.port event from the workspace");
    expect(RELAY_MIN_PORT).toBe(1024);

    const { server: taken, port } = await heldOnOneFamily();
    servers.push(taken);
    link.emit({ type: "callback.port", port });
    await until(() => lines.some(l => l.includes("already in use")));
    expect(lines).toContain(`task-1: port ${port} is already in use on this computer; the sign-in callback is not forwarded`);
    expect(relay!.forwards()).toEqual([]);
    expect(await refused(port, "127.0.0.1")).toBe(true);
  });

  it("with no guest listener seen, a forward closes at the floor, traffic or not", async () => {
    const { clock, lines, link } = await setup({ window: 1_000, cap: 3_000 });
    const port = await freePort();
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()[0]).toMatchObject({ listener: false, expiresAt: clock.t + 1_000 });
    clock.advance(900);
    const c = await dial(port);
    await until(() => link.ops.some(x => x.op === "tunnel.open"));
    c.destroy();
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t + 100);
    clock.advance(99);
    expect(relay!.forwards().length).toBe(1);
    clock.advance(1);
    expect(relay!.forwards()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (no listener on the workspace within 0 min)`);
    expect(await refused(port)).toBe(true);
  });

  it("a forward whose port the guest listens on stays open past the floor and ends when that listener closes", async () => {
    const port = await freePort();
    const { clock, lines, link } = await setup({ window: 1_000, cap: 3_000, guestPorts: [port] });
    link.emit({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()[0]).toMatchObject({ listener: true, expiresAt: clock.t + 3_000 });
    clock.advance(2_000);
    expect(relay!.forwards().length).toBe(1);
    link.emit({ type: "port.close", port: port + 1 });
    await new Promise(r => setTimeout(r, 20));
    expect(relay!.forwards().length).toBe(1);
    link.emit({ type: "port.close", port });
    await until(() => relay!.forwards().length === 0);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (the workspace stopped listening)`);
    expect(await refused(port)).toBe(true);
  });

  it("a listener that appears after the forward keeps it open, and nothing outlives the cap", async () => {
    const { clock, lines, link } = await setup({ window: 1_000, cap: 3_000 });
    const port = await freePort();
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    clock.advance(500);
    link.emit({ type: "port.open", port, loopback: true });
    await until(() => relay!.forwards()[0]?.listener === true);
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t - 500 + 3_000);
    clock.advance(2_499);
    expect(relay!.forwards().length).toBe(1);
    clock.advance(1);
    expect(relay!.forwards()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (open for 0 min, the cap)`);
  });

  it("keeps one forward per workspace: a new port replaces the old, the same port is one forward", async () => {
    const { clock, lines, link } = await setup();
    const a = await freePort();
    const b = await freePort();
    link.emit({ type: "callback.port", port: a });
    await until(() => relay!.forwards().length === 1);
    clock.advance(60_000);
    link.emit({ type: "callback.port", port: a });
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toMatchObject([{ port: a, expiresAt: clock.t - 60_000 + RELAY_WINDOW_MS }]);
    expect(lines.filter(l => l.includes("forwarding localhost")).length).toBe(1);
    link.emit({ type: "callback.port", port: b });
    await until(() => relay!.forwards()[0]?.port === b);
    expect(relay!.forwards().length).toBe(1);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${a} (port ${b} replaces it)`);
    expect(await refused(a)).toBe(true);
    expect(RELAY_CAP_MS).toBe(15 * 60_000);
  });

  it("redials with a random fraction added to the wait, so links do not come back in lockstep", async () => {
    const { fake, clock, link } = await setup({ jitter: 1 });
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    clock.advance(2_000);
    await new Promise(r => setTimeout(r, 50));
    expect(fake.links.length).toBe(1);
    clock.advance(1_000);
    await until(() => fake.links.length === 2);
  });

  it("a dropped link keeps the callback forward: no close, the row stays, and the next callback rides the new link", async () => {
    const port = await freePort();
    const { fake, clock, lines, link } = await setup({ guestPorts: [port] });
    const events: ForwardEvent[] = [];
    relay!.on(e => events.push(e));
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    const before = relay!.forwards()[0]!;
    expect(before.listener).toBe(true);
    clock.advance(3_000);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toEqual([before]);
    expect(lines.some(l => l.includes("stopped forwarding"))).toBe(false);

    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => lines.some(l => l.includes("the daemon link is back")));
    expect(lines.filter(l => l.includes("the daemon link is back"))).toEqual([`task-1: the daemon link is back; localhost:${port} still forwarded`]);
    expect(relay!.forwards()).toEqual([before]);
    expect(events.filter(e => e.type === "forward.close")).toEqual([]);
    expect(events.filter(e => e.type === "forward.open")).toHaveLength(1);
    const c = await dial(port);
    await until(() => second.ops.some(x => x.op === "tunnel.open" && x.extra["port"] === port));
    expect(link.ops.filter(x => x.op === "tunnel.open")).toEqual([]);
    c.destroy();
  });

  it("a redial that finds the callback port no longer listening closes the forward saying so, and the row leaves", async () => {
    const port = await freePort();
    const guestPorts = [port];
    const { fake, clock, lines, link } = await setup({ guestPorts });
    const events: ForwardEvent[] = [];
    relay!.on(e => events.push(e));
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards()[0]?.listener === true);
    guestPorts.splice(0);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    await until(() => relay!.forwards().length === 0);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (the workspace stopped listening while the daemon link was down)`);
    expect(events.filter(e => e.type === "forward.close").map(e => e.port)).toEqual([port]);
    expect(lines.some(l => l.includes("the daemon link is back"))).toBe(false);
    expect(await refused(port)).toBe(true);
  });

  it("a listener that appears while the link is down is spotted at the redial and keys the window on itself", async () => {
    const port = await freePort();
    const guestPorts: number[] = [];
    const { fake, clock, link } = await setup({ guestPorts, window: 60_000, cap: 600_000 });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    const before = relay!.forwards()[0]!;
    expect(before.listener).toBe(false);
    guestPorts.push(port);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    await until(() => relay!.forwards()[0]?.listener === true);
    expect(relay!.forwards()[0]!.expiresAt).toBe(before.expiresAt - 60_000 + 600_000);
  });

  it("a callback that lands during the redial wait is held, not refused, and rides the new link once it is back", async () => {
    const port = await freePort();
    const { fake, clock, lines, link } = await setup({ guestPorts: [port] });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards()[0]?.listener === true);
    link.drop();
    await new Promise(r => setTimeout(r, 50));

    const request = "GET /oauth/callback?code=abc HTTP/1.1\r\nHost: localhost\r\n\r\n";
    const c = await dial(port);
    const got: Buffer[] = [];
    c.on("data", d => got.push(d));
    c.write(request);
    // A browser that gives up before the link is back is dropped, never tunnelled.
    const gone = await dial(port);
    gone.write(request);
    await new Promise(r => setTimeout(r, 50));
    gone.destroy();
    await new Promise(r => setTimeout(r, 50));
    expect(got).toEqual([]);
    expect(c.destroyed).toBe(false);
    expect(lines.filter(l => l.includes("holding"))).toEqual([`task-1: a sign-in callback reached localhost:${port} here while the daemon link is down; holding it until the link is back`]);
    expect(lines.some(l => l.includes("found the workspace unreachable"))).toBe(false);

    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => second.ops.some(x => x.op === "tunnel.write"));
    const opens = second.ops.filter(x => x.op === "tunnel.open");
    expect(opens).toHaveLength(1);
    expect(opens[0]!.extra).toMatchObject({ port });
    const tunnelId = opens[0]!.extra["tunnelId"] as string;
    const write = second.ops.find(x => x.op === "tunnel.write")!;
    expect(write.extra["tunnelId"]).toBe(tunnelId);
    expect(Buffer.from(write.extra["data"] as string, "base64").toString()).toBe(request);
    expect(link.ops.filter(x => x.op === "tunnel.open")).toEqual([]);

    const ended = new Promise<void>(r => c.once("end", () => r()));
    second.emit({ type: "tunnel.data", tunnelId, data: Buffer.from("HTTP/1.1 200 OK\r\n\r\nsigned in").toString("base64") });
    second.emit({ type: "tunnel.end", tunnelId });
    await ended;
    expect(Buffer.concat(got).toString()).toBe("HTTP/1.1 200 OK\r\n\r\nsigned in");
    // The hold's clock is gone with the hold: nothing answers this socket a second time.
    clock.advance(CALLBACK_HOLD_MS);
    expect(Buffer.concat(got).toString()).toBe("HTTP/1.1 200 OK\r\n\r\nsigned in");
  });

  it("a held callback past the hold gets a 502 saying the machine was reconnecting and to retry the sign-in", async () => {
    expect(CALLBACK_HOLD_MS).toBe(REDIAL_CEILING_MS * 1.5 + DAEMON_CONNECT_TIMEOUT_MS);
    const port = await freePort();
    const { fake, clock, lines, link } = await setup({ guestPorts: [port] });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards()[0]?.listener === true);
    fake.refuseDials = true;
    link.drop();
    await new Promise(r => setTimeout(r, 50));

    const res = fetch(`http://127.0.0.1:${port}/oauth/callback?code=abc`);
    await until(() => lines.some(l => l.includes("holding")));
    clock.advance(CALLBACK_HOLD_MS - 1);
    await new Promise(r => setTimeout(r, 50));
    expect(lines.some(l => l.includes("start the sign-in again"))).toBe(false);
    clock.advance(1);
    const answer = await res;
    expect(answer.status).toBe(502);
    expect(await answer.text()).toBe(`The sign-in callback reached this computer while workspace task-1 was reconnecting, and the daemon link did not come back within 60 s. Start the sign-in again.\n`);
    expect(lines).toContain(`task-1: a sign-in callback held on localhost:${port} for 60 s found no daemon link; start the sign-in again`);
    expect(fake.links).toHaveLength(1);
    expect(relay!.forwards()).toHaveLength(1);
  });

  it("a held callback whose forward closes at the redial is answered with the close reason, not left hanging", async () => {
    const port = await freePort();
    const guestPorts = [port];
    const { fake, clock, link } = await setup({ guestPorts });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards()[0]?.listener === true);
    guestPorts.splice(0);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    const res = fetch(`http://127.0.0.1:${port}/oauth/callback?code=abc`);
    await new Promise(r => setTimeout(r, 50));
    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    const answer = await res;
    expect(answer.status).toBe(502);
    expect(await answer.text()).toBe(`The sign-in callback reached this computer while workspace task-1 was reconnecting, but its forward on port ${port} closed (the workspace stopped listening while the daemon link was down). Start the sign-in again.\n`);
    expect(relay!.forwards()).toEqual([]);
  });

  it("a callback at the top of a full redial pause outlives the dial that carries it, and is plumbed on the new link", async () => {
    const port = await freePort();
    const { fake, clock, lines, link } = await setup({ guestPorts: [port], jitter: 1 });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards()[0]?.listener === true);
    fake.refuseDials = true;
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    // Four refused redials at 2, 4, 8 and 16 s (each times the full jitter) bring the pause to the ceiling.
    for (const base of [2_000, 4_000, 8_000, 16_000]) {
      clock.advance(base * 1.5);
      await new Promise(r => setTimeout(r, 50));
    }
    expect(fake.links).toHaveLength(1);

    const c = await dial(port);
    const got: Buffer[] = [];
    c.on("data", d => got.push(d));
    c.write("GET /oauth/callback?code=abc HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await until(() => lines.some(l => l.includes("holding")));
    let release: () => void = () => {};
    fake.refuseDials = false;
    fake.slowDial = () => new Promise<void>(r => (release = r));
    // Released on every path: close() awaits the gated dial, so a failed assertion here would hang afterEach.
    try {
      clock.advance(REDIAL_CEILING_MS * 1.5);
      await until(() => fake.targets.length === 2);
      // The dial is in flight for its whole budget; the hold must not run out under it.
      clock.advance(DAEMON_CONNECT_TIMEOUT_MS - 1);
      await new Promise(r => setTimeout(r, 50));
      expect(got).toEqual([]);
      expect(lines.some(l => l.includes("start the sign-in again"))).toBe(false);
    } finally {
      fake.slowDial = undefined;
      release();
    }
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => second.ops.some(x => x.op === "tunnel.write"));
    expect(second.ops.filter(x => x.op === "tunnel.open")).toHaveLength(1);
    clock.advance(CALLBACK_HOLD_MS);
    await new Promise(r => setTimeout(r, 50));
    expect(got).toEqual([]);
    expect(c.destroyed).toBe(false);
    expect(lines.some(l => l.includes("start the sign-in again"))).toBe(false);
    c.destroy();
  });

  it("a held socket that sends more than the byte cap is dropped, and never tunnelled at the redial; one under it still is", async () => {
    const port = await freePort();
    const { fake, clock, lines, link } = await setup({ guestPorts: [port] });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards()[0]?.listener === true);
    link.drop();
    await new Promise(r => setTimeout(r, 50));

    const flood = await dial(port);
    const floodClosed = new Promise<void>(r => flood.once("close", () => r()));
    flood.write(Buffer.alloc(CALLBACK_HOLD_MAX_BYTES, 0x41));
    await new Promise(r => setTimeout(r, 100));
    expect(flood.destroyed).toBe(false);
    flood.write("B");
    await floodClosed;

    const request = "GET /oauth/callback?code=abc HTTP/1.1\r\nHost: localhost\r\n\r\n";
    const c = await dial(port);
    c.write(request);
    await new Promise(r => setTimeout(r, 50));
    expect(c.destroyed).toBe(false);
    expect(lines.filter(l => l.includes("holding"))).toHaveLength(1);

    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => second.ops.some(x => x.op === "tunnel.write"));
    expect(second.ops.filter(x => x.op === "tunnel.open")).toHaveLength(1);
    const writes = second.ops.filter(x => x.op === "tunnel.write");
    expect(writes.map(w => Buffer.from(w.extra["data"] as string, "base64").toString())).toEqual([request]);
    c.destroy();
  });

  it("past the held-connection cap a callback is answered 502 at once, and the redial plumbs only the held ones", async () => {
    const port = await freePort();
    const { fake, clock, link } = await setup({ guestPorts: [port] });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards()[0]?.listener === true);
    link.drop();
    await new Promise(r => setTimeout(r, 50));

    const held: Socket[] = [];
    for (let i = 0; i < CALLBACK_HOLD_MAX_CONNS; i++) {
      const c = await dial(port);
      c.write(`GET /oauth/callback?n=${i} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      held.push(c);
    }
    await new Promise(r => setTimeout(r, 50));
    expect(held.every(c => !c.destroyed)).toBe(true);
    const answer = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=abc`);
    expect(answer.status).toBe(502);
    expect(await answer.text()).toBe(
      `The sign-in callback reached this computer while workspace task-1 was reconnecting, and ${CALLBACK_HOLD_MAX_CONNS} connections were already waiting for it. Start the sign-in again.\n`,
    );
    expect(held.every(c => !c.destroyed)).toBe(true);

    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => second.ops.filter(x => x.op === "tunnel.write").length === CALLBACK_HOLD_MAX_CONNS);
    expect(second.ops.filter(x => x.op === "tunnel.open")).toHaveLength(CALLBACK_HOLD_MAX_CONNS);
    for (const c of held) c.destroy();
  });

  it("a napped workspace loses its link and the redial stops; a deleted one for good", async () => {
    const { rt, fake, clock, link, ws } = await setup();
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    clock.advance(2_000);
    await until(() => fake.links.length === 2);

    await rt.workspaces.nap(ws.id);
    await until(() => !fake.links[1]!.open);
    clock.advance(10_000);
    expect(fake.links.length).toBe(2);
    await rt.workspaces.delete(ws.id);
    clock.advance(10_000);
    expect(fake.links.length).toBe(2);
  });

  it("dials the init builder through its own reach and names it", async () => {
    const { rt, fake, opened, lines } = await setupWithBuilder();
    const builder = (await rt.golden.builders())[0]!;
    await until(() => fake.links.length === 2);
    expect(fake.targets).toEqual(["http://guest.test", "http://guest.test"]);
    // The two links dial in parallel, so each gets the event and the lines name both.
    for (const l of fake.links) l.emit({ type: "browser.open", url: DEVICE });
    await until(() => opened.length === 2);
    await until(() => lines.filter(l => l.includes("opened a sign-in page")).length === 2);
    expect(lines).toContain(`${builder.name} (builder): opened a sign-in page in your browser`);
    expect(lines).toContain("task-1: opened a sign-in page in your browser");
  });

  it("does nothing on a backend without the callbackRelay capability", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend: { ...backend, capabilities: { ...backend.capabilities, callbackRelay: false } }, store: memoryStore(), adapters: {} });
    const fake = fakeConnect();
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, connect: fake.connect, clock: fakeClock() });
    await new Promise(r => setTimeout(r, 50));
    expect(fake.links).toEqual([]);
    expect(relay.forwards()).toEqual([]);
  });
});

describe("callback relay end to end through a real daemon", () => {
  let daemon: DaemonUnderTest | undefined;
  let relay: CallbackRelay | undefined;
  let guest: Server | undefined;
  let dir: string | undefined;
  /** The fake machine the daemon reads its listening ports off: darwin has no /proc/net/tcp. */
  let procRoot: string | undefined;
  afterEach(async () => {
    await relay?.close();
    await daemon?.close();
    await new Promise<void>(r => (guest ? guest.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (procRoot) rmSync(procRoot, { recursive: true, force: true });
    relay = daemon = guest = dir = procRoot = undefined;
  });

  it("shim post in the guest opens on the laptop and the callback rides the tunnel back to the guest listener", { timeout: 15_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-relay-e2e-"));
    const sockPath = join(dir, "open.sock");
    procRoot = fakeProcTree([]);
    daemon = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: MACHINE_TOKEN, openSocket: sockPath, procRoot });
    const { rt } = relayRuntime(`http://127.0.0.1:${daemon.port}/?pt_token=ignored`);
    await createOn(rt, { golden: "snap_gold", name: "task-1" });

    // Guest and laptop share this machine's loopback, so the guest tool takes 127.0.0.1 (where the daemon dials first) and the laptop side [::1].
    const seen: string[] = [];
    guest = createServer(s => {
      s.on("data", d => {
        seen.push(d.toString());
        s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
      });
    });
    const port = await freeOnBothLoopbacks();
    await new Promise<void>(r => guest!.listen(port, "127.0.0.1", r));

    const opened: string[] = [];
    const lines: string[] = [];
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async url => {
        opened.push(url);
        return true;
      },
      log: l => lines.push(l),
      autoOpen: () => true,
      listenHosts: ["::1"],
    });
    const script = join(dir, "wsp-open");
    writeFileSync(script, openShimScript(CLOUD_PLACE).replace("/root/.wsp/open.sock", sockPath));
    chmodSync(script, 0o755);
    const url = AUTH(port);
    // The link dials in the background; a post before it is up reaches no socket, so post until one lands.
    for (let i = 0; i < 50 && opened.length === 0; i++) {
      await execFileAsync("sh", [script, url]);
      await new Promise(r => setTimeout(r, 100));
    }
    expect(opened[0]).toBe(url);
    await until(() => relay!.forwards().length === 1, 5000, () => lines);

    const res = await fetch(`http://[::1]:${port}/oauth/callback?code=abc&state=S`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(seen.join("")).toContain("GET /oauth/callback?code=abc&state=S HTTP/1.1");
    expect(lines.join("\n")).not.toContain("dash.example.com");

    // A URL the daemon's own socket lets through but that does not parse must not bring the host down.
    const thrown: unknown[] = [];
    const onThrow = (e: unknown) => thrown.push(e);
    process.on("uncaughtException", onThrow);
    try {
      const before = lines.length;
      const status = (await execFileAsync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--unix-socket", sockPath, "-X", "POST", "--data-binary", "https://%", "http://wsp/open"])).stdout;
      expect(status).toBe("400");
      await new Promise(r => setTimeout(r, 200));
      expect(thrown).toEqual([]);
      expect(lines.slice(before)).toEqual([]);
    } finally {
      process.off("uncaughtException", onThrow);
    }
  });
});

describe("localhost forwards over a fake daemon link", () => {
  let relay: CallbackRelay | undefined;
  const servers: Server[] = [];
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  });

  async function setup(o: { idle?: number; guestPorts?: number[] } = {}) {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const clock = fakeClock();
    const lines: string[] = [];
    const events: ForwardEvent[] = [];
    /** What every link's ports.watch answers; a test mutates it before a redial or a wake. */
    const guestPorts = o.guestPorts ?? [];
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async () => true,
      log: l => lines.push(l),
      clock,
      connect: async c => {
        const l = (await fake.connect(c)) as FakeLink;
        l.ports = guestPorts;
        return l;
      },
      ...(o.idle !== undefined ? { idleMs: o.idle } : {}),
      jitter: () => 0,
    });
    relay.on(e => events.push(e));
    await until(() => fake.links.length >= 1);
    const link = fake.links[0]!;
    await until(() => link.ops.some(x => x.op === "ports.watch"));
    return { rt, fake, clock, lines, events, ws, link, guestPorts };
  }

  it("the default idle window is ten minutes", () => {
    expect(FORWARD_IDLE_MS).toBe(10 * 60_000);
  });

  it("a renamed workspace's forwards read the name it carries now, on the rows and in the lines, and the app hears each row again", async () => {
    const { rt, lines, events, link, ws, clock } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.list()).toEqual([{ workspaceId: ws.id, port, startedAt: new Date(clock.t).toISOString(), name: "task-1", kind: "url" }]);

    await rt.workspaces.rename(ws.id, "the name he typed");
    await until(() => relay!.list()[0]?.name === "the name he typed");

    // The row a client already holds is announced again under the new name, so nothing waits for the next open.
    expect(events.at(-1)).toEqual({ type: "forward.open", forward: { workspaceId: ws.id, port, startedAt: new Date(clock.t).toISOString(), name: "the name he typed", kind: "url" } });
    // Every line from here names the workspace as it is now.
    const before = lines.length;
    relay!.stop(ws.id, port);
    await until(() => lines.length > before);
    expect(lines.slice(before).join("\n")).toContain("the name he typed:");
    expect(lines.slice(before).join("\n")).not.toContain("task-1:");
  });

  it("localhost.url forwards its port, one per port per workspace, and the app hears each one open", async () => {
    const { lines, events, link, ws, clock } = await setup();
    const a = await freePort();
    const b = await freePort();
    link.emit({ type: "localhost.url", port: a });
    link.emit({ type: "localhost.url", port: b });
    await until(() => relay!.forwards().length === 2);
    expect(relay!.forwards().map(f => ({ port: f.port, kind: f.kind })).sort((x, y) => x.port - y.port)).toEqual([{ port: a, kind: "url" }, { port: b, kind: "url" }].sort((x, y) => x.port - y.port));
    expect(relay!.list()).toEqual(expect.arrayContaining([
      { workspaceId: ws.id, port: a, startedAt: new Date(clock.t).toISOString(), name: "task-1", kind: "url" },
      { workspaceId: ws.id, port: b, startedAt: new Date(clock.t).toISOString(), name: "task-1", kind: "url" },
    ]));
    expect(events.map(e => e.type)).toEqual(["forward.open", "forward.open"]);
    expect(lines).toContain(`task-1: forwarding localhost:${a} on this computer to the workspace (closes after 10 min without traffic)`);

    // The same port again is the same forward: no second bind, no second line, no second event.
    link.emit({ type: "localhost.url", port: a });
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toHaveLength(2);
    expect(lines.filter(l => l.includes(`localhost:${a}`))).toHaveLength(1);
    expect(events).toHaveLength(2);

    // Both families listen, and a connection rides the tunnel to the guest.
    const c = await dial(a, "::1");
    await until(() => link.ops.some(x => x.op === "tunnel.open" && x.extra["port"] === a));
    c.destroy();
  });

  it("traffic keeps a url forward alive; the idle window without any closes it and frees the port", async () => {
    const { clock, lines, events, link, ws } = await setup({ idle: 1_000 });
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()[0]).toMatchObject({ kind: "url", expiresAt: clock.t + 1_000 });

    // A connection at 500 ms moves the close to 1500 ms.
    clock.advance(500);
    const c = await dial(port);
    await until(() => link.ops.some(x => x.op === "tunnel.open"));
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t + 1_000);

    // Bytes from this computer at 900 ms move it to 1900 ms.
    clock.advance(400);
    c.write("GET / HTTP/1.1\r\n\r\n");
    await until(() => link.ops.some(x => x.op === "tunnel.write"));
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t + 1_000);

    // Bytes from the guest at 1300 ms move it to 2300 ms.
    clock.advance(400);
    const tunnelId = link.ops.find(x => x.op === "tunnel.open")!.extra["tunnelId"] as string;
    link.emit({ type: "tunnel.data", tunnelId, data: Buffer.from("hi").toString("base64") });
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t + 1_000);
    c.destroy();
    clock.advance(999);
    expect(relay!.forwards()).toHaveLength(1);
    clock.advance(1);
    expect(relay!.forwards()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (no traffic for 0 min)`);
    expect(events.at(-1)).toEqual({ type: "forward.close", workspaceId: ws.id, port });
    expect(await refused(port)).toBe(true);
  });

  it("no cap: a url forward with traffic outlives the callback cap", async () => {
    const { clock, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    for (let i = 0; i < 4; i++) {
      clock.advance(FORWARD_IDLE_MS - 60_000);
      const c = await dial(port);
      await until(() => link.ops.filter(x => x.op === "tunnel.open").length === i + 1);
      c.destroy();
    }
    expect(clock.t - 1_000_000).toBeGreaterThan(RELAY_CAP_MS);
    expect(relay!.forwards()).toHaveLength(1);
  });

  it("a port this computer already uses is refused with one line, no forward and no event; nothing ends the process", async () => {
    const { lines, events, link } = await setup();
    const held = createServer();
    servers.push(held);
    await new Promise<void>(r => held.listen(0, "127.0.0.1", r));
    const port = (held.address() as { port: number }).port;
    const rejections: unknown[] = [];
    const onReject = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onReject);
    try {
      link.emit({ type: "localhost.url", port });
      await until(() => lines.length === 1);
      expect(lines).toEqual([`task-1: port ${port} is already in use on this computer; localhost:${port} here will not reach the workspace`]);
      for (const bad of [80, 1023, 65536, 70000, 1.5, -1, "8123"]) link.emit({ type: "localhost.url", port: bad });
      await until(() => lines.length === 8);
      expect(lines.slice(1)).toEqual(Array(7).fill("task-1: ignored a malformed localhost.url event from the workspace"));
      await new Promise(r => setTimeout(r, 50));
      expect(rejections).toEqual([]);
      expect(relay!.forwards()).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      process.off("unhandledRejection", onReject);
    }
  });

  it("a connection to a forwarded port nothing on the guest answers gets a 502 that names the forward, and one line without a URL", async () => {
    const { lines, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    link.refuseTunnels = true;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(`localhost:${port} on this computer is forwarded to workspace task-1, but nothing there answered on port ${port}.\n`);
    await until(() => lines.length === 2);
    expect(lines[1]).toBe(`task-1: a connection to localhost:${port} here reached the workspace but nothing there answered on port ${port}`);
    expect(lines.join("\n")).not.toContain("http://");
  });

  it("at most 16 url forwards per workspace: the next port is refused with one line until one is stopped", async () => {
    const { lines, link, ws } = await setup();
    const ports: number[] = [];
    for (let i = 0; i < FORWARD_MAX_PER_TARGET + 1; i++) ports.push(await freePort());
    for (const port of ports) link.emit({ type: "localhost.url", port });
    await until(() => lines.length === FORWARD_MAX_PER_TARGET + 1, 5000);
    expect(relay!.forwards()).toHaveLength(FORWARD_MAX_PER_TARGET);
    const refusal = lines.find(l => l.includes("stop one first"))!;
    expect(refusal).toMatch(/^task-1: not forwarding localhost:\d+; 16 ports are already forwarded for this workspace, stop one first$/);
    const refusedPort = Number(refusal.match(/localhost:(\d+)/)![1]);
    expect(relay!.forwards().some(f => f.port === refusedPort)).toBe(false);
    // Stopping one makes room.
    expect(relay!.stop(ws.id, ports.find(p => p !== refusedPort)!)).toBe(true);
    link.emit({ type: "localhost.url", port: refusedPort });
    await until(() => relay!.forwards().some(f => f.port === refusedPort));
    expect(relay!.forwards()).toHaveLength(FORWARD_MAX_PER_TARGET);
  });

  it("stop from the app closes the forward and frees the port; a second stop is false", async () => {
    const { lines, events, link, ws } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.stop(ws.id, port)).toBe(true);
    expect(relay!.forwards()).toEqual([]);
    expect(relay!.list()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (stopped from the app)`);
    expect(events.at(-1)).toEqual({ type: "forward.close", workspaceId: ws.id, port });
    expect(await refused(port)).toBe(true);
    expect(relay!.stop(ws.id, port)).toBe(false);
    expect(relay!.stop("nobody", port)).toBe(false);
  });

  it("a port the callback forward already holds is not forwarded twice; a link drop keeps both kinds in their order and one line names them", async () => {
    const { fake, clock, lines, events, link } = await setup();
    const p = await freePort();
    const q = await freePort();
    link.emit({ type: "callback.port", port: p });
    await until(() => relay!.forwards().length === 1);
    link.emit({ type: "localhost.url", port: p });
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards().map(f => f.kind)).toEqual(["callback"]);
    expect(lines.some(l => l.includes("already in use"))).toBe(false);
    // The app sees the callback forward too, told apart by its kind: a port on this computer the person can stop.
    expect(relay!.list()).toMatchObject([{ port: p, kind: "callback" }]);

    link.emit({ type: "localhost.url", port: q });
    await until(() => relay!.forwards().length === 2);
    const before = relay!.forwards();
    expect(before.map(f => f.port)).toEqual([p, q]);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toEqual(before);
    clock.advance(2_000);
    await until(() => fake.links.length === 2 && lines.some(l => l.includes("the daemon link is back")));
    expect(relay!.forwards()).toEqual(before);
    expect(lines.filter(l => l.includes("the daemon link is back"))).toEqual([`task-1: the daemon link is back; localhost:${p}, localhost:${q} still forwarded`]);
    expect(lines.some(l => l.includes("stopped forwarding"))).toBe(false);
    expect(events.filter(e => e.type === "forward.close")).toEqual([]);
    expect(await refused(p)).toBe(false);
    expect(await refused(q)).toBe(false);
  });

  it("a link drop keeps a url forward bound with its idle clock running; a connection meanwhile gets the 502; the redial plumbs it through the new link with one line", async () => {
    const { fake, clock, lines, events, link } = await setup({ idle: 10_000 });
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    const expiresAt = relay!.forwards()[0]!.expiresAt;
    clock.advance(3_000);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toMatchObject([{ port, kind: "url", expiresAt }]);
    expect(events.filter(e => e.type === "forward.close")).toEqual([]);

    // A tab left open pings once a second: one line for the stretch, not one per connection.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(502);
      expect(await res.text()).toContain(`localhost:${port} on this computer is forwarded to workspace task-1`);
    }
    expect(lines.filter(l => l.includes("found the workspace unreachable"))).toEqual([`task-1: a connection to localhost:${port} here found the workspace unreachable`]);

    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => lines.some(l => l.includes("the daemon link is back")));
    expect(lines.filter(l => l.includes("the daemon link is back"))).toEqual([`task-1: the daemon link is back; localhost:${port} still forwarded`]);
    expect(relay!.forwards()[0]!.expiresAt).toBe(expiresAt);
    expect(events.filter(e => e.type === "forward.open")).toHaveLength(1);
    const c = await dial(port);
    await until(() => second.ops.some(x => x.op === "tunnel.open" && x.extra["port"] === port));
    c.destroy();

    // A second stretch gets its own line.
    second.drop();
    await new Promise(r => setTimeout(r, 50));
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502);
    expect(lines.filter(l => l.includes("found the workspace unreachable"))).toHaveLength(2);
  });

  it("a connection that resets with the 502 unread, while the workspace refuses the tunnel and then while it is unreachable, does not end the host", async () => {
    const { link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    const thrown: unknown[] = [];
    const onThrow = (e: unknown) => thrown.push(e);
    process.on("uncaughtException", onThrow);
    process.on("unhandledRejection", onThrow);
    // Write a request and answer the reply with a reset instead of reading it, as a browser closing a keep-alive socket does.
    const slam = async (): Promise<void> => {
      const c = await dial(port);
      c.setNoDelay(true);
      c.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await new Promise(r => setImmediate(r));
      c.resetAndDestroy();
      await new Promise(r => setTimeout(r, 60));
    };
    try {
      // Refusing: the link is up and the guest rejects tunnel.open, so plumb ends the socket with the 502.
      link.refuseTunnels = true;
      for (let i = 0; i < 5; i++) await slam();
      await until(() => link.ops.filter(x => x.op === "tunnel.open").length === 5);
      expect(thrown).toEqual([]);
      // Unreachable: no link at all, so onConn ends the socket with the 502.
      link.drop();
      await new Promise(r => setTimeout(r, 50));
      for (let i = 0; i < 5; i++) await slam();
      expect(thrown).toEqual([]);
    } finally {
      process.off("uncaughtException", onThrow);
      process.off("unhandledRejection", onThrow);
    }
    expect(relay!.forwards()).toHaveLength(1);
  });

  it("a stretch where nothing on the guest answers logs one line, and a connection that gets through starts a new stretch", async () => {
    const { lines, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    link.refuseTunnels = true;
    for (let i = 0; i < 3; i++) expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502);
    const line = `task-1: a connection to localhost:${port} here reached the workspace but nothing there answered on port ${port}`;
    expect(lines.filter(l => l === line)).toHaveLength(1);
    link.refuseTunnels = false;
    const c = await dial(port);
    await until(() => link.ops.filter(x => x.op === "tunnel.open").length === 4);
    c.destroy();
    link.refuseTunnels = true;
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502);
    expect(lines.filter(l => l === line)).toHaveLength(2);
  });

  it("a nap pauses the idle clock and keeps the row; the wake resumes it, closes a port the workspace no longer listens on, and says so in one line per link", async () => {
    const { rt, fake, clock, lines, events, ws, link, guestPorts } = await setup({ idle: 10_000 });
    const a = await freePort();
    const b = await freePort();
    link.emit({ type: "localhost.url", port: a });
    link.emit({ type: "localhost.url", port: b });
    await until(() => relay!.forwards().length === 2);
    clock.advance(4_000);
    await rt.workspaces.nap(ws.id);
    await until(() => !link.open);
    // Napping: nothing closes, nothing expires, a click here gets the 502 that names the workspace.
    clock.advance(60_000);
    expect(relay!.forwards()).toHaveLength(2);
    expect(events.filter(e => e.type === "forward.close")).toEqual([]);
    const napped = await fetch(`http://127.0.0.1:${a}/`);
    expect(napped.status).toBe(502);

    // The machine kept a; b is gone.
    guestPorts.push(a);
    await rt.workspaces.wake(ws.id);
    await until(() => fake.links.length === 2);
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()).toMatchObject([{ port: a, kind: "url", expiresAt: clock.t + 6_000 }]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${b} (not listening on the workspace after the wake)`);
    // A connection during the nap logged once; a connection after the wake goes through and a later stretch logs again.
    expect(lines.filter(l => l.includes("found the workspace unreachable"))).toEqual([`task-1: a connection to localhost:${a} here found the workspace unreachable`]);
    expect(lines.filter(l => l.includes("awake again"))).toEqual([`task-1: awake again; localhost:${a} still forwarded`]);
    expect(events.filter(e => e.type === "forward.close").map(e => e.port)).toEqual([b]);
    expect(events.filter(e => e.type === "forward.open")).toHaveLength(2);
    expect(await refused(b)).toBe(true);
    // The clock resumes with the 6 s it had left, not a fresh window.
    clock.advance(5_999);
    expect(relay!.forwards()).toHaveLength(1);
    clock.advance(1);
    expect(relay!.forwards()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${a} (no traffic for 0 min)`);
  });

  it("a nap closes a callback forward saying the workspace napped; a delete closes a url forward for good", async () => {
    const { rt, fake, lines, ws, link, guestPorts } = await setup();
    const p = await freePort();
    const q = await freePort();
    link.emit({ type: "callback.port", port: p });
    link.emit({ type: "localhost.url", port: q });
    await until(() => relay!.forwards().length === 2);
    await rt.workspaces.nap(ws.id);
    await until(() => relay!.forwards().length === 1);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${p} (the workspace napped)`);
    guestPorts.push(q);
    await rt.workspaces.wake(ws.id);
    await until(() => fake.links.length === 2 && lines.some(l => l.includes("awake again")));
    expect(relay!.forwards()).toMatchObject([{ port: q, kind: "url" }]);
    await rt.workspaces.delete(ws.id);
    await until(() => relay!.forwards().length === 0);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${q} (the workspace was deleted)`);
    expect(await refused(q)).toBe(true);
  });

  it("after the workspace moves to a new machine, a url forward whose port the new machine does not serve closes saying so", async () => {
    const { rt, fake, lines, ws, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    await rt.workspaces.upgrade(ws.id);
    await until(() => fake.links.length === 2 && relay!.forwards().length === 0);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (not listening on the workspace after it moved to a new machine)`);
    expect(await refused(port)).toBe(true);
  });

  it("a callback bind in flight does not count toward the url cap", async () => {
    const { link } = await setup();
    const forwarded = (): Set<number> => new Set(relay!.forwards().map(f => f.port));
    const ports: number[] = [];
    for (let i = 0; i < FORWARD_MAX_PER_TARGET - 1; i++) ports.push(await freePort());
    for (const port of ports) link.emit({ type: "localhost.url", port });
    await until(() => ports.every(p => forwarded().has(p)));
    const x = await freePort();
    const y = await freePort();
    link.emit({ type: "callback.port", port: x });
    link.emit({ type: "localhost.url", port: y });
    await until(() => forwarded().has(x) && forwarded().has(y));
    expect(relay!.forwards().filter(f => f.kind === "url")).toHaveLength(FORWARD_MAX_PER_TARGET);
    expect(relay!.forwards().find(f => f.port === x)?.kind).toBe("callback");
  });

  it("two workspaces asking for the same laptop port: the second is refused as in use, the first keeps it", async () => {
    const { rt, fake, lines, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    await createOn(rt, { golden: "snap_gold", name: "task-2" });
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => second.ops.some(x => x.op === "ports.watch"));
    second.emit({ type: "localhost.url", port });
    await until(() => lines.some(l => l.startsWith("task-2:")));
    expect(lines.filter(l => l.startsWith("task-2:"))).toEqual([`task-2: port ${port} is already in use on this computer; localhost:${port} here will not reach the workspace`]);
    expect(relay!.forwards()).toHaveLength(1);
    const c = await dial(port);
    await until(() => link.ops.some(x => x.op === "tunnel.open"));
    c.destroy();
  });
});

describe("localhost forwards end to end through a real daemon", () => {
  let daemon: DaemonUnderTest | undefined;
  let relay: CallbackRelay | undefined;
  let guest: Server | undefined;
  let dir: string | undefined;
  /** The fake machine the daemon reads its listening ports off: darwin has no /proc/net/tcp. */
  let procRoot: string | undefined;
  afterEach(async () => {
    await relay?.close();
    await daemon?.close();
    await new Promise<void>(r => (guest ? guest.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (procRoot) rmSync(procRoot, { recursive: true, force: true });
    relay = daemon = guest = dir = procRoot = undefined;
  });

  it("a URL printed in a workspace pty forwards its port; a request here reaches the guest listener; stop closes it", { timeout: 15_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-forward-e2e-"));
    procRoot = fakeProcTree([]);
    daemon = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: MACHINE_TOKEN, openSocket: join(dir, "open.sock"), procRoot });
    const { rt } = relayRuntime(`http://127.0.0.1:${daemon.port}/?pt_token=ignored`);
    const ws = await createOn(rt, { golden: "snap_gold", name: "task-1" });

    // Guest and laptop share this machine's loopback: the guest server takes 127.0.0.1 (where the daemon dials first), the laptop side [::1].
    const seen: string[] = [];
    const body = "<h1>Directory listing</h1>\n";
    guest = createServer(s => {
      s.on("data", d => {
        seen.push(d.toString());
        s.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      });
    });
    const port = await freeOnBothLoopbacks();
    await new Promise<void>(r => guest!.listen(port, "127.0.0.1", r));

    const lines: string[] = [];
    const events: ForwardEvent[] = [];
    let linked = false;
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async () => true,
      log: l => lines.push(l),
      listenHosts: ["::1"],
      retryMs: 200,
      jitter: () => 0,
      connect: async c => {
        const s = await connectDaemonSocket(c);
        linked = true;
        void s.closed.then(() => {
          linked = false;
        });
        return s;
      },
    });
    relay.on(e => events.push(e));
    // The daemon pushes to the sockets it has; the host's link must be one of them before the tool prints.
    await until(() => linked, 5000);

    // A wsp terminal: a pty on the daemon, the tool prints its URL. The typed line carries the port only
    // as a variable: readline wraps its own echo at the pty width, and a wrap inside a literal URL is not
    // what a tool's output looks like.
    const sock = await connectDaemonSocket({ url: `ws://127.0.0.1:${daemon.port}`, token: MACHINE_TOKEN });
    try {
      const created = await sock.op("pty.create", { shell: "bash" });
      await sock.op("pty.write", { ptyId: created["ptyId"], data: `P=${port}; printf 'Serving HTTP on 0.0.0.0 port %s (http://0.0.0.0:%s/) ...\\n' $P $P\n` });
      await until(() => relay!.forwards().length === 1, 8000);
    } finally {
      sock.close();
    }
    expect(lines).toEqual([`task-1: forwarding localhost:${port} on this computer to the workspace (closes after 10 min without traffic)`]);
    expect(relay.list()).toEqual([{ workspaceId: ws.id, port, startedAt: expect.any(String), name: "task-1", kind: "url" }]);
    expect(events).toEqual([{ type: "forward.open", forward: relay.list()[0] }]);

    const res = await fetch(`http://[::1]:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(seen.join("")).toContain("GET / HTTP/1.1");

    // The daemon goes away and comes back on the same port: the forward is still there and rides the new link.
    const daemonPort = daemon.port;
    await daemon.close();
    daemon = undefined;
    // The link's socket is gone before the daemon comes back; the forward stays.
    await until(() => !linked, 5000);
    expect(relay.forwards()).toMatchObject([{ port, kind: "url" }]);
    for (let i = 0; i < 50 && daemon === undefined; i++) {
      daemon = await daemonUnderTest({ host: "127.0.0.1", port: daemonPort, token: MACHINE_TOKEN, procRoot }).catch(() => undefined);
      if (daemon === undefined) await new Promise(r => setTimeout(r, 100));
    }
    expect(daemon).toBeDefined();
    await until(() => lines.some(l => l.includes("the daemon link is back")), 8000);
    expect(lines.filter(l => l.includes("the daemon link is back"))).toEqual([`task-1: the daemon link is back; localhost:${port} still forwarded`]);
    const again = await fetch(`http://[::1]:${port}/`);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(body);

    expect(relay.stop(ws.id, port)).toBe(true);
    expect(relay.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "forward.close", workspaceId: ws.id, port });
    expect(await refused(port, "::1")).toBe(true);
    expect(lines.join("\n")).not.toContain("http://");
  });
});
