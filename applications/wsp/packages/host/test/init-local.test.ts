// SPDX-License-Identifier: AGPL-3.0-only
// wsp init with no machine provider key: what it says it will not do, the one
// workspace it makes, and the app it opens on it. Nothing here touches a
// provider: the runtime's provider module is the one that holds no machine.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { LocalBackend, NoProviderBackend } from "@wsp/engine";
import { HERE_PLACE_ID, NO_PROVIDER_LINE } from "@wsp/protocol";
import { createRuntime, localExecStream, memoryStore, type LocalWiring, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { ALSO_LOCAL_QUESTION } from "../src/init-first.js";
import { hostPlatform } from "../src/verbs.js";
import { noKeyLines, runLocalInit, type LocalInitOptions } from "../src/init-local.js";
import { KEY_LAYER_WORDS } from "../src/env-keys.js";
import type { InitIO } from "../src/init.js";
import type { HostHandle, WorkspaceRoads } from "../src/server.js";
import { copyingFake, createOn, projectOn } from "./verbs-fixture.js";

const ENTER = "\r";
/** The code the fake host mints for the browser init opens, which the address the run opens carries. */
const CODE = "7K3MQP2X";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fake {
  io: InitIO;
  opts: LocalInitOptions;
  text: () => string;
  press: (...keys: string[]) => Promise<void>;
  until: (needle: string) => Promise<void>;
  runtime: () => Runtime;
  trail: string[];
  hosts: number;
  closed: number;
  records: Record<string, unknown>[];
}

/** This computer as the run holds it: a real local backend over a scratch folder and the provider module a keyless
 * host wires, so every road this test does not take refuses the way it does on a person's machine. */
function localWiring(root: string): LocalWiring {
  return {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({}),
    platform: hostPlatform(),
    copier: copyingFake(),
  };
}

function fake(over: { tty?: boolean; nonInteractive?: boolean; yes?: boolean; json?: boolean } = {}): Fake {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = Object.assign(new PassThrough(), { isTTY: over.tty ?? true });
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  stderr.on("data", (c: Buffer) => chunks.push(c.toString()));
  const root = mkdtempSync(join(tmpdir(), "wsp-init-local-"));
  dirs.push(root);
  const store: Store = memoryStore();
  const trail: string[] = [];
  const records: Record<string, unknown>[] = [];
  const counters = { hosts: 0, closed: 0 };
  let built: Runtime | undefined;
  const io: InitIO = {
    input,
    output,
    stderr,
    isTTY: over.tty ?? true,
    env: {},
    open: async url => {
      trail.push(`open ${url}`);
      return true;
    },
    signals: new EventEmitter(),
    exit: () => {},
    ...(over.json === true ? { json: (record: Record<string, unknown>) => records.push(record) } : {}),
  };
  const roads = (rt: Runtime): WorkspaceRoads => ({
    createWorkspace: async () => { trail.push("local"); return createOn(rt, { on: HERE_PLACE_ID, name: "this-mac" }); },
    addProject: (source: string) => projectOn(rt, HERE_PLACE_ID, source),
    planProject: async () => { throw new Error("no project in this fixture"); },
    importProject: async () => { throw new Error("no project in this fixture"); },
  });
  const repo = realpathSync(mkdtempSync(join(root, "this-mac-")));
  execFileSync("git", ["init", "-q", repo]);
  const opts: LocalInitOptions = {
    yes: over.yes ?? false,
    ...(over.nonInteractive === true ? { nonInteractive: true } : {}),
    statePath: join(root, "state.json"),
    ports: { port: 0, wsPort: 0, named: true },
    upCommand: "wsp up",
    // A workspace here is a folder of the person's own worked in place, so the tick needs a folder to record.
    importFolder: repo,
    runtime: () => (built ??= createRuntime({ backend: new NoProviderBackend(), store, adapters: {}, local: localWiring(root), hostId: "box:h1" })),
    roads,
    host: async rt => {
      counters.hosts += 1;
      return { port: 4400, wsPort: 4410, authToken: "tok", revokeDevice: async () => false, hereCode: async () => CODE, door: { open: async () => ({ port: 4420, addresses: ["http://192.168.1.20:4420"] }), port: () => 4420, close: async () => {} }, ...roads(rt), close: async () => void (counters.closed += 1) };
    },
  };
  const press = async (...keys: string[]): Promise<void> => {
    for (const k of keys) {
      input.write(k);
      await new Promise(r => setTimeout(r, 5));
    }
  };
  const until = async (needle: string, ms = 2000): Promise<void> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (stripVTControlCharacters(chunks.join("")).includes(needle)) return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`never saw ${needle} in:\n${stripVTControlCharacters(chunks.join(""))}`);
  };
  return {
    io,
    opts,
    text: () => stripVTControlCharacters(chunks.join("")),
    press,
    until,
    runtime: () => opts.runtime(),
    trail,
    records,
    get hosts() {
      return counters.hosts;
    },
    get closed() {
      return counters.closed;
    },
  };
}

