// SPDX-License-Identifier: AGPL-3.0-only
// The daemon for this computer's own workspace is the binary every machine
// runs, spawned on loopback; these hold what the host reads off it and what it
// leaves on disk. They run on the binary built in this checkout, placed by
// packages/wspx/scripts/daemon-binary.mjs, so a failure here is a failure of
// the road the host takes.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_VERSION, daemonListeningLine, type DaemonEvent, type ProcInspectReply, type ProcSnapshot, type SysSample } from "@wsp/protocol";
import { connectDaemon } from "@wsp/runtime";
import { daemonBinaryHere } from "../src/assets.js";
import { choosePorts } from "../src/ports.js";
import { LocalDaemon, type LocalDaemonOptions } from "../src/local-daemon.js";

async function waitForEvent(events: DaemonEvent[], type: string, ms = 10_000): Promise<DaemonEvent> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = events.find(e => e.type === type);
    if (found) return found;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`no ${type} event within ${ms} ms; saw ${events.map(e => e.type).join(", ") || "nothing"}`);
}

/** Whether a process is alive, asked of the kernel and not of node's handle. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A stand-in for the daemon binary: it prints the listening line the host reads the port off, answers the auth
 * frame, and then either sends a hello of the version a case names or nothing at all, which is the binary too old
 * to say and the binary that is not a daemon. Written as a script so the real start road runs: a child process, its
 * stdout read for the port, and a socket opened to it with the token the start minted. */
