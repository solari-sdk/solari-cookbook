// SPDX-License-Identifier: AGPL-3.0-only
// The forward a host holds for a computer that cannot reach it: made again
// after it ends, moved to a fresh port when the box still holds the old one,
// and cut where sshd put it beyond the box's own loopback. Every ssh child
// here is a fake; the place file rewrite runs in a real bash on this computer.
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeDaemonPaths, placeFileText, type PlaceBack } from "@wsp/protocol";
import { keyFingerprint, type HeldChild, type SshCarried, type SshTransport } from "@wsp/engine";
import { backBindLine, backBindScript, backBinds, backNoDoorLine, backNoHostLine, backTakenLine, heldPlaceScript, placeBackHolder } from "../src/place-back.js";

/** Waits for a condition the holder reaches on its own, on the loop's own turns. */
const until = (ok: () => boolean): Promise<void> => vi.waitFor(() => expect(ok()).toBe(true), { timeout: 5_000, interval: 5 });

const HOST_KEY = "dGhpcyBob3N0";
const LOGIN = { ssh: "root@spoo" };
const AT_DOOR: PlaceBack = { boxPort: 4640 };
const SSHD = ' users:(("sshd",pid=4242,fd=9))';

/** A child that never leaves this process: the test says what ssh wrote and when it ended. */
function fakeChild(): { child: HeldChild; stdout: PassThrough; stderr: PassThrough; stdinEnded: () => boolean; exit: (code: number | null, signal?: string) => void } {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let ended = false;
  stdin.on("finish", () => (ended = true));
  stdin.resume();
  const child: HeldChild = {
    stdin,
    stdout,
    stderr,
    kill: signal => {
      setImmediate(() => events.emit("exit", null, signal ?? "SIGTERM"));
      return true;
    },
    once: (event: string, fn: Parameters<EventEmitter["once"]>[1]) => events.once(event, fn),
  };
  return { child, stdout, stderr, stdinEnded: () => ended, exit: (code, signal) => events.emit("exit", code, signal ?? null) };
}

/** Every child the holder starts, with the -R it asked for, in order. */
function spawner(): { spawn: (file: string, args: readonly string[]) => HeldChild; started: { forward: string; fake: ReturnType<typeof fakeChild> }[] } {
  const started: { forward: string; fake: ReturnType<typeof fakeChild> }[] = [];
  return {
    started,
    spawn: (_file, args) => {
      const fake = fakeChild();
      started.push({ forward: args[args.indexOf("-R") + 1]!, fake });
      return fake.child;
    },
  };
}

const carry = async (reach: { user: string; host: string; port: number }): Promise<SshCarried> => ({ reach, options: [] });

/** The box's answer to the bind read, by port; everything else it is asked runs in a real bash on this computer,
 * which is where the place file of the test's box lives. */
function box(binds: (port: number) => string[]): { transport: SshTransport; ran: string[] } {
  const ran: string[] = [];
  const transport: SshTransport = async (_reach, script, opts) => {
    ran.push(script);
    const bind = /sport = :(\d+)/.exec(script);
    if (bind !== null && script === backBindScript(Number(bind[1]))) return { exitCode: 0, stdout: binds(Number(bind[1])).map(at => `WSP_BIND ${at}\n`).join(""), stderr: "" };
    return new Promise(done => {
      const child = execFile("/bin/bash", ["-c", script], (error, stdout, stderr) => done({ exitCode: error === null ? 0 : Number(error.code ?? 1), stdout, stderr }));
      child.stdin?.end(opts.stdin === undefined ? undefined : Buffer.from(opts.stdin));
    });
  };
  return { transport, ran };
}

const loopback = (port: number): string[] => [`127.0.0.1:${port}${SSHD}`];

