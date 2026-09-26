// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ARCH_READ, OS_READ, SHELL_READ, SYSTEM_READ, UPTIME_READ, archOf, readValues } from "../src/machine-facts.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { probeCommand } from "../src/machine-context.js";
import { SSH_CONTROL_PERSIST_S, SSH_FACTS_SCRIPT, SSH_READ_SCRIPT, SSH_STORE_VARS, SshBackend, makeSshControlDir, readSshMachine, sshControlDir, sshControlPath, parseSshAddress, parseSshMachineId, hostKeyFound, knownHostFiles, knownHostKey, knownHostsWritten, offeredHostKey, knownHostTarget, plainPath, DEFAULT_REMOTE_PATH, sshArgs, sshDialArgs, sshIdentity, sshMachineId, sshMachineName, sshHostName, sshWordReach, SSH_WORD_REFUSAL, type SshHostKeyReader, type SshLocalRun, type SshReach, type SshTransport } from "../src/ssh-backend.js";

/** An ssh client that never leaves this computer: it answers the read every adopt makes, records every script it was
 * asked to carry, and lets a case script the answer for anything else. */
function fakeSsh(answer: (script: string) => Partial<ExecResult> = () => ({})): { transport: SshTransport; carried: { reach: SshReach; script: string }[] } {
  const carried: { reach: SshReach; script: string }[] = [];
  const transport: SshTransport = async (reach, script, opts) => {
    carried.push({ reach, script });
    if (script === SSH_READ_SCRIPT) {
      // What a dial riding a master the last minute left open has on its stderr: the client exchanged no key on it,
      // so nothing here says which machine answered.
      return { exitCode: 0, stdout: "home /home/dev\nuser dev\npath /home/dev/.local/bin:/usr/bin\ncpu 8\nmemkb 16384000\n", stderr: "" };
    }
    const scripted = { exitCode: 0, stdout: "", stderr: "", ...answer(script) };
    for (const line of scripted.stdout.split("\n").slice(0, -1)) opts.onLine?.(line);
    return scripted;
  };
  return { transport, carried };
}

const REACH: SshReach = { user: "dev", host: "10.0.0.5", port: 2222, keyPath: "/tmp/k/id_ed25519" };

/** The key the client on this computer has for that machine, as a case hands it: one line of its known_hosts, read
 * without dialling anything. A case that is about something else hands the reader, so none of them reaches the real
 * client for a key. */
const FOUND_KEY = "ssh-ed25519 SHA256:Ge9MQ9S/Faik2WzsxidRXnoEOJRIHkJKTBkOJ903vq4";
const knownKey: SshHostKeyReader = async () => FOUND_KEY;
const sshBackend = (transport: SshTransport, hostKey: SshHostKeyReader = knownKey): SshBackend => new SshBackend({ transport, hostKey });

