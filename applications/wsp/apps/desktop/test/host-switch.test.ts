// SPDX-License-Identifier: AGPL-3.0-only
// The window moves between hosts: the session it holds changes, the origin
// gate every bridge call reads follows it, the app's own host is left running,
// and the hosts file the command line reads is the one list.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialHost, readHost, writeHost, type HostRecord } from "@wsp/host";
import { hostNoKeyLine } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSession } from "../src/host-lifecycle.js";
import { hostSwitcher, type SwitcherDeps } from "../src/host-switch.js";
import { fromAppPage } from "../src/origin.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-switch-"));
  dirs.push(dir);
  return dir;
}

function local(): HostSession & { closes: number } {
  const session = {
    url: "http://127.0.0.1:41000",
    port: 41000,
    owned: true,
    remote: false,
    label: "This Mac",
    closes: 0,
    close: async () => {
      session.closes += 1;
    },
  };
  return session;
}

/** A record wsp hosts wrote off the account's listing, holding the token an earlier dial took. */
const accountRecord = (url: string, over: Partial<HostRecord> = {}): HostRecord => ({ url, deviceId: "d_1", deviceToken: "tok-1", pairedAt: "2026-09-11T10:00:00.000Z", hostKey: "SHA256:box", via: { kind: "account", hostId: "hbox1" }, ...over });

/** A socket that carries nothing: what the window asks a dial for is the token, not a conversation. */
const stubClient = (): Awaited<ReturnType<typeof dialHost>> => ({
  request: async <T extends Record<string, unknown>>(): Promise<T> => ({}) as T,
  events: async () => {},
  onFrame: () => () => {},
  closed: Promise.resolve(),
  closeWords: () => "",
  close: () => {},
  terminate: () => {},
});

/** The command line's dial as the window uses it: it writes the token the host answered this computer's key with
 * into the record under that alias, which is what the real one does on the admit road, and leaves a record that
 * already holds a token as it is when nothing is answered. */
function admittingDial(home: string, answered: { deviceId: string; deviceToken: string } | Record<string, never> = {}): { dial: typeof dialHost; dialled: string[] } {
  const dialled: string[] = [];
  return {
    dialled,
    dial: async (_statePath, opts = {}) => {
      const aim = opts.aim;
      if (aim?.kind !== "alias") throw new Error(`the window dialled ${JSON.stringify(aim)} rather than a host on the account`);
      dialled.push(aim.alias);
      writeHost(home, aim.alias, { ...aim.record, ...answered });
      return stubClient();
    },
  };
}

type Deps = Omit<SwitcherDeps, "local"> & { local: ReturnType<typeof local>; loaded: HostSession[]; opened: string[] };

function deps(over: Partial<Omit<SwitcherDeps, "local">> = {}): Deps {
  const loaded: HostSession[] = [];
  const opened: string[] = [];
  const dir = over.home ?? home();
  return {
    local: local(),
    home: dir,
    dial: admittingDial(dir).dial,
    statePath: "/nowhere/state.json",
    here: "This Mac",
    load: async (session, hash) => {
      loaded.push(session);
      opened.push(`${session.url}${hash ?? ""}`);
    },
    log: () => {},
    loaded,
    opened,
    ...over,
  };
}