/** A holder on a host whose door stands at 4640 unless the test says otherwise. */
function holderAt(deps: Parameters<typeof placeBackHolder>[0], door: () => Promise<number | undefined> = async () => 4640): ReturnType<typeof placeBackHolder> {
  const holder = placeBackHolder(deps);
  holder.door(door);
  return holder;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A box's home holding a place file that names this host, dialling the relay and then the forward at 4640. */
function placeHome(hostPublicKey = HOST_KEY): string {
  const home = mkdtempSync(join(tmpdir(), "wsp-back-"));
  homes.push(home);
  const path = placeDaemonPaths(home).placeFile;
  mkdirSync(join(path, ".."), { recursive: true });
  const file = { placeId: "p_1", name: "spoo", hostName: "studio", hostUrls: ["https://relay.example", "http://127.0.0.1:4640"], hostPublicKey, keyPath: `${home}/.wsp/place.key`, joinedAt: "2026-09-24T10:00:00Z" };
  writeFileSync(path, placeFileText(file), { mode: 0o600 });
  return home;
}

describe("the forward a host holds back from a computer", () => {
  it("stands at the door's own port, reads where sshd bound it, and is made again after it ends", async () => {
    const children = spawner();
    const { transport, ran } = box(loopback);
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5 });
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stdout.write("WSP_BACK_UP\n");
    await expect(first).resolves.toEqual(AT_DOOR);
    expect(children.started[0]!.forward).toBe("127.0.0.1:4640:127.0.0.1:4640");
    expect(ran).toEqual([backBindScript(4640)]);
    children.started[0]!.fake.stderr.write("Timeout, server spoo not responding.\n");
    children.started[0]!.fake.exit(255);
    await until(() => children.started.length === 2);
    expect(children.started[1]!.forward).toBe("127.0.0.1:4640:127.0.0.1:4640");
    holder.close();
  });

  it("takes a fresh port when the box still holds the old one, and writes it into the place file at its mode before saying so", async () => {
    const home = placeHome();
    const children = spawner();
    const { transport } = box(loopback);
    const moved: PlaceBack[] = [];
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5, pickPort: () => 23456 });
    const first = holder.hold(LOGIN, AT_DOOR, { home }, to => moved.push(to));
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stdout.write("WSP_BACK_UP\n");
    await first;
    // The Mac slept: the session died, and sshd on the box still holds the dead one's listener.
    children.started[0]!.fake.exit(255);
    await until(() => children.started.length === 2);
    children.started[1]!.fake.stderr.write("Error: remote port forwarding failed for listen port 4640\n");
    children.started[1]!.fake.exit(255);
    await until(() => children.started.length === 3);
    expect(children.started[2]!.forward).toBe("127.0.0.1:23456:127.0.0.1:4640");
    children.started[2]!.fake.stdout.write("WSP_BACK_UP\n");
    await until(() => moved.length === 1);
    expect(moved).toEqual([{ boxPort: 23456 }]);
    const path = placeDaemonPaths(home).placeFile;
    expect(JSON.parse(readFileSync(path, "utf8")).hostUrls).toEqual(["https://relay.example", "http://127.0.0.1:23456"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // A second hold of the same login is the record taking it over: it answers where the forward stands now.
    await expect(holder.hold(LOGIN, AT_DOOR, { home })).resolves.toEqual({ boxPort: 23456 });
    holder.close();
  });

  it("leaves a place file that names another wsp as it was", async () => {
    const home = placeHome("c3R1ZGlv");
    const before = readFileSync(placeDaemonPaths(home).placeFile, "utf8");
    const children = spawner();
    const { transport, ran } = box(loopback);
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5, pickPort: () => 23456 });
    const first = holder.hold(LOGIN, AT_DOOR, { home });
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stderr.write("Error: remote port forwarding failed for listen port 4640\n");
    children.started[0]!.fake.exit(255);
    await until(() => children.started.length === 2);
    children.started[1]!.fake.stdout.write("WSP_BACK_UP\n");
    await expect(first).resolves.toEqual({ boxPort: 23456 });
    expect(ran).toContain(heldPlaceScript(home));
    expect(readFileSync(placeDaemonPaths(home).placeFile, "utf8")).toBe(before);
    holder.close();
  });

  it("cuts a forward sshd put beyond the box's loopback and never makes it again", async () => {
    const children = spawner();
    const { transport } = box(port => [`0.0.0.0:${port}${SSHD}`, `[::]:${port}${SSHD}`]);
    const said: string[] = [];
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, spawn: children.spawn, transport, waitMs: () => 5, log: (line: string) => said.push(line) });
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stdout.write("WSP_BACK_UP\n");
    await expect(first).rejects.toThrow(backBindLine("root@spoo", "0.0.0.0"));
    await until(() => children.started[0]!.fake.stdinEnded());
    await new Promise(r => setTimeout(r, 50));
    expect(children.started).toHaveLength(1);
    expect(said).toEqual([backBindLine("root@spoo", "0.0.0.0")]);
    expect(backBindLine("root@spoo", "0.0.0.0")).toBe(
      "root@spoo's sshd put the forward back to this computer on 0.0.0.0, beyond its own loopback, so wsp cut it; set GatewayPorts to clientspecified or no in its sshd_config, or link this host to your relay",
    );
  });

  it("cuts a forward whose bind the box would not show", async () => {
    const children = spawner();
    const { transport } = box(() => []);
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5 });
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stdout.write("WSP_BACK_UP\n");
    await expect(first).rejects.toThrow(backBindLine("root@spoo", undefined));
  });

  it("ends a child whose up line never comes at the bound", async () => {
    const children = spawner();
    const { transport } = box(loopback);
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 60_000, upMs: 30 });
    await expect(holder.hold(LOGIN, AT_DOOR, { home: "/root" })).rejects.toThrow("root@spoo did not stand the forward back to this computer within");
    await until(() => children.started[0]!.fake.stdinEnded());
    holder.release(LOGIN);
  });

  it("makes nothing again once released, and close releases every one", async () => {
    const children = spawner();
    const { transport } = box(loopback);
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5 });
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    const second = holder.hold({ ssh: "root@other" }, AT_DOOR, { home: "/root" });
    await until(() => children.started.length === 2);
    for (const { fake } of children.started) fake.stdout.write("WSP_BACK_UP\n");
    await Promise.all([first, second]);
    holder.release(LOGIN);
    await until(() => children.started[0]!.fake.stdinEnded());
    expect(children.started[1]!.fake.stdinEnded()).toBe(false);
    holder.close();
    await until(() => children.started[1]!.fake.stdinEnded());
    await new Promise(r => setTimeout(r, 50));
    expect(children.started).toHaveLength(2);
  });
});