describe("wsp init with no provider key", () => {
  it("names the file a key goes in with the one spelling every other line about those files uses", () => {
    expect(noKeyLines("wsp up").join("\n")).toContain(KEY_LAYER_WORDS);
  });

  it("says there is no provider before it does anything, makes this computer the workspace, and opens the app on it", async () => {
    const f = fake({ tty: true });
    const run = runLocalInit(f.opts, f.io);
    await f.until(ALSO_LOCAL_QUESTION);
    await f.press(ENTER);
    const result = await run;
    expect(result.code).toBe(0);
    const workspaces = await f.runtime().workspaces.list();
    expect(workspaces.map(w => ({ name: w.name, kind: w.kind }))).toEqual([{ name: "this-mac", kind: "local" }]);
    // The browser is opened on a page in the host's run folder that sends it to the address, which carries the
    // code the host minted for it: that browser is the owner's, and the code rides no process argument.
    expect(f.trail).toEqual(["local", expect.stringMatching(/^open .*\/runs\/open-[0-9a-f]+\.html$/)]);
    expect(readFileSync(f.trail[1]!.slice("open ".length), "utf8")).toContain(`url=http://127.0.0.1:4400/#w/${workspaces[0]!.id}/c/${CODE}`);
    const out = f.text();
    expect(out).toContain(`Opened http://127.0.0.1:4400/#w/${workspaces[0]!.id}/c/${CODE}`);
    expect(out).toContain(NO_PROVIDER_LINE);
    expect(out).toContain("So this run seals nothing and boots nothing.");
    expect(out).toContain(`Workspace this-mac (${workspaces[0]!.id}) is a copy of `);
    expect(out).toContain("on this computer; its threads run here, under your own sign-ins.");
    // Nothing was built or sealed: the only mention of a golden is the offer to add one later.
    expect(out).not.toMatch(/Sealing|is sealed|Forking/);
    expect(f.hosts).toBe(1);
  });

  it("over ssh, a run told to bind beyond this computer prints that address and no forward, and opens no browser", async () => {
    const f = fake({ tty: true });
    f.io.env["SSH_CONNECTION"] = "10.0.0.2 51000 10.0.0.9 22";
    f.opts.address = "100.64.0.3";
    const run = runLocalInit(f.opts, f.io);
    await f.until(ALSO_LOCAL_QUESTION);
    await f.press(ENTER);
    expect((await run).code).toBe(0);
    const workspaces = await f.runtime().workspaces.list();
    expect(f.trail).toEqual(["local"]);
    const out = f.text();
    expect(out).toContain(`Open http://100.64.0.3:4400/#w/${workspaces[0]!.id}/c/${CODE}`);
    expect(out).not.toContain("ssh -L");
  });

  it("No at the tick leaves the state empty and says what would fill it", async () => {
    const f = fake({ tty: true });
    const run = runLocalInit(f.opts, f.io);
    await f.until(ALSO_LOCAL_QUESTION);
    await f.press("n");
    expect((await run).code).toBe(0);
    expect(await f.runtime().workspaces.list()).toEqual([]);
    // No workspace, so the address names none and carries the code alone.
    expect(f.trail).toEqual([expect.stringMatching(/^open .*\/runs\/open-[0-9a-f]+\.html$/)]);
    expect(readFileSync(f.trail[0]!.slice("open ".length), "utf8")).toContain(`url=http://127.0.0.1:4400/#c/${CODE}`);
  });

  it("a second run on the same state opens the app on the workspace already here and asks nothing", async () => {
    const f = fake({ tty: true });
    const first = runLocalInit(f.opts, f.io);
    await f.until(ALSO_LOCAL_QUESTION);
    await f.press(ENTER);
    await first;
    const workspaces = await f.runtime().workspaces.list();
    f.trail.splice(0);
    expect((await runLocalInit(f.opts, f.io)).code).toBe(0);
    expect(f.text()).toContain(`this-mac (${workspaces[0]!.id}) is already the workspace here; this run opens the app on it.`);
    expect(f.trail).toEqual([expect.stringMatching(/^open .*\/runs\/open-[0-9a-f]+\.html$/)]);
    expect(readFileSync(f.trail[0]!.slice("open ".length), "utf8")).toContain(`url=http://127.0.0.1:4400/#w/${workspaces[0]!.id}/c/${CODE}`);
    // One local workspace per host: the second run made none.
    expect((await f.runtime().workspaces.list()).map(w => w.name)).toEqual(["this-mac"]);
  });

  it("with nobody at a terminal the tick is taken, no app is served, and the last object names the workspace", async () => {
    const f = fake({ tty: false, nonInteractive: true, json: true });
    const result = await runLocalInit(f.opts, f.io);
    expect(result.code).toBe(0);
    expect(result.handle).toBeUndefined();
    const workspaces = await f.runtime().workspaces.list();
    expect(workspaces.map(w => w.name)).toEqual(["this-mac"]);
    expect(f.hosts).toBe(0);
    expect(f.trail).toEqual(["local"]);
    expect(f.records).toEqual([{ event: "done", nextCommand: "wsp up", workspace: { id: workspaces[0]!.id, name: "this-mac" } }]);
    expect(f.text()).toContain("Done. wsp up starts the app on this-mac.");
  });

  it("a host that will not start ends the run with the command that starts it again, and the workspace stays", async () => {
    const f = fake({ tty: true });
    f.opts.host = async () => { throw new Error("port 4400 is held"); };
    const run = runLocalInit(f.opts, f.io);
    const result = await run;
    expect(result.code).toBe(1);
    expect(f.text()).toContain("port 4400 is held");
    expect(f.text()).toContain("The app did not start; fix that and run wsp up, with --port when a port is taken.");
  });

  it("a state holding machines this host has no key for refuses with the provider's sentence, before the tick or the app", async () => {
    const f = fake({ tty: true });
    const real = f.opts.runtime;
    let closed = 0;
    f.opts.runtime = () => {
      const rt = real();
      const list = async (): Promise<never> => { throw new Error(NO_PROVIDER_LINE); };
      const close = async (): Promise<void> => void (closed += 1);
      return { ...rt, workspaces: { ...rt.workspaces, list }, close };
    };
    await expect(runLocalInit(f.opts, f.io)).rejects.toThrow(NO_PROVIDER_LINE);
    expect(f.text()).not.toContain(ALSO_LOCAL_QUESTION);
    expect(f.text()).not.toContain("was not made a workspace");
    expect(f.hosts).toBe(0);
    expect(closed).toBe(1);
  });
});
