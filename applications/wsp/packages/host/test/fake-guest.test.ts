// SPDX-License-Identifier: AGPL-3.0-only
// The guest a stand-in provider's machines get: where one process keeps a
// machine's daemon token, and that everything it started goes when its command
// is done.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { standInMachinePath } from "@wsp/protocol";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { closeStandInGuests, fakeGuestAt, fakeNoPortLine, guestPath, inGuestRoot } from "../src/fake-guest.js";
import { onPath, thisComputersPath } from "../src/mcp-install.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

describe("a stand-in machine's guest", () => {
  const made: string[] = [];
  afterEach(async () => {
    await closeStandInGuests();
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const throwaway = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-fake-guest-test-"));
    made.push(dir);
    return dir;
  };

  it("keeps each process's daemon token in a file of its own, since the machine's folder is shared and its token is not", () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const held = guest.tokenPath("fk_c0ffee");
    // The folder is the machine's disk and two processes look at the same one; the token is the runtime's, and a
    // second process writing its own over the first left the host serving the app holding a token its own daemon
    // had stopped reading, so the terminal, the files and the live rows went dark until it was restarted.
    expect(held.startsWith(`${standInMachinePath(root, "fk_c0ffee")}/`)).toBe(true);
    expect(held).toContain(String(process.pid));
    expect(guest.folder("fk_c0ffee")).toBe(standInMachinePath(root, "fk_c0ffee"));
  });

  it("starts a daemon at the first road asked for and takes it away when the command that asked is done", async () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const reach = await guest.reach("fk_c0ffee", 7070);
    expect(reach.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // A daemon that opened its own port is a reason this process stays: a verb that dialled one printed its whole
    // answer and then sat at a prompt that never came back.
    expect((await fetch(reach.url)).status).toBe(426);
    expect(existsSync(guest.tokenPath("fk_c0ffee"))).toBe(true);
    await closeStandInGuests();
    await expect(fetch(reach.url)).rejects.toThrow();
  }, 20_000);

  it("leaves no daemon behind when the host that spawned it is stopped", async () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const reach = await guest.reach("fk_c0ffee", 7070);
    const argv = execFileSync("ps", ["-ax", "-o", "args="], { encoding: "utf8" });
    expect(argv).toContain(guest.tokenPath("fk_c0ffee"));
    // The daemon is a child process now, and a child outlives the parent that spawned it: a lab whose host was
    // stopped left one of these running on the person's computer per machine a tester had opened.
    await closeStandInGuests();
    expect(execFileSync("ps", ["-ax", "-o", "args="], { encoding: "utf8" })).not.toContain(guest.tokenPath("fk_c0ffee"));
    await expect(fetch(reach.url)).rejects.toThrow();
  }, 20_000);

  it("answers a Linux guest's own folders inside the machine's folder, and leaves every other path alone", () => {
    const at = "/Users/Shared/wsp-lab/dev/.wsp/stand-in/fk_c0ffee";
    // A guest writes its home, the files its boot writes, and the folder a transfer stages bytes through; on this
    // computer each of those is either the person's own or a folder nothing may write, so a fork printed
    // "sethostname: Operation not permitted" at its birth and "ls: /root" at every pause.
    expect(inGuestRoot(at, "ls -A /root")).toBe(`ls -A ${at}/root`);
    expect(inGuestRoot(at, "hostname web && echo web > /etc/hostname")).toBe(`hostname web && echo web > ${at}/etc/hostname`);
    expect(inGuestRoot(at, "cat '/tmp/wsp-vault-in.tgz' | tar xzf - -C '/' --no-same-owner")).toBe(`cat '${at}/tmp/wsp-vault-in.tgz' | tar xzf - -C '${at}/' --no-same-owner`);
    // The commands themselves live under /usr and /bin, and a shell whose own binaries moved has nothing to run.
    expect(inGuestRoot(at, "df -Pk /usr; /bin/echo hi; grep -qw overlay /proc/filesystems")).toBe("df -Pk /usr; /bin/echo hi; grep -qw overlay /proc/filesystems");
    // A slash inside a word is not a path this rewrites: a sed script and a shell expansion both carry one.
    expect(inGuestRoot(at, "sed -n 's/^export //p'; echo ${shell##*/}")).toBe("sed -n 's/^export //p'; echo ${shell##*/}");
    // The same table read as one path, which is the road bytes land on.
    expect(guestPath(at, "/root/.wsp/machine-context.md")).toBe(`${at}/root/.wsp/machine-context.md`);
    expect(guestPath(at, "/")).toBe(`${at}/`);
    expect(guestPath(at, `${at}/.wsp-daemon-token-9`)).toBe(`${at}/.wsp-daemon-token-9`);
  });

  it("names the machine without a line of stderr and lands the bytes a machine's own context travels as", async () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const at = guest.folder("fk_c0ffee");
    const run = guest.shell!("fk_c0ffee", "hostname web && echo web > /etc/hostname");
    const { execFile } = await import("node:child_process");
    const ran = await new Promise<{ code: number; err: string }>(done => {
      execFile("bash", ["-c", run.cmd], { cwd: run.cwd, env: { ...process.env, ...run.env } }, (e, _out, err) => done({ code: e === null ? 0 : 1, err }));
    });
    // Every tester who forked a machine this round read "sethostname: Operation not permitted" in the creation
    // log and in the row's own status, and none of them could tell it from a fork that had failed.
    expect([ran.code, ran.err]).toEqual([0, ""]);
    expect(readFileSync(`${at}/etc/hostname`, "utf8")).toBe("web\n");
    // The home a guest's scripts write is inside the machine's folder, and the commands start there.
    expect(run.cwd).toBe(`${at}/root`);
    expect(run.env["HOME"]).toBe(`${at}/root`);
    // Bytes land, which is what writes a fork's own context onto it: without a road the runtime said the provider
    // minted no signed upload URL and the fork came up with no context at all.
    await guest.putBytes!("fk_c0ffee", "/root/.wsp/hello", new TextEncoder().encode("there"));
    expect(readFileSync(`${at}/root/.wsp/hello`, "utf8")).toBe("there");
  });

  it("launches a turn's script in a session of its own, so the pid written down is the group a reap takes", async () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const at = guest.folder("fk_c0ffee");
    // The words a launch runs on the machine it lands on (machine-exec's after line): the script in a session of
    // its own, in the background, with its pid written down. Every turn and every exec on a stand-in died here,
    // before the agent had been asked anything, and the tester read it as the launch never reaching the agent.
    const run = guest.shell!("fk_c0ffee", "setsid bash -c 'echo up; sleep 30' > /root/run.log 2>&1 & echo $! > /root/run.pid; echo launched");
    const { execFile } = await import("node:child_process");
    const ran = await new Promise<{ out: string; err: string }>(done => {
      execFile("bash", ["-c", run.cmd], { cwd: run.cwd, env: { ...process.env, ...run.env } }, (_e, out, err) => done({ out, err }));
    });
    expect([ran.err, ran.out.trim()]).toEqual(["", "launched"]);
    // Waited for, never slept on: a launch answers the moment the shell has forked, and the script's first words
    // land whenever this computer next runs the two execs behind them, which on a machine under a whole suite and
    // five threads is no length a number here could name. The log the redirect opened is empty until then, and a
    // launch that failed writes its own words into that same log, so an empty one is only a run not yet started.
    await vi.waitFor(() => expect(readFileSync(`${at}/root/run.log`, "utf8")).toBe("up\n"), { timeout: 15_000, interval: 25 });
    // The reap of a run kills the group the pid leads, so the launched process has to lead one: a shim that only
    // ran the command would leave every turn's work behind at the end of the turn.
    const pid = Number(readFileSync(`${at}/root/run.pid`, "utf8").trim());
    const group = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    expect(group).toBe(String(pid));
    process.kill(-pid, "SIGKILL");
  }, 20_000);

  it("gives a file landing on this machine the machine's own folders, since its text names the guest's", async () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const at = guest.folder("fk_c0ffee");
    // A script lands on a machine as base64 a shell decodes, so the rewrite a command line takes never reaches the
    // words inside it: every turn's script wrote its exit code and read its input at paths on this computer, and
    // the reader waited out a run whose answer it could not see.
    const script = "export PATH=/root/.local/bin:/usr/bin\ncd '/root' && echo $? > /tmp/wsp-run/x.exit\n";
    const landed = `printf %s ${JSON.stringify(Buffer.from(script, "utf8").toString("base64"))} | base64 -d > /tmp/landed.sh`;
    const run = guest.shell!("fk_c0ffee", landed);
    const { execFile } = await import("node:child_process");
    await new Promise(done => execFile("bash", ["-c", run.cmd], { cwd: run.cwd, env: { ...process.env, ...run.env } }, done));
    // The same answer the command line's own rewrite gives, since both read one rule.
    expect(readFileSync(`${at}/tmp/landed.sh`, "utf8")).toBe(inGuestRoot(at, script));
    expect(readFileSync(`${at}/tmp/landed.sh`, "utf8")).toContain(`${at}/tmp/wsp-run/x.exit`);
  }, 20_000);

  it("carries the agents and the wsp command a machine forked from this computer's image would have", () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const at = guest.folder("fk_c0ffee");
    // The turn's own script exports the image's PATH over the launch's, and that path leads with the golden's tools
    // folder: an agent anywhere else is on no turn's path, and the turn ends before the agent says a word.
    const run = guest.shell!("fk_c0ffee", "true");
    const bin = join(at, "root", ".local", "bin");
    expect(run.env["PATH"]!.startsWith(`${bin}:`)).toBe(true);
    // Every agent this computer has, by the catalog's own name for its command; a computer with none gets none,
    // which is what a machine forked from an image with no agent on it would have.
    for (const agent of CATALOG_AGENTS) {
      expect([agent.id, existsSync(join(bin, agent.bin))]).toEqual([agent.id, onPath(agent.bin, thisComputersPath()) !== undefined]);
    }
    // The runtime the tools and an agent shipped as a script are started with is this computer's own node.
    expect(readFileSync(join(bin, "node"), "utf8")).toContain(process.execPath);
    // A turn on a fork names the word wsp for its own tools and a stand-in carries no daemon to answer it, so the
    // launch met nothing on the path and had no tools at all. This one runs this computer's own wsp against the
    // host the launch named, beside the other commands a guest has and a Mac spells differently.
    const stood = readFileSync(join(bin, "wsp"), "utf8");
    expect(stood.split("\n")[0]).toBe("#!/bin/sh");
    expect(stood).toContain('"$@" --host "$WSP_HOST_URL"');
    expect(statSync(join(bin, "wsp")).mode & 0o111).toBeGreaterThan(0);
  });

  it("has no road to any other port, since answering with this computer's own would frame whatever runs there", async () => {
    const guest = fakeGuestAt(throwaway());
    await expect(guest.reach("fk_c0ffee", 5173)).rejects.toThrow(fakeNoPortLine("fk_c0ffee", 5173));
  });
});
