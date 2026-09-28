// SPDX-License-Identifier: AGPL-3.0-only
// Where a daemon lives on a machine, one value per kind. A fork's place must
// spell the script it always did, byte for byte, since the golden's content
// sha pins it and any drift rebuilds every golden on the account; a machine
// somebody owns must spell one that needs no root and touches nothing of
// theirs outside one folder under their home.
import { describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MACHINE_LACKS_LINES, machineLacksLine, machineLacksShort, machineNeverAnswered, NO_LINGER_LINE, NO_NODE_LINE, PLACE_NEEDS_ROOT_LINE, NO_SYSTEMD_LINE, shellQuote, sshDaemonPaths, WSP_WORKSPACE_APPARMOR_PATH } from "@wsp/protocol";
import { putBytesScript } from "@wsp/engine";
import type { Machine } from "@wsp/engine";
import { BOOT_SCRIPT, CLOUD_PLACE, JOINED, joinedPlace, CONTAINER_PLACE, DAEMON_GONE_LINE, daemonBinaryOn, daemonExecLine, daemonFlags, daemonLogCommand, guestPlace, SYSTEMD, NEEDS_SYSTEMD, deployDaemon, PREFLIGHT_OK_LINE, preflightScript, profileSourceLine, profileSourceStep, DAEMON_UNIT, daemonUnit, deployScript, loginFilesStep, removeDaemonScript, sshDaemonPlace, stageDaemonBundle, stopDaemonScript, WSP_COMMAND_NODE_MAJOR } from "../src/doctor.js";
import { daemonBinaryIn, GUEST_DAEMON_TARGETS } from "../src/daemon-binary.js";

const LOGIN = { home: "/home/maya", path: "/usr/local/bin:/usr/bin:/bin" };

/** A machine that writes nothing and remembers what it was asked to write and run, so a deploy that must put
 * nothing on a machine can be held to it. */
function fakeMachine(over: { preflight?: { exitCode: number; stdout: string; stderr?: string } } = {}): { machine: Machine; wrote: string[]; ran: string[] } {
  const wrote: string[] = [];
  const ran: string[] = [];
  const machine = {
    id: "ssh://maya@box:2222",
    kind: "sandbox" as const,
    putBytes: async (path: string) => void wrote.push(path),
    run: async (script: string) => {
      ran.push(script);
      if (script.includes(PREFLIGHT_OK_LINE) && over.preflight !== undefined) return { stderr: "", ...over.preflight };
      return { exitCode: 0, stdout: script.includes(PREFLIGHT_OK_LINE) ? `${PREFLIGHT_OK_LINE}\n` : "", stderr: "" };
    },
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  } as unknown as Machine;
  return { machine, wrote, ran };
}

/** A daemon asset folder with just enough in it to stage a bundle from: a stand-in binary per guest target, each
 * saying which one it is. */
function emptyBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-bundle-"));
  for (const target of GUEST_DAEMON_TARGETS) {
    mkdirSync(join(dir, target.triple), { recursive: true });
    writeFileSync(daemonBinaryIn(dir, target.triple), `#!/bin/sh\necho ${target.triple}\n`, { mode: 0o755 });
  }
  return dir;
}
/** The wsp command as npm lays the published package out, which is all a bundle takes of it: without one every
 * stage throws before the deploy reaches the machine, and a test reading what landed reads an empty list instead
 * of a failure. */
function emptyCli(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-cli-"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "bin.js"), "");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@zingzy/wsp", version: "0.0.0" }));
  return dir;
}
/** One chip a guest can be, for every line that names the binary by its own path. */
const GUEST_TARGET = GUEST_DAEMON_TARGETS[0]!;

const script = (): string => deployScript(sshDaemonPlace(LOGIN), "aabbcc");

describe("the place a fork keeps its daemon", () => {
  it("spells the guest's own layout: /root, a system unit, and the edge-reachable bind", () => {
    const cloud = deployScript(CLOUD_PLACE, "aabbcc");
    expect(cloud).toContain("mkdir -p /root/wsp-daemon /root/.wsp/inbox");
    expect(cloud).toContain("tar --no-same-owner -xzf /root/wsp-daemon.tgz -C /root/wsp-daemon");
    expect(cloud).toContain(`cat > /etc/systemd/system/${DAEMON_UNIT} <<'WSP_UNIT'`);
    expect(cloud).toContain(`systemctl restart ${DAEMON_UNIT}`);
    expect(cloud).not.toContain("systemctl --user");
    expect(daemonFlags(CLOUD_PLACE)).toContain("0.0.0.0");
    expect(daemonUnit(CLOUD_PLACE, GUEST_TARGET)).toContain("WantedBy=multi-user.target");
    // Nothing is read off the machine before the install: wsp built it and knows what is on it.
    expect(cloud).not.toContain("Node 22");
    expect(cloud).not.toContain("command -v node");
  });
});

