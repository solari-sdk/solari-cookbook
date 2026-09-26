// SPDX-License-Identifier: AGPL-3.0-only
// The two commands that hand out access and take it back, and the words they
// print. Both dial a host, so a fake client is the whole of what they need.
// wsp host pair refuses a line aimed at a host on another computer and wsp
// host devices dials it, which is why every call here names the home and the
// environment the run reads rather than leaving them to this process's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES, pairToken, SEAL_UNSERVED } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { advertisedUrl, deviceLines, deviceRoadWord, deviceRoleWord, hostReach, pairLines, pairOnLoopbackLine, reachAddresses, devicesCommand, pairCommand } from "../src/pairing.js";
import { hostSideOnlyFix, hostSideOnlyLine, type HostAim } from "../src/hosts.js";
import { cli, HOST_COMMANDS, HOST_FLAG, type CliIO } from "../src/cli.js";
import { dialAddress } from "../src/host-lock.js";
import { doorAddresses } from "../src/server.js";
import { writeHost, type HostRecord } from "../src/hosts.js";
import type { HostClient } from "../src/verbs.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

type Interfaces = Parameters<typeof reachAddresses>[1];

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const io = (log: string[], err: string[]): CliIO => ({ log: l => log.push(l), error: l => err.push(l), ask: noPrompt, askSecret: noPrompt });

/** A host that answers the two ops and records what it was asked, and counts the closes so a command cannot leave a
 * socket behind. */
function fakeHost(answers: Record<string, Record<string, unknown>>): { client: HostClient; asked: { op: string; params?: Record<string, unknown> }[]; closes: () => number } {
  const asked: { op: string; params?: Record<string, unknown> }[] = [];
  let closed = 0;
  const client: HostClient = {
    request: async (op, params) => {
      asked.push({ op, ...(params !== undefined ? { params } : {}) });
      const answer = answers[op];
      if (answer === undefined) throw new Error(`no fake answer for ${op}`);
      return answer as never;
    },
    events: () => Promise.resolve(),
    onFrame: () => () => {},
    closed: new Promise<void>(() => {}),
    closeWords: () => "closed",
    close: () => {
      closed++;
    },
    terminate: () => {
      closed++;
    },
  };
  return { client, asked, closes: () => closed };
}

/** The dial a command makes, with the aim it handed over: where a line went is the whole of what these cases read. */
const deps = (client: HostClient, now = Date.parse("2026-09-11T10:00:00.000Z")): { dial: (statePath: string, opts: { aim?: HostAim }) => Promise<HostClient>; now: () => number; aimed: HostAim[] } => {
  const aimed: HostAim[] = [];
  return {
    dial: (_statePath, opts) => {
      if (opts.aim !== undefined) aimed.push(opts.aim);
      return Promise.resolve(client);
    },
    now: () => now,
    aimed,
  };
};

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A home with no hosts folder in it, which is a computer that paired with nobody: named on every call, since a
 * call that named none would read the person's own ~/.wsp and answer out of whatever they have connected. */
const NO_HOSTS = "/nowhere/wsp-home";

/** The fingerprint the host proves, which wsp host pair prints beside the code and every record carries. */
const HOST_KEY = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";
const here = (home = NO_HOSTS): { statePath: string; home: string; env: Record<string, string> } => ({ statePath: "/s/state.json", home, env: {} });

/** A home holding one host on the account under the name box, which every line falls to when nothing serves here. */
function homeWithBox(): string {
  const home = mkdtempSync(join(tmpdir(), "wsp-pair-home-"));
  dirs.push(home);
  const record: HostRecord = { url: "http://box.local:4400", deviceId: "d_box", deviceToken: "tok-box", hostKey: HOST_KEY, pairedAt: "2026-09-11T10:00:00.000Z", via: { kind: "account", hostId: "hbox" } };
  writeHost(home, "box", record);
  return home;
}

