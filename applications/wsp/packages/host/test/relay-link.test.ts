// SPDX-License-Identifier: AGPL-3.0-only
// The box's side of the relay: the device code flow that links it to a
// person's account, the tunnel it asks for at every start, the connector child
// it runs against its own loopback port, and the unlink that hands everything
// back. The relay here is a real http server in this process, so the requests,
// the headers and the refusals are real ones.
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIO } from "../src/cli.js";
import { addressLines } from "../src/host-lock.js";
import { aimedHost, dialWindowMs, hostsDir, readHost, writeHost } from "../src/hosts.js";
import { startConnector, type Connector } from "../src/connector.js";
import {
  BEAT_FLOOR_MS,
  accountHere,
  admittedDevices,
  hostsCommand,
  loginCommand,
  logoutCommand,
  publicHostname,
  readDeviceKeyPair,
  readRelayClient,
  readRelayRecord,
  reconcileAccountDevices,
  relayCommand,
  relayRecordPath,
  startRelay,
  writeRelayRecord,
  type RelayDeps,
  type RelayDeviceDoor,
} from "../src/relay-link.js";
import { CLOUDFLARED } from "../src/connector.js";
import type { DialOpts, HostClient } from "../src/verbs.js";
import { keyFingerprint, verifyPlaceBytes } from "@wsp/keys";
import { makeDevices, memoryStore } from "@wsp/runtime";
import { ADDRESS_NEXT_START, DEFAULT_RELAY, LOGIN_NO_KEY_REFUSAL, NOT_UP_YET, NO_HOSTS_LINE, deviceAdmissionTranscript, exitClassOf, type DeviceView } from "@wsp/protocol";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const io = (log: string[] = [], err: string[] = []): CliIO => ({ log: l => log.push(l), error: l => err.push(l), ask: noPrompt, askSecret: noPrompt });
/** Everything a line said, in the order it said it, for a case about which sentence comes first. */
const transcript = (said: string[]): CliIO => ({ log: l => said.push(l), error: l => said.push(l), ask: noPrompt, askSecret: noPrompt });

let dirs: string[] = [];
let servers: Server[] = [];
const closers: (() => Promise<void>)[] = [];

// A home of this run's own: what a host on this computer serves is read off the home directory, and the real one
// would make these cases say different things on different machines.
beforeEach(() => {
  const user = mkdtempSync(join(tmpdir(), "wsp-relay-user-"));
  dirs.push(user);
  vi.stubEnv("HOME", user);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of closers.splice(0)) await close();
  for (const server of servers) await new Promise<void>(done => server.close(() => done()));
  servers = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Whether a pid this test started is still there; a stop is asked for and the process goes a moment later. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${tag}-`));
  dirs.push(dir);
  return dir;
}

interface FakeRelay {
  url: string;
  /** Every request the box made: the line and the token it carried. */
  calls: { line: string; token?: string; body: Record<string, unknown> }[];
  /** How many polls answer pending before the person approves. */
  pending: number;
  /** What the tunnel route answers; a hostname of null is a relay with no zone. */
  tunnel: { tunnelToken: string | null; hostname: string | null; why?: string };
  /** What the approval says about who approved it; empty for a relay from before it named one. */
  login: { login?: string };
  hosts: { id: string; name: string; hostname: string | null; hostKey?: string | null; lastSeen?: string | null; connectorVersion?: string | null }[];
  clients: { id: string; name: string; thisOne: boolean; fingerprint?: string | null; admissions?: { by: string; issuedAt: string; signature: string }[] }[];
  /** Whether the heartbeat's reply carries a devices field at all: a relay from before the migration carries none,
   * and absent is unknown rather than empty. */
  saysDevices: boolean;
  /** Called as each request arrives, for a test that cares what was already true by then. */
  onCall?: (line: string) => void;
  /** A route answers this refusal instead, once armed. */
  refuse?: { status: number; error: string };
}

/** The one shape a box may report, as the Worker reads it (isQuickTunnel in infra/relay/src/env.ts). */
const isQuickTunnel = (name: string): boolean => /^[a-z0-9-]+\.trycloudflare\.com$/i.test(name);

async function fakeRelay(): Promise<FakeRelay> {
  const state: FakeRelay = { url: "", calls: [], pending: 1, login: { login: "zingzy" }, tunnel: { tunnelToken: null, hostname: null, why: "this relay has no zone" }, hosts: [], clients: [], saysDevices: true };
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const path = new URL(req.url ?? "/", "http://box").pathname;
      const line = `${req.method} ${path}`;
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      state.calls.push({ line, ...(token !== undefined ? { token } : {}), body });
      state.onCall?.(line);
      const send = (status: number, answer: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      };
      if (state.refuse !== undefined && !line.includes("/link/")) return send(state.refuse.status, { error: state.refuse.error });
      if (line === "POST /link/start") {
        // The Worker's own rule: a computer signing in names the key it will prove to the boxes, and a box's link
        // names none, since a box names its key on its heartbeat.
        const fingerprint = body["fingerprint"];
        if (body["kind"] === "client" && typeof fingerprint !== "string") return send(400, { error: "a sign-in starts with the fingerprint of this computer's device key, which wsp login sends; this wsp sent none" });
        if (body["kind"] === "host" && fingerprint !== undefined) return send(400, { error: "a box's link carries no fingerprint" });
        return send(200, { code: "ABCD2345", verifyUrl: `${state.url}/link/verify`, pollToken: "poll-token", expiresAt: new Date(Date.now() + 900_000).toISOString(), pollAfterMs: 1 });
      }
      if (line === "POST /link/approve") {
        // The road a wsp already in takes: its own token, the code and the admission it signed, which the relay
        // keeps and cannot make.
        const started = state.calls.filter(c => c.line === "POST /link/start").at(-1);
        return send(200, { approved: true, name: String(started?.body["name"] ?? "") });
      }
      if (/^POST \/clients\/[^/]+\/admissions$/.test(line)) return send(200, { recorded: true });
      if (line === "POST /hosts") {
        state.hosts.push({ id: "hbox1", name: String(body["name"] ?? ""), hostname: null, hostKey: typeof body["hostKey"] === "string" ? body["hostKey"] : null });
        return send(200, { hostId: "hbox1", name: String(body["name"] ?? ""), token: "host-token", ...state.login });
      }
      if (line === "POST /link/poll") {
        if (state.pending > 0) {
          state.pending -= 1;
          return send(200, { state: "pending" });
        }
        const started = state.calls.filter(c => c.line === "POST /link/start").at(-1);
        const kind = started?.body["kind"];
        const name = String(started?.body["name"] ?? "");
        if (kind === "client") return send(200, { state: "approved", token: "client-token", name, ...state.login });
        // The approval is what makes the box's row, as the Worker's own does, so a listing and a beat find it.
        if (!state.hosts.some(h => h.id === "hbox1")) state.hosts.push({ id: "hbox1", name, hostname: null, hostKey: null });
        return send(200, { state: "approved", token: "host-token", hostId: "hbox1", name, ...state.login });
      }
      if (line === "POST /hosts/hbox1/tunnel") return send(200, state.tunnel);
      if (line === "POST /hosts/hbox1/heartbeat") {
        // The Worker's own heartbeat rule (hostHeartbeat in infra/relay/src/hosts.ts), in the four parts a box can
        // tell apart: a name is lowercased, only the quick tunnel it was given is allowed, a row already holding a
        // managed name keeps it, and what is left is written onto the row a listing reads. A managed row here is one
        // whose name is not a quick tunnel's, since the zone the Worker derives that name from is the relay's own.
        const said = body["hostname"];
        const reported = typeof said === "string" && said !== "" ? said.toLowerCase() : undefined;
        if (reported !== undefined && !isQuickTunnel(reported)) {
          return send(400, { error: "a host may report the quick tunnel it was given and no other name; a managed hostname is the relay's own" });
        }
        const row = state.hosts.find(h => h.id === "hbox1");
        const managed = row !== undefined && row.hostname !== null && !isQuickTunnel(row.hostname);
        if (row !== undefined && reported !== undefined && !managed) row.hostname = reported;
        // The key is written once: a beat proving another is refused and nothing on that beat is written, which is
        // what a box whose state was wiped meets.
        const provedKey = body["hostKey"];
        if (row !== undefined && typeof provedKey === "string") {
          if (row.hostKey === null || row.hostKey === undefined) row.hostKey = provedKey;
          else if (row.hostKey !== provedKey) return send(409, { error: `${row.name} is on this account under the key ${row.hostKey}; take it off with wsp host unlink there and put it back on with wsp host link` });
        }
        // The account's own computers, with the admissions signed for them: the box verifies every signature
        // itself, with keys this relay does not hold. A computer holding no key is on no box's list.
        const devices = state.clients.flatMap(c => (typeof c.fingerprint === "string" ? [{ id: c.id, name: c.name, fingerprint: c.fingerprint, admissions: c.admissions ?? [] }] : []));
        return send(200, { ok: true, ...(state.saysDevices ? { devices } : {}) });
      }
      if (line === "GET /hosts") return send(200, { hosts: state.hosts });
      if (line === "GET /clients") return send(200, { clients: state.clients });
      if (line.startsWith("DELETE /clients/")) return send(200, { deleted: true });
      if (line === "DELETE /hosts/hbox1") return send(200, { deleted: true });
      return send(404, { error: `no route: ${line}` });
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  state.url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  return state;
}

/** A script that says what a quick tunnel says and then waits, so the connector under test is a real child. */
function fakeConnector(dir: string, hostname = "blue-sky-1234.trycloudflare.com"): string {
  const bin = join(dir, "fake-cloudflared");
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${join(dir, "argv")}"\n>&2 echo 'INF |  https://${hostname}  |'\nsleep 30\n`, { mode: 0o755 });
  return bin;
}

