// SPDX-License-Identifier: AGPL-3.0-only
// The hosts file and the one rule that decides which host a line runs
// against: a record round trips at mode 0600, a flag beats the environment
// beats the lock on this computer beats the account's one host, and a URL
// typed where an alias goes is a host nothing is stored for.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCHED_WITH, WS_PATH, hostNoKeyLine } from "@wsp/protocol";
import { accountHosts, aimedAlias, aimedHost, aliasFrom, dialWindowMs, hostsDir, listHosts, noSuchHostLine, readHost, removeHost, severalAccountHostsLine, wsUrlOf, wspHome, writeHost, type HostRecord } from "../src/hosts.js";
import { homeNamed } from "../src/serving-home.js";
import { hostAddress, noHostServingLine } from "../src/verbs.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${tag}-`));
  dirs.push(dir);
  return dir;
}

/** The fingerprint the account listed for a host, which every record wsp hosts writes pins. */
const HOST_KEY = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";

const record = (url: string, id = "d_1a2b3c4d"): HostRecord => ({ url, deviceId: id, deviceToken: `tok-${id}`, hostKey: HOST_KEY, pairedAt: "2026-09-11T10:00:00.000Z", via: { kind: "account", hostId: `h${id}` } });

/** A state folder whose lock names this process, which is a host serving it as far as every reader is concerned. */
function servedState(port = 4400): string {
  const dir = tempDir("hosts-state");
  writeFileSync(join(dir, "host.lock"), JSON.stringify({ pid: process.pid, port, wsPort: port + 10, startedAt: "2026-09-11T10:00:00.000Z" }));
  writeFileSync(join(dir, "host-token"), "host-token\n");
  return join(dir, "state.json");
}