describe("the door a forward lands on", () => {
  it("stands nothing until the host hands over its door, then lands on the door as it stands", async () => {
    const children = spawner();
    const { transport } = box(loopback);
    const holder = placeBackHolder({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5 });
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    await new Promise(r => setTimeout(r, 50));
    expect(children.started).toHaveLength(0);
    holder.door(async () => 4700);
    await until(() => children.started.length === 1);
    expect(children.started[0]!.forward).toBe("127.0.0.1:4640:127.0.0.1:4700");
    children.started[0]!.fake.stdout.write("WSP_BACK_UP\n");
    await expect(first).resolves.toEqual(AT_DOOR);
    holder.close();
  });

  it("refuses a hold in one sentence at the bound where no host hands a door, and stands once one does", async () => {
    const children = spawner();
    const { transport } = box(loopback);
    const said: string[] = [];
    const holder = placeBackHolder({ hostKey: keyFingerprint(HOST_KEY), carry, log: line => said.push(line), spawn: children.spawn, transport, waitMs: () => 5, upMs: 30 });
    await expect(holder.hold(LOGIN, AT_DOOR, { home: "/root" })).rejects.toThrow(backNoHostLine("root@spoo"));
    expect(backNoHostLine("root@spoo").split(". ")).toHaveLength(1);
    expect(children.started).toHaveLength(0);
    holder.door(async () => 4700);
    await until(() => children.started.length === 1);
    expect(said).toEqual([]);
    holder.close();
  });

  it("settles a hold still waiting for the door once it is released", async () => {
    const children = spawner();
    const { transport } = box(loopback);
    const holder = placeBackHolder({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5 });
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    holder.release(LOGIN);
    await expect(Promise.race([first, new Promise((_, fail) => setTimeout(() => fail(new Error("still pending")), 200))])).rejects.toThrow("the forward back from root@spoo was let go");
    holder.door(async () => 4700);
    await new Promise(r => setTimeout(r, 50));
    expect(children.started).toHaveLength(0);
  });

  it("holds nothing on a host with no door of its own", async () => {
    const children = spawner();
    const { transport } = box(loopback);
    const said: string[] = [];
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: line => said.push(line), spawn: children.spawn, transport, waitMs: () => 5 }, async () => undefined);
    await expect(holder.hold(LOGIN, AT_DOOR, { home: "/root" })).rejects.toThrow(backNoDoorLine("root@spoo"));
    await new Promise(r => setTimeout(r, 50));
    expect(children.started).toHaveLength(0);
    expect(said).toEqual([backNoDoorLine("root@spoo")]);
  });

  it("follows the door to its new port at the next standing and never falls back to the old one while the door refuses", async () => {
    const children = spawner();
    const { transport } = box(loopback);
    const moved: PlaceBack[] = [];
    let door: () => Promise<number> = async () => 4640;
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5 }, () => door());
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" }, to => moved.push(to));
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stdout.write("WSP_BACK_UP\n");
    await first;
    let asked = 0;
    door = async () => {
      asked += 1;
      if (asked < 3) throw new Error("port 4640 is held by another program");
      return 4655;
    };
    children.started[0]!.fake.exit(255);
    await until(() => children.started.length === 2);
    expect(asked).toBe(3);
    expect(children.started[1]!.forward).toBe("127.0.0.1:4640:127.0.0.1:4655");
    children.started[1]!.fake.stdout.write("WSP_BACK_UP\n");
    await new Promise(r => setTimeout(r, 30));
    // The box dials its own loopback port, which did not move: nothing on the box or in the record changes.
    expect(moved).toEqual([]);
    holder.close();
  });
});