/** A connector handed a fresh quick tunnel name every time it runs, as cloudflared is: the first child prints one
 * and goes, the next prints another and stays. */
function restartingConnector(dir: string): string {
  const bin = join(dir, "restarting-cloudflared");
  const runs = join(dir, "runs");
  writeFileSync(
    bin,
    `#!/bin/sh\nn=$(cat "${runs}" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "${runs}"\n>&2 echo "INF |  https://name-$n.trycloudflare.com  |"\nif [ "$n" -ge 2 ]; then sleep 30; else exit 1; fi\n`,
    { mode: 0o755 },
  );
  return bin;
}

/** The connector, restarted fast enough for a test: the two seconds a real box waits are the box's constraint. */
function restarting(dir: string): Partial<RelayDeps> {
  return { cloudflared: async () => restartingConnector(dir), connector: opts => startConnector({ ...opts, restartMs: 20 }) };
}

function deps(dir: string, extra: Partial<RelayDeps> = {}): RelayDeps {
  return {
    fetch: (input, init) => fetch(input as string, init),
    now: () => Date.now(),
    // The half second the poll floor holds a real box to protects it from a relay that answers zero; a test that
    // sat through it would only be measuring the floor.
    sleep: () => Promise.resolve(),
    deviceName: () => "the box",
    cloudflared: async () => fakeConnector(dir),
    connector: startConnector,
    heartbeatMs: 40,
    ...extra,
  };
}

/** A host serving this computer's default home, as the launchd service is: a lock naming a live pid beside the
 * state file every line that names no home works on. Returns the state file that host serves. */
function servingStateHere(): string {
  const home = join(homedir(), ".wsp");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: 4400, wsPort: 4410, startedAt: new Date().toISOString() }));
  return join(home, "state.json");
}

/** A state folder with nothing in it, as a box that has never linked has. */
function box(): { statePath: string; dir: string; home: string } {
  const dir = tempDir("relay-state");
  return { statePath: join(dir, "state.json"), dir, home: tempDir("relay-home") };
}