describe("the hosts file", () => {
  it("writes a record only this user can read and reads it back whole", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    expect(readHost(home, "box")).toEqual(record("http://box.local:4400"));
    expect(statSync(join(hostsDir(home), "box.json")).mode & 0o777).toBe(0o600);
    expect(statSync(hostsDir(home)).mode & 0o777).toBe(0o700);
  });

  it("a record and a folder an older build left wider are repaired by the write that goes over them", () => {
    const home = tempDir("hosts-wide");
    mkdirSync(hostsDir(home), { recursive: true });
    chmodSync(hostsDir(home), 0o755);
    writeFileSync(join(hostsDir(home), "box.json"), "{}\n");
    chmodSync(join(hostsDir(home), "box.json"), 0o644);
    writeHost(home, "box", record("http://box.local:4400"));
    expect(statSync(join(hostsDir(home), "box.json")).mode & 0o777).toBe(0o600);
    expect(statSync(hostsDir(home)).mode & 0o777).toBe(0o700);
    expect(readHost(home, "box")).toEqual(record("http://box.local:4400"));
  });

  it("lists every alias with its url, and answers nothing for a home with no hosts folder", () => {
    const home = tempDir("hosts-home");
    expect(listHosts(home)).toEqual([]);
    writeHost(home, "box", record("http://box.local:4400", "d_1"));
    writeHost(home, "attic", record("https://attic.example", "d_2"));
    expect(listHosts(home)).toEqual([
      { alias: "attic", url: "https://attic.example", deviceId: "d_2" },
      { alias: "box", url: "http://box.local:4400", deviceId: "d_1" },
    ]);
  });

  it("removes the file, and answers false when there was none", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    expect(removeHost(home, "box")).toBe(true);
    expect(readHost(home, "box")).toBeUndefined();
    expect(removeHost(home, "box")).toBe(false);
  });

  it("refuses an alias that is a path rather than a name, so nothing writes outside the hosts folder", () => {
    const home = tempDir("hosts-home");
    expect(() => writeHost(home, "../evil", record("http://x"))).toThrow(/alias/);
    expect(() => writeHost(home, "a/b", record("http://x"))).toThrow(/alias/);
    expect(readHost(home, "../evil")).toBeUndefined();
  });

  it("reads a file with no account behind it as no record, since nothing but wsp hosts writes one now", () => {
    const home = tempDir("hosts-home");
    mkdirSync(hostsDir(home), { recursive: true });
    const { via: _gone, ...paired } = record("http://192.168.1.9:4400");
    writeFileSync(join(hostsDir(home), "lan.json"), JSON.stringify(paired));
    expect(readHost(home, "lan")).toBeUndefined();
    expect(listHosts(home)).toEqual([]);
  });

  it("folds a name nobody typed through the same rule a typed one is held to", () => {
    expect(aliasFrom("box.local")).toBe("box.local");
    expect(aliasFrom("192.168.1.9")).toBe("192.168.1.9");
    expect(aliasFrom("[::1]")).toBe("1-");
    expect(aliasFrom("///")).toBe("host");
    expect(aliasFrom("a".repeat(200))).toHaveLength(64);
    // A dot is in the alias class and the checker refuses a dot-dot, so a run of dots is the one fold that could
    // hand back a word the checker would not take: new URL("http://a..b:4400").hostname is a..b, and a person who
    // typed no --name would have died on a name they never chose.
    expect(aliasFrom(new URL("http://a..b:4400").hostname)).toBe("a.b");
    expect(aliasFrom("a....b")).toBe("a.b");
    expect(aliasFrom("..")).toBe("host");
    const home = tempDir("hosts-folds");
    for (const folded of ["box.local", "[::1]", "///", "a..b", "a....b", "..", "a..", ".", "-.-", "a".repeat(200)].map(aliasFrom)) {
      writeHost(home, folded, record("http://x"));
      expect(readHost(home, folded)).toEqual(record("http://x"));
    }
  });

  it("refuses a word that could never be a file under the hosts folder, in one sentence", () => {
    const home = tempDir("hosts-refused");
    for (const word of ["../evil", "a/b", "", "-box", "a".repeat(65)]) expect(() => writeHost(home, word, record("http://x")), word).toThrow(/not a host alias/);
  });

  it("reads WSP_HOME for the home the hosts folder sits in, and an empty one names no home at all", () => {
    expect(wspHome({ WSP_HOME: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    expect(wspHome({})).toMatch(/\.wsp$/);
    // WSP_HOME= with nothing after it is what a launcher leaves when it carries the name and not the value; read as
    // a home it is the folder the run happens to sit in, and the hosts, the keys and the state land beside it.
    expect(wspHome({ WSP_HOME: "" })).toBe(wspHome({}));
    expect(homeNamed("")).toBeUndefined();
  });
});

describe("the ws url of a host's address", () => {
  it("keeps the address and puts the runtime's path on it, over ws for http and wss for https", () => {
    expect(wsUrlOf("http://box.local:4400")).toBe(`ws://box.local:4400${WS_PATH}`);
    expect(wsUrlOf("https://attic.example")).toBe(`wss://attic.example${WS_PATH}`);
    expect(wsUrlOf("http://box.local:4400/")).toBe(`ws://box.local:4400${WS_PATH}`);
    expect(wsUrlOf("ws://box.local:4400")).toBe(`ws://box.local:4400${WS_PATH}`);
    expect(wsUrlOf("https://relay.example/mine")).toBe(`wss://relay.example/mine${WS_PATH}`);
  });
});

describe("how long a dial waits, by the road", () => {
  it("gives a host on this computer a loopback's window and one at an address off it the road's", () => {
    const near = dialWindowMs({ kind: "here" });
    const far = dialWindowMs({ kind: "alias", alias: "box", record: record("https://h5aab7a97cd80893f.singhi.me") });
    expect(near).toBe(5_000);
    // Longer than the 5.8 s a content delivery edge was measured holding a request while its tunnel came up, which
    // is the road a relayed box is reached over.
    expect(far).toBeGreaterThan(6_000);
    for (const url of ["http://127.0.0.1:4400", "http://127.0.0.2:4400", "http://localhost:4400", "http://[::1]:4400"]) {
      expect(dialWindowMs({ kind: "alias", alias: "box", record: record(url) }), url).toBe(near);
      expect(dialWindowMs({ kind: "url", url }), url).toBe(near);
    }
    // A hand-edited record can hold any word, and the window is no place to throw over one.
    for (const url of ["https://h5aab7a97cd80893f.singhi.me", "http://box.local:4400", "http://10.0.0.4:4400", "wss://attic.example/ws", "not-an-address", "http://"]) {
      expect(dialWindowMs({ kind: "alias", alias: "box", record: record(url) }), url).toBe(far);
      expect(dialWindowMs({ kind: "url", url }), url).toBe(far);
    }
  });
});

describe("which host a line runs against", () => {
  it("takes the flag over the environment, the environment over the lock here, and the lock over the account's one host", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "attic", record("https://attic.example", "d_attic"));
    const served = servedState();
    const gone = join(tempDir("hosts-empty"), "state.json");
    expect(aimedHost(served, { host: "attic", env: { WSP_HOST: "https://box.example" }, home })).toMatchObject({ kind: "alias", alias: "attic" });
    expect(aimedHost(served, { env: { WSP_HOST: "attic" }, home })).toMatchObject({ kind: "alias", alias: "attic" });
    expect(aimedHost(served, { env: {}, home })).toEqual({ kind: "here" });
    expect(aimedHost(gone, { env: {}, home })).toMatchObject({ kind: "alias", alias: "attic" });
    expect(aimedHost(gone, { env: {}, home: tempDir("hosts-none") })).toEqual({ kind: "here" });
  });

  it("takes a url typed where an alias goes as a host nothing is stored for", () => {
    const home = tempDir("hosts-home");
    expect(aimedHost("/nowhere/state.json", { host: "http://127.0.0.1:14400", env: {}, home })).toEqual({ kind: "url", url: "http://127.0.0.1:14400" });
    expect(aimedHost("/nowhere/state.json", { env: { WSP_HOST: "https://attic.example" }, home })).toEqual({ kind: "url", url: "https://attic.example" });
  });

  it("takes the pair a turn's launch left in the environment over any state file or alias on this computer, under the flag and WSP_HOST", () => {
    const home = tempDir("hosts-home");
    const carried = { WSP_HOST_URL: "http://10.0.0.2:4700", WSP_HOST_TOKEN: "scoped-token", WSP_HOST_KEY: HOST_KEY };
    const aimed = { kind: "url", url: "http://10.0.0.2:4700", token: "scoped-token", hostKey: HOST_KEY };
    const gone = join(tempDir("hosts-empty"), "state.json");
    // On a machine there is no hosts folder and no host of its own, so the pair is the only road there is.
    expect(aimedHost(gone, { env: carried, home })).toEqual(aimed);
    // The pair is the identity the launch handed this turn: a host serving the state file the line names and the
    // account's one host are both this computer's roads, and neither is what the turn was given.
    expect(aimedHost(servedState(4600), { env: carried, home })).toEqual(aimed);
    writeHost(home, "attic", record("https://attic.example", "d_attic"));
    expect(aimedHost(gone, { env: carried, home })).toEqual(aimed);
    // What a person names on the line, or with WSP_HOST, still wins: those are typed, the pair is inherited.
    expect(aimedHost(gone, { host: "attic", env: carried, home })).toMatchObject({ kind: "alias", alias: "attic" });
    expect(aimedHost(gone, { env: { ...carried, WSP_HOST: "attic" }, home })).toMatchObject({ kind: "alias", alias: "attic" });
    // An address with no token beside it opens nothing, so the pair reads as absent.
    expect(aimedHost(gone, { env: { WSP_HOST_URL: "http://10.0.0.2:4700" }, home: tempDir("hosts-none") })).toEqual({ kind: "here" });
    expect(aimedHost(servedState(4600), { env: { WSP_HOST_URL: "http://10.0.0.2:4700" }, home })).toEqual({ kind: "here" });
  });

  it("gives a --host address the token the environment carries for that same address, and nothing for another", () => {
    const home = tempDir("hosts-none");
    const carried = { WSP_HOST_URL: "http://10.0.0.2:4700", WSP_HOST_TOKEN: "scoped-token", WSP_HOST_KEY: HOST_KEY };
    expect(aimedHost("/nowhere/state.json", { host: "http://10.0.0.2:4700", env: carried, home })).toEqual({ kind: "url", url: "http://10.0.0.2:4700", token: "scoped-token", hostKey: HOST_KEY });
    expect(aimedHost("/nowhere/state.json", { host: "http://other.example:4700", env: carried, home })).toEqual({ kind: "url", url: "http://other.example:4700" });
    expect(hostAddress("/nowhere/state.json", { host: "http://10.0.0.2:4700", env: carried, home })).toEqual({ url: `ws://10.0.0.2:4700${WS_PATH}`, token: "scoped-token" });
  });

  it("refuses an aim at a host it holds no key for, whether a record wrote it or a launch carried it", () => {
    const home = tempDir("hosts-home");
    const { hostKey: _gone, ...keyless } = record("https://box.example", "d_old");
    writeHost(home, "box", keyless);
    // A record somebody edited the key out of: the line says which record and what to do, and dials nothing.
    expect(() => aimedHost("/nowhere/state.json", { host: "box", env: {}, home })).toThrow(hostNoKeyLine("box"));
    // A turn a host older than this one launched: the same sentence, naming the launch rather than a record.
    const carried = { WSP_HOST_URL: "https://box.example", WSP_HOST_TOKEN: "scoped-token" };
    expect(() => aimedHost("/nowhere/state.json", { env: carried, home: tempDir("hosts-none") })).toThrow(hostNoKeyLine(LAUNCHED_WITH));
    expect(() => aimedHost("/nowhere/state.json", { host: "https://box.example", env: carried, home: tempDir("hosts-none") })).toThrow(hostNoKeyLine("https://box.example"));
    expect(hostNoKeyLine(LAUNCHED_WITH).split("\n")).toHaveLength(1);
    // The host this computer serves itself, and a line the launch aimed at it over its own loopback: there is no
    // road between two ports of one computer for anybody to stand on, and both dial with the token they hold.
    const here = { WSP_HOST_URL: "http://127.0.0.1:4700", WSP_HOST_TOKEN: "scoped-token" };
    expect(aimedHost("/nowhere/state.json", { env: here, home: tempDir("hosts-none") })).toEqual({ kind: "url", url: "http://127.0.0.1:4700", token: "scoped-token" });
    expect(aimedHost(servedState(4800), { env: {}, home: tempDir("hosts-none") })).toEqual({ kind: "here" });
  });

  it("refuses an alias nothing is stored for in one sentence naming the ones that are", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    expect(() => aimedHost("/nowhere/state.json", { host: "attic", env: {}, home })).toThrow(noSuchHostLine("attic", home));
    expect(noSuchHostLine("attic", home)).toContain("box");
    expect(noSuchHostLine("attic", home).split("\n")).toHaveLength(1);
  });
});