describe("ssh backend", () => {
  it("every capability a machine wsp forks has and one it only reaches does not is false, and it says the machine is kept", () => {
    const backend = new SshBackend();
    expect(backend.capabilities).toEqual({
      liveCloneForks: false,
      replacesMachine: false,
      previewUrls: false,
      signedUrls: false,
      callbackRelay: false,
      diskSnapshots: false,
      images: false,
      snapshotsAnyLife: false,
      snapshotListing: false,
      templates: false,
      kept: true,
      // wsp reaches this machine and nothing more: a project on it is worked where it sits and no copy is made.
      copies: false,
      ownNetwork: false,
      sizes: [],
    });
    expect(backend.pricing.rateUsdPerHour({ cpu: 8, memMb: 16384 })).toBe(0);
  });

  it("the machine id is the dial: user, host, port and key go in and come back out", () => {
    expect(parseSshMachineId(sshMachineId(REACH))).toEqual(REACH);
    expect(parseSshMachineId(sshMachineId({ user: "dev", host: "box", port: 22 }))).toEqual({ user: "dev", host: "box", port: 22 });
    expect(parseSshMachineId("local")).toBeUndefined();
    expect(parseSshMachineId("m_ab12cd")).toBeUndefined();
  });

  it("user@host names the dial, with the port and key the person gave", () => {
    expect(parseSshAddress("dev@box")).toEqual({ user: "dev", host: "box", port: 22 });
    expect(parseSshAddress("dev@box:2222")).toEqual({ user: "dev", host: "box", port: 2222 });
    expect(parseSshAddress("dev@box", { port: 2200, keyPath: "/tmp/k" })).toEqual({ user: "dev", host: "box", port: 2200, keyPath: "/tmp/k" });
    expect(() => parseSshAddress("box")).toThrow("name the machine as user@host");
  });

  it("the client runs the script under bash -c on the machine, never a login shell, with the port and key asked for", () => {
    const args = sshArgs(REACH, "echo 'it works'");
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "2222"]);
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "/tmp/k/id_ed25519"]);
    expect(args).not.toContain("-lc");
    // The script is one quoted word after the address, so a quote inside it reaches the machine as written.
    expect(args.slice(-4)).toEqual(["dev@10.0.0.5", "bash", "-c", `'echo '\\''it works'\\'''`]);
    expect(sshArgs({ user: "dev", host: "box", port: 22 }, "true")).not.toContain("-i");
  });

  it("a machine with no name given is called what its address calls it", () => {
    expect(sshMachineName({ user: "dev", host: "box.example.com", port: 22 })).toBe("box");
    expect(sshMachineName({ user: "dev", host: "box", port: 22 })).toBe("box");
    expect(sshMachineName({ user: "dev", host: "10.0.0.5", port: 22 })).toBe("10.0.0.5");
  });

  it("adopt dials once, reads the machine's own login and size, and hands back the handle the record stands on", async () => {
    const { transport, carried } = fakeSsh();
    const backend = sshBackend(transport);
    const { machine, login, shape } = await backend.adopt(REACH);
    expect(carried.map(c => c.script)).toEqual([SSH_READ_SCRIPT]);
    expect(shape).toEqual({ cpu: 8, memMb: 16000 });
    // The turn's environment is the machine's own login: its home, who it runs as, and the PATH their shell gives.
    expect(login).toEqual({ HOME: "/home/dev", USER: "dev", PATH: "/home/dev/.local/bin:/usr/bin" });
    expect(parseSshMachineId(machine.id)).toEqual(REACH);
    // The record keeps the id alone, and a later host process reaches the same machine from it.
    expect(parseSshMachineId((await backend.get(machine.id)).id)).toEqual(REACH);
  });

  it("holds each folder of the machine's own PATH to the rule the home is held to, and falls back with nothing left", () => {
    // The PATH is the last thing the machine answers with that is written rather than run: a turn exports it and
    // the daemon's unit states it, where systemd splits an Environment= line on whitespace and reads a quote as
    // quoting. A folder carrying either is dropped at this door, so nothing downstream escapes it twenty times.
    expect(plainPath("/home/dev/.local/bin:/usr/bin")).toBe("/home/dev/.local/bin:/usr/bin");
    expect(plainPath('/usr/bin:/opt/a"b/bin:/bin')).toBe("/usr/bin:/bin");
    expect(plainPath("/usr/bin:/opt/my tools/bin")).toBe("/usr/bin");
    expect(plainPath("/usr/bin:/opt/$(id)/bin:/opt/`id`/bin")).toBe("/usr/bin");
    // An empty entry is the working directory, which is a folder nobody meant to put on a PATH.
    expect(plainPath("/usr/bin::/bin")).toBe("/usr/bin:/bin");
    expect(plainPath("./bin:/bin")).toBe("/bin");
    // A machine that answers with nothing usable leaves a harness missing rather than every command missing.
    for (const answered of [undefined, "", "relative:also/relative", '"'])
      expect(plainPath(answered), JSON.stringify(answered)).toBe(DEFAULT_REMOTE_PATH);
  });

  it("a machine that does not answer the dial is refused with the client's own words, not its debug log", async () => {
    const transport: SshTransport = async () => ({
      exitCode: 255,
      stdout: "",
      stderr: "debug1: Offering public key: /tmp/k/id_ed25519\ndebug1: No more authentication methods to try.\ndev@10.0.0.5: Permission denied (publickey).\n",
    });
    const failed = await sshBackend(transport).adopt(REACH).then(() => "", (e: unknown) => (e as Error).message);
    expect(failed).toContain("Permission denied (publickey).");
    expect(failed).not.toContain("debug1:");
  });

  it("a refusal carries none of ssh's note about the key accept-new wrote, which the road that offers the login has already said", async () => {
    const transport: SshTransport = async () => ({
      exitCode: 255,
      stdout: "",
      stderr: "Warning: Permanently added '10.0.0.5' (ED25519) to the list of known hosts.\ndev@10.0.0.5: Permission denied (publickey).\n",
    });
    const failed = await sshBackend(transport).adopt(REACH).then(() => "", (e: unknown) => (e as Error).message);
    expect(failed).toContain("Permission denied (publickey).");
    expect(failed).not.toContain("Permanently added");
    expect(failed).not.toContain("known hosts");
  });

  it("a dial that exchanged no key still hands back the machine's identity, since the key is not read out of it", async () => {
    const { transport, carried } = fakeSsh();
    const { machine, hostKey } = await sshBackend(transport).adopt(REACH);
    // The dial rode a master the last minute left open, so the client logged no key exchange on it. What the record
    // stands on is the entry that client already holds for the machine, which is there either way.
    expect(hostKey).toBe(FOUND_KEY);
    // Two machines are the same machine when they hold the same key for the same login, whatever the address.
    expect(sshIdentity(hostKey!, "dev")).toBe(`${FOUND_KEY} as dev`);
    // No dial asks the client for its debug log any more: a warm master has none to give, and the log rode the
    // stderr of the one command whose failure the person reads.
    expect(sshArgs(REACH, "true")).not.toContain("LogLevel=DEBUG");
    expect(sshDialArgs(REACH)).not.toContain("LogLevel=DEBUG");
    await machine.exec("true");
    expect(carried.map(c => c.script)).toEqual([SSH_READ_SCRIPT, "true"]);
  });

  it("a machine the client holds no key for is recorded without an identity of its own rather than an invented one", async () => {
    const { transport } = fakeSsh();
    expect((await sshBackend(transport, async () => undefined).adopt(REACH)).hostKey).toBeUndefined();
  });

  it("the machine's own words for its home are held to a plain path, since every path a turn runs is built from it", async () => {
    const home = (answer: string): Promise<unknown> => {
      const transport: SshTransport = async () => ({ exitCode: 0, stdout: `home ${answer}\nuser dev\npath /usr/bin\ncpu 1\nmemkb 1024\n`, stderr: "" });
      return sshBackend(transport).adopt(REACH).then(a => a.login["HOME"], (e: unknown) => (e as Error).message);
    };
    // What a machine answering with shell in its home would land in the launch: refused at the one door instead.
    expect(await home("/home/dev x; touch /tmp/pwned")).toContain("is not a plain path");
    expect(await home("/home/$(id -un)")).toContain("is not a plain path");
    expect(await home("/home/dev`whoami`")).toContain("is not a plain path");
    expect(await home("relative/home")).toContain("is not a plain path");
    expect(await home("")).toContain("no home folder");
    // A space is a home on macOS and stays a home: the paths built from it are quoted where they land in a command.
    expect(await home("/Users/John Smith")).toBe("/Users/John Smith");
    expect(await home("/root")).toBe("/root");
  });

  it("the store folder each harness reads is asked of the machine's own login shell, and held to the same rule", async () => {
    const read = (line: string): Promise<Record<string, string>> => {
      const transport: SshTransport = async () => ({ exitCode: 0, stdout: `home /root\nuser root\npath /usr/bin\n${line}cpu 1\nmemkb 1024\n`, stderr: "" });
      return sshBackend(transport).adopt(REACH).then(a => ({ ...a.login }));
    };
    expect(SSH_STORE_VARS).toContain("CLAUDE_CONFIG_DIR");
    // The read asks the machine's own shell for each store variable the catalog names, in the same call as PATH.
    expect(SSH_READ_SCRIPT).toContain("bash --noprofile --norc -c");
    expect(SSH_READ_SCRIPT).toContain('printf "store:CLAUDE_CONFIG_DIR %s');
    expect(await read("store:CLAUDE_CONFIG_DIR /root/.claude-cfg\n")).toMatchObject({ HOME: "/root", CLAUDE_CONFIG_DIR: "/root/.claude-cfg" });
    // A machine that names none leaves the harness on its default, and one that names shell is left there too.
    expect((await read(""))["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect((await read("store:CLAUDE_CONFIG_DIR /root/x; id\n"))["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });

  it("opens no login file of the machine's own, run against a home whose profile would write one", async () => {
    // A computer somebody owns is worked as its own root by the host, and that root's home is the one every
    // workspace on it writes, so a profile or an rc file under it is a file a workspace wrote.
    expect(SSH_READ_SCRIPT).toContain("bash --noprofile --norc -c");
    expect(SSH_READ_SCRIPT).not.toContain("bash -lc");
    expect(SSH_READ_SCRIPT).not.toContain("bash -l ");
    const home = mkdtempSync(join(tmpdir(), "wsp-login-read-"));
    try {
      const marker = join(home, "sourced");
      for (const rc of [".profile", ".bash_profile", ".bashrc"]) writeFileSync(join(home, rc), `echo ${rc} >> ${marker}\n`);
      const said = spawnSync("bash", ["-c", `export HOME=${home}\n${SSH_READ_SCRIPT}`], { encoding: "utf8" });
      expect(said.status).toBe(0);
      const values = readValues(said.stdout);
      expect(values["home"]).toBe(home);
      expect(values["user"]).toBe(userInfo().username);
      expect(values["path"]).toBeTruthy();
      expect(Number(values["cpu"])).toBeGreaterThan(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("reads which login shell the machine's root runs, off its passwd entry and never by running that shell", async () => {
    // sshd hands every command wsp sends to this login's own shell with -c before the bash -c the client names, so
    // which shell it is decides whether a file under the login's home runs first. The read asks getent, which runs
    // no shell of the machine's, and is the same line the context probe reads.
    expect(SSH_READ_SCRIPT).toContain(SHELL_READ);
    expect(SSH_READ_SCRIPT).toContain('printf "shell %s\\n" "$shell"');
    expect(probeCommand()).toContain(SHELL_READ);
    const said = (line: string): SshTransport => async () => ({ exitCode: 0, stdout: `home /root\nuser root\n${line}path /usr/bin\ncpu 1\nmemkb 1024\n`, stderr: "" });
    expect(await readSshMachine(REACH, said("shell zsh\n"))).toMatchObject({ shell: "zsh" });
    expect(await readSshMachine(REACH, said("shell bash\n"))).toMatchObject({ shell: "bash" });
    // A read that named none carries none: which shells a road may work through is that road's rule, not this one's.
    expect((await readSshMachine(REACH, said("")))["shell"]).toBeUndefined();
    expect((await new SshBackend({ transport: said("shell fish\n"), hostKey: async () => undefined, knownHosts: async () => ({}) }).adopt(REACH)).shell).toBe("fish");

    // What the line answers on this computer, run for real: a name and nothing more, and no file of a home read.
    const home = mkdtempSync(join(tmpdir(), "wsp-shell-read-"));
    try {
      const marker = join(home, "sourced");
      for (const rc of [".profile", ".bash_profile", ".bashrc", ".zshenv"]) writeFileSync(join(home, rc), `echo ${rc} >> ${marker}\n`);
      // A folder holding this computer's bash and nothing else, so the read finds no getent whichever system this
      // runs on: that is the shape of a machine whose passwd cannot be read, which is what the fallbacks are for.
      const bin = join(home, "bin");
      mkdirSync(bin);
      symlinkSync(spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim(), join(bin, "bash"));
      const answers = (env: Record<string, string>): string => {
        const out = spawnSync("bash", ["-c", `${SHELL_READ}\nprintf "shell %s\\n" "$shell"`], { encoding: "utf8", env: { HOME: home, PATH: bin, ...env } });
        expect(out.status).toBe(0);
        return readValues(out.stdout)["shell"]!;
      };
      expect(answers({ PATH: process.env["PATH"]! })).toMatch(/^[A-Za-z0-9._-]+$/);
      // What this line reads is a passwd entry and two variables, never a file; that the whole read opens none of
      // the machine's own is the case below, which runs the script the way a dial runs it. Pointing a shell's own
      // HOME at this home before it starts would measure that shell's startup, which is not this line's.
      // Behind the passwd entry, the login's own SHELL, which sshd sets for every session it opens: a machine
      // carrying no getent names its own shell rather than the word that would let it through. PATH holds nothing
      // here, so getent is missing whether or not this computer has one.
      expect(answers({ SHELL: "/usr/bin/zsh" })).toBe("zsh");
      expect(answers({ SHELL: "/usr/local/bin/fish" })).toBe("fish");
      // And behind that bash, which is what every reader takes an answer of nothing for. bash fills SHELL from the
      // passwd database where it is unset, so the word has to be emptied rather than left out to reach this.
      expect(answers({ SHELL: "" })).toBe("bash");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("every command to one machine rides one master connection, and two machines never share one", () => {
    const args = sshArgs(REACH, "true");
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain(`ControlPersist=${SSH_CONTROL_PERSIST_S}`);
    expect(args).toContain(`ControlPath=${sshControlPath(REACH)}`);
    // One socket per machine, named by the dial and short enough for a unix socket whatever the host name is.
    expect(sshControlPath({ ...REACH, keyPath: "/tmp/k/other" })).toBe(sshControlPath(REACH));
    expect(sshControlPath({ ...REACH, port: 22 })).not.toBe(sshControlPath(REACH));
    expect(sshControlPath({ user: "dev", host: "a".repeat(200), port: 22 }, "/tmp").length).toBeLessThan(100);
  });

  it("the master sockets live in a folder only the person can read, made and kept at that mode", () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-ssh-home-"));
    try {
      // Whoever holds a control socket holds every command that rides it, so the folder is wsp's own and nobody
      // else's: not the shared temp folder, whose name anyone could work out and sit on first.
      const dir = makeSshControlDir(home);
      expect(dir).toBe(join(home, ".wsp", "ssh"));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(sshControlPath(REACH, dir).startsWith(`${dir}/`)).toBe(true);
      // With no home named it is the person's own, never the folder every login on this computer shares.
      expect(sshControlDir()).toBe(join(homedir(), ".wsp", "ssh"));
      // A folder left looser by something else is tightened rather than trusted.
      chmodSync(dir, 0o755);
      expect(statSync(makeSshControlDir(home)).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("exec and run carry the script to the machine, and run streams each line", async () => {
    const { transport, carried } = fakeSsh(script => (script === "exit 7" ? { exitCode: 7 } : { stdout: "a\nb\n" }));
    const backend = sshBackend(transport);
    const { machine } = await backend.adopt(REACH);
    expect((await machine.exec("exit 7")).exitCode).toBe(7);
    const lines: string[] = [];
    const res = await machine.run("printf 'a\\nb\\n'", { deadlineMs: 5_000, onLine: l => lines.push(l) });
    expect(lines).toEqual(["a", "b"]);
    expect(res.exitCode).toBe(0);
    expect(carried.map(c => c.script).slice(1)).toEqual(["exit 7", "printf 'a\\nb\\n'"]);
    expect(carried.every(c => c.reach.user === "dev" && c.reach.host === "10.0.0.5" && c.reach.port === 2222 && c.reach.keyPath === REACH.keyPath)).toBe(true);
  });

  it("the moves only a machine wsp forks takes are refused, and it serves no preview or signed URL", async () => {
    const { transport } = fakeSsh();
    const backend = sshBackend(transport);
    // Read as the runtime holds it, through the seam, so a refusal is proven on the interface every road calls.
    const machine: Machine = (await backend.adopt(REACH)).machine;
    await expect(machine.snapshot("x", { firstLife: true })).rejects.toThrow("cannot be snapshotted");
    await expect(machine.pause()).rejects.toThrow("cannot be paused");
    await expect(machine.resume()).rejects.toThrow("cannot be resumed");
    expect(machine.previewUrl).toBeUndefined();
    await expect(machine.downloadUrl("/x")).rejects.toThrow("no signed download URL");
    await expect(machine.uploadUrl("/x")).rejects.toThrow("no signed upload URL");
    await expect(backend.create()).rejects.toThrow("already exists");
    await expect(backend.deleteSnapshot()).rejects.toThrow("no snapshots");
    await expect(backend.get("local")).rejects.toThrow("is not a machine this host reaches over ssh");
    // Deleting an ssh workspace drops its record only: kill is a no-op, and nothing lists the person's machines.
    await expect(machine.kill()).resolves.toBeUndefined();
    expect(await machine.state()).toBe("running");
    expect(await backend.list()).toEqual([]);
  });
});

describe("the chip a machine over ssh says it runs", () => {
  /** A client that answers the adopt read with the chip word this case is about, and nothing else scripted. Every
   * other line is what an Ubuntu box prints, so only the one answer under test differs between cases. */
  const readsArch = (line: string): SshTransport => async (_reach, script) =>
    script === SSH_READ_SCRIPT
      ? { exitCode: 0, stdout: `home /home/dev\n${line}user dev\npath /usr/bin:/bin\ncpu 8\nmemkb 16384000\n`, stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };

  it("asks for it on the read that adopts the machine, in the words uname itself prints", () => {
    // One printf on the read that already runs, not a round trip of its own: the chip is wanted before anything is
    // sent to the machine, which is the same moment the home and the login PATH are wanted.
    expect(SSH_READ_SCRIPT).toContain(ARCH_READ);
    expect(ARCH_READ).toContain("uname -m");
  });

  it("carries the word back whatever it is, since the table that knows the chips is not this one's", async () => {
    // Every word a machine may print for itself rides through unread: Linux prints x86_64 or aarch64, a Mac prints
    // arm64, and a board nobody builds for prints its own. Which of them wsp has a daemon for is decided against a
    // table above this file, so nothing here turns an unknown word into nothing.
    for (const said of ["x86_64", "aarch64", "arm64", "riscv64"]) {
      expect(await readSshMachine(REACH, readsArch(`arch ${said}\n`))).toMatchObject({ arch: said });
      expect(await new SshBackend({ transport: readsArch(`arch ${said}\n`), hostKey: async () => undefined, knownHosts: async () => ({}) }).adopt(REACH)).toMatchObject({ arch: said });
    }
  });

  it("answers none where the machine printed none, rather than a word this computer made up", async () => {
    // A machine whose uname printed nothing leaves the key present and empty, and one on a shell that never ran the
    // line leaves it absent. Neither is a chip, and the caller refuses rather than guessing at one.
    for (const line of ["", "arch \n"]) {
      expect(await readSshMachine(REACH, readsArch(line))).not.toHaveProperty("arch");
      expect(await new SshBackend({ transport: readsArch(line), hostKey: async () => undefined, knownHosts: async () => ({}) }).adopt(REACH)).not.toHaveProperty("arch");
    }
    expect(archOf({})).toBeUndefined();
    expect(archOf({ arch: "" })).toBeUndefined();
    expect(archOf({ arch: "x86_64" })).toBe("x86_64");
  });
});

describe("the system a machine over ssh says it runs", () => {
  const reads = (lines: string): SshTransport => async (_reach, script) =>
    script === SSH_READ_SCRIPT ? { exitCode: 0, stdout: `home /home/dev\n${lines}user dev\npath /usr/bin:/bin\ncpu 8\nmemkb 16384000\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };

  it("asks uname -s on the same read as the chip, ahead of it, and carries the word back as the machine said it", async () => {
    expect(SYSTEM_READ).toContain("uname -s");
    expect(SSH_READ_SCRIPT.indexOf(SYSTEM_READ)).toBeGreaterThanOrEqual(0);
    expect(SSH_READ_SCRIPT.indexOf(SYSTEM_READ)).toBeLessThan(SSH_READ_SCRIPT.indexOf(ARCH_READ));
    for (const said of ["Linux", "Darwin", "FreeBSD"]) {
      expect(await readSshMachine(REACH, reads(`system ${said}\narch x86_64\n`))).toMatchObject({ system: said });
      expect(await new SshBackend({ transport: reads(`system ${said}\n`), hostKey: async () => undefined, knownHosts: async () => ({}) }).adopt(REACH)).toMatchObject({ system: said });
    }
    expect(await readSshMachine(REACH, reads("system \n"))).not.toHaveProperty("system");
  });
});

describe("what a machine over ssh says it is", () => {
  /** What an Ubuntu box prints for the facts script, as its own shell would. */
  const UBUNTU = "pretty Ubuntu 24.04.3 LTS\nmac \nkernel Linux 6.8.0-79-generic\nuptime 96521.42\nboot \nhome /home/dev\n";

  /** The machine handle as the runtime holds it, through the seam every kind answers on. */
  async function machineOf(answer: (script: string) => Partial<ExecResult>): Promise<{ machine: Machine; carried: { script: string }[] }> {
    const { transport, carried } = fakeSsh(answer);
    const { machine } = await sshBackend(transport).adopt(REACH);
    return { machine, carried };
  }

  it("the three the pane waits on are read off the machine itself, in one script over the connection", async () => {
    const { machine, carried } = await machineOf(script => (script === SSH_FACTS_SCRIPT ? { stdout: UBUNTU } : {}));
    expect(machine.facts).toBeDefined();
    expect(await machine.facts!()).toEqual({ os: "Ubuntu 24.04.3 LTS", uptimeMs: 96_521_420, folder: "/home/dev" });
    // One round trip per read, and the same lines this computer's own machine is read with: one reader, two callers.
    expect(carried.map(c => c.script).slice(1)).toEqual([SSH_FACTS_SCRIPT]);
    expect(SSH_FACTS_SCRIPT).toContain(OS_READ.join("\n"));
    expect(SSH_FACTS_SCRIPT).toContain(UPTIME_READ.join("\n"));
    // Nothing is held: a machine somebody owns is rebooted and upgraded under wsp rather than by it.
    await machine.facts!();
    expect(carried.map(c => c.script).slice(1)).toEqual([SSH_FACTS_SCRIPT, SSH_FACTS_SCRIPT]);
  });

  it("a Mac over ssh says when it booted rather than how long it has been up, and the row gets a length either way", async () => {
    const bootSec = Math.floor(Date.now() / 1000) - 7_200;
    const mac = `pretty \nmac 15.6.1\nkernel Darwin 24.6.0\nuptime \nboot { sec = ${bootSec}, usec = 12 } Thu Sep 10 17:24:09 2026\nhome /Users/maya\n`;
    const { machine } = await machineOf(script => (script === SSH_FACTS_SCRIPT ? { stdout: mac } : {}));
    const facts = await machine.facts!();
    expect(facts.os).toBe("macOS 15.6.1");
    expect(facts.folder).toBe("/Users/maya");
    expect(facts.uptimeMs).toBeGreaterThanOrEqual(7_200_000);
    expect(facts.uptimeMs).toBeLessThan(7_205_000);
  });

  it("says why the rows sit at pending once for a machine, and again only when the machine says something else", async () => {
    let stderr = "ssh: connect to host 10.0.0.5 port 2222: Connection refused\n";
    const { machine } = await machineOf(script => (script === SSH_FACTS_SCRIPT ? { exitCode: 255, stderr } : {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The caller shows pending and swallows the refusal, so a read that fails every 15 seconds would otherwise
      // say nothing anywhere; it says it here, and not four times an hour.
      for (let i = 0; i < 3; i++) await machine.facts!().catch(() => {});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("Connection refused");
      stderr = "ssh: Permission denied (publickey).\n";
      await machine.facts!().catch(() => {});
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]![0]).toContain("Permission denied");
    } finally {
      warn.mockRestore();
    }
  });

  it("a machine that did not answer leaves the rows waiting rather than showing this computer's own answers for it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { machine } = await machineOf(script =>
        script === SSH_FACTS_SCRIPT ? { exitCode: 255, stderr: "debug1: Connecting to 10.0.0.5\nssh: connect to host 10.0.0.5 port 2222: Connection refused\n" } : {},
      );
      const refused = await machine.facts!().then(() => "", (e: unknown) => (e as Error).message);
      expect(refused).toContain("Connection refused");
      expect(refused).not.toContain("debug1:");
      // A machine that answered the dial but not the lines is the same: no name of this computer's stands in for it.
      const { machine: quiet } = await machineOf(() => ({ stdout: "\n" }));
      await expect(quiet.facts!()).rejects.toThrow("did not say what it is over ssh");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the key a machine over ssh is known by", () => {
  /** What `ssh -G` answered on this computer for the dial, cut to the lines the read uses. A client that spells its
   * own folder with a tilde is spelled that way here too, since older ones do. */
  const CONFIG = [
    "user dev",
    "hostname 10.0.0.5",
    "port 2222",
    "userknownhostsfile /Users/dev/.ssh/known_hosts ~/.ssh/known_hosts2",
    "globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2",
    "hostkeyalgorithms ssh-ed25519-cert-v01@openssh.com,rsa-sha2-512-cert-v01@openssh.com,ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256,ssh-rsa",
  ].join("\n");

  /** What `ssh-keygen -F` printed for a machine known by a key of each type: its own comment lines, the rsa entry
   * ahead of the others in the file, and the ed25519 one hashed, which is how a Debian client writes every entry.
   * The keys are a throwaway set made for this case; their fingerprints below are what `ssh-keygen -lf` printed. */
  const FOUND = [
    "# Host [10.0.0.5]:2222 found: line 3 ",
    "[10.0.0.5]:2222 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDdxs0iI8J5qm7+4hxS2LKxvEImRo4YOgbsh7o/q6LcNs+/euQcFejNmlxWKGPcPx6ZAFZEvYmdwe/yDUYsoAH66WB32nACpcm8ELAXEkXxQZEjmr8daugXOpWv0qDzNu/2u5+eMJJJRNDDDupbkvmCM74T9cCAVkHDjisNybGndQ==",
    "# Host [10.0.0.5]:2222 found: line 4 ",
    "|1|g4CYAxJ751PqMLyUC5r0xLd/ov4=|8lv3RgXEmKyoPgL0K37Xx452RDA= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC6sV8jQCzynkpUOM40rRIjA7tPstUSjC+A/LVMnAZhP",
    "# Host [10.0.0.5]:2222 found: line 5 ",
    "[10.0.0.5]:2222 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBAK+5Ayg30RfuGD20d/q2F5UrbqEc1RarPuGTfhzyv0OHw3UiZIAlCu+Eg145j6r4sxS0Jm0uSKkMggV0oW70bY=",
    "",
  ].join("\n");

  const ED25519 = "ssh-ed25519 SHA256:Ge9MQ9S/Faik2WzsxidRXnoEOJRIHkJKTBkOJ903vq4";
  const RSA = "ssh-rsa SHA256:00VO3BTKQbJeAg/nTIZvht3husrdVHRx5/E4JC9fFBE";
  const ALGORITHMS = readValues(CONFIG)["hostkeyalgorithms"]!;

  it("the key is read off the client's own entry for the machine, with nothing dialled", async () => {
    const asked: { file: string; args: readonly string[] }[] = [];
    const run: SshLocalRun = async (file, args) => {
      asked.push({ file, args });
      if (file === "ssh") return { exitCode: 0, stdout: CONFIG, stderr: "" };
      const named = args[args.indexOf("-f") + 1];
      return named === "/Users/dev/.ssh/known_hosts"
        ? { exitCode: 0, stdout: FOUND, stderr: "" }
        : { exitCode: 255, stdout: "", stderr: `Cannot stat ${named}: No such file or directory\n` };
    };
    expect(await knownHostKey(REACH, run)).toBe(ED25519);
    // The client is asked where it looks and what it prefers there, for the dial as it would make it, and nothing
    // is dialled: this is why the read costs nothing on a master a turn already has open.
    expect(asked[0]).toEqual({ file: "ssh", args: ["-G", ...sshDialArgs(REACH), "dev@10.0.0.5"] });
    expect(asked.slice(1).map(a => [a.file, a.args[0], a.args[1]])).toEqual([
      ["ssh-keygen", "-F", "[10.0.0.5]:2222"],
      ["ssh-keygen", "-F", "[10.0.0.5]:2222"],
      ["ssh-keygen", "-F", "[10.0.0.5]:2222"],
      ["ssh-keygen", "-F", "[10.0.0.5]:2222"],
    ]);
    // A client that cannot say what it would do leaves the machine without an identity rather than with a guess.
    expect(await knownHostKey(REACH, async () => ({ exitCode: 255, stdout: "", stderr: "Bad configuration\n" }))).toBeUndefined();
    expect(await knownHostKey(REACH, async file => (file === "ssh" ? { exitCode: 0, stdout: "port 2222\n", stderr: "" } : { exitCode: 0, stdout: FOUND, stderr: "" }))).toBeUndefined();
  });

  it("the entry is looked up under the name and port the client itself writes one under, in the files it reads", () => {
    const values = readValues(CONFIG);
    expect(knownHostTarget(values)).toBe("[10.0.0.5]:2222");
    // ssh's own port is written with no brackets, and an alias the person set is the whole name the client writes.
    expect(knownHostTarget({ ...values, port: "22" })).toBe("10.0.0.5");
    expect(knownHostTarget({ ...values, hostkeyalias: "box-behind-a-tunnel" })).toBe("box-behind-a-tunnel");
    expect(knownHostTarget({ port: "2222" })).toBeUndefined();
    expect(knownHostFiles(values, "/Users/dev")).toEqual(["/Users/dev/.ssh/known_hosts", "/Users/dev/.ssh/known_hosts2", "/etc/ssh/ssh_known_hosts", "/etc/ssh/ssh_known_hosts2"]);
    // A person who turned a file off named no path to read.
    expect(knownHostFiles({ userknownhostsfile: "none", globalknownhostsfile: "none" })).toEqual([]);
    // A tilde is the password database entry, which is what ssh expands one from: a home pointed elsewhere for
    // this process moves the file wsp reads nowhere, because it moves the file ssh reads nowhere.
    const home = process.env["HOME"];
    process.env["HOME"] = join(tmpdir(), "wsp-not-a-home");
    try {
      expect(knownHostFiles({ userknownhostsfile: "~/.ssh/known_hosts" })).toEqual([join(userInfo().homedir, ".ssh", "known_hosts")]);
    } finally {
      if (home === undefined) delete process.env["HOME"];
      else process.env["HOME"] = home;
    }
  });

  it("the key picked is the type a dial would negotiate, not whichever line was written first", () => {
    // The rsa entry is first in the file and the ed25519 one is hashed, and what comes back is still the key this
    // client prefers, so two records of one machine cannot answer with two different keys for it.
    expect(hostKeyFound(FOUND, ALGORITHMS)).toBe(ED25519);
    // An rsa-sha2 signature is made by an ssh-rsa key, so a client preferring those picks that entry.
    expect(hostKeyFound(FOUND, "rsa-sha2-512,ssh-ed25519")).toBe(RSA);
    expect(hostKeyFound(FOUND, "ecdsa-sha2-nistp256")).toBe("ecdsa-sha2-nistp256 SHA256:AgZa9U1SScxiIabgv4cA75Tb8rufTUtnU35jEB/IQWk");
    // Nothing to pick: a machine no entry names, a client that prefers none of the types it is known by, and a line
    // that marks an authority or a revoked key rather than naming a machine's own.
    expect(hostKeyFound("", ALGORITHMS)).toBeUndefined();
    expect(hostKeyFound(FOUND, "ssh-dss")).toBeUndefined();
    const marked = FOUND.split("\n").map(line => (line.startsWith("#") ? line : `@revoked ${line}`)).join("\n");
    expect(hostKeyFound(marked, ALGORITHMS)).toBeUndefined();
  });

  /** What `ssh-keygen -F` prints for a machine whose key this client trusts through an authority: the marker line
   * for the signing key and nothing of the machine's own, which is what a cold dial leaves behind as much as a
   * warm one, since accept-new writes no entry for a certificate it could already check. Measured on OpenSSH 9.6
   * against a local sshd holding a CA signed host certificate. */
  const CA_FOUND = [
    "# Host [10.0.0.5]:2222 found: line 1 CA",
    "@cert-authority [10.0.0.5]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfANGYQHGkxSRKmhym/quMT78KoIKc7giNRg8nHlfF9",
    "",
  ].join("\n");

  /** The signing key the line above carries, as a fingerprint: what a record would stand on if the marker line were
   * read as a machine's own, which would make every machine that authority signed one machine. */
  const AUTHORITY_KEY = "ssh-ed25519 SHA256:IGh+ehqXAjwW77irxqOmwHmu3koeqPEHgvUh/f71i34";

  /** What `ssh-keyscan -p 2222 10.0.0.5` answered: the machine's own key, which is the key its certificate signs. */
  const OFFERED = "[10.0.0.5]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOqrJ12qHMroq65CsKPtn/r4PuMQCbWynvVaYYSkR73z\n";
  const OFFERED_KEY = "ssh-ed25519 SHA256:VWJESUiByqqBIKEH1I0uAkXiG6HL1qBI3XJke8oNyMs";

  it("a machine trusted through an authority is known by the key its certificate signs, read off the machine", async () => {
    const asked: { file: string; args: readonly string[] }[] = [];
    const run: SshLocalRun = async (file, args) => {
      asked.push({ file, args });
      if (file === "ssh") return { exitCode: 0, stdout: CONFIG, stderr: "" };
      if (file === "ssh-keyscan") return { exitCode: 0, stdout: OFFERED, stderr: "# 10.0.0.5:2222 SSH-2.0-OpenSSH_9.6\n" };
      const named = args[args.indexOf("-f") + 1];
      return named === "/Users/dev/.ssh/known_hosts" ? { exitCode: 0, stdout: CA_FOUND, stderr: "" } : { exitCode: 255, stdout: "", stderr: `Cannot stat ${named}\n` };
    };
    expect(await knownHostKey(REACH, run)).toBe(OFFERED_KEY);
    // The machine is asked at the host and port the client resolved for the dial, not at the word that was typed.
    expect(asked.at(-1)).toEqual({ file: "ssh-keyscan", args: ["-T", "5", "-p", "2222", "10.0.0.5"] });
    // The authority's own key is never the answer: every machine it signed would then be the same machine.
    expect(await knownHostKey(REACH, run)).not.toBe(AUTHORITY_KEY);
    // One machine, one identity, whichever of its addresses a record was made under: the client resolves both to
    // the same host, and what the machine offers there is what both records stand on.
    expect(await knownHostKey({ ...REACH, host: "box" }, run)).toBe(OFFERED_KEY);
  });

  it("only a machine the client knows by nothing else is asked, and a machine that answers nothing keeps no identity", async () => {
    const scans: string[] = [];
    const run = (found: string, offered: string): SshLocalRun => async (file, args) => {
      if (file === "ssh") return { exitCode: 0, stdout: CONFIG, stderr: "" };
      if (file === "ssh-keyscan") {
        scans.push(args.join(" "));
        return offered === "" ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: offered, stderr: "" };
      }
      return args[args.indexOf("-f") + 1] === "/Users/dev/.ssh/known_hosts" ? { exitCode: 0, stdout: found, stderr: "" } : { exitCode: 255, stdout: "", stderr: "" };
    };
    // A client holding the machine's own entry beside the authority's line reads it there and dials nothing.
    expect(await knownHostKey(REACH, run(`${CA_FOUND}${FOUND}`, OFFERED))).toBe(ED25519);
    // A machine the client holds no line for at all is not one an authority stands behind: nothing is asked of it.
    expect(await knownHostKey(REACH, run("", OFFERED))).toBeUndefined();
    expect(scans).toEqual([]);
    // The machine was asked and said nothing: the record goes without an identity rather than with a guess.
    expect(await knownHostKey(REACH, run(CA_FOUND, ""))).toBeUndefined();
    expect(scans).toHaveLength(1);
  });

  it("the file and the name the entry is written under come off one reading of the dial, never off the word typed", async () => {
    // A config of the shape the review found: the person types a short name and the client dials, and writes the
    // entry under, the address behind it. A line built from the typed word would remove nothing.
    const behindAName = ["user dev", "hostname 10.0.0.5", "port 2222", "userknownhostsfile /Users/dev/.ssh/known_hosts_work"].join("\n");
    const run = (config: string): SshLocalRun => async file => (file === "ssh" ? { exitCode: 0, stdout: config, stderr: "" } : { exitCode: 255, stdout: "", stderr: "" });
    expect(await knownHostsWritten({ user: "dev", host: "box", port: 2222 }, run(behindAName))).toEqual({ file: "/Users/dev/.ssh/known_hosts_work", target: "[10.0.0.5]:2222" });
    // An alias the person set is the whole name the client writes, and ssh's own port carries no brackets.
    expect(await knownHostsWritten(REACH, run(`${behindAName}\nhostkeyalias box-behind-a-tunnel`))).toMatchObject({ target: "box-behind-a-tunnel" });
    expect(await knownHostsWritten(REACH, run("user dev\nhostname 10.0.0.5\nport 22"))).toMatchObject({ target: "10.0.0.5" });
    // A client that cannot say what it would do names neither half, which leaves a screen its own default.
    expect(await knownHostsWritten(REACH, async () => ({ exitCode: 255, stdout: "", stderr: "Bad configuration\n" }))).toEqual({});
  });

  it("the key a machine itself answers with is one read of its ssh port, and nothing where the person's config stops the scan", async () => {
    const asked: { file: string; args: readonly string[] }[] = [];
    const run = (proxy: string): SshLocalRun => async (file, args) => {
      asked.push({ file, args });
      if (file === "ssh") return { exitCode: 0, stdout: `${CONFIG}\n${proxy}`, stderr: "" };
      return file === "ssh-keyscan" ? { exitCode: 0, stdout: OFFERED, stderr: "# 10.0.0.5:2222 SSH-2.0-OpenSSH_9.6\n" } : { exitCode: 255, stdout: "", stderr: "" };
    };
    // The machine is asked at the host and port the client resolved for the dial, and the key that comes back is
    // the one of the types this client prefers, so what a person is shown is what a dial would negotiate.
    expect(await offeredHostKey(REACH, run(""))).toEqual({ key: OFFERED_KEY });
    expect(asked.at(-1)).toEqual({ file: "ssh-keyscan", args: ["-T", "5", "-p", "2222", "10.0.0.5"] });
    // Nothing is dialled where the client would reach the machine through a jump or a command of the person's: the
    // scan dials the resolved name itself, and whatever answered there is not that machine. The refusal names the
    // config line that stopped it, so the person knows what to read the key off instead.
    expect(await offeredHostKey(REACH, run("proxyjump bastion.example.com"))).toEqual({ stoppedBy: "ProxyJump" });
    expect(await offeredHostKey(REACH, run("proxycommand nc %h %p"))).toEqual({ stoppedBy: "ProxyCommand" });
    expect(asked.filter(a => a.file === "ssh-keyscan")).toHaveLength(1);
    // A machine that answers no scan leaves the person with neither a key nor a reason of the config's.
    expect(await offeredHostKey(REACH, async file => (file === "ssh" ? { exitCode: 0, stdout: CONFIG, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" }))).toEqual({});
  });

  it("a machine the client reaches through a jump or a command of the person's is asked nothing, since this road cannot take either", async () => {
    const scans: string[] = [];
    const run = (proxy: string): SshLocalRun => async (file, args) => {
      if (file === "ssh") return { exitCode: 0, stdout: `${CONFIG}\n${proxy}`, stderr: "" };
      if (file === "ssh-keyscan") {
        scans.push(args.join(" "));
        return { exitCode: 0, stdout: OFFERED, stderr: "" };
      }
      return args[args.indexOf("-f") + 1] === "/Users/dev/.ssh/known_hosts" ? { exitCode: 0, stdout: CA_FOUND, stderr: "" } : { exitCode: 255, stdout: "", stderr: "" };
    };
    // The scan dials the resolved name itself, which on this network is some other machine or nothing at all, and
    // whatever answered there would be written down as this machine's identity.
    for (const proxy of ["proxyjump bastion.example.com", "proxycommand nc %h %p"]) {
      expect(await knownHostKey(REACH, run(proxy)), proxy).toBeUndefined();
    }
    expect(scans).toEqual([]);
    // ssh prints neither line where the person set neither, so the machine is asked as it was.
    expect(await knownHostKey(REACH, run(""))).toBe(OFFERED_KEY);
    expect(scans).toHaveLength(1);
  });
});

describe("an alias out of the person's ssh config", () => {
  /** A client whose config holds a spoo block with a HostName, a User and a Port of its own, the way the owner's
   * does, and nothing else: any other word comes back as its own hostname, which is what `ssh -G` prints for a
   * name no block renames. Every call is kept, so a case can say nothing was asked. */
  function config(): { run: SshLocalRun; asked: (readonly string[])[] } {
    const asked: (readonly string[])[] = [];
    const run: SshLocalRun = async (file, args) => {
      asked.push([file, ...args]);
      const word = args.at(-1)!.toLowerCase();
      const stdout = word === "spoo" ? "host spoo\nuser root\nhostname 178.156.161.168\nport 2222\n" : `host ${word}\nuser dev\nhostname ${word}\nport 22\n`;
      return { exitCode: 0, stdout, stderr: "" };
    };
    return { run, asked };
  }

  it("a bare word ssh renames is the alias itself as the host, with the config's user and port", async () => {
    const { run, asked } = config();
    expect(await sshWordReach("spoo", {}, run)).toEqual({ user: "root", host: "spoo", port: 2222 });
    expect(asked).toEqual([["ssh", "-G", "spoo"]]);
  });

  it("a port or a key the person typed wins over the config's, as ssh itself lets a flag win", async () => {
    const { run } = config();
    expect(await sshWordReach("spoo", { port: 2200, keyPath: "/tmp/k/id" }, run)).toEqual({ user: "root", host: "spoo", port: 2200, keyPath: "/tmp/k/id" });
  });

  it("a word ssh does not rename is refused in one sentence, and a hostname ssh only lowercased is not a rename", async () => {
    const { run } = config();
    await expect(sshWordReach("nonsense", {}, run)).rejects.toThrow(SSH_WORD_REFUSAL("nonsense"));
    expect(SSH_WORD_REFUSAL("nonsense")).not.toMatch(/\.\s+\S/);
    const shouting: SshLocalRun = async () => ({ exitCode: 0, stdout: "user dev\nhostname box\nport 22\n", stderr: "" });
    await expect(sshWordReach("BOX", {}, shouting)).rejects.toThrow(SSH_WORD_REFUSAL("BOX"));
    const broken: SshLocalRun = async () => ({ exitCode: 255, stdout: "", stderr: "Bad configuration option\n" });
    await expect(sshWordReach("spoo", {}, broken)).rejects.toThrow(SSH_WORD_REFUSAL("spoo"));
  });

  it("a numeric word the resolver would rewrite into an address is refused in the same sentence without asking the client", async () => {
    const asked: string[][] = [];
    const rewriting: SshLocalRun = async (cmd, args) => {
      asked.push([cmd, ...args]);
      return { exitCode: 0, stdout: "user dev\nhostname 127.0.0.1\nport 22\n", stderr: "" };
    };
    for (const word of ["123", "1.2.3", "2130706433", "0x7f000001", "0177.1"]) {
      await expect(sshWordReach(word, {}, rewriting)).rejects.toThrow(SSH_WORD_REFUSAL(word));
    }
    expect(asked).toEqual([]);
  });

  it("a typed login is read as it always was, and a word that could be an option never reaches the client", async () => {
    const { run, asked } = config();
    expect(await sshWordReach("root@spoo", {}, run)).toEqual({ user: "root", host: "spoo", port: 22 });
    await expect(sshWordReach("-oProxyCommand=touch", {}, run)).rejects.toThrow(SSH_WORD_REFUSAL("-oProxyCommand=touch"));
    expect(asked).toEqual([]);
  });
});

describe("the address a login dials", () => {
  it("is the HostName the config gives an alias, read with nothing dialled, and the host itself where the client cannot say", async () => {
    const asked: (readonly string[])[] = [];
    const run: SshLocalRun = async (file, args) => {
      asked.push([file, ...args]);
      return { exitCode: 0, stdout: args.at(-1) === "root@me" ? "user root\nhostname 127.0.0.1\nport 22\n" : "user root\nhostname 178.156.161.168\nport 2222\n", stderr: "" };
    };
    expect(await sshHostName({ user: "root", host: "spoo", port: 2222 }, run)).toBe("178.156.161.168");
    expect(asked[0]).toEqual(["ssh", "-G", ...sshDialArgs({ user: "root", host: "spoo", port: 2222 }), "root@spoo"]);
    expect(await sshHostName({ user: "root", host: "me", port: 22 }, run)).toBe("127.0.0.1");
    const broken: SshLocalRun = async () => ({ exitCode: 255, stdout: "", stderr: "Bad configuration option\n" });
    expect(await sshHostName({ user: "root", host: "spoo", port: 22 }, broken)).toBe("spoo");
    expect(await new SshBackend({ hostName: async () => "10.0.0.9" }).hostNameFor({ user: "root", host: "spoo", port: 22 })).toBe("10.0.0.9");
  });

  it("is no address of this computer's own where a ProxyJump or a ProxyCommand carries the dial", async () => {
    const said: Record<string, string> = {
      "root@inner": "user root\nhostname 127.0.0.1\nproxyjump bastion\n",
      "root@piped": "user root\nhostname 127.0.0.1\nproxycommand nc %h %p\n",
    };
    const run: SshLocalRun = async (_file, args) => ({ exitCode: 0, stdout: said[String(args.at(-1))] ?? "", stderr: "" });
    expect(await sshHostName({ user: "root", host: "inner", port: 22 }, run)).toBeUndefined();
    expect(await sshHostName({ user: "root", host: "piped", port: 22 }, run)).toBeUndefined();
  });
});