describe("wsp host link", () => {
  it("prints the code, the page and what to type there, waits for the approval and keeps the token where only this user reads it", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    const log: string[] = [];
    expect(await relayCommand(io(log), { statePath, home }, ["link", relay.url], {}, deps(dir))).toBe(0);

    expect(log).toContain("code        ABCD2345");
    expect(log).toContain(`open        ${relay.url}/link/verify`);
    // The page asks for the code rather than reading it out of the address, so the line says what to type.
    expect(log).toContain("type        ABCD2345 on that page");
    expect(log.join("\n")).not.toContain("host-token");
    expect(relay.calls.map(c => c.line)).toEqual(["POST /link/start", "POST /link/poll", "POST /link/poll"]);
    expect(relay.calls[0]!.body).toMatchObject({ kind: "host", name: "the box" });

    const record = readRelayRecord(statePath)!;
    expect(record).toMatchObject({ relayUrl: relay.url, hostId: "hbox1", token: "host-token", name: "the box" });
    expect(statSync(relayRecordPath(statePath)).mode & 0o777).toBe(0o600);
  });

  it("takes the name to show the person from the line", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], { name: "attic" }, deps(dir));
    expect(relay.calls[0]!.body["name"]).toBe("attic");
    expect(readRelayRecord(statePath)!.name).toBe("attic");
  });

  it("names the state it wrote to, in the spelling wsp status uses", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    const log: string[] = [];
    await relayCommand(io(log), { statePath, home }, ["link", relay.url], {}, deps(dir));

    expect(log).toContain(`relay       ${relay.url}`);
    expect(log).toContain("host        the box");
    // The one spelling of the state line, so the link and wsp status never name it two ways.
    expect(log).toContain(addressLines(statePath, { port: 4400, wsPort: 4410 }).find(l => l.startsWith("state"))!);
  });

  it("says which state the host on this computer serves, and the --state that reaches it, before anything is written", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    const served = servingStateHere();
    const said: string[] = [];
    await relayCommand(transcript(said), { statePath, home }, ["link", relay.url], {}, deps(dir));

    const warned = said.findIndex(l => l.includes(served));
    expect(warned, said.join("\n")).toBeGreaterThanOrEqual(0);
    expect(said[warned]).toContain(`--state ${served}`);
    // Before the code goes up, so nothing is approved by somebody who has not read it.
    expect(warned).toBeLessThan(said.findIndex(l => l.includes("ABCD2345")));
  });

  it("says nothing about another state when the host on this computer is the one being linked", async () => {
    const relay = await fakeRelay();
    const home = tempDir("relay-home");
    const said: string[] = [];
    await relayCommand(transcript(said), { statePath: servingStateHere(), home }, ["link", relay.url], {}, deps(tempDir("relay-bin")));
    expect(said.join("\n")).not.toContain("--state");
  });

  it("refuses a second link over the first, and a line with no relay to link to", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    await expect(relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir))).rejects.toThrow(/unlink/);
    const fresh = box();
    await expect(relayCommand(io(), { statePath: fresh.statePath, home: fresh.home }, ["link"], {}, deps(fresh.dir))).rejects.toThrow(/address/);
  });
});