describe("the account hosts a line falls to", () => {
  /** A record wsp hosts wrote off the account's listing: the road it came by and the host's id there, and no token
   * until this computer's first dial. */
  const onAccount = (url: string, hostId: string): HostRecord => ({ url, deviceId: "", deviceToken: "", hostKey: HOST_KEY, pairedAt: "2026-09-22T00:00:00.000Z", via: { kind: "account", hostId } });

  /** A state folder holding a relay record, which is what says the host on this computer is one of the account's. */
  function linkedState(hostId: string): string {
    const dir = tempDir("hosts-linked");
    writeFileSync(join(dir, "relay.json"), JSON.stringify({ relayUrl: "https://relay.example", hostId, token: "t", name: "this-mac", linkedAt: "2026-09-22T00:00:00.000Z" }));
    return join(dir, "state.json");
  }

  it("goes to the one account host that is not this computer when nothing serves here and nothing else named one", () => {
    const home = tempDir("hosts-account");
    writeHost(home, "attic", onAccount("https://hattic.example", "hattic"));
    const aim = aimedHost(linkedState("hbox1"), { env: {}, home });
    expect(aim).toMatchObject({ kind: "alias", alias: "attic" });
    expect(aimedAlias(linkedState("hbox1"), home)).toBe("attic");
    // The record is what a dial reads, so it carries the address and the key off the listing.
    expect(aim.kind === "alias" && aim.record.url).toBe("https://hattic.example");
  });

  it("starts a host here when the account's one host is the host on this computer", () => {
    const home = tempDir("hosts-own");
    writeHost(home, "this-mac", onAccount("https://hbox1.example", "hbox1"));
    expect(aimedHost(linkedState("hbox1"), { env: {}, home })).toEqual({ kind: "here" });
    expect(accountHosts(linkedState("hbox1"), home)).toEqual([]);
    expect(aimedAlias(linkedState("hbox1"), home)).toBeUndefined();
  });

  it("refuses in one sentence naming them when several are on the account, and a name on the line settles it", () => {
    const home = tempDir("hosts-several");
    writeHost(home, "attic", onAccount("https://hattic.example", "hattic"));
    writeHost(home, "cellar", onAccount("https://hcellar.example", "hcellar"));
    const statePath = linkedState("hbox1");
    expect(() => aimedHost(statePath, { env: {}, home })).toThrow(severalAccountHostsLine(["attic", "cellar"]));
    expect(() => aimedHost(statePath, { env: {}, home })).toThrow(/--host <name>/);
    expect(aimedAlias(statePath, home)).toBeUndefined();
    expect(aimedHost(statePath, { host: "cellar", env: {}, home })).toMatchObject({ kind: "alias", alias: "cellar" });
  });

  it("starts a host here when this computer holds no account record, and when a host does serve the state file", () => {
    const home = tempDir("hosts-none-here");
    expect(aimedHost(linkedState("hbox1"), { env: {}, home })).toEqual({ kind: "here" });
    // A host serving this state file wins over the account.
    const served = servedState(4600);
    writeHost(home, "attic", onAccount("https://hattic.example", "hattic"));
    expect(aimedHost(served, { env: {}, home })).toEqual({ kind: "here" });
  });

  it("reads the account off the hosts folder and this computer's own record, with no relay asked", () => {
    const home = tempDir("hosts-offline");
    writeHost(home, "attic", onAccount("https://hattic.example", "hattic"));
    // A computer that is on no account of its own still falls to the record: the rule reads files and nothing else.
    expect(aimedHost("/nowhere/state.json", { env: {}, home })).toMatchObject({ kind: "alias", alias: "attic" });
  });
});

