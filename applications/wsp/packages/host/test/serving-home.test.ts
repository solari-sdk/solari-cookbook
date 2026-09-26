// SPDX-License-Identifier: AGPL-3.0-only
// Which home a line works on when it names none. The reading has two
// spellings, one for this computer and one in sh for a box answering over
// ssh before any wsp of its own has run, so every case here is put to both
// and they have to agree: the desktop's probe and the box's own wsp host pair
// cannot pick different homes.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultStatePath, devCheckoutState, optsFor, statePick } from "../src/cli.js";
import { servingHost } from "../src/host-lock.js";
import { SERVING_HOME_SH, servingElsewhere, servingHome } from "../src/serving-home.js";

let dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A computer with a home directory of its own and a second wsp home beside it, the way a box that moved its home
 * with WSP_HOME has. */
function computer(): { user: string; own: string; moved: string } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-serving-home-"));
  dirs.push(dir);
  const user = join(dir, "user");
  const own = join(user, ".wsp");
  const moved = join(dir, "moved");
  for (const d of [own, moved]) mkdirSync(d, { recursive: true });
  return { user, own, moved };
}

/** What makes a folder a checkout of wsp: its own root package.json naming the workspace. A folder holding keys and
 * nothing else is not one, which is the whole point of the marker. */