describe("a linked box starting up", () => {
  it("asks for a tunnel, runs the connector against its own loopback port and says where it landed", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    relay.calls.length = 0;

    const lines: string[] = [];
    const up = (await startRelay({ statePath, home, port: 4400, log: line => lines.push(line) }, deps(dir)))!;
    closers.push(() => up.close());
    const hostname = await up.hostname();

    expect(hostname).toBe("blue-sky-1234.trycloudflare.com");
    expect(readFileSync(join(dir, "argv"), "utf8").trim()).toBe("tunnel --no-autoupdate --url http://127.0.0.1:4400");
    expect(lines.join("\n")).toContain("public      https://blue-sky-1234.trycloudflare.com");
    const asked = relay.calls.find(c => c.line === "POST /hosts/hbox1/tunnel")!;
    expect(asked.token).toBe("host-token");
    expect(asked.body).toEqual({ port: 4400 });
    // The hostname a quick tunnel handed out is the box's to report: the relay learns it from the heartbeat.
    await vi.waitUntil(() => relay.calls.some(c => c.line === "POST /hosts/hbox1/heartbeat" && c.body["hostname"] === hostname), { timeout: 4000 });
    expect(readRelayRecord(statePath)!.hostname).toBe(hostname);
  });

  it("says which connector is carrying it, not which wsp asked", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const up = (await startRelay({ statePath, home, port: 4400, log: () => {} }, deps(dir)))!;
    closers.push(() => up.close());
    await up.hostname();
    const beat = await vi.waitUntil(() => relay.calls.find(c => c.line === "POST /hosts/hbox1/heartbeat"), { timeout: 4000 });
    expect(beat.body["version"]).toBe(CLOUDFLARED.version);
  });

  it("names the public address only while a connector this computer started is carrying it", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const up = (await startRelay({ statePath, home, port: 4400, log: () => {} }, deps(dir)))!;
    closers.push(() => up.close());
    const hostname = await up.hostname();
    expect(publicHostname(statePath)).toBe(hostname);

    // wsp status and wsp host pair read this: with the connector stopped, the name in the record serves nothing.
    await up.close();
    expect(publicHostname(statePath)).toBeUndefined();
  });

  it("keeps saying it is there", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const up = (await startRelay({ statePath, home, port: 4400, log: () => {} }, deps(dir)))!;
    closers.push(() => up.close());
    await vi.waitUntil(() => relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat").length >= 2, { timeout: 4000 });
  });

  it("runs the managed tunnel by its token when the relay had a hostname to give", async () => {
    const relay = await fakeRelay();
    relay.tunnel = { tunnelToken: "tunnel-token", hostname: "hbox1.boxes.example" };
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const lines: string[] = [];
    const up = (await startRelay({ statePath, home, port: 4400, log: line => lines.push(line) }, deps(dir)))!;
    closers.push(() => up.close());

    expect(await up.hostname()).toBe("hbox1.boxes.example");
    // The relay already holds the managed name, so the heartbeat carries none: one that named it would be refused
    // and the box would never read as up.
    const beat = await vi.waitUntil(() => relay.calls.find(c => c.line === "POST /hosts/hbox1/heartbeat"), { timeout: 4000 });
    expect(beat.body).toEqual({ version: CLOUDFLARED.version, hostKey: expect.stringMatching(/^SHA256:/) });
    expect(lines.join("\n")).not.toContain("could not say where this host is");
    await vi.waitUntil(() => existsSync(join(dir, "argv")) && readFileSync(join(dir, "argv"), "utf8").trim() !== "", { timeout: 4000 });
    expect(readFileSync(join(dir, "argv"), "utf8").trim()).toBe("tunnel --no-autoupdate run");
    expect(lines.join("\n")).toContain("public      https://hbox1.boxes.example");
    expect(lines.join("\n")).not.toContain("tunnel-token");
    expect(readRelayRecord(statePath)!.hostname).toBe("hbox1.boxes.example");
  });

  it("reports the fresh name a restarted quick tunnel was given, and is listed under it", async () => {
    const relay = await fakeRelay();
    relay.hosts = [{ id: "hbox1", name: "the box", hostname: null }];
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));

    const lines: string[] = [];
    const up = (await startRelay({ statePath, home, port: 4400, log: line => lines.push(line) }, deps(dir, restarting(dir))))!;
    closers.push(() => up.close());
    expect(await up.hostname()).toBe("name-1.trycloudflare.com");

    // The first child goes and the next is given another name; nothing else tells the relay the old one is dead.
    await vi.waitUntil(() => readRelayRecord(statePath)!.hostname === "name-2.trycloudflare.com", { timeout: 4000 });
    await vi.waitUntil(() => relay.calls.some(c => c.line === "POST /hosts/hbox1/heartbeat" && c.body["hostname"] === "name-2.trycloudflare.com"), { timeout: 4000 });
    expect(lines.join("\n")).toContain("public      https://name-2.trycloudflare.com");

    relay.pending = 1;
    const listed: string[] = [];
    expect(await loginCommand(io(), { statePath, home }, relay.url, deps(dir))).toBe(0);
    expect(await hostsCommand(io(listed), { statePath, home }, deps(dir))).toBe(0);
    expect(listed.join("\n")).toContain("https://name-2.trycloudflare.com");
    expect(listed.join("\n")).not.toContain("name-1.trycloudflare.com");
  });

  it("sends no hostname when a managed tunnel's connector restarts, whatever the child prints", async () => {
    const relay = await fakeRelay();
    relay.tunnel = { tunnelToken: "tunnel-token", hostname: "hbox1.boxes.example" };
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));

    const lines: string[] = [];
    const up = (await startRelay({ statePath, home, port: 4400, log: line => lines.push(line) }, deps(dir, restarting(dir))))!;
    closers.push(() => up.close());
    expect(await up.hostname()).toBe("hbox1.boxes.example");

    // A managed name is the relay's own: it does not change when the child does, and a box that reported one back
    // would be refused and never read as up. This child prints a quick tunnel's line at every start regardless.
    await vi.waitUntil(() => existsSync(join(dir, "runs")) && Number(readFileSync(join(dir, "runs"), "utf8").trim()) >= 2, { timeout: 4000 });
    await vi.waitUntil(() => relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat").length >= 2, { timeout: 4000 });
    for (const beat of relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat")) expect(beat.body).toEqual({ version: CLOUDFLARED.version, hostKey: expect.stringMatching(/^SHA256:/) });
    expect(readRelayRecord(statePath)!.hostname).toBe("hbox1.boxes.example");
    expect(lines.join("\n")).not.toContain("trycloudflare.com");
    expect(lines.join("\n")).not.toContain("could not say where this host is");
  });

  it("puts no record back when a name arrives after the unlink took it away", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));

    // The one moment the guard is for: the record is cleared while a connector child is still coming up, so the
    // name it prints arrives with nothing left on disk to write it into. The connector is a stand-in here, since a
    // child started for a box that has been unlinked is exactly what must not happen.
    let arrived: ((hostname: string) => void) | undefined;
    const stub: Connector = { pid: undefined, hostname: async () => undefined, stop: async () => {} };
    const lines: string[] = [];
    const up = (await startRelay(
      { statePath, home, port: 4400, log: line => lines.push(line) },
      deps(dir, {
        connector: opts => {
          arrived = opts.onHostname;
          return stub;
        },
      }),
    ))!;
    closers.push(() => up.close());

    expect(await relayCommand(io(), { statePath, home }, ["unlink"], {}, deps(dir))).toBe(0);
    expect(existsSync(relayRecordPath(statePath))).toBe(false);
    relay.calls.length = 0;

    arrived!("late-name-9.trycloudflare.com");
    await new Promise(done => setTimeout(done, 100));
    // The file itself, not what readRelayRecord makes of it: a record put back holding a hostname alone is one the
    // reader rejects, so a box would read as never linked and the file would sit there with nothing to clear it.
    expect(existsSync(relayRecordPath(statePath))).toBe(false);
    expect(lines.join("\n")).not.toContain("late-name-9");
    expect(relay.calls.some(c => c.body["hostname"] === "late-name-9.trycloudflare.com")).toBe(false);
  });

  it("starts nothing at all on a box that never linked", async () => {
    const { statePath, home, dir } = box();
    expect(await startRelay({ statePath, home, port: 4400, log: () => {} }, deps(dir))).toBeUndefined();
  });

  it("leaves the host running when the relay is down, and says so once", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    relay.refuse = { status: 500, error: "the relay fell over" };
    const lines: string[] = [];
    expect(await startRelay({ statePath, home, port: 4400, log: line => lines.push(line) }, deps(dir))).toBeUndefined();
    expect(lines.join("\n")).toContain("relay");
    expect(existsSync(join(dir, "argv"))).toBe(false);
  });
});

describe("wsp host unlink", () => {
  it("takes the host off the relay, stops the connector it started and forgets the token", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const up = (await startRelay({ statePath, home, port: 4400, log: () => {} }, deps(dir)))!;
    await up.hostname();
    const pid = Number(readFileSync(join(dir, "connector.pid"), "utf8").trim());

    // The tunnel cannot be deleted while its connector still holds connections, so the child goes first.
    let childAtDelete: boolean | undefined;
    relay.onCall = line => {
      if (line === "DELETE /hosts/hbox1") childAtDelete = alive(pid);
    };
    const log: string[] = [];
    expect(await relayCommand(io(log), { statePath, home }, ["unlink"], {}, deps(dir))).toBe(0);
    expect(relay.calls.some(c => c.line === "DELETE /hosts/hbox1" && c.token === "host-token")).toBe(true);
    expect(childAtDelete).toBe(false);
    expect(readRelayRecord(statePath)).toBeUndefined();
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
    await vi.waitUntil(() => !alive(pid), { timeout: 4000 });
    // The host is still running, and it is what would start another connector; with the record gone it starts none.
    await new Promise(done => setTimeout(done, 300));
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
    await up.close();
  });

  it("forgets the token even when the relay refuses, and says what is left to do", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    relay.refuse = { status: 401, error: "that token does not name this host" };
    const err: string[] = [];
    expect(await relayCommand(io([], err), { statePath, home }, ["unlink"], {}, deps(dir))).toBe(0);
    expect(readRelayRecord(statePath)).toBeUndefined();
    expect(err.join("\n")).toContain("that token does not name this host");
  });

  it("says there is nothing to unlink on a box that never linked", async () => {
    const { statePath, home, dir } = box();
    await expect(relayCommand(io(), { statePath, home }, ["unlink"], {}, deps(dir))).rejects.toThrow(/wsp host link/);
  });
});