describe("a listener on the forward's port that is not sshd's", () => {
  it("counts as the port being taken: a fresh port, not a cut", async () => {
    const home = placeHome();
    const children = spawner();
    const { transport } = box(port => (port === 4640 ? [`127.0.0.1:4640${SSHD}`, "203.0.113.9:4640", '[::]:4640 users:(("nginx",pid=77,fd=6))'] : loopback(port)));
    const moved: PlaceBack[] = [];
    const said: string[] = [];
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: line => said.push(line), spawn: children.spawn, transport, waitMs: () => 5, pickPort: () => 23456 });
    const first = holder.hold(LOGIN, AT_DOOR, { home }, to => moved.push(to));
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stdout.write("WSP_BACK_UP\n");
    await until(() => children.started.length === 2);
    await until(() => children.started[0]!.fake.stdinEnded());
    expect(children.started[1]!.forward).toBe("127.0.0.1:23456:127.0.0.1:4640");
    children.started[1]!.fake.stdout.write("WSP_BACK_UP\n");
    await expect(first).resolves.toEqual({ boxPort: 23456 });
    expect(moved).toEqual([{ boxPort: 23456 }]);
    expect(said).toEqual([]);
    holder.close();
  });

  it("a wide listener the box names no owner for is taken too, and two taken ports are a try that failed, not a stop", async () => {
    const children = spawner();
    const { transport } = box(port => [`0.0.0.0:${port}`]);
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5, pickPort: () => 23456 });
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stdout.write("WSP_BACK_UP\n");
    await until(() => children.started.length === 2);
    children.started[1]!.fake.stdout.write("WSP_BACK_UP\n");
    await expect(first).rejects.toThrow(backTakenLine("root@spoo", 23456));
    await until(() => children.started.length === 3);
    holder.close();
  });
});

describe("a box without ss", () => {
  it("stops for good on a wide bind /proc/net/tcp shows, with the sshd_config sentence, since it names no owner", async () => {
    const children = spawner();
    const inner = box(loopback);
    const transport: SshTransport = async (reach, script, opts) =>
      script === backBindScript(4640) ? { exitCode: 0, stdout: "WSP_BINDHEX 0100007F:1220\nWSP_BINDHEX 00000000:1220\n", stderr: "" } : inner.transport(reach, script, opts);
    const said: string[] = [];
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: line => said.push(line), spawn: children.spawn, transport, waitMs: () => 5, pickPort: () => 23456 });
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stdout.write("WSP_BACK_UP\n");
    await expect(first).rejects.toThrow(backBindLine("root@spoo", "0.0.0.0"));
    await new Promise(r => setTimeout(r, 30));
    expect(children.started).toHaveLength(1);
    expect(children.started[0]!.fake.stdinEnded()).toBe(true);
    expect(said).toEqual([backBindLine("root@spoo", "0.0.0.0")]);
    holder.close();
  });
});

describe("a release while the forward is moving", () => {
  it("writes nothing into the place file and says no move", async () => {
    const home = placeHome();
    const before = readFileSync(placeDaemonPaths(home).placeFile, "utf8");
    const children = spawner();
    const inner = box(loopback);
    let reading!: () => void;
    const read = new Promise<void>(r => (reading = r));
    let answer!: () => void;
    const answered = new Promise<void>(r => (answer = r));
    const transport: SshTransport = async (reach, script, opts) => {
      if (script === backBindScript(23456)) {
        reading();
        await answered;
      }
      return inner.transport(reach, script, opts);
    };
    const moved: PlaceBack[] = [];
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 5, pickPort: () => 23456 });
    const first = holder.hold(LOGIN, AT_DOOR, { home }, to => moved.push(to));
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stderr.write("Error: remote port forwarding failed for listen port 4640\n");
    children.started[0]!.fake.exit(255);
    await until(() => children.started.length === 2);
    children.started[1]!.fake.stdout.write("WSP_BACK_UP\n");
    await read;
    holder.release(LOGIN);
    answer();
    await expect(first).rejects.toThrow();
    await new Promise(r => setTimeout(r, 30));
    expect(moved).toEqual([]);
    expect(inner.ran).not.toContain(heldPlaceScript(home));
    expect(readFileSync(placeDaemonPaths(home).placeFile, "utf8")).toBe(before);
    expect(children.started[1]!.fake.stdinEnded()).toBe(true);
  });
});

