// SPDX-License-Identifier: AGPL-3.0-only
// A computer with no machine provider key, driven from the command line: the
// machines the person already has are recorded and listed, and the roads that
// would fork one answer the sentence naming what is missing. Nothing here
// asks for a key, and the ssh client never leaves this computer.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtSize, kindWords, NO_PROVIDER_LINE } from "@wsp/protocol";
import { localShape, NoProviderBackend } from "@wsp/engine";
import { createRuntime, jsonFileStore } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, makeRuntime, noClaudeKeyNote, up } from "../src/cli.js";
import { stateWriterHere } from "../src/version.js";
import { NO_PROJECT_YET } from "../src/verbs.js";
import { noProviderStorageLine } from "../src/storage.js";
import type { HostHandle } from "../src/server.js";
import { fakeSsh } from "../../runtime/test/fake-ssh.js";
import { PAGE, captured, copyingFake, fakeDaemonStart } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

describe("a computer with no machine provider key", () => {
  let dir: string;
  let home: string;
  let webDir: string;
  let statePath: string;
  let handle: HostHandle | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-keyless-"));
    home = join(dir, "user");
    webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "home", "state.json");
    // Pinned off this computer's own key layers: a key on the machine running the suite would make this a cloud run.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("HOME", home);
    vi.stubEnv("WSP_HOME", join(dir, "home"));
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A host serving this state file with no key: the provider module is the one a keyless host wires, and the ssh
   * client is the fake, so a dial proves the road and reaches nothing. The host records this computer as it starts,
   * which is the one workspace a state file with nothing in it gains. */
  async function serving(): Promise<void> {
    const io = captured();
    const rt = createRuntime({
      backend: new NoProviderBackend(),
      store: jsonFileStore(statePath, stateWriterHere()),
      adapters: {},
      local: localWiring(home, undefined, fakeDaemonStart, statePath, copyingFake()),
      ssh: fakeSsh().wiring,
      hostId: "box:h1",
    });
    handle = await up(io, { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    expect(handle).toBeDefined();
    expect(io.errors).toEqual([]);
  }

  it("serves with no key and nothing asked, records no workspace, and lists the one a project here makes", async () => {
    // The whole real wiring, provider module and all, brought up with no key in the environment. The copy road
    // alone is the fake, since every workspace here is a copy and this checkout stages no daemon binary.
    const served = captured();
    handle = await up(served, { port: 0, wsPort: 0, statePath, webDir, runtime: makeRuntime({}, statePath, undefined, process.env, undefined, localWiring(home, process.env, fakeDaemonStart, statePath, copyingFake())) });
    expect(handle).toBeDefined();
    expect(served.errors).toEqual([]);
    // A workspace is one project's copy, so a start records none and the first line says what records one.
    expect(served.lines[0]).toBe(NO_PROJECT_YET);
    // Then the line where a storage listing would have been: this host has no provider to ask and does not ask.
    expect(served.lines[1]).toBe(noProviderStorageLine(statePath));
    expect(served.lines[2]).toBe(`app         http://127.0.0.1:${handle!.port}`);
    // A folder of the person's own, worked in place, is the workspace here.
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-keyless-")));
    execFileSync("git", ["init", "-q", folder]);
    const added = captured();
    expect(await cli(["add", folder, "--state", statePath], added), added.errors.join("\n")).toBe(0);
    const made = captured();
    expect(await cli(["new", "work here", "--state", statePath], made), made.errors.join("\n")).toBe(0);
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as { workspaces: Record<string, { name: string; kind: string }> };
    expect(Object.values(stored.workspaces).map(w => w.kind)).toEqual(["local"]);
    // Nothing forks here, so the missing Claude key is about the threads that run on this computer, not about forks.
    expect(served.lines.at(-1)).toBe(noClaudeKeyNote(true));
    const listed = captured();
    expect(await cli(["workspaces", "--state", statePath], listed)).toBe(0);
    // The listing's machine cell is this computer's cores and memory, the size line its sidebar row reads, off the
    // same os facts the local backend records; this runs on the real machine, so the line is computed, not spelled.
    expect(listed.lines[0]).toContain(fmtSize(localShape(), kindWords("local").cpu));
    expect(listed.lines[0]).toMatch(/\d+\u00a0cores,\u00a0\d+\u00a0GB/);
  });

  it("answers the sentence naming what is missing on every road that would fork a machine, once and with nothing before it", async () => {
    await serving();
    // Two roads to a copy, whose own refusals would each name a second road that cannot be taken here.
    // A project on the computer this host forks at, which forks nothing here: every road to a copy of it names the
    // one sentence, and nothing is minted.
    expect(await cli(["add", "https://github.com/dev/proj.git", "--on", "default", "--state", statePath], captured())).toBe(0);
    for (const argv of [["new", "proj", "alpha"], ["new", "proj", "beta", "--from", "proj"]]) {
      const road = argv.join(" ");
      const asked = captured();
      expect([road, await cli([...argv, "--state", statePath], asked)]).toEqual([road, 1]);
      expect([road, asked.errors]).toEqual([road, [`wsp ${argv[0]}: ${NO_PROVIDER_LINE}`]]);
      // Nothing on stdout and no stage streamed: no machine was ever going to be minted here.
      expect([road, asked.lines, asked.streamed]).toEqual([road, [], ""]);
    }
  });
});