describe("wsp login", () => {
  it("mints this computer's key once, sends its fingerprint, prints the word and both roads to approve it, and keeps the token", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    const log: string[] = [];
    expect(await loginCommand(io(log), { statePath, home }, relay.url, deps(dir))).toBe(0);

    const pair = readDeviceKeyPair(home)!;
    const fingerprint = keyFingerprint(pair.publicKey);
    expect(statSync(join(home, "device-key.json")).mode & 0o777).toBe(0o600);
    // The key goes up with the name, so the page can show it and an approval can be signed for it.
    expect(relay.calls[0]!.body).toMatchObject({ kind: "client", name: "the box", fingerprint });
    // The word carries the code and the key as one string, and the bare code is what the page's field takes.
    expect(log).toContain(`word        ABCD-2345.${fingerprint}`);
    expect(log).toContain("code        ABCD2345");
    expect(log).toContain(`open        ${relay.url}/link/verify`);
    expect(log.join("\n")).toContain(`wsp login ABCD-2345.${fingerprint}`);
    expect(log.join("\n")).toContain("wsp login <id>");
    expect(log.join("\n")).not.toContain("client-token");

    expect(readRelayClient(home)).toMatchObject({ relayUrl: relay.url, token: "client-token", fingerprint, login: "zingzy" });
    expect(statSync(join(home, "relay-client.json")).mode & 0o777).toBe(0o600);
    // The key is this computer's from here on: a second line signs with the same one.
    relay.pending = 1;
    await loginCommand(io(), { statePath, home }, undefined, deps(dir)).catch(() => undefined);
    expect(readDeviceKeyPair(home)!.publicKey).toBe(pair.publicKey);
  });

  it("signs in to the relay this project runs when the line names none", async () => {
    const { statePath, home, dir } = box();
    const asked: string[] = [];
    const refused = await loginCommand(io(), { statePath, home }, undefined, {
      ...deps(dir),
      fetch: (async (url: string) => {
        asked.push(url);
        throw new Error("nothing answers here");
      }) as unknown as typeof fetch,
    }).then(() => undefined, (e: unknown) => e as Error);
    expect(asked[0]).toBe(`${DEFAULT_RELAY}/link/start`);
    expect(refused!.message).toContain(DEFAULT_RELAY);
  });

  it("refuses a second sign-in over the first, naming the line that signs this computer out", async () => {
    const relay = await fakeRelay();
    const other = await fakeRelay();
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    relay.pending = 1;
    await expect(loginCommand(io(), { statePath, home }, relay.url, deps(dir))).rejects.toThrow(/wsp logout/);
    await expect(loginCommand(io(), { statePath, home }, other.url, deps(dir))).rejects.toThrow(relay.url);
    expect(readRelayClient(home)!.relayUrl).toBe(relay.url);
  });

  it("signs an admission for the word another computer printed, and refuses a word that carries no key before anything is posted", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    const mine = readDeviceKeyPair(home)!;
    relay.calls.length = 0;

    const laptop = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";
    const log: string[] = [];
    expect(await loginCommand(io(log), { statePath, home }, `WXYZ-6789.${laptop}`, deps(dir))).toBe(0);
    const posted = relay.calls.find(c => c.line === "POST /link/approve")!;
    expect(posted.token).toBe("client-token");
    // The code loses the dash the screens group it with, and the admission is bytes this computer signed for that
    // key: the relay keeps them and can make none of them.
    expect(posted.body["code"]).toBe("WXYZ6789");
    const admission = posted.body["admission"] as { device: string; by: string; issuedAt: string; signature: string };
    expect(admission.device).toBe(laptop);
    expect(admission.by).toBe(keyFingerprint(mine.publicKey));
    expect(verifyPlaceBytes(mine.publicKey, deviceAdmissionTranscript(laptop, admission.by, admission.issuedAt), admission.signature)).toBe(true);

    relay.calls.length = 0;
    await expect(loginCommand(io(), { statePath, home }, "WXYZ-6789", deps(dir))).rejects.toThrow(LOGIN_NO_KEY_REFUSAL);
    expect(relay.calls).toEqual([]);
  });

  it("admits a computer already on the account by its id, off the key the account holds for it", async () => {
    const relay = await fakeRelay();
    const laptop = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";
    relay.clients = [
      { id: "c1", name: "the box", thisOne: true, fingerprint: "SHA256:aaa" },
      { id: "c2", name: "the laptop", thisOne: false, fingerprint: laptop },
      { id: "c3", name: "a computer from before keys", thisOne: false, fingerprint: null },
    ];
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    const mine = readDeviceKeyPair(home)!;
    relay.calls.length = 0;

    expect(await loginCommand(io(), { statePath, home }, "c2", deps(dir))).toBe(0);
    const posted = relay.calls.find(c => c.line === "POST /clients/c2/admissions")!;
    expect(posted.token).toBe("client-token");
    expect(posted.body).toMatchObject({ device: laptop, by: keyFingerprint(mine.publicKey) });
    // A computer that signed in before device keys holds none, so no host could admit it and the line says so.
    await expect(loginCommand(io(), { statePath, home }, "c3", deps(dir))).rejects.toThrow(/wsp logout c3/);
    await expect(loginCommand(io(), { statePath, home }, "c9", deps(dir))).rejects.toThrow(/c9/);
  });

  it("names the page beside the command when the row it was given holds no device key", async () => {
    const relay = await fakeRelay();
    relay.clients = [
      { id: "c1", name: "the box", thisOne: true, fingerprint: "SHA256:aaa" },
      { id: "c3", name: "a computer from before keys", thisOne: false, fingerprint: null },
    ];
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));

    const refused = await loginCommand(io(), { statePath, home }, "c3", deps(dir)).then(() => undefined, (e: unknown) => e);
    expect(exitClassOf(refused)).toBe("usage");
    expect((refused as Error).message).toContain(`Sign it out with wsp logout c3, or from ${relay.url}/link/verify in your browser, and run wsp login there again.`);
  });

  it("lists the account's computers, their keys and who admitted each, when it is asked nothing", async () => {
    const relay = await fakeRelay();
    relay.clients = [
      { id: "c1", name: "the box", thisOne: true, fingerprint: "SHA256:aaa" },
      { id: "c2", name: "the laptop", thisOne: false, fingerprint: "SHA256:bbb", admissions: [{ by: "SHA256:aaa", issuedAt: "2026-09-22T00:00:00.000Z", signature: "sig" }] },
    ];
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    const log: string[] = [];
    expect(await loginCommand(io(log), { statePath, home }, undefined, deps(dir))).toBe(0);
    expect(log[0]).toMatch(/^COMPUTER\s+ID\s+KEY\s+ADMITTED BY\s+SIGNED IN\s+LAST SEEN$/);
    expect(log.join("\n")).toContain("c2");
    expect(log.join("\n")).toContain("this one");
    // Who admitted it, by the name the account holds that key under rather than by the key alone.
    expect(log.join("\n")).toContain("2026-09-22T00:00:00.000Z");
    // A listing has no use for a signature and never prints one.
    expect(log.join("\n")).not.toContain("sig");
  });

  it("refuses every road but the sign-in on a computer that is signed in to nothing", async () => {
    const { statePath, home, dir } = box();
    await expect(loginCommand(io(), { statePath, home }, "c2", deps(dir))).rejects.toThrow(/wsp login/);
    await expect(logoutCommand(io(), { statePath, home }, undefined, deps(dir))).rejects.toThrow(/wsp login/);
  });
});