describe("where a verb dials", () => {
  it("gives the loopback address and the host's own token for a host on this computer", () => {
    const statePath = servedState(4500);
    expect(hostAddress(statePath, { env: {}, home: tempDir("hosts-none") })).toEqual({ url: "ws://127.0.0.1:4510", token: "host-token" });
  });

  it("gives the alias's address with the runtime's path and the device token it holds there", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400", "d_box"));
    expect(hostAddress("/nowhere/state.json", { host: "box", env: {}, home })).toEqual({ url: `ws://box.local:4400${WS_PATH}`, token: "tok-d_box" });
  });

  it("gives a url typed on the line no token, which the dial then refuses", () => {
    expect(hostAddress("/nowhere/state.json", { host: "http://127.0.0.1:14400", env: {}, home: tempDir("hosts-none") })).toEqual({
      url: `ws://127.0.0.1:14400${WS_PATH}`,
      token: "",
    });
  });

  it("refuses a state file no host serves in one sentence", () => {
    const gone = join(tempDir("hosts-empty"), "state.json");
    expect(() => hostAddress(gone, { env: {}, home: tempDir("hosts-none") })).toThrow(noHostServingLine(gone));
  });
});

describe("a hosts folder somebody hand-edited", () => {
  it("skips a file that is not a record rather than refusing every listing", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    mkdirSync(hostsDir(home), { recursive: true });
    writeFileSync(join(hostsDir(home), "broken.json"), "{ not json");
    writeFileSync(join(hostsDir(home), "notes.txt"), "hello");
    expect(listHosts(home).map(h => h.alias)).toEqual(["box"]);
    expect(readHost(home, "broken")).toBeUndefined();
  });
});