const checkoutAt = (dir: string): void => writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "wsp", private: true })}\n`);

const lockOn = (home: string, pid: number): void =>
  writeFileSync(join(home, "host.lock"), JSON.stringify({ pid, port: 4400, wsPort: 4410, address: "127.0.0.1", startedAt: "2026-09-11T10:00:00.000Z" }));

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

interface Reading {
  home: string;
  serving: boolean;
}

/** The sh spelling put the same question, on the same folders: the home it settles on, and what its own liveness
 * test says about it, which is what the probe prints as a lock or as none. */
function inSh(user: string, env: Record<string, string>): Reading {
  const script = `${SERVING_HOME_SH}\nif wsp_serving "$home"; then echo serving; else echo none; fi\necho "$home"`;
  const out = execFileSync("/bin/sh", ["-c", script], { env: { PATH: "/usr/bin:/bin", HOME: user, ...env }, encoding: "utf8" });
  const [serving, home] = out.trim().split("\n");
  return { home: home!, serving: serving === "serving" };
}

/** Both spellings, held to the same answer before the answer is read. */
function reading(user: string, env: Record<string, string> = {}): Reading {
  const home = servingHome(env, user);
  const here: Reading = { home, serving: servingHost(join(home, "state.json")) !== undefined };
  expect(inSh(user, env)).toEqual(here);
  return here;
}

describe("the home this computer's host serves", () => {
  it("is WSP_HOME when it names one and this computer's own otherwise, whatever stands under that home, in sh as here", () => {
    const { user, own, moved } = computer();
    expect(reading(user)).toEqual({ home: own, serving: false });

    // A host serving a home somebody moved changes nothing for a line that names no home: the person names that
    // home with WSP_HOME or --state, and no file under their own home speaks for it.
    lockOn(moved, process.pid);
    expect(reading(user)).toEqual({ home: own, serving: false });
    expect(reading(user, { WSP_HOME: moved })).toEqual({ home: moved, serving: true });

    // A home named outright is the home, serving or not.
    expect(reading(user, { WSP_HOME: own })).toEqual({ home: own, serving: false });

    // The host under the moved home is gone; nothing about this computer's own reading changes with it.
    lockOn(moved, deadPid());
    expect(reading(user, { WSP_HOME: moved })).toEqual({ home: moved, serving: false });

    lockOn(own, process.pid);
    expect(reading(user)).toEqual({ home: own, serving: true });
  });

  it("names the state a host here serves when a line works on another, and nothing when they are the same", () => {
    const { user, own, moved } = computer();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "wsp-checkout-")), ".wsp", "state.json");
    dirs.push(dirname(dirname(elsewhere)));

    // Nothing is serving on this computer, so there is no other state to name.
    expect(servingElsewhere(elsewhere, {}, user)).toBeUndefined();

    lockOn(own, process.pid);
    expect(servingElsewhere(elsewhere, {}, user)).toBe(join(own, "state.json"));
    // The state the host serves is the state this line works on: nothing to say.
    expect(servingElsewhere(join(own, "state.json"), {}, user)).toBeUndefined();

    // A host under a moved home is named by the line that wants it, and this reading answers for that home then.
    lockOn(moved, process.pid);
    expect(servingElsewhere(elsewhere, { WSP_HOME: moved }, user)).toBe(join(moved, "state.json"));
    // A line that names no home reads this computer's own, whatever else is serving beside it.
    expect(servingElsewhere(elsewhere, {}, user)).toBe(join(own, "state.json"));

    // One folder reached by two names is one state, which is what /tmp and /private/tmp are on a Mac.
    const link = join(dirname(own), ".wsp-link");
    symlinkSync(own, link);
    expect(servingElsewhere(join(link, "state.json"), {}, user)).toBeUndefined();
  });

  it("is the state file every verb that names none works on, and a dev checkout keeps its own", () => {
    const { user, own, moved } = computer();
    const cwd = mkdtempSync(join(tmpdir(), "wsp-serving-cwd-"));
    dirs.push(cwd);
    vi.stubEnv("HOME", user);
    expect(defaultStatePath(cwd, {})).toBe(join(own, "state.json"));

    lockOn(moved, process.pid);
    expect(defaultStatePath(cwd, { WSP_HOME: moved })).toBe(join(moved, "state.json"));
    expect(defaultStatePath(cwd, { WSP_HOME: own })).toBe(join(own, "state.json"));

    // Keys alone say nothing about a folder: the wsp home itself holds a .env, and a line typed in it must still
    // reach the home it names rather than an empty state under ~/.wsp/.wsp.
    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=slr_live_fake\n");
    expect(defaultStatePath(cwd, { WSP_HOME: moved })).toBe(join(moved, "state.json"));

    // A checkout of wsp is the reading where nothing names a state.
    checkoutAt(cwd);
    expect(defaultStatePath(cwd, {})).toBe(join(cwd, ".wsp", "state.json"));

    // The two readings above are the only lines that pick a state, so wsp host pair, wsp host devices and every other verb
    // or command that names no --state comes through this one rule.
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const calls = source
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.includes("statePick(") && !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("export function"));
    expect(calls).toEqual(["return statePick(undefined, cwd, env).path;", "const pick = statePick(flag, process.cwd(), env);"]);
  });

  it("keeps a state the person named: WSP_HOME over a checkout, --state over both, and says which one ran", () => {
    const { user, own, moved } = computer();
    const cwd = mkdtempSync(join(tmpdir(), "wsp-state-pick-"));
    dirs.push(cwd);
    vi.stubEnv("HOME", user);
    checkoutAt(cwd);

    const named = statePick(undefined, cwd, { WSP_HOME: moved });
    expect(named.path).toBe(join(moved, "state.json"));
    expect(named.note).toContain("WSP_HOME");
    expect(named.note).toContain(join(moved, "state.json"));
    expect(named.note).toContain(join(cwd, ".wsp", "state.json"));

    const flagged = statePick(join(own, "state.json"), cwd, { WSP_HOME: moved });
    expect(flagged.path).toBe(join(own, "state.json"));
    expect(flagged.note).toContain("--state");
    expect(flagged.note).toContain(join(cwd, ".wsp", "state.json"));

    // Nothing names a state, so the checkout keeps its own, and there is nothing to say about it.
    expect(statePick(undefined, cwd, {})).toEqual({ path: join(cwd, ".wsp", "state.json") });

    // A checkout that names the state which won is not a disagreement.
    expect(statePick(undefined, cwd, { WSP_HOME: join(cwd, ".wsp") }).note).toBeUndefined();

    // Nor is one folder reached by two names, which is what /tmp and /private/tmp are on a Mac.
    mkdirSync(join(cwd, ".wsp"), { recursive: true });
    writeFileSync(join(cwd, ".wsp", "state.json"), "{}\n");
    const link = join(dirname(cwd), `${basename(cwd)}-link`);
    symlinkSync(cwd, link);
    dirs.push(link);
    expect(statePick(undefined, link, { WSP_HOME: join(cwd, ".wsp") }).note).toBeUndefined();
  });

  it("a folder that only holds keys is not a checkout, and this repository's own root is", () => {
    const { user, moved } = computer();
    vi.stubEnv("HOME", user);
    lockOn(moved, process.pid);

    // The person's own state home: wsp writes their provider keys into ~/.wsp/.env and the state file is right
    // there too, so a folder holding both must not answer off ~/.wsp/.wsp/state.json, which nothing ever wrote.
    const home = mkdtempSync(join(tmpdir(), "wsp-keys-only-"));
    dirs.push(home);
    writeFileSync(join(home, ".env"), "SOLARI_API_KEY=slr_live_fake\n");
    mkdirSync(join(home, ".wsp"), { recursive: true });
    writeFileSync(join(home, ".wsp", "state.json"), "{}\n");
    expect(devCheckoutState(home)).toBeUndefined();
    expect(defaultStatePath(home, { WSP_HOME: moved })).toBe(join(moved, "state.json"));

    // A folder carrying a package.json of some other project is not this one either.
    const other = mkdtempSync(join(tmpdir(), "wsp-other-repo-"));
    dirs.push(other);
    writeFileSync(join(other, "package.json"), `${JSON.stringify({ name: "something-else" })}\n`);
    expect(devCheckoutState(other)).toBeUndefined();

    // The repository this test runs out of is one, read off the file it really carries.
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    expect(devCheckoutState(repo)).toBe(join(repo, ".wsp", "state.json"));
  });

  it("gives the commands that parse flags the same reading and the same sentence", () => {
    const { user, moved } = computer();
    const cwd = mkdtempSync(join(tmpdir(), "wsp-state-opts-"));
    dirs.push(cwd);
    vi.stubEnv("HOME", user);
    checkoutAt(cwd);
    const back = process.cwd();
    process.chdir(cwd);
    try {
      const said: string[] = [];
      expect(optsFor({}, { WSP_HOME: moved }, line => said.push(line)).statePath).toBe(join(moved, "state.json"));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("WSP_HOME");
      said.length = 0;
      expect(optsFor({ state: join(moved, "other.json") }, { WSP_HOME: moved }, line => said.push(line)).statePath).toBe(join(moved, "other.json"));
      expect(said[0]).toContain("--state");
      said.length = 0;
      expect(optsFor({}, {}, line => said.push(line)).statePath).toBe(resolve(process.cwd(), ".wsp", "state.json"));
      expect(said).toEqual([]);
    } finally {
      process.chdir(back);
    }
  });
});