describe("wsp logout", () => {
  it("deletes this computer's own row, drops the hosts it reached through the account and keeps the key it signs with", async () => {
    const relay = await fakeRelay();
    relay.clients = [{ id: "c1", name: "the box", thisOne: true, fingerprint: "SHA256:aaa" }];
    relay.hosts = [{ id: "hbox1", name: "box", hostname: "hbox1.boxes.example", hostKey: "SHA256:key" }];
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    await hostsCommand(io(), { statePath, home }, deps(dir));
    expect(readHost(home, "box")).toBeDefined();
    const key = readDeviceKeyPair(home)!.publicKey;

    const log: string[] = [];
    expect(await logoutCommand(io(log), { statePath, home }, undefined, deps(dir))).toBe(0);
    expect(relay.calls.some(c => c.line === "DELETE /clients/c1" && c.token === "client-token")).toBe(true);
    expect(readRelayClient(home)).toBeUndefined();
    expect(readHost(home, "box")).toBeUndefined();
    // The key opens nothing by itself and is the one the hosts already trust, so it stays.
    expect(readDeviceKeyPair(home)!.publicKey).toBe(key);
    expect(log.join("\n")).toContain("box");
  });

  it("says the account may still hold this computer when the relay will not say which row is this one", async () => {
    const relay = await fakeRelay();
    relay.clients = [{ id: "c1", name: "the box", thisOne: true, fingerprint: "SHA256:aaa" }];
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    relay.refuse = { status: 500, error: "this relay is having a moment" };

    const err: string[] = [];
    expect(await logoutCommand(io([], err), { statePath, home }, undefined, deps(dir))).toBe(0);
    expect(err.join("\n")).toContain("this relay is having a moment");
    // The reading never got an id, so the line names the word wsp login prints beside every row over there.
    expect(err.join("\n")).toContain("wsp logout <id>");
    // The records go whatever the relay said: a token this computer cannot use must not be left behind.
    expect(readRelayClient(home)).toBeUndefined();
  });

  it("signs another of the account's computers out by its id", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    const log: string[] = [];
    expect(await logoutCommand(io(log), { statePath, home }, "c2", deps(dir))).toBe(0);
    expect(relay.calls.some(c => c.line === "DELETE /clients/c2")).toBe(true);
    expect(readRelayClient(home)).toBeDefined();
    expect(log.join("\n")).toContain("c2");
  });
});