describe("hostSwitcher", () => {
  it("starts on this computer, and the view lists every host on the account with none marked", () => {
    const d = deps();
    writeHost(d.home, "box", accountRecord("http://127.0.0.1:14400"));
    const switcher = hostSwitcher(d);
    expect(switcher.current()).toBe(d.local);
    expect(switcher.view()).toEqual({ here: "This Mac", current: null, hosts: [{ alias: "box", url: "http://127.0.0.1:14400" }] });
    expect(switcher.token()).toBeUndefined();
  });

  it("the page of the host here is answered that host's own token, read beside the state it serves", () => {
    const dir = home();
    writeFileSync(join(dir, "host-token"), "host-tok\n");
    const switcher = hostSwitcher(deps({ statePath: join(dir, "state.json") }));
    expect(switcher.token()).toBe("host-tok");
  });

  it("on a host somewhere else the answer is that host's device token, and this computer's own comes back on return", async () => {
    const dir = home();
    writeFileSync(join(dir, "host-token"), "host-tok\n");
    const d = deps({ statePath: join(dir, "state.json") });
    writeHost(d.home, "box", accountRecord("http://127.0.0.1:14400"));
    const switcher = hostSwitcher(d);
    expect(await switcher.to("box")).toEqual({ ok: true });
    expect(switcher.token()).toBe("tok-1");
    expect(await switcher.to(null)).toEqual({ ok: true });
    expect(switcher.token()).toBe("host-tok");
  });

  it("switching reassigns the session, the origin gate follows it, and the app's own host keeps running", async () => {
    const d = deps();
    writeHost(d.home, "box", accountRecord("http://127.0.0.1:14400"));
    const switcher = hostSwitcher(d);
    // The gate every bridge call reads is the origin of the host the window is on, read at call time.
    const gate = (frame: string): boolean => fromAppPage(frame, switcher.current().url);
    expect(gate("http://127.0.0.1:41000/")).toBe(true);
    expect(await switcher.to("box")).toEqual({ ok: true });
    expect(switcher.current()).toMatchObject({ url: "http://127.0.0.1:14400", remote: true, alias: "box", label: "box", deviceToken: "tok-1" });
    expect(switcher.token()).toBe("tok-1");
    expect(gate("http://127.0.0.1:14400/workspaces/w1")).toBe(true);
    expect(gate("http://127.0.0.1:41000/")).toBe(false);
    expect(switcher.view().current).toBe("box");
    expect(d.loaded.map(s => s.url)).toEqual(["http://127.0.0.1:14400"]);
    expect(await switcher.to(null)).toEqual({ ok: true });
    expect(switcher.current()).toBe(d.local);
    expect(gate("http://127.0.0.1:41000/")).toBe(true);
    expect(d.local.closes).toBe(0);
  });

  it("dials a host on the account once before the move, so a token it no longer takes is renewed and the page is handed the fresh one", async () => {
    const d = deps();
    writeHost(d.home, "box", accountRecord("https://hbox1.boxes.example", { deviceId: "", deviceToken: "" }));
    const { dial, dialled } = admittingDial(d.home, { deviceId: "d_2", deviceToken: "tok-fresh" });
    const switcher = hostSwitcher({ ...d, dial });
    expect(await switcher.to("box")).toEqual({ ok: true });
    expect(dialled).toEqual(["box"]);
    expect(switcher.current()).toMatchObject({ url: "https://hbox1.boxes.example", remote: true, alias: "box", deviceToken: "tok-fresh" });
    expect(switcher.token()).toBe("tok-fresh");
    // The record carries what the host answered, so the next launch opens on it with no dial of its own.
    expect(readHost(d.home, "box")).toMatchObject({ deviceId: "d_2", deviceToken: "tok-fresh" });
  });

  it("a host on the account that refuses this computer says so in its own words, and the window stays where it was", async () => {
    const d = deps();
    writeHost(d.home, "box", accountRecord("https://hbox1.boxes.example"));
    const dial: typeof dialHost = async () => {
      throw Object.assign(new Error("this host admits no device under that key"), { kind: "auth" });
    };
    const switcher = hostSwitcher({ ...d, dial });
    expect(await switcher.to("box")).toEqual({ ok: false, error: "this host admits no device under that key" });
    expect(switcher.current()).toBe(d.local);
    expect(d.loaded).toEqual([]);
  });

  it("refuses a record on the account holding a token and no key for the host before any dial, as every verb does", async () => {
    const d = deps();
    writeHost(d.home, "box", accountRecord("https://hbox1.boxes.example", { hostKey: undefined }));
    const { dial, dialled } = admittingDial(d.home, { deviceId: "d_2", deviceToken: "tok-fresh" });
    const switcher = hostSwitcher({ ...d, dial });
    expect(await switcher.to("box")).toEqual({ ok: false, error: hostNoKeyLine("box") });
    expect(dialled).toEqual([]);
    expect(switcher.current()).toBe(d.local);
    expect(d.loaded).toEqual([]);
  });

  it("does not list this computer's own host on the account, which the row for this computer already is", () => {
    const dir = home();
    const d = deps({ home: dir, statePath: join(dir, "state.json") });
    writeFileSync(join(dir, "relay.json"), JSON.stringify({ relayUrl: "https://relay.example", hostId: "hmac", token: "host-relay-token", name: "macbook", linkedAt: "2026-09-20T09:00:00.000Z" }));
    writeHost(dir, "macbook", accountRecord("https://hmac.boxes.example", { via: { kind: "account", hostId: "hmac" } }));
    writeHost(dir, "box", accountRecord("https://hbox1.boxes.example"));
    // A file a pairing code left names no account and is read as no record, so it is no row either.
    mkdirSync(join(dir, "hosts"), { recursive: true });
    writeFileSync(join(dir, "hosts", "lan.json"), JSON.stringify({ url: "http://192.168.1.9:4400", deviceId: "d_9", deviceToken: "t", pairedAt: "2026-09-01T00:00:00.000Z" }));
    expect(hostSwitcher(d).view().hosts.map(h => h.alias)).toEqual(["box"]);
  });

  it("a switch to a host this computer holds no record for is refused in one sentence and moves nothing", async () => {
    const d = deps();
    const switcher = hostSwitcher(d);
    const answer = await switcher.to("attic");
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error).toMatch(/no host named attic/);
    expect(switcher.current()).toBe(d.local);
    expect(d.loaded).toEqual([]);
  });
});