describe("what keeps the daemon running is a module, not a question the deploy asks", () => {
  it("registers one module per way and one place per kind, and no line of a script names either", () => {
    // A fork and a machine over ssh are kept up by the same service manager, told a different scope; a container
    // whose only lasting process is its own boot gets the script that loop-restarts the daemon.
    expect(CLOUD_PLACE.supervise).toBe(SYSTEMD);
    expect(sshDaemonPlace(LOGIN).supervise).toBe(SYSTEMD);
    expect(CONTAINER_PLACE.supervise).toBe(BOOT_SCRIPT);
    expect([CLOUD_PLACE.scope, sshDaemonPlace(LOGIN).scope]).toEqual(["system", "user"]);

    // The one place a supervisor id is matched to a place, which is what a machine's own answer picks.
    expect(guestPlace("systemd")).toBe(CLOUD_PLACE);
    expect(guestPlace("entrypoint")).toBe(CONTAINER_PLACE);

    // And nothing a place writes names a supervisor or a kind: the place answers, the script does not ask. The
    // sentences a refusing check echoes are left out of the read: those are words for a person about what their
    // machine has not got, and naming the thing is the whole of what they say.
    const asking = (script: string): string => MACHINE_LACKS_LINES.reduce((text, said) => text.split(said).join(""), script);
    for (const place of [CLOUD_PLACE, CONTAINER_PLACE, sshDaemonPlace(LOGIN)]) {
      for (const script of [deployScript(place, "aabbcc"), removeDaemonScript(place), preflightScript(place)]) {
        for (const word of ["entrypoint", "systemd ", "supervisor ===", '"cloud"', '"ssh"']) expect(asking(script), word).not.toContain(word);
      }
    }
  });

  it("gives each way its own answer to whether the daemon came up, in words that machine can say", () => {
    // A guest has iproute2; a container image ships neither ss nor curl, so bash's own network road answers.
    expect(deployScript(CLOUD_PLACE, "aabbcc")).toContain("ss -ltnH 'sport = :7070'");
    expect(deployScript(CONTAINER_PLACE, "aabbcc")).toContain("exec 3<>/dev/tcp/127.0.0.1/7070");
    expect(deployScript(CONTAINER_PLACE, "aabbcc")).not.toContain("ss -ltn");
    // A machine somebody owns let its daemon pick the port, so the file it wrote is what says it bound.
    expect(deployScript(sshDaemonPlace(LOGIN), "aabbcc")).toContain("'/home/maya/.wsp/daemon.port'");
    // And each reads the log its own supervision bounds.
    expect(daemonLogCommand(CLOUD_PLACE, 50)).toContain("journalctl -u");
    expect(daemonLogCommand(sshDaemonPlace(LOGIN), 50)).toContain("journalctl --user -u");
    expect(daemonLogCommand(CONTAINER_PLACE, 50)).toContain("tail -n 50");
  });
});