describe("a login held twice and a log that repeats", () => {
  it("a second hold after a failed first try answers the next try, not the stale failure", async () => {
    const children = spawner();
    const { transport } = box(loopback);
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: () => {}, spawn: children.spawn, transport, waitMs: () => 60_000 });
    const first = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    await until(() => children.started.length === 1);
    children.started[0]!.fake.stderr.write("ssh: connect to host spoo port 22: Connection refused\n");
    children.started[0]!.fake.exit(255);
    await expect(first).rejects.toThrow("Connection refused");
    const again = holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    await until(() => children.started.length === 2);
    children.started[1]!.fake.stdout.write("WSP_BACK_UP\n");
    await expect(again).resolves.toEqual(AT_DOOR);
    holder.close();
  });

  it("says a drop once per reason, not once per remake", async () => {
    const children = spawner();
    const { transport } = box(loopback);
    const said: string[] = [];
    const holder = holderAt({ hostKey: keyFingerprint(HOST_KEY), carry, log: line => said.push(line), spawn: children.spawn, transport, waitMs: () => 5 });
    void holder.hold(LOGIN, AT_DOOR, { home: "/root" });
    for (let n = 0; n < 4; n += 1) {
      await until(() => children.started.length === n + 1);
      children.started[n]!.fake.stdout.write("WSP_BACK_UP\n");
      await new Promise(r => setTimeout(r, 10));
      children.started[n]!.fake.stderr.write(n % 2 === 0 ? "Host is down\n" : "No route to host\n");
      children.started[n]!.fake.exit(255);
    }
    await until(() => children.started.length === 5);
    expect(said).toHaveLength(2);
    holder.close();
  });
});

describe("what the box wrote, inside a sentence of ours", () => {
  it("loses its control characters and never pushes the fix off the end", () => {
    const line = backBindLine("root@spoo", `\x1b]0;pwned\x07${"A".repeat(400)}`);
    expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).toContain("set GatewayPorts to clientspecified or no in its sshd_config, or link this host to your relay");
    const long = backBindLine(`${"u".repeat(255)}@spoo`, "0.0.0.0");
    expect(long).toContain("or link this host to your relay");
  });
});

describe("where the box says the forward listens", () => {
  it("reads ss's addresses and /proc/net/tcp's hex, for the port asked about alone", () => {
    const said = [
      "WSP_BIND 127.0.0.1:4640",
      "WSP_BIND [::1]:4640",
      "WSP_BIND 127.0.0.1%lo:4640",
      "WSP_BIND *:4640",
      "WSP_BIND 0.0.0.0:22",
      "WSP_BINDHEX 0100007F:1220",
      "WSP_BINDHEX 00000000:1220",
      "WSP_BINDHEX 00000000000000000000000001000000:1220",
      "WSP_BINDHEX 0000000000000000FFFF00000100007F:1220",
      "WSP_BINDHEX 00000000000000000000000000000000:1220",
      "WSP_BINDHEX 0100007F:0016",
    ].join("\n");
    expect(backBinds(said, 4640).map(b => b.at)).toEqual(["127.0.0.1", "::1", "127.0.0.1", "*", "127.0.0.1", "0.0.0.0", "::1", "127.0.0.1", "0000:0000:0000:0000:0000:0000:0000:0000"]);
    expect(backBinds(said, 4640).some(b => b.sshd)).toBe(false);
  });

  it("names sshd the owner only where ss says so", () => {
    const said = ['WSP_BIND 0.0.0.0:4640 users:(("sshd",pid=4242,fd=9))', 'WSP_BIND [::]:4640 users:(("sshd-session",pid=4242,fd=10))', 'WSP_BIND 0.0.0.0:4640 users:(("nginx",pid=7,fd=6))', "WSP_BIND 0.0.0.0:4640"].join("\n");
    expect(backBinds(said, 4640)).toEqual([
      { at: "0.0.0.0", sshd: true },
      { at: "::", sshd: true },
      { at: "0.0.0.0", sshd: false },
      { at: "0.0.0.0", sshd: false },
    ]);
  });

  it("the script itself runs in bash and prints nothing for a port nothing holds", async () => {
    const out = await new Promise<string>((done, fail) => execFile("/bin/bash", ["-c", backBindScript(1)], (error, stdout) => (error === null ? done(stdout) : fail(error))));
    expect(backBinds(out, 1)).toEqual([]);
  });
});