function fakeDaemon(root: string, version?: number, noise: readonly string[] = []): string {
  const bin = join(root, "fake-daemon.mjs");
  const hello = version === undefined ? '    if (frame.op === "auth") console.error("nothing of a hello");' : `    if (frame.op === "auth") socket.send(JSON.stringify({ type: "daemon.hello", root: "/wsp", version: ${version} }));`;
  writeFileSync(
    bin,
    [
      `import ws from ${JSON.stringify(createRequire(import.meta.url).resolve("ws"))};`,
      "const { WebSocketServer } = ws;",
      'import { writeFileSync } from "node:fs";',
      'const at = process.argv.indexOf("--root");',
      'writeFileSync(process.argv[at + 1] + "/fake-daemon-pid", String(process.pid));',
      ...noise.map(line => `console.error(${JSON.stringify(line)});`),
      'const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {',
      `  console.log(${JSON.stringify(daemonListeningLine("127.0.0.1", "PORT"))}.replace("PORT", String(wss.address().port)));`,
      "});",
      "wss.on('connection', socket => {",
      "  socket.on('message', raw => {",
      "    const frame = JSON.parse(String(raw));",
      "    socket.send(JSON.stringify({ id: frame.id, ok: true }));",
      hello,
      "  });",
      "});",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  const sh = join(root, "fake-daemon.sh");
  writeFileSync(sh, `#!/bin/sh\nexec ${process.execPath} ${bin} "$@"\n`, { mode: 0o755 });
  return sh;
}

describe("local daemon", () => {
  let root: string;
  let daemon: LocalDaemon | undefined;
  /** The folder the host serving this daemon keeps its own files in, which is where its state file sits. */
  const stateFolder = (): string => join(root, "state");
  /** This daemon as a host starts it: the person's home as the browse root, and the roots file and the inbox
   * named by the host, beside its state file. */
  const startLocal = (over: Partial<LocalDaemonOptions> = {}): Promise<LocalDaemon> =>
    LocalDaemon.start({ root, workFolder: root, rootsPath: join(stateFolder(), "roots"), inboxDir: join(stateFolder(), "inbox"), ...over });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localdaemon-"));
  });
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("spawns this computer's own binary out of the daemon asset, on loopback, and answers the same link a cloud workspace's daemon is reached by", async () => {
    expect(existsSync(daemonBinaryHere())).toBe(true);
    daemon = await startLocal();
    expect(daemon.port).toBeGreaterThan(0);
    expect(alive(daemon.pid)).toBe(true);
    const link = daemon.link();
    await link.ready;
    await link.request("ping");
    link.close();
  });

  it("the inbox folder is the owner's, and one an older build left wider is repaired", async () => {
    mkdirSync(join(stateFolder(), "inbox"), { recursive: true });
    chmodSync(join(stateFolder(), "inbox"), 0o755);
    daemon = await startLocal();
    expect(statSync(join(stateFolder(), "inbox")).mode & 0o777).toBe(0o700);
  });

  it("binds a free ephemeral port the host's own port check never sees as a clash, and leaves nothing of its own beside the host's files", async () => {
    // Two ports of the host's own, free right now, standing in for its app and runtime ports.
    const free = async (): Promise<number> =>
      new Promise(resolve => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
          const port = (s.address() as { port: number }).port;
          s.close(() => resolve(port));
        });
      });
    const hostPorts = [await free(), await free()];
    daemon = await startLocal();
    expect(hostPorts).not.toContain(daemon.port);
    // The host's own pick, with both ports named: it binds exactly the pair asked for, nothing taken, nothing stepped over.
    expect(await choosePorts({ port: hostPorts[0]!, wsPort: hostPorts[1]!, named: true })).toEqual({ ports: { port: hostPorts[0], wsPort: hostPorts[1] } });
    // The browse root holds the host's own folder and nothing else: the token file and the manifest sit in a folder
    // of the daemon's own under the system's temp dir, and the flags name both, so nothing falls back to a path
    // under /root.
    expect(readdirSync(root)).toEqual(["state"]);
    const argv = execFileSync("ps", ["-o", "args=", "-p", String(daemon.pid)], { encoding: "utf8" }).trim().split(" ");
    for (const flag of ["--token-path", "--manifest"]) {
      const path = argv[argv.indexOf(flag) + 1]!;
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(path.startsWith(root)).toBe(false);
    }
    // The roots file and the inbox are the two the caller named, in the folder the host's state file sits in:
    // the browse root is the person's home, one folder however many hosts run on this computer, and a path taken
    // off it would be one file two hosts wrote.
    expect(argv[argv.indexOf("--roots-path") + 1]).toBe(join(stateFolder(), "roots"));
    expect(argv[argv.indexOf("--inbox") + 1]).toBe(join(stateFolder(), "inbox"));
    expect(existsSync(join(stateFolder(), "inbox"))).toBe(true);
    expect(existsSync(join(root, ".wsp"))).toBe(false);
  });

  it("hands out one road for the panes and the probe: an http route the probe fetches and every link turns into ws, with the token beside it", async () => {
    daemon = await startLocal();
    const road = daemon.road;
    expect(road.url).toBe(`http://127.0.0.1:${daemon.port}`);
    expect(road.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(road.daemonToken).toMatch(/^[0-9a-f]{48}$/);
    // The status probe fetches that url; a WebSocket server answers a plain GET 426, which is what it reads as a daemon.
    expect((await fetch(road.url)).status).toBe(426);
    // The browser's link dials the same url as ws, with the token in the first frame.
    const link = connectDaemon({ previewUrl: road.url, token: road.daemonToken!, onEvent: () => {} });
    await link.ready;
    link.close();
  });

  it("reads its token off a file the caller named, so a rotation under it opens the next link", async () => {
    const tokenPath = join(root, "handed", "token");
    daemon = await startLocal({ tokenPath });
    const minted = readFileSync(tokenPath, "utf8").trim();
    expect(minted).toMatch(/^[0-9a-f]{48}$/);
    // A stand-in machine's daemon is reached by a token the runtime writes through that machine's own shell, and
    // that shell cannot write the path a Linux guest keeps one at; one holding only the token it minted would
    // refuse every link after the first rotation.
    const rotated = "b".repeat(48);
    writeFileSync(tokenPath, `${rotated}\n`);
    expect(daemon.road.daemonToken).toBe(rotated);
    const link = connectDaemon({ previewUrl: daemon.road.url, token: rotated, onEvent: () => {} });
    await link.ready;
    await link.request("ping");
    link.close();
  });

  it("serves the files under the workspace folder", async () => {
    writeFileSync(join(root, "hello.txt"), "hi");
    daemon = await startLocal();
    const link = daemon.link();
    await link.ready;
    const listing = (await link.request("fs.list", { path: root })) as { entries: { name: string }[] };
    expect(listing.entries.map(e => e.name)).toContain("hello.txt");
    link.close();
  });

  it("answers the Live rows and the Processes tab off this computer itself, with a sample and a snapshot that holds this process", async () => {
    daemon = await startLocal();
    const events: DaemonEvent[] = [];
    const link = daemon.link(e => events.push(e));
    await link.ready;
    // The watches answer only once this computer has been read, so an ok here is already the module working.
    await link.request("sys.watch");
    await link.request("proc.watch");
    const sample = await waitForEvent(events, "sys.sample");
    expect((sample as SysSample).mem.total).toBe(totalmem());
    expect((sample as SysSample).disk.total).toBeGreaterThan(0);
    const snapshot = await waitForEvent(events, "proc.snapshot");
    expect((snapshot as ProcSnapshot).procs.some(p => p.pid === process.pid)).toBe(true);
    // Which modules answered, not merely that something did: this computer's processes module reads ps, which has
    // no thread column on macOS, so it leaves the field off where the guest's /proc module always sets it. Without
    // that, a host that forgot to say which kind it serves would pass this on Linux, where /proc exists.
    const inspect = (await link.request("proc.inspect", { pid: process.pid })) as ProcInspectReply;
    expect(inspect.pid).toBe(process.pid);
    expect(inspect.threads).toBeUndefined();
    link.close();
  }, 20_000);

  it("hands the host's Live rows one shared watch: a second pane reads the same samples, and the last one leaving closes it", async () => {
    daemon = await startLocal();
    const a: SysSample[] = [];
    const b: SysSample[] = [];
    const detachA = await daemon.sysSamples(s => a.push(s));
    const detachB = await daemon.sysSamples(s => b.push(s));
    await waitForEvent(a as unknown as DaemonEvent[], "sys.sample");
    await waitForEvent(b as unknown as DaemonEvent[], "sys.sample");
    expect(a[0]!.mem.total).toBe(totalmem());
    // One watch on one link: the same sample reaches both.
    expect(b[0]).toEqual(a[0]);
    detachA();
    const seenByA = a.length;
    detachB();
    // A new listener after the last left opens a watch of its own and is answered again.
    const c: SysSample[] = [];
    const detachC = await daemon.sysSamples(s => c.push(s));
    await waitForEvent(c as unknown as DaemonEvent[], "sys.sample");
    detachC();
    expect(a.length).toBe(seenByA);
  }, 20_000);

  it("runs a pty in the workspace folder", async () => {
    daemon = await startLocal();
    const link = daemon.link();
    await link.ready;
    const created = (await link.request("pty.create", { cwd: root })) as { ptyId: string; pid: number };
    expect(created.pid).toBeGreaterThan(0);
    const listed = (await link.request("pty.list")) as { ptys: { id: string }[] };
    expect(listed.ptys.map(p => p.id)).toContain(created.ptyId);
    link.close();
  });

  it("ends the process it spawned when closed, and takes its token folder with it", async () => {
    daemon = await startLocal();
    const pid = daemon.pid;
    await daemon.close();
    daemon = undefined;
    expect(alive(pid)).toBe(false);
    expect(readdirSync(tmpdir()).filter(name => name.startsWith("wsp-local-daemon-")).map(name => existsSync(join(tmpdir(), name, "token")) && alive(pid))).not.toContain(true);
  });

  it("the folder carries the pid of the process that removes it, and a start sweeps the folders of processes that are gone", async () => {
    // Seventeen of these sat under one Mac's temp dir, each holding a token: a host that is killed runs no close,
    // and nothing anywhere read a folder as a dead host's until the pid was in its own name.
    const at = join(root, "tmp");
    mkdirSync(at, { recursive: true });
    vi.stubEnv("TMPDIR", at);
    const made = (name: string): string => {
      mkdirSync(join(at, name), { recursive: true });
      writeFileSync(join(at, name, "token"), "0123456789abcdef\n");
      return name;
    };
    // A process this case started and waited out, so its pid is one nothing holds now.
    const gone = made(`wsp-local-daemon-${spawnSync(process.execPath, ["-e", "0"]).pid!}-x`);
    const live = made(`wsp-local-daemon-${process.pid}-y`);
    // The shape wsp wrote before the pid was in the name: nothing can say whose it is, so nothing takes it.
    const older = made("wsp-local-daemon-z");

    daemon = await startLocal();

    const own = readdirSync(at).filter(name => name.startsWith("wsp-local-daemon-") && ![live, older].includes(name));
    expect(own).toHaveLength(1);
    expect(own[0]!.startsWith(`wsp-local-daemon-${process.pid}-`)).toBe(true);
    expect([existsSync(join(at, gone)), existsSync(join(at, live)), existsSync(join(at, older))]).toEqual([false, true, true]);

    await daemon.close();
    daemon = undefined;
    expect([existsSync(join(at, own[0]!)), existsSync(join(at, live)), existsSync(join(at, older))]).toEqual([false, true, true]);
  });

  it("keeps the version off the hello the binary answered the first frame with, so every road that runs it reads what it is", async () => {
    daemon = await startLocal();
    // The binary in this checkout is the one this wsp deploys; a staged binary older than it is the case below.
    expect(daemon.version).toBe(DAEMON_VERSION);
  });

  it("reads the version off a binary of any age, since the hello is the one word a stale one still says", async () => {
    const bin = fakeDaemon(root, 50);
    daemon = await startLocal({ binary: bin });
    expect(daemon.version).toBe(50);
  });

  it("stops a binary that listens and answers no hello, and refuses it in one sentence naming what it said", async () => {
    const bin = fakeDaemon(root);
    await expect(startLocal({ binary: bin })).rejects.toThrow(/did not answer its version within \d+ ms: nothing of a hello/);
    // Nothing of it is left running: a daemon this host cannot read is no daemon it holds.
    const pids = readdirSync(root).filter(name => name.startsWith("fake-daemon-pid"));
    expect(pids).toHaveLength(1);
    for (const name of pids) expect(alive(Number(readFileSync(join(root, name), "utf8").trim()))).toBe(false);
    // The bound is the start's own, so this case waits it out.
  }, 20_000);

  it("names the binary and what it said when it does not start, and leaves no child behind", async () => {
    const bin = join(root, "not-a-daemon.sh");
    writeFileSync(bin, "#!/bin/sh\necho refusing >&2\nexit 3\n", { mode: 0o755 });
    await expect(startLocal({ binary: bin })).rejects.toThrow(/exited with 3 before it listened: refusing/);
  });

  it("hands what the binary says on its own stderr to the sink the caller named, a line at a time, and writes none of it itself", async () => {
    const noise = ["oom_score_adj not set: No such file or directory (os error 2)", "priority not set: Permission denied (os error 13)"];
    const said: string[] = [];
    const wrote: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      wrote.push(String(chunk));
      return true;
    });
    try {
      daemon = await startLocal({ binary: fakeDaemon(root, 54, noise), say: line => void said.push(line) });
    } finally {
      spy.mockRestore();
    }
    expect(said).toEqual(noise);
    expect(wrote.join("")).not.toContain("oom_score_adj");
  }, 20_000);

  it("writes them to this process's own stderr where the caller named no sink, which is a serving host's log", async () => {
    const wrote: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      wrote.push(String(chunk));
      return true;
    });
    try {
      daemon = await startLocal({ binary: fakeDaemon(root, 54, ["priority not set: Permission denied (os error 13)"]) });
    } finally {
      spy.mockRestore();
    }
    expect(wrote.join("")).toContain("priority not set: Permission denied (os error 13)");
  }, 20_000);

  it("a start that fails still carries what the binary said in its own sentence, whichever sink the lines went to", async () => {
    const bin = join(root, "noisy-refusal.sh");
    writeFileSync(bin, "#!/bin/sh\necho refusing >&2\nexit 3\n", { mode: 0o755 });
    const said: string[] = [];
    await expect(startLocal({ binary: bin, say: line => void said.push(line) })).rejects.toThrow(/exited with 3 before it listened: refusing/);
    expect(said).toEqual(["refusing"]);
  });
});