describe("the place a machine reached over ssh keeps its daemon", () => {
  it("puts every path under the login's own home and nothing under /root", () => {
    const at = sshDaemonPaths(LOGIN.home);
    const s = script();
    expect(s).toContain(`mkdir -p '${at.dir}' '${at.inbox}' '${at.binDir}' '${at.unitDir}'`);
    expect(s).toContain(`tar --no-same-owner -xzf '${at.bundle}' -C '${at.dir}'`);
    // The token's value is not in this script: it lands over the byte road, which the case below pins. The path
    // the daemon reads it from is, on the unit's own line.
    expect(s).not.toContain("aabbcc");
    expect(s).toContain(`--token-path "${at.tokenPath}"`);
    expect(s).toContain(`install -m 0755 '${at.dir}/wsp-open' '${at.binDir}/wsp-open'`);
    // The one rule for where these sit is the protocol's, so the deploy that writes them and the runtime that
    // reads the token and the port back cannot spell one path two ways.
    expect(at.tokenPath).toBe("/home/maya/.wsp/daemon-token");
    expect(at.portFile).toBe("/home/maya/.wsp/daemon.port");
    // Nothing on the machine is root's to write: every path the place names sits under the login's own home, and
    // the only file of the person's own touched outside wsp's folder is one line in their .profile.
    const place = sshDaemonPlace(LOGIN);
    const named = [place.dir, place.bundle, place.inbox, place.tokenPath, place.rootsPath, place.root, place.runDir, place.binDir, place.openShim, place.openSocket, place.manifestPath, place.profileFile, place.unitPath, ...place.make];
    expect(named.filter(path => !path.startsWith("/home/maya/") && path !== "/home/maya")).toEqual([]);
    expect(place.profileSource).toBe("/home/maya/.profile");
    expect(s).not.toMatch(/\/root\b/);
    expect(s).not.toContain("/etc/");
    // The person's PATH carries /usr/local/bin and rides the unit, but nothing is installed there or anywhere
    // else this login does not own, and no line asks for another one's rights.
    expect(s.split("\n").filter(line => /(^|[;&|(] *)sudo /.test(line))).toEqual([]);
    expect(s.split("\n").filter(line => /(> *|-C +|install [^\n]* )\/(usr|etc|opt|var)\//.test(line))).toEqual([]);
  });

  it("runs under the login's own systemd, enabled so a reboot brings it back", () => {
    const s = script();
    expect(s).toContain(`cat > '/home/maya/.config/systemd/user/${DAEMON_UNIT}' <<'WSP_UNIT'`);
    for (const verb of ["daemon-reload", `enable ${DAEMON_UNIT}`, `restart ${DAEMON_UNIT}`]) expect(s).toContain(`systemctl --user ${verb}`);
    expect(s).toContain(`journalctl --user -u ${DAEMON_UNIT}`);
    expect(daemonUnit(sshDaemonPlace(LOGIN), GUEST_TARGET)).toContain("WantedBy=default.target");
    expect(daemonUnit(sshDaemonPlace(LOGIN), GUEST_TARGET)).toContain('Environment="HOME=/home/maya"');
    // A login that arrives with no session bus cannot reach its own systemd at all, so the address is settled
    // before the first systemctl rather than every line failing at the bus.
    const lines = s.split("\n");
    expect(lines.findIndex(l => l.startsWith("export XDG_RUNTIME_DIR="))).toBeLessThan(lines.findIndex(l => l.includes("systemctl --user")));
  });

  it("binds the machine's own loopback on a port it picks, and writes that port down", () => {
    const flags = daemonFlags(sshDaemonPlace(LOGIN));
    expect(flags).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--token-path",
      "/home/maya/.wsp/daemon-token",
      "--root",
      "/home/maya",
      "--roots-path",
      "/home/maya/.wsp/roots",
      "--kind",
      "ssh",
      "--inbox",
      "/home/maya/.wsp/inbox",
      "--manifest",
      "/home/maya/.wsp/manifest.json",
      "--open-socket",
      "/home/maya/.wsp/open.sock",
      "--port-file",
      "/home/maya/.wsp/daemon.port",
    ]);
    expect(flags).not.toContain("0.0.0.0");
    const s = script();
    // The old port file goes before the restart, so the wait cannot read the port of the daemon just replaced.
    expect(s.indexOf("rm -f '/home/maya/.wsp/daemon.port'")).toBeLessThan(s.indexOf(`systemctl --user restart ${DAEMON_UNIT}`));
    expect(s).toContain("for _ in $(seq 80); do [ -s '/home/maya/.wsp/daemon.port' ] && break; sleep 0.25; done");
    // iproute2 is on a guest wsp built and on nothing else in particular, so the port file and the supervisor
    // are what say the daemon is up.
    expect(stopDaemonScript(sshDaemonPlace(LOGIN))).not.toContain("ss -");
    expect(s).toContain(`systemctl --user is-active --quiet ${DAEMON_UNIT} && echo "DAEMON_PORT $p"`);
  });

  it("refuses a machine without a node the wsp command runs on before it installs anything, and asks nothing for the daemon itself", () => {
    const s = preflightScript(sshDaemonPlace(LOGIN));
    // The sentence rides the script quoted, so what is looked for is the clause a shell quote leaves alone.
    const said = NO_NODE_LINE.slice(0, NO_NODE_LINE.indexOf(","));
    const lines = s.split("\n");
    const refusal = lines.find(l => l.includes(said));
    expect(refusal).toContain("command -v node");
    expect(refusal).toContain(`-lt ${WSP_COMMAND_NODE_MAJOR}`);
    expect(WSP_COMMAND_NODE_MAJOR).toBe(22);
    // It ends the deploy itself. A guard written as `|| { ...; false; }` does not: bash ignores set -e inside a
    // compound command that is part of an || list, so the script runs on (measured 2026-09-11 on bash 5.2).
    expect(refusal).toContain("exit 1");
    // The daemon is a static binary: no compiler, no headers, no package manager is asked for.
    expect(s).not.toContain("cc make python3");
    expect(s).not.toContain("npm");
    // Nothing of the install is in this script at all: it is asked on its own, before anything is packed or sent.
    expect(s).not.toContain("mkdir -p");
  });

  it("installs the bundle and nothing else: no node, no npm, no compiler, no download", () => {
    const s = script();
    for (const word of ["nodejs.org", "npm install", "node_pin", "sha256sum", "curl", "NODE_VERSION", "npm_config_nodedir"]) expect(s, word).not.toContain(word);
    // The unit's PATH is the person's own plus the shim's folder; nothing of wsp's is put ahead of it.
    expect(daemonUnit(sshDaemonPlace(LOGIN), GUEST_TARGET)).toContain('Environment="PATH=/home/maya/.local/bin:/usr/local/bin:/usr/bin:/bin"');
  });

  it("adds its BROWSER line to the person's own login file once, guarded on the file it names", () => {
    const s = script();
    expect(s).toContain("printf 'export BROWSER=%s\\nunset DISPLAY\\n' '/home/maya/.local/bin/wsp-open' > '/home/maya/.wsp/profile.sh'");
    // A workspace on a box binds the computer's /root and keeps its own wsp folder inside it, so the file the
    // line names is not there and a login shell printed an error for it: the line reads the file first.
    expect(profileSourceLine("/home/maya/.wsp/profile.sh")).toBe("[ -f /home/maya/.wsp/profile.sh ] && . /home/maya/.wsp/profile.sh");
    // Their .profile is theirs: every line naming wsp's file goes out before this one goes in, so a second
    // deploy leaves one line and a computer joined before the guard is left with the guarded spelling alone.
    expect(s).toContain(`grep -vF '/home/maya/.wsp/profile.sh' '/home/maya/.profile'`);
    expect(s).toContain(`printf '%s\\n' '${profileSourceLine("/home/maya/.wsp/profile.sh")}' >> '/home/maya/.profile'`);
    expect(s).not.toContain("grep -q '/home/maya/.wsp/profile.sh'");
    // One home for the text: what the join deploys here is the lines an update runs on a computer already joined,
    // in this order and with nothing of the deploy's own between them.
    expect(s).toContain(loginFilesStep(sshDaemonPlace(LOGIN)).join("\n"));
  });

  it("never writes the token into a command, since every account on the machine can read a running one", () => {
    const s = script();
    // /proc/<pid>/cmdline is world readable, and a machine somebody owns may carry other accounts: the token
    // lands over the byte road before this script runs, so the script names the file and never its content.
    expect(s).not.toContain("aabbcc");
    expect(s).not.toContain("WSP_DAEMON_TOKEN");
    // A fork is root's alone and keeps the write in its script, which is what the golden's sha pins.
    expect(deployScript(CLOUD_PLACE, "aabbcc")).toContain("WSP_DAEMON_TOKEN='aabbcc'");
    expect(sshDaemonPlace(LOGIN).tokenRoad).toBe("bytes");
    expect(CLOUD_PLACE.tokenRoad).toBe("script");
    // What that road writes is the writer's alone from the moment it exists.
    expect(putBytesScript("/home/maya/.wsp/daemon-token", 24, "/home/maya/.wsp/t")).toContain("umask 077");
  });

  it("quotes every path it writes, since the home came from the machine and may hold a space", () => {
    const spaced = sshDaemonPlace({ home: "/home/Jane Doe", path: "/usr/bin" });
    const off = removeDaemonScript(spaced);
    // Unquoted, this line is `rm -rf /home/Jane Doe/.wsp/daemon`, which is /home/Jane and a relative path.
    expect(off).toContain("rm -rf '/home/Jane Doe/.wsp/daemon'");
    expect(off).not.toMatch(/rm -[rf]+ [^'\n]*\/home\/Jane Doe/);
    const on = deployScript(spaced, "aabbcc");
    for (const line of [...on.split("\n"), ...off.split("\n")]) {
      // Every naked mention of the home is inside quotes; the one exception is the unit heredoc, which is systemd's
      // language and quoted below.
      if (!line.includes("/home/Jane Doe")) continue;
      if (line.startsWith("WorkingDirectory=")) continue;
      expect(line, line).toMatch(/['"][^'"]*\/home\/Jane Doe/);
    }
    // The unit is systemd's own quoting, and each setting wants its own. WorkingDirectory takes the rest of the
    // line, so a quote there is read as part of the path (measured on systemd 255: "path is not absolute");
    // Environment is split on whitespace, so a value with a space in it is quoted; ExecStart is a command line
    // systemd splits itself, where a double quoted word holds.
    const unit = daemonUnit(spaced, GUEST_TARGET);
    expect(unit).toContain("WorkingDirectory=/home/Jane Doe/.wsp/daemon");
    expect(unit).not.toContain('WorkingDirectory="');
    expect(unit).toContain('Environment="HOME=/home/Jane Doe"');
    expect(unit).toContain(`ExecStart=${daemonExecLine(spaced, GUEST_TARGET)}`);
    expect(daemonExecLine(spaced, GUEST_TARGET).startsWith(`"${daemonBinaryOn(spaced.dir, GUEST_TARGET)}" --host 127.0.0.1 --port 0 --token-path "/home/Jane Doe/.wsp/daemon-token" `)).toBe(true);
    for (const word of daemonExecLine(spaced, GUEST_TARGET).match(/"[^"]*"|\S+/g)!) if (word.includes("Jane")) expect(word, word).toMatch(/^"[^"]*"$/);
    // A fork chose its own paths and its script is pinned byte for byte, so nothing there is quoted.
    expect(CLOUD_PLACE.quotePaths).toBe(false);
    expect(daemonUnit(CLOUD_PLACE, GUEST_TARGET)).toContain("WorkingDirectory=/root/wsp-daemon");
    expect(daemonExecLine(CLOUD_PLACE, GUEST_TARGET)).not.toContain('"');
  });

  it("asks the machine before a byte of wsp's lands on it, so one that refuses keeps nothing", async () => {
    const place = sshDaemonPlace(LOGIN);
    // The checks are their own command now, not lines inside the deploy: nothing is packed, uploaded or written
    // until the machine has passed them, so a machine that refuses is left exactly as it was found.
    const ask = preflightScript(place);
    expect(ask).toContain("command -v node");
    expect(ask).toContain("Linger");
    expect(ask.trim().endsWith(PREFLIGHT_OK_LINE)).toBe(true);
    const s = deployScript(place, "aabbcc");
    expect(s).not.toContain("command -v node");
    expect(s).not.toContain("Linger");

    // A machine that refuses is told what it needs, and had nothing put on it: no write, no run but the ask.
    const refused = fakeMachine({ preflight: { exitCode: 1, stdout: `${NO_NODE_LINE}\n` } });
    await expect(deployDaemon(refused.machine, { place, daemonDir: emptyBundle(), cliDir: emptyCli() })).rejects.toThrow(NO_NODE_LINE);
    expect(refused.wrote).toEqual([]);
    expect(refused.ran).toEqual([ask]);

    // A place with nothing to ask does not spend a round trip on it, which is every fork.
    expect(CLOUD_PLACE.preflight).toEqual([]);
    const guest = fakeMachine();
    await deployDaemon(guest.machine, { place: CLOUD_PLACE, daemonDir: emptyBundle(), cliDir: emptyCli() }).catch(() => {});
    expect(guest.ran.some(r => r.includes(PREFLIGHT_OK_LINE))).toBe(false);
  });

  it("asks a machine for the service manager its daemon would be held up by, on the road that asks before anything lands", async () => {
    // One systemd predicate in the tree, asked by every place standing on a machine wsp did not build: the
    // workspace over ssh and the computer joined over it, whose own join installs a unit under that same manager.
    const joined = joinedPlace(LOGIN, { hostUrls: ["http://192.168.1.20:4400"], codeFile: "/home/maya/.wsp/join-code", name: "box" });
    for (const place of [sshDaemonPlace(LOGIN), joined]) {
      const ask = preflightScript(place);
      expect(ask, place.kind).toContain(NEEDS_SYSTEMD);
      expect(ask, place.kind).toContain(machineLacksShort(NO_SYSTEMD_LINE));
      expect(deployScript(place, "aabbcc"), place.kind).not.toContain("command -v systemctl");
    }
    // A fork is asked none of it: wsp built that machine and knows what is on it, and a refusal recorded there is
    // one nothing would offer again, since a machine wsp made answers no read of what it is.
    expect(CLOUD_PLACE.preflight).toEqual([]);
    expect(CONTAINER_PLACE.preflight).toEqual([]);
    // What holds the daemon up is asked first: a machine nothing there would restart a daemon on cannot take one
    // whatever else it carries, so that is the sentence a person is given rather than the second thing it lacks.
    const lines = preflightScript(sshDaemonPlace(LOGIN)).split("\n");
    expect(lines.findIndex(l => l.includes("command -v systemctl"))).toBeLessThan(lines.findIndex(l => l.includes("command -v node")));
    // A machine that refuses says the whole sentence and had nothing put on it: no write, no run but the ask.
    const place = sshDaemonPlace(LOGIN);
    const refused = fakeMachine({ preflight: { exitCode: 1, stdout: `${NO_SYSTEMD_LINE}\n` } });
    const said = await deployDaemon(refused.machine, { place, daemonDir: emptyBundle(), cliDir: emptyCli() }).catch((e: unknown) => e);
    expect(machineLacksLine(said)).toBe(NO_SYSTEMD_LINE);
    expect(refused.wrote).toEqual([]);
    expect(refused.ran).toEqual([preflightScript(place)]);
  });

  it("marks the machine's own refusal apart from a check that never reached the machine", async () => {
    const place = sshDaemonPlace(LOGIN);
    // The refusing line echoes its sentence and exits 1, so the words are the machine's own and are marked as
    // what it has not got: that is the sentence a row shows.
    const refused = await deployDaemon(fakeMachine({ preflight: { exitCode: 1, stdout: `${NO_NODE_LINE}\n` } }).machine, { place, daemonDir: emptyBundle(), cliDir: emptyCli() }).catch((e: unknown) => e);
    expect(machineLacksLine(refused)).toBe(NO_NODE_LINE);
    expect(machineNeverAnswered(refused)).toBe(false);

    // A box that is switched off: nothing ran on it, so ssh answers 255 with its own words on stderr and nothing
    // on stdout. Those words say nothing about what that machine has, so they carry no lack and never reach a row.
    const off = await deployDaemon(fakeMachine({ preflight: { exitCode: 255, stdout: "", stderr: "ssh: connect to host box port 2222: Connection refused\n" } }).machine, { place, daemonDir: emptyBundle(), cliDir: emptyCli() }).catch((e: unknown) => e);
    expect(machineLacksLine(off)).toBeUndefined();
    expect(machineNeverAnswered(off)).toBe(true);
    expect((off as Error).message).toContain("Connection refused");
  });

  it("refuses a login whose services stop with it, naming the one command that turns that off", () => {
    const s = preflightScript(sshDaemonPlace(LOGIN));
    const line = s.split("\n").find(l => l.includes("Linger"));
    expect(line).toContain("loginctl show-user");
    expect(line).toContain("exit 1");
    expect(line).toContain(machineLacksShort(NO_LINGER_LINE));
    expect(NO_LINGER_LINE).toContain("loginctl enable-linger");
    // Asked only where the machine can answer: a machine with no loginctl is not refused for lacking one.
    expect(line).toContain("command -v loginctl");
    // A fork's own systemd is the machine's, so nothing there asks about a login.
    expect(preflightScript(CLOUD_PLACE)).not.toContain("Linger");
    expect(deployScript(CLOUD_PLACE, "aabbcc")).not.toContain("Linger");
  });

  it("takes everything it put on the machine off again, so nothing of wsp's outlives the record", () => {
    const at = sshDaemonPaths(LOGIN.home);
    const off = removeDaemonScript(sshDaemonPlace(LOGIN));
    expect(off).toContain(`systemctl --user disable --now ${DAEMON_UNIT}`);
    expect(off).toContain(`rm -f '${at.unitDir}/${DAEMON_UNIT}'`);
    for (const path of [at.dir, at.bundle, at.inbox, at.tokenPath, at.rootsPath, at.profileFile, at.openSocket, at.portFile, at.runDir, `${at.binDir}/wsp-open`, `${at.binDir}/xdg-open`]) {
      expect(off, path).toContain(`'${path}'`);
    }
    // The one line wsp added to their own login file goes too: left behind it would print an error at every
    // login for a file that is gone.
    // Matched by the file it names and not by one spelling of the line, so the removal takes out the line a
    // computer joined before the guard carries as surely as the one written now.
    expect(off).toContain(`grep -vF '${at.profileFile}' '/home/maya/.profile'`);
    // The working copy goes whether the rewrite landed or not: a read that failed must not leave them an empty
    // login file, and must not leave a file of wsp's beside their own either.
    expect(off).toContain("rm -f '/home/maya/.profile.wsp-out'");
    expect(off).toContain(`echo ${DAEMON_GONE_LINE}`);
    // Only what wsp put there, each path named. Their home, their bin folder and their login file stay, and so
    // does wsp's own folder itself: another road of wsp keeps things beside the daemon in it, and a machine on
    // this test's own box once held one builder's file there while another's record was being deleted.
    expect(off).not.toMatch(/rm -rf [^\n]*\/home\/maya(\s|$)/);
    expect(off).not.toMatch(new RegExp(`rm -rf [^\n]*${at.wsp}(\\s|$)`));
    expect(off).not.toContain(`rm -rf ${at.binDir}`);
    expect(off).not.toMatch(/rm -[rf]+ [^\n]*\/home\/maya\/\.profile(\s|$)/);
  });

  it("leaves a login file it never wrote to byte for byte as it was, symlink and all", async () => {
    // The sweep runs on every machine recorded over ssh now, including one whose deploy never landed, so the
    // removal must not touch a login file wsp put no line in. Run for real: their .profile is a symlink into a
    // dotfiles checkout on many machines, and a rewrite that replaces the file turns it into a plain one.
    const dir = mkdtempSync(join(tmpdir(), "wsp-profile-"));
    try {
      const home = join(dir, "home");
      const dotfiles = join(dir, "dotfiles");
      mkdirSync(home, { recursive: true });
      mkdirSync(dotfiles, { recursive: true });
      const real = join(dotfiles, "profile");
      const theirs = "# mine\nexport EDITOR=vim\n";
      writeFileSync(real, theirs);
      symlinkSync(real, join(home, ".profile"));
      const before = statSync(real);

      await promisify(execFile)("bash", ["-c", removeDaemonScript(sshDaemonPlace({ home, path: "/usr/bin" }))]);

      // Byte for byte, the same inode, and still a symlink.
      expect(readFileSync(real, "utf8")).toBe(theirs);
      expect(statSync(real).ino).toBe(before.ino);
      expect(lstatSync(join(home, ".profile")).isSymbolicLink()).toBe(true);
      expect(existsSync(`${join(home, ".profile")}.wsp-out`)).toBe(false);

      // And with wsp's line in it, in the spelling a computer joined before the guard carries, the line goes and
      // everything else stays, the symlink and inode with it.
      const at = sshDaemonPaths(home);
      writeFileSync(real, `# mine\n. ${at.profileFile}\nexport EDITOR=vim\n`);
      const kept = statSync(real).ino;
      await promisify(execFile)("bash", ["-c", removeDaemonScript(sshDaemonPlace({ home, path: "/usr/bin" }))]);
      expect(readFileSync(real, "utf8")).toBe(theirs);
      expect(statSync(real).ino).toBe(kept);
      expect(lstatSync(join(home, ".profile")).isSymbolicLink()).toBe(true);

      // The guarded spelling a deploy writes now goes the same way, and a file holding nothing but wsp's own line
      // loses it too, which reading what grep says about a file it selected nothing from is there for.
      writeFileSync(real, `# mine\n[ -f ${at.profileFile} ] && . ${at.profileFile}\n`);
      await promisify(execFile)("bash", ["-c", removeDaemonScript(sshDaemonPlace({ home, path: "/usr/bin" }))]);
      expect(readFileSync(real, "utf8")).toBe("# mine\n");
      writeFileSync(real, `. ${at.profileFile}\n`);
      await promisify(execFile)("bash", ["-c", removeDaemonScript(sshDaemonPlace({ home, path: "/usr/bin" }))]);
      expect(readFileSync(real, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes its one line under set -e on a login with no file of its own, and leaves one line on a second deploy", async () => {
    // The deploy runs under set -e, so the step that takes wsp's older line out must not fail on a login file
    // that is not there, nor on one holding nothing else; the append makes the file as the old step did.
    const dir = mkdtempSync(join(tmpdir(), "wsp-profile-step-"));
    try {
      const home = join(dir, "home");
      mkdirSync(home, { recursive: true });
      const place = sshDaemonPlace({ home, path: "/usr/bin" });
      const step = profileSourceStep(place).join("\n");
      const run = async (): Promise<void> => void (await promisify(execFile)("sh", ["-ec", step]));
      await run();
      expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`${profileSourceLine(place.profileFile)}\n`);
      // A second deploy replaces it rather than sitting beside it, and a line of theirs is kept.
      writeFileSync(join(home, ".profile"), `. ${place.profileFile}\nexport EDITOR=vim\n`);
      await run();
      expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`export EDITOR=vim\n${profileSourceLine(place.profileFile)}\n`);
      await run();
      expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`export EDITOR=vim\n${profileSourceLine(place.profileFile)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stages a bundle whose browser shim is that machine's own, with one binary per chip and nothing built there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-ssh-stage-"));
    try {
      const home = join(dir, "home");
      const stage = join(dir, "stage");
      await stageDaemonBundle(stage, sshDaemonPlace({ home, path: LOGIN.path }), emptyBundle(), emptyCli());
      expect(readdirSync(stage).sort()).toEqual(["wsp", "wsp-open"]);
      // The shim posts to the socket under this login's own folder, and is the one executable file beside the binaries.
      const shim = readFileSync(join(stage, "wsp-open"), "utf8");
      expect(shim).toContain(`--unix-socket '${home}/.wsp/open.sock'`);
      expect(statSync(join(stage, "wsp-open")).mode & 0o111).toBe(0o111);
      // Each chip's binary under its own triple, where the wsp command beside them reads one, and executable.
      for (const target of GUEST_DAEMON_TARGETS) {
        const bin = daemonBinaryOn(stage, target);
        expect(statSync(bin).mode & 0o111).toBe(0o111);
        expect(execFileSync(bin, { encoding: "utf8" }).trim()).toBe(target.triple);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the place a computer joined over ssh keeps its agent", () => {
  const JOIN = { hostUrls: ["http://192.168.1.20:4400", "https://p_x.example.com"], codeFile: "/home/maya/.wsp/join-code", name: "box" };
  const joined = (): string => deployScript(joinedPlace(LOGIN, JOIN), "aabbcc");

  it("runs the computer's own join on the node the preflight asked for, at every address this host answers on and with the code read off a file", () => {
    const s = joined();
    expect(s).toContain(
      "node '/home/maya/.wsp/daemon/wsp/dist/bin.js' join 'http://192.168.1.20:4400' 'https://p_x.example.com' --code-file '/home/maya/.wsp/join-code' --name 'box'",
    );
    // The code never sits in a command line, where every account on that computer could read it while it runs.
    expect(s).not.toContain("--code ");
    expect(preflightScript(joinedPlace(LOGIN, JOIN))).toContain("command -v node");
  });

  it("writes no unit of its own, because the join it runs installs the one that holds the agent up", () => {
    const s = joined();
    expect(s).not.toContain(DAEMON_UNIT);
    expect(s).not.toContain("systemctl --user enable");
    // What it waits on is the file that says this computer belongs to a wsp.
    expect(s).toContain("[ -s '/home/maya/.wsp/place.json' ] && echo DAEMON_UP || echo DAEMON_DOWN");
  });

  it("takes the code off that computer however the deploy ends, armed before the first line that writes", () => {
    const s = joined();
    expect(s).toContain(`trap "rm -f '/home/maya/.wsp/join-code'" EXIT`);
    // Before anything lands: a deploy that dies at the unpack must leave no code on their disk either.
    expect(s.indexOf("trap ")).toBeLessThan(s.indexOf("tar --no-same-owner -xzf"));
    // Every other place carries no trap at all, so what a fork's deploy writes is what it always wrote.
    expect(deployScript(CLOUD_PLACE, "aabbcc")).not.toContain("trap ");
    expect(script()).not.toContain("trap ");
  });

  it("parses as a shell script, and the trap takes the code off however the deploy ends", () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-trap-"));
    mkdirSync(`${home}/.wsp`, { recursive: true });
    const codeFile = `${home}/.wsp/join-code`;
    const place = joinedPlace({ home, path: LOGIN.path }, { hostUrls: ["http://10.0.0.2:4400"], codeFile, name: "box" });
    const whole = deployScript(place, "aabbcc");
    const path = `${home}/deploy.sh`;
    // bash reads the whole file before it runs a line, so a quoting fault anywhere in it is a parse error here.
    writeFileSync(path, whole);
    execFileSync("bash", ["-n", path]);
    // The trap and then a line that fails, which is every deploy that dies before the join spends the code.
    writeFileSync(codeFile, "7QK3M2VD\n");
    writeFileSync(path, `${whole.split("\n").slice(0, 3).join("\n")}\nfalse\n`);
    expect(() => execFileSync("bash", [path], { stdio: "ignore" })).toThrow();
    expect(existsSync(codeFile)).toBe(false);
  });

  it("keeps every path the ssh road lays down, so one sweep takes the lot however the agent got there", () => {
    const place = joinedPlace(LOGIN, JOIN);
    const { supervise: _ssh, kind: _k, scope: _s, unitPath: _u, wantedBy: _w, preflight: _p, ...ssh } = sshDaemonPlace(LOGIN);
    const { supervise: _joined, kind: _jk, join: _j, onExit: _x, scope: _js, unitPath: _ju, wantedBy: _jw, preflight: _jp, ...rest } = place;
    expect(rest).toEqual(ssh);
    expect(place.kind).toBe("place");
  });

  it("installs the daemon as a system service, since joining a computer you own needs root, and never asks that login to linger", () => {
    const place = joinedPlace(LOGIN, JOIN);
    expect(place.scope).toBe("system");
    expect(place.unitPath).toBe(`/etc/systemd/system/${DAEMON_UNIT}`);
    expect(daemonUnit(place, GUEST_TARGET)).toContain("WantedBy=multi-user.target");
    expect(preflightScript(place)).not.toContain("enable-linger");
    expect(preflightScript(place)).not.toContain(NO_LINGER_LINE);
  });

  it("reads one sentence and stops before anything is written when the login is not root", async () => {
    const place = joinedPlace(LOGIN, JOIN);
    expect(preflightScript(place)).toContain(PLACE_NEEDS_ROOT_LINE);
    // The one line, under bash, with the login it reads standing in: the checks beside it ask this machine what it
    // has, and the answer differs on a Mac and a Linux box, so running the whole script would read the machine the
    // test is on rather than the condition under test.
    const rootCheck = place.preflight.at(-1)!;
    expect(rootCheck).toContain(PLACE_NEEDS_ROOT_LINE);
    const asLogin = (uid: number): Promise<{ stdout: string; code?: number }> =>
      promisify(execFile)("bash", ["-c", `id() { echo ${uid}; }\n${rootCheck}\necho ${PREFLIGHT_OK_LINE}`]).catch((e: unknown) => e as { stdout: string; code?: number });
    const plain = await asLogin(1000);
    expect(plain.stdout).toContain(PLACE_NEEDS_ROOT_LINE);
    expect(plain.stdout).not.toContain(PREFLIGHT_OK_LINE);
    expect(plain.code).toBe(1);
    // The same line says nothing at all for root, so the check is the login and not the machine.
    const asRoot = await asLogin(0);
    expect(asRoot.stdout.trim()).toBe(PREFLIGHT_OK_LINE);
    expect(asRoot.code).toBeUndefined();
    // Nothing lands before the check: a refused preflight leaves the computer exactly as it was found.
    const box = fakeMachine({ preflight: { exitCode: 1, stdout: `${PLACE_NEEDS_ROOT_LINE}\n` } });
    await expect(deployDaemon(box.machine, { place, daemonDir: emptyBundle(), cliDir: emptyCli() })).rejects.toThrow(PLACE_NEEDS_ROOT_LINE);
    expect(box.wrote).toEqual([]);
  });

  it("takes the workspace profile back off, so a remove leaves a root install holding nothing of wsp's", () => {
    const place = joinedPlace(LOGIN, JOIN);
    const off = removeDaemonScript(place);
    // Unloaded before the file goes: the kernel holds a profile by name, so a bare rm would leave it loaded for a
    // binary that is gone. Guarded the way the step that wrote it is, and only where this scope could write it.
    expect(off).toContain(`apparmor_parser -R ${shellQuote(WSP_WORKSPACE_APPARMOR_PATH)}`);
    expect(off).toContain(`rm -f ${shellQuote(WSP_WORKSPACE_APPARMOR_PATH)}`);
    expect(off.indexOf("apparmor_parser -R")).toBeLessThan(off.indexOf(`rm -f ${shellQuote(WSP_WORKSPACE_APPARMOR_PATH)}`));
    expect(off).toContain("command -v apparmor_parser >/dev/null 2>&1");
    // The two scopes that write no such profile take none off: a login's own daemon owns no /etc.
    expect(removeDaemonScript(sshDaemonPlace(LOGIN))).not.toContain("apparmor_parser");
    // What the deploy wrote is what the remove takes: one path, named once.
    expect(deployScript(place, "aabbcc")).toContain(WSP_WORKSPACE_APPARMOR_PATH);
  });

  it("says so when a place it is given names no wsp to join, rather than writing a join line with nothing in it", () => {
    expect(() => JOINED.start(sshDaemonPlace(LOGIN), GUEST_TARGET)).toThrow("names no wsp to join");
  });

  it("lands whatever else that place's script reads off disk by the byte road, never in a command", async () => {
    const place = joinedPlace(LOGIN, JOIN);
    const box = fakeMachine();
    await deployDaemon(box.machine, { place, daemonDir: emptyBundle(), cliDir: emptyCli(), land: [{ path: place.join!.codeFile, bytes: new TextEncoder().encode("7QK3M2VD\n") }] }).catch(() => {});
    // The bundle, the token and then the code, each over the byte road, before one command names any of them.
    expect(box.wrote).toEqual([place.bundle, place.tokenPath, "/home/maya/.wsp/join-code"]);
    expect(box.ran.join("\n")).not.toContain("7QK3M2VD");
  });
});