describe("wsp host pair", () => {
  it("prints the code with the key the host proves, when it expires and the address to open, and closes its socket", async () => {
    const now = Date.parse("2026-09-11T10:00:00.000Z");
    const host = fakeHost({ "pair.issue": { code: "7K3MQP2X", expiresAt: now + 600_000, hostKey: HOST_KEY } });
    const log: string[] = [];
    expect(await pairCommand(io(log, []), here(), [], deps(host.client, now))).toBe(0);
    expect(host.asked).toEqual([{ op: "pair.issue" }]);
    // One word to copy: the code the host is holding and the fingerprint the computer taking it pins before it
    // sends anything of its own, as the line wsp add prints for a computer being joined already carries.
    expect(log[0]).toBe(`code        ${pairToken("7K3MQP2X", HOST_KEY)}`);
    expect(log[0]).toBe(`code        7K3M-QP2X.${HOST_KEY}`);
    expect(log[1]).toContain("in 10m");
    expect(log[1]).toContain("2026-09-11T10:10:00.000Z");
    expect(host.closes()).toBe(1);
  });

  it("prints no code at all where the host proves no key, since nothing could spend one", async () => {
    const now = Date.parse("2026-09-11T10:00:00.000Z");
    const host = fakeHost({ "pair.issue": { code: "7K3MQP2X", expiresAt: now + 600_000 } });
    const log: string[] = [];
    await expect(pairCommand(io(log, []), here(), [], deps(host.client, now))).rejects.toThrow(SEAL_UNSERVED);
    expect(log).toEqual([]);
  });

  it("refuses a positional argument rather than taking it for something", async () => {
    const host = fakeHost({});
    await expect(pairCommand(io([], []), here(), ["laptop"], deps(host.client))).rejects.toThrow(/no positional/);
  });
});