describe("wsp hosts", () => {
  const HOST_KEY = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";

  /** An account holding one box that is up and one that has never said where it is. */
  async function signedIn(): Promise<{ relay: FakeRelay; statePath: string; home: string; dir: string }> {
    const relay = await fakeRelay();
    relay.hosts = [
      { id: "hbox1", name: "box", hostname: "hbox1.boxes.example", hostKey: HOST_KEY, connectorVersion: "2026.8.1", lastSeen: new Date().toISOString() },
      { id: "hattic", name: "attic", hostname: null, hostKey: null },
    ];
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    return { relay, statePath, home, dir };
  }

  it("prints one table and writes a record per account host that has an address, with no token in it", async () => {
    const { relay, statePath, home, dir } = await signedIn();
    const log: string[] = [];
    expect(await hostsCommand(io(log), { statePath, home }, deps(dir))).toBe(0);

    expect(log[0]).toMatch(/^HOST\s+ADDRESS\s+STATE\s+DEVICE\s+CONNECTOR\s+KEY$/);
    const rows = log.slice(1).map(line => line.split(/\s\s+/));
    expect(rows.find(r => r[0] === "box")).toEqual(["box", "https://hbox1.boxes.example", expect.stringMatching(/^up /), "2026.8.1", HOST_KEY, "default"]);
    expect(rows.find(r => r[0] === "attic")![1]).toBe(NOT_UP_YET);

    const record = readHost(home, "box")!;
    expect(record).toMatchObject({ url: "https://hbox1.boxes.example", hostKey: HOST_KEY, deviceId: "", deviceToken: "", via: { kind: "account", hostId: "hbox1" } });
    expect(statSync(join(hostsDir(home), "box.json")).mode & 0o777).toBe(0o600);
    // A host on the account with no address gets no record: there is nothing to dial until wsp up runs there.
    expect(readHost(home, "attic")).toBeUndefined();
    expect(relay.calls.some(c => c.line === "GET /hosts" && c.token === "client-token")).toBe(true);
  });

  it("writes no record for an account host that has said no key, prints its address as waiting on its next start and refuses a line aimed at it", async () => {
    const { relay, statePath, home, dir } = await signedIn();
    // A host beating from a wsp from before it sent its key: it says where it is and nothing about what it proves.
    relay.hosts = [{ id: "hattic", name: "attic", hostname: "hattic.boxes.example", hostKey: null, lastSeen: new Date().toISOString() }];
    const log: string[] = [];
    expect(await hostsCommand(io(log), { statePath, home }, deps(dir))).toBe(0);

    // The host is beating, so the row calls it up and says its address waits on the next start over there: one
    // row says one thing.
    const row = log.find(line => line.startsWith("attic"))!;
    expect(row).toContain(ADDRESS_NEXT_START);
    expect(row).not.toContain(NOT_UP_YET);
    expect(row).toMatch(/\bup /);
    // Nothing to dial and nothing to pin: a record here would send this computer's token at whatever answers.
    expect(readHost(home, "attic")).toBeUndefined();
    // The refusal is the one for a name this computer holds nothing under, which names the listing and not a code.
    expect(() => aimedHost(statePath, { home, host: "attic", env: {} })).toThrow(/no host named attic is connected[\s\S]*wsp hosts/);
  });

  it("marks the single account host as the one every line takes when nothing else is marked", async () => {
    const { statePath, home, dir } = await signedIn();
    const log: string[] = [];
    await hostsCommand(io(log), { statePath, home }, deps(dir));
    expect(log.find(line => line.startsWith("box"))).toContain("default");
  });

  it("removes a record whose host the account no longer names", async () => {
    const { relay, statePath, home, dir } = await signedIn();
    await hostsCommand(io(), { statePath, home }, deps(dir));
    expect(readHost(home, "box")).toBeDefined();

    relay.hosts = [{ id: "hattic", name: "attic", hostname: "hattic.boxes.example", hostKey: "SHA256:attic" }];
    const err: string[] = [];
    await hostsCommand(io([], err), { statePath, home }, deps(dir));
    expect(readHost(home, "box")).toBeUndefined();
    expect(err.join("\n")).toContain("box is no longer a host on your account");
  });

  it("refuses a host the account lists under another key, keeps the key it pinned and names the line that frees it", async () => {
    const { relay, statePath, home, dir } = await signedIn();
    await hostsCommand(io(), { statePath, home }, deps(dir));
    relay.hosts = [{ id: "hbox1", name: "box", hostname: "hsomewhere.boxes.example", hostKey: "SHA256:another" }];
    const err: string[] = [];
    await hostsCommand(io([], err), { statePath, home }, deps(dir));

    expect(err.join("\n")).toContain(HOST_KEY);
    expect(err.join("\n")).toContain("SHA256:another");
    expect(err.join("\n")).toContain("wsp logout, wsp login and wsp hosts");
    // The record keeps the key and the address it pinned: nothing of this computer's goes to whatever answers there.
    expect(readHost(home, "box")).toMatchObject({ hostKey: HOST_KEY, url: "https://hbox1.boxes.example" });
  });

  it("prints what this computer holds when the relay does not answer, and says so", async () => {
    const { relay, statePath, home, dir } = await signedIn();
    await hostsCommand(io(), { statePath, home }, deps(dir));
    relay.refuse = { status: 500, error: "this relay is having a moment" };
    const log: string[] = [];
    const err: string[] = [];
    expect(await hostsCommand(io(log, err), { statePath, home }, deps(dir))).toBe(0);
    expect(err.join("\n")).toContain("this relay is having a moment");
    expect(log.join("\n")).toContain("box");
    expect(readHost(home, "box")).toBeDefined();
  });

  it("says a computer signed in to nothing reaches no host but itself, and asks no relay", async () => {
    const { statePath, home, dir } = box();
    const err: string[] = [];
    const log: string[] = [];
    expect(await hostsCommand(io(log, err), { statePath, home }, deps(dir))).toBe(0);
    expect(err).toEqual([]);
    expect(log).toEqual([NO_HOSTS_LINE]);
  });
});