describe("wsp host devices", () => {
  it("lists what took a code, with a row per device saying what its token is read as, and never a token", async () => {
    const host = fakeHost({
      "devices.list": {
        devices: [
          { id: "d_1a2b3c4d5e6f7a8b", name: "maya's laptop", createdAt: "2026-09-11T10:00:00.000Z", lastSeenAt: "2026-09-11T10:05:00.000Z" },
          { id: "d_5e6f7a8b1a2b3c4d", name: "a Mac in a browser at 127.0.0.1:4400", createdAt: "2026-09-11T11:00:00.000Z", lastSeenAt: "2026-09-11T11:00:00.000Z", here: true },
          { id: "d_9a8b7c6d5e4f3a2b", name: "thread abcd1234", createdAt: "2026-09-11T12:00:00.000Z", lastSeenAt: "2026-09-11T12:00:00.000Z", scope: { kind: "thread", threadId: "t_1", workspaceId: "ws_1", rootThreadId: "t_1" } },
          {
            id: "d_2b3c4d5e6f7a8b1a",
            name: "the desk",
            createdAt: "2026-09-11T13:00:00.000Z",
            lastSeenAt: "2026-09-11T13:00:00.000Z",
            via: { kind: "account", relayDeviceId: "c_desk", fingerprint: "SHA256:aaa", publicKey: "pub", admittedBy: "SHA256:bbb" },
          },
        ],
      },
    });
    const log: string[] = [];
    expect(await devicesCommand(io(log, []), here(), [], deps(host.client))).toBe(0);
    expect(log[0]).toMatch(/^DEVICE\s+ID\s+AS\s+VIA\s+PAIRED\s+LAST SEEN$/);
    // One listing for both roads, with the road in a column of its own: a code, or the account both computers are
    // signed in to.
    expect(log[1]).toMatch(/^maya's laptop\s+d_1a2b3c4d5e6f7a8b\s+device\s+code\s+2026/);
    expect(log[2]).toMatch(/^a Mac in a browser at 127\.0\.0\.1:4400\s+d_5e6f7a8b1a2b3c4d\s+owner\s+code\s+2026/);
    expect(log[3]).toMatch(/^thread abcd1234\s+d_9a8b7c6d5e4f3a2b\s+thread\s+code\s+2026/);
    expect(log[4]).toMatch(/^the desk\s+d_2b3c4d5e6f7a8b1a\s+device\s+account\s+2026/);
    expect(deviceRoleWord({})).toBe("device");
    expect(deviceRoleWord({ here: true })).toBe("owner");
    expect(deviceRoadWord({})).toBe("code");
    expect(deviceRoadWord({ via: { kind: "account", relayDeviceId: "c_1", fingerprint: "SHA256:aaa", publicKey: "pub", admittedBy: "SHA256:bbb" } })).toBe("account");
    expect(host.closes()).toBe(1);
  });

  it("says so plainly when nobody is paired, naming the host the line was aimed at", async () => {
    const host = fakeHost({ "devices.list": { devices: [] } });
    const log: string[] = [];
    await devicesCommand(io(log, []), here(), [], deps(host.client));
    expect(log).toEqual(["No computer is paired with this host. Run wsp host pair for a code."]);
    // Aimed at a host on another computer, the line names it, and the code is minted at that host's own terminal.
    const box = fakeHost({ "devices.list": { devices: [] } });
    const aimed: string[] = [];
    await devicesCommand(io(aimed, []), { ...here(homeWithBox()), host: "box" }, [], deps(box.client));
    expect(aimed).toEqual(["No computer is paired with box. Run wsp host pair on box for a code."]);
  });

  it("revokes by id, and exits non-zero on an id nothing is paired under", async () => {
    const gone = fakeHost({ "devices.revoke": { revoked: true } });
    const log: string[] = [];
    expect(await devicesCommand(io(log, []), here(), ["revoke", "d_1a2b3c4d"], deps(gone.client))).toBe(0);
    expect(gone.asked).toEqual([{ op: "devices.revoke", params: { deviceId: "d_1a2b3c4d" } }]);
    expect(log[0]).toContain("d_1a2b3c4d revoked");

    const none = fakeHost({ "devices.revoke": { revoked: false } });
    const err: string[] = [];
    expect(await devicesCommand(io([], err), here(), ["revoke", "d_nope"], deps(none.client))).toBe(1);
    expect(err[0]).toContain("no device d_nope");
  });

  it("refuses a word it does not know and a revoke with no id", async () => {
    const host = fakeHost({});
    for (const args of [["forget", "d_1"], ["revoke"], ["revoke", "d_1", "d_2"]]) {
      await expect(devicesCommand(io([], []), here(), args, deps(host.client))).rejects.toThrow(/wsp host devices/);
    }
  });

  it("dials the host --host names and lists that host's devices, with the AS column, from the computer paired with it", async () => {
    const host = fakeHost({ "devices.list": { devices: [{ id: "d_box1", name: "maya's laptop", createdAt: "2026-09-11T10:00:00.000Z", lastSeenAt: "2026-09-11T10:05:00.000Z" }] } });
    const home = homeWithBox();
    const d = deps(host.client);
    const log: string[] = [];
    expect(await devicesCommand(io(log, []), { ...here(home), host: "box" }, [], d)).toBe(0);
    expect(d.aimed).toMatchObject([{ kind: "alias", alias: "box" }]);
    expect(host.asked).toEqual([{ op: "devices.list" }]);
    expect(log[0]).toContain("AS");
    expect(log[1]).toMatch(/maya's laptop\s+d_box1\s+device/);
    expect(host.closes()).toBe(1);
  });

  it("sends a revoke to the host --host names, and reads where the line is aimed out of the environment the run was given, not this process's", async () => {
    const host = fakeHost({ "devices.revoke": { revoked: true } });
    // The home holding the host every line falls to is named by this environment alone: a command that read
    // process.env instead would dial whatever this process's own home holds.
    const home = homeWithBox();
    const d = deps(host.client);
    const log: string[] = [];
    expect(await devicesCommand(io(log, []), { statePath: "/s/state.json", env: { WSP_HOME: home } }, ["revoke", "d_box1"], d)).toBe(0);
    expect(d.aimed).toMatchObject([{ kind: "alias", alias: "box" }]);
    expect(host.asked).toEqual([{ op: "devices.revoke", params: { deviceId: "d_box1" } }]);
    expect(log[0]).toContain("d_box1 revoked");
    // A revoke of an id that host holds nothing under names the host the line was aimed at.
    const none = fakeHost({ "devices.revoke": { revoked: false } });
    const err: string[] = [];
    expect(await devicesCommand(io([], err), { ...here(homeWithBox()), host: "box" }, ["revoke", "d_nope"], deps(none.client))).toBe(1);
    expect(err[0]).toBe("wsp host devices revoke: no device d_nope is paired with box.");
  });

  it("is a verb aimed like every other, so the shared parse takes --host on it and the skill's list of host commands carries it", () => {
    expect(HOST_FLAG["host devices"]).toBe("aimed");
    expect(HOST_COMMANDS).toContain("host devices");
  });
});

describe("a host side command aimed at a host on another computer", () => {
  it("refuses --host, and the account's one host, with the one sentence that says where to run it, while devices dials", async () => {
    const host = fakeHost({ "devices.list": { devices: [] }, "pair.issue": { code: "7K3MQP2X", expiresAt: 0 } });
    const home = homeWithBox();
    // A flag naming a host on the account.
    await expect(pairCommand(io([], []), { ...here(home), host: "box" }, [], deps(host.client))).rejects.toThrow(hostSideOnlyLine("host pair", "box"));
    // The account's one host, with no flag and nothing in the environment: the aim no host on this computer wins
    // back, which is the road that reached the remote host by accident.
    const marked = homeWithBox();
    await expect(pairCommand(io([], []), here(marked), [], deps(host.client))).rejects.toThrow(hostSideOnlyLine("host pair", "box"));
    // Nothing was dialled: a code handed out over a device token is a code the host would refuse anyway, and the
    // refusal has to read as a line the person can act on rather than as the host's own.
    expect(host.asked).toEqual([]);
    expect(host.closes()).toBe(0);
    // The devices line takes the same aim and goes there.
    const d = deps(host.client);
    expect(await devicesCommand(io([], []), here(marked), [], d)).toBe(0);
    expect(d.aimed).toMatchObject([{ kind: "alias", alias: "box" }]);
    expect(host.asked).toEqual([{ op: "devices.list" }]);
  });

  // The flag is one key of the shared parse: a word that does not declare it is refused before its command runs,
  // which is how wsp host devices --host box answered "Unknown option '--host'" while the help promised the flag on
  // every verb. Each door is its own case, since each is a line a person types and the third reaches the flag
  // through its parent's declaration rather than a list written out beside it. The home is named by the
  // environment this call is given, so nothing here reads the person's own.
  const typed = async (argv: readonly string[], word: string): Promise<void> => {
    const errors: string[] = [];
    expect(await cli([...argv], io([], errors), undefined, { WSP_HOME: homeWithBox() }), `wsp ${argv.join(" ")}`).toBe(EXIT_CODES.usage);
    expect(errors).toEqual([`${hostSideOnlyLine(word, "box")} ${hostSideOnlyFix()}`]);
  };

  it("wsp host pair takes a typed --host and answers that sentence, not the parse's unknown option", async () => {
    await typed(["host", "pair", "--host", "box"], "host pair");
  });

  it("the plumbing answers under wsp host alone: the old top level word is no command, and pair still runs at the host's own terminal", async () => {
    const gone: string[] = [];
    expect(await cli(["pair"], io([], gone), undefined, { WSP_HOME: homeWithBox() })).toBe(EXIT_CODES.usage);
    expect(gone).toEqual(["unknown command: pair. Run wsp --help for the list."]);
    expect(HOST_FLAG["host pair"]).toBe("hostSide");
    // The words select the command; wsp host devices revoke reaches it as the two words plus what follows.
    const revoked: string[] = [];
    expect(await cli(["host", "devices", "revoke"], io([], revoked), undefined, { WSP_HOME: homeWithBox() })).toBe(EXIT_CODES.usage);
    expect(revoked[0]).toContain("wsp host devices takes nothing, or revoke and one device id.");
  });

  it("says which command it is and where the line was aimed, then where to run it", () => {
    expect(hostSideOnlyLine("host pair", "box")).toContain("wsp host pair");
    expect(hostSideOnlyLine("host pair", "box")).toContain("box");
    expect(hostSideOnlyFix()).toContain("Run it in a terminal over there");
  });
});

describe("the addresses a client may use", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "fe80::aede:48ff:fe00:1122", family: "IPv6", internal: false },
      { address: "2001:db8::5", family: "IPv6", internal: false },
    ],
    en1: [{ address: "169.254.10.2", family: "IPv4", internal: false }],
  } as unknown as Interfaces;

  it("expands the wildcard to the addresses of the family it covers, and leaves any other address alone", () => {
    // An IPv4 wildcard listens on no IPv6 address, so naming one would send a person at another computer to a
    // port nothing answers on; the IPv6 wildcard is dual stack and covers both.
    expect(reachAddresses("0.0.0.0", interfaces)).toEqual(["192.168.1.20"]);
    expect(reachAddresses("::", interfaces)).toEqual(["192.168.1.20", "2001:db8::5"]);
    expect(reachAddresses("100.64.0.3", interfaces)).toEqual(["100.64.0.3"]);
  });

  it("leaves out the addresses that reach only the link they sit on, which no browser opens", () => {
    expect(reachAddresses("::", interfaces)).not.toContain("fe80::aede:48ff:fe00:1122");
    expect(reachAddresses("0.0.0.0", interfaces)).not.toContain("169.254.10.2");
    const linkOnly = { en0: [{ address: "fe80::1", family: "IPv6", internal: false }] } as unknown as Interfaces;
    expect(reachAddresses("::", linkOnly)).toEqual(["127.0.0.1"]);
  });

  it("the address a machine dials this host at follows the bind, and is nothing on a host no machine can reach", () => {
    // A wildcard stands for the first address that leaves this computer, and a named one is itself.
    expect(advertisedUrl("0.0.0.0", 4700, undefined, interfaces)).toBe("http://192.168.1.20:4700");
    expect(advertisedUrl("100.64.0.3", 4700, undefined, interfaces)).toBe("http://100.64.0.3:4700");
    // Loopback reaches no machine, so no turn is handed a token it could not use; --advertise is the way past that.
    expect(advertisedUrl("127.0.0.1", 4700, undefined, interfaces)).toBeUndefined();
    const onlyLoopback = { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } as unknown as Interfaces;
    expect(advertisedUrl("0.0.0.0", 4700, undefined, onlyLoopback)).toBeUndefined();
    // What the person named wins whatever the bind is, and a trailing slash is not part of an address.
    expect(advertisedUrl("127.0.0.1", 4700, "https://box.example/wsp/", interfaces)).toBe("https://box.example/wsp");
    expect(advertisedUrl("0.0.0.0", 4700, "  ", interfaces)).toBe("http://192.168.1.20:4700");
    // An IPv6 address is bracketed, so the url is one a machine's client parses.
    expect(advertisedUrl("2001:db8::5", 4700, undefined, interfaces)).toBe("http://[2001:db8::5]:4700");
  });

  it("what a turn is told about this host: the person's word, the relay's name while it holds, else the bind", () => {
    const at = { address: "0.0.0.0", port: 4700 };
    const none = (): undefined => undefined;
    // Nothing named and no tunnel up: the address this computer answers on, and the port, which is what a kind
    // whose machines know an address of their own writes with.
    expect({ ...hostReach(at, undefined, none, interfaces) }).toEqual({ url: "http://192.168.1.20:4700", port: 4700 });
    // A connector holding a tunnel beats it: a machine at a provider reaches a name from anywhere and a LAN
    // address from nowhere. Read at each turn, since a quick tunnel is renamed every time its connector runs.
    let name: string | undefined;
    const relayed = hostReach(at, undefined, () => name, interfaces);
    expect(relayed.url).toBe("http://192.168.1.20:4700");
    name = "wsp-box.example.com";
    expect(relayed.url).toBe("https://wsp-box.example.com");
    // What the person named stands above both, and above every kind's own answer at the launch: somebody who names
    // an address has said which one the other end can reach, and a relay name they never asked for is a guess.
    expect({ ...hostReach(at, "https://box.example/wsp/", () => name, interfaces) }).toEqual({ advertise: "https://box.example/wsp", url: "https://box.example/wsp", port: 4700 });
    // The wildcard on a computer that answers on nothing else: no address to hand a machine somewhere else, and
    // still the port, since a container reaches the gateway whatever this computer's own cards say.
    const onlyLoopback = { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } as unknown as Interfaces;
    expect({ ...hostReach(at, undefined, none, onlyLoopback) }).toEqual({ url: undefined, port: 4700 });
    // A host bound to one address names no port: it answers there and nowhere else, so a kind that would write
    // an address of its own with it would write one this host does not listen on.
    expect({ ...hostReach({ address: "192.168.1.20", port: 4700 }, undefined, none, interfaces) }).toEqual({ url: "http://192.168.1.20:4700" });
    // A host bound to this computer alone names no port either: nothing outside this computer reaches it there,
    // so a kind that would write an address of its own with it is told none.
    expect({ ...hostReach({ address: "127.0.0.1", port: 4700 }, undefined, none, interfaces) }).toEqual({ url: undefined });
    // A host bound to this computer alone that was given a word dials back at the word: the flag is the one
    // override for a bind nothing outside can reach, which is what it exists for.
    expect({ ...hostReach({ address: "127.0.0.1", port: 4700 }, "http://10.0.0.9:4700", none, interfaces) }).toEqual({ advertise: "http://10.0.0.9:4700", url: "http://10.0.0.9:4700" });
  });

  it("hands out the word the person named, the relay's name where they named none, and the interface where there is neither", () => {
    const at = { address: "0.0.0.0", port: 4720 };
    const none = (): undefined => undefined;
    // The word, over interfaces that would otherwise pick this computer's first card. This is the case the flag
    // exists for: the card a host answers on is one the box across the room cannot route to.
    expect(hostReach(at, "http://65.21.4.12:4720", none, interfaces).url).toBe("http://65.21.4.12:4720");
    expect(hostReach(at, "http://65.21.4.12:4720", () => "wsp-box.example.com", interfaces).url).toBe("http://65.21.4.12:4720");
    // No word: the relay's name, which works from anywhere, and the interface where no connector is holding one.
    expect(hostReach(at, undefined, () => "wsp-box.example.com", interfaces).url).toBe("https://wsp-box.example.com");
    expect(hostReach(at, undefined, none, interfaces).url).toBe("http://192.168.1.20:4720");
  });

  it("leads the addresses a joining box is told with the word the person named, and keeps this computer's after it", () => {
    // The sighting this pins: a host on the wildcard whose first card is a Tailscale address the box cannot route
    // to, started with a word naming the address it can. The word is first, so it is the one the box dials first.
    expect(doorAddresses("0.0.0.0", 4720, "http://65.21.4.12:4720", interfaces)).toEqual(["http://65.21.4.12:4720", "http://192.168.1.20:4720"]);
    // Named none: what this computer answers on, as before.
    expect(doorAddresses("0.0.0.0", 4720, undefined, interfaces)).toEqual(["http://192.168.1.20:4720"]);
    // A word this computer already answers on is not handed out twice.
    expect(doorAddresses("0.0.0.0", 4720, "http://192.168.1.20:4720", interfaces)).toEqual(["http://192.168.1.20:4720"]);
    // A word that is no address at all is left out rather than handed to a box as one, which would be a dial that
    // could never land and a person reading their own typo back twenty seconds later.
    expect(doorAddresses("0.0.0.0", 4720, "box.local", interfaces)).toEqual(["http://192.168.1.20:4720"]);
    // Loopback is not filtered here: a person who names it is told it reaches nothing by the install that refuses,
    // which names the flag, rather than having their word silently dropped.
    expect(doorAddresses("0.0.0.0", 4720, "http://127.0.0.1:4720", interfaces)).toEqual(["http://127.0.0.1:4720", "http://192.168.1.20:4720"]);
  });

  it("brackets an IPv6 address in the line it prints, so the URL is one a browser takes", () => {
    expect(pairLines("7K3MQP2X", 1_000, 0, ["2001:db8::5"], 4400)).toContain("open        http://[2001:db8::5]:4400");
  });

  it("falls back to loopback when this computer answers on nothing else, rather than printing no address at all", () => {
    const onlyLoopback = { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } as unknown as Interfaces;
    expect(reachAddresses("0.0.0.0", onlyLoopback)).toEqual(["127.0.0.1"]);
  });

  it("dials the address the lock records, and turns only the wildcard into loopback", () => {
    expect(dialAddress({})).toBe("127.0.0.1");
    expect(dialAddress({ address: "0.0.0.0" })).toBe("127.0.0.1");
    expect(dialAddress({ address: "::" })).toBe("127.0.0.1");
    // Every other spelling is passed through as given: a host on ::1 or on a second loopback alias answers there
    // and nowhere else, so rewriting it to 127.0.0.1 would dial a port nothing is listening on.
    expect(dialAddress({ address: "127.0.0.1" })).toBe("127.0.0.1");
    expect(dialAddress({ address: "::1" })).toBe("::1");
    expect(dialAddress({ address: "127.0.0.2" })).toBe("127.0.0.2");
    expect(dialAddress({ address: "localhost" })).toBe("localhost");
    expect(dialAddress({ address: "100.64.0.3" })).toBe("100.64.0.3");
    expect(dialAddress({ address: "2001:db8::5" })).toBe("2001:db8::5");
  });
});

describe("the words", () => {
  it("says a code opens nothing on a host that binds this computer alone", () => {
    expect(pairOnLoopbackLine("127.0.0.1")).toContain("--listen");
  });

  it("pads the device table's columns and never carries a token", () => {
    const lines = deviceLines([{ id: "d_1", name: "one", createdAt: "2026-09-11T10:00:00.000Z", lastSeenAt: "2026-09-11T10:00:00.000Z" }], { kind: "here" });
    expect(lines[0]).toMatch(/^DEVICE\s+ID\s+AS\s+VIA\s+PAIRED\s+LAST SEEN$/);
    expect(lines.join("\n")).not.toContain("token");
  });

  it("pairLines names the port each address is reached on", () => {
    const lines = pairLines("7K3MQP2X", 1_000, 0, ["192.168.1.20"], 4400);
    expect(lines).toContain("open        http://192.168.1.20:4400");
  });
});