describe("what a linked host says on its beat and reads back", () => {
  /** The devices standing on a host, as the reconcile reads and cuts them. */
  function devicesHere(devices: DeviceView[]): RelayDeviceDoor & { revoked: string[] } {
    const door = {
      revoked: [] as string[],
      list: async () => devices,
      revoke: async (id: string) => {
        door.revoked.push(id);
        devices = devices.filter(d => d.id !== id);
        return true;
      },
    };
    return door;
  }

  const accountDevice = (id: string, fingerprint: string): DeviceView => ({
    id,
    name: id,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    via: { kind: "account", relayDeviceId: `c_${id}`, fingerprint, publicKey: "pub", admittedBy: "SHA256:signer" },
  });

  it("records the device key of the computer it was linked from, and the key it proves on its beat", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    const log: string[] = [];
    await relayCommand(io(log), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const mine = keyFingerprint(readDeviceKeyPair(home)!.publicKey);
    expect(readRelayRecord(statePath)!.deviceKey).toEqual({ fingerprint: mine, publicKey: readDeviceKeyPair(home)!.publicKey });
    expect(log.join("\n")).toContain(mine);

    const up = (await startRelay({ statePath, home, port: 4400, log: () => {} }, deps(dir)))!;
    closers.push(() => up.close());
    await vi.waitUntil(() => relay.calls.some(c => c.line === "POST /hosts/hbox1/heartbeat"), { timeout: 4000 });
    // The key this host proves goes up with every beat, and the relay writes it once.
    expect(relay.calls.find(c => c.line === "POST /hosts/hbox1/heartbeat")!.body["hostKey"]).toMatch(/^SHA256:/);
    expect(relay.hosts.find(h => h.id === "hbox1")!.hostKey).toMatch(/^SHA256:/);
  });

  it("records that key at the first start of a host linked before this wsp wrote one", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const held = readRelayRecord(statePath)!;
    const { deviceKey: _gone, ...older } = held;
    writeRelayRecord(statePath, older);
    rmSync(join(home, "device-key.json"), { force: true });

    const log: string[] = [];
    const up = (await startRelay({ statePath, home, port: 4400, log: line => log.push(line) }, deps(dir)))!;
    closers.push(() => up.close());
    const minted = readDeviceKeyPair(home)!;
    expect(readRelayRecord(statePath)!.deviceKey).toEqual({ fingerprint: keyFingerprint(minted.publicKey), publicKey: minted.publicKey });
    expect(log.join("\n")).toContain(keyFingerprint(minted.publicKey));
  });

  it("puts the host on the account with no code and no page from a computer already signed in", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    relay.calls.length = 0;
    const log: string[] = [];
    expect(await relayCommand(io(log), { statePath, home }, ["link"], { name: "attic" }, deps(dir))).toBe(0);

    // One call and no waiting: the token this computer holds is what puts the box on its own account.
    const posted = relay.calls.find(c => c.line === "POST /hosts")!;
    expect(posted.token).toBe("client-token");
    expect(posted.body["name"]).toBe("attic");
    expect(posted.body["hostKey"]).toMatch(/^SHA256:/);
    expect(relay.calls.map(c => c.line)).not.toContain("POST /link/start");
    expect(readRelayRecord(statePath)).toMatchObject({ hostId: "hbox1", token: "host-token", name: "attic" });
    expect(log.join("\n")).not.toContain("type");
  });

  it("revokes an account device the listing no longer names, and leaves a device that redeemed a code alone", async () => {
    const relay = await fakeRelay();
    relay.clients = [{ id: "c1", name: "the laptop", thisOne: false, fingerprint: "SHA256:laptop" }];
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const door = devicesHere([
      accountDevice("d_1", "SHA256:laptop"),
      accountDevice("d_2", "SHA256:gone"),
      { id: "d_3", name: "a paired computer", createdAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-01T00:00:00.000Z" },
    ]);
    const log: string[] = [];
    const up = (await startRelay({ statePath, home, port: 4400, log: line => log.push(line), devices: door }, deps(dir)))!;
    closers.push(() => up.close());

    await vi.waitUntil(() => door.revoked.length > 0, { timeout: 4000 });
    expect(door.revoked).toEqual(["d_2"]);
    expect(log.join("\n")).toContain("no longer on this account");
  });

  it("keeps refusing a key it took away when a listing stops naming that computer and then names it again", async () => {
    const devices = makeDevices(memoryStore());
    const laptop = { kind: "account", relayDeviceId: "c1", fingerprint: "SHA256:laptop", publicKey: "pub", admittedBy: "SHA256:signer" } as const;
    const paired = await devices.admitAccount("the laptop", laptop, Date.parse("2026-09-22T00:00:00.000Z"));
    expect(await devices.revoke(paired.deviceId)).toBe(true);

    // The relay leaves that computer off one beat's list and puts it back on the next. The revocation was made
    // here, so neither beat is any part of undoing it: the key stands refused and a code is the road back in.
    await reconcileAccountDevices(devices, [], () => {});
    await reconcileAccountDevices(devices, [{ id: "c1", name: "the laptop", fingerprint: "SHA256:laptop", admissions: [] }], () => {});
    expect(await devices.refuses("SHA256:laptop")).toBe(true);
  });

  it("revokes nobody on a reply carrying no devices field, and nobody on a beat the relay refused", async () => {
    const relay = await fakeRelay();
    relay.saysDevices = false;
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const door = devicesHere([accountDevice("d_1", "SHA256:laptop")]);
    const admitted = admittedDevices(statePath);
    const up = (await startRelay({ statePath, home, port: 4400, log: () => {}, devices: door, admitted }, deps(dir)))!;
    closers.push(() => up.close());

    await vi.waitUntil(() => relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat").length >= 2, { timeout: 4000 });
    expect(door.revoked).toEqual([]);
    // Absent is unknown and never empty: the door still says it has heard no listing at all.
    expect(admitted.list()).toBeUndefined();

    relay.refuse = { status: 500, error: "this relay is having a moment" };
    const beats = relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat").length;
    await vi.waitUntil(() => relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat").length > beats, { timeout: 4000 });
    expect(door.revoked).toEqual([]);
    expect(admitted.list()).toBeUndefined();
  });

  it("costs the relay one extra beat per ten seconds of misses, and carries what that beat learned", async () => {
    const relay = await fakeRelay();
    relay.clients = [{ id: "c1", name: "the laptop", thisOne: false, fingerprint: "SHA256:laptop" }];
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    let now = Date.parse("2026-09-22T00:00:00.000Z");
    const admitted = admittedDevices(statePath, { now: () => now });
    // A heartbeat far enough off that only the misses below call the relay.
    const up = (await startRelay({ statePath, home, port: 4400, log: () => {}, admitted }, deps(dir, { heartbeatMs: 600_000 })))!;
    closers.push(() => up.close());
    // The beat a start makes of its own, out of the way before the misses below are counted.
    await vi.waitUntil(() => relay.calls.some(c => c.line === "POST /hosts/hbox1/heartbeat"), { timeout: 4000 });
    relay.calls.length = 0;

    await admitted.refresh();
    await admitted.refresh();
    expect(relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat")).toHaveLength(1);
    // The listing that beat learned is what the door reads, and a device on it is admitted at once.
    expect(admitted.list()).toEqual([{ id: "c1", name: "the laptop", fingerprint: "SHA256:laptop", admissions: [] }]);

    now += BEAT_FLOOR_MS;
    await admitted.refresh();
    expect(relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat")).toHaveLength(2);
    // A host that is on no account beats nowhere at all, so a refresh there asks nothing.
    const bare = admittedDevices(join(tempDir("relay-bare"), "state.json"));
    await bare.refresh();
    expect(bare.signer()).toBeUndefined();
    expect(bare.list()).toBeUndefined();
  });
});

describe("who this wsp is signed in to", () => {
  it("reads as no sign-in while neither record is on this computer, and on a host serving no state file", () => {
    const { statePath, home } = box();
    expect(accountHere(statePath, home)).toEqual({ signedIn: false });
    // A bare path must not send the read at whatever relay.json the working folder holds.
    expect(accountHere(undefined, home)).toEqual({ signedIn: false });
    expect(accountHere("", home)).toEqual({ signedIn: false });
  });

  it("names the account the box was linked under", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    expect(accountHere(statePath, home)).toEqual({ signedIn: true, login: "zingzy" });
  });

  it("names the account this computer signed in under, a wsp home apart from the box's state", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await loginCommand(io(), { statePath, home }, relay.url, deps(dir));
    expect(accountHere(statePath, home)).toEqual({ signedIn: true, login: "zingzy" });
  });

  it("says signed in with no name against a relay whose approval names no account", async () => {
    // A relay from before the approval carried a login: the record is a sign-in all the same, and the row says so
    // rather than reading as signed out.
    const relay = await fakeRelay();
    relay.login = {};
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    expect(accountHere(statePath, home)).toEqual({ signedIn: true });
  });
});
