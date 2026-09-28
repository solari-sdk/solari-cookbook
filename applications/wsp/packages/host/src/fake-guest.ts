// SPDX-License-Identifier: AGPL-3.0-only
// The guest a stand-in provider's machines get when a harness names a folder
// for them. One folder per machine standing in for its disk, with the same
// daemon this computer's own workspace runs rooted in it, so a fixture's fork
// has a terminal, a process list, live readings and browsable files instead of
// six ways of saying unreachable.
//
// It is wired from here and not from the stand-in itself for two reasons. The
// daemon package runs inside guests and the engine never imports it, so nothing
// down there can start one. And a stand-in that started a guest whether or not
// anybody asked would be a provider running a tester's commands on the person's
// computer by default: the folder has to be named, and a harness names one
// inside the throwaway home it serves out of.
//
// The daemon reads its token from a file in that folder rather than holding one
// this process minted, because the runtime rotates a machine's token by writing
// it to the path that machine names, and a stand-in machine has no root of a
// Linux guest to keep it under. One file per process, since every process that
// dials a machine writes its own token there and a machine's folder is the one
// thing two of them share.
//
// Every daemon started here is held so the command that started it can take it
// away again: a child whose pipes this process reads is a reason it stays, and
// a command whose work was done printed its whole report and never returned to
// the prompt. The host serving the app is held up by its own ports, so closing
// these when a command ends costs it nothing.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import type { FakeGuest } from "@wsp/engine";
import { DAEMON_PORT } from "@wsp/engine";
import { placeDaemonPaths, shellQuote, standInMachinePath, type PreviewReach } from "@wsp/protocol";
import { LocalDaemon } from "./local-daemon.js";
import { onPath, runningWsp, thisComputersPath, wspCommand } from "./mcp-install.js";

/** A loopback road has no edge token and no expiry; the field is the shape every reach arrives in. */
const NO_EDGE_TOKEN = "";
const NEVER = Number.MAX_SAFE_INTEGER;

/** One guest per folder, so a provider module built twice over one root does not put two daemons on one machine. */
const GUESTS = new Map<string, FakeGuest>();

/** Every daemon this process started for a stand-in machine, so all of them go when its command is done. */
const STARTED: Promise<LocalDaemon>[] = [];

/** The file one process's daemon for one stand-in machine reads its token from. The process is in the name because
 * a machine's folder is shared and its token is not: the runtime writes its own token there at every first reach,
 * and two of them on one file left the host serving the app holding a token its own daemon had stopped reading, so
 * a tester who typed a second verb watched the terminal, the files and the live rows go dark until it restarted. */
export const standInTokenPath = (root: string, machineId: string, of: number): string => join(standInMachinePath(root, machineId), `.wsp-daemon-token-${of}`);

/** The folders of a Linux guest that a stand-in machine answers for inside its own folder: the home a fork's
 * scripts write, the files its boot writes, and the two it stages bytes through. A path under one of them becomes
 * that machine's folder with the path under it, so a script written for a guest writes the stand-in's copy of it
 * rather than the root of the computer running it, where it either refuses or is the person's own. Nothing else
 * moves: /usr and /bin are where the commands themselves live, and a shell whose own binaries moved has nothing
 * left to run. */
const GUEST_FOLDERS = ["root", "etc", "tmp", "var"];

/** The guest's home, which is the folder its commands start in and where a path written under ~ lands. */
const guestHome = (at: string): string => join(at, "root");

/** Where this guest keeps the handful of commands a Linux guest has and a Mac spells differently or will not run,
 * and the agents this computer carries. The folder a golden's own tools sit in, under the machine's home, and not
 * one of this harness's choosing: a turn's script exports the image's PATH over whatever the shell it was launched
 * from had, and that PATH leads here (`TOOLS_PATH`), so a folder anywhere else is on the launch's path and on no
 * turn's. */
const guestBin = (at: string): string => join(at, "root", ".local", "bin");

/** The rule a file landing on this machine is read by, kept as a program of its own: the pattern carries both kinds
 * of quote, so no shell line holds it whole. */
const guestPaths = (at: string): string => join(guestBin(at), "guest-paths.pl");

/** The commands that folder holds. A fork names itself at birth, a Mac refuses the call, and the line it prints
 * reads as a fork that failed; the transfer that writes a machine's own context hashes its archive by the name
 * coreutils gives that command, which a Mac spells shasum; every turn and every exec launches its script in a
 * session of its own, which a Mac has no command for, so the reader waits on a run that died before the agent
 * spoke; and a file lands on a machine as text a shell decodes, whose own words name the guest's folders and would
 * otherwise name this computer's. The session is what the reap of a run takes away, so the stand-in's own has to be
 * a real one: perl's setsid is on every Mac and leaves the launched process leading its own group, which is what
 * the pid written down is killed as. */
const guestCommands = (at: string): Record<string, string> => ({
  hostname: `#!/bin/sh\n[ $# -eq 0 ] && cat ${shellQuote(join(at, "etc", "hostname"))} 2>/dev/null\nexit 0\n`,
  sha256sum: '#!/bin/sh\nexec shasum -a 256 "$@"\n',
  setsid: '#!/bin/sh\nexec perl -e \'use POSIX qw(setsid); setsid(); exec @ARGV or die "$ARGV[0]: $!\\n";\' -- "$@"\n',
  base64: `#!/bin/sh\ncase " $* " in\n  *" -d "*|*" --decode "*) /usr/bin/base64 "$@" | perl -p ${shellQuote(guestPaths(at))}; exit $?;;\nesac\nexec /usr/bin/base64 "$@"\n`,
  // What the wsp tools of a turn on a fork are started with, and what an agent shipped as a script runs under.
  node: `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`,
  // The word a turn's launch names for its own tools, and the one a turn's shell types. A real fork answers it with
  // the shim the deploy writes onto its PATH, two lines onto the daemon binary; a stand-in machine has no daemon of
  // that kind, so this runs this computer's own wsp against the host the launch named, which is the host those
  // tools would have reached anyway.
  wsp: wspLine(),
  ...guestAgents(),
});

/** This computer's own wsp, told which host to drive off the launch's own environment. */
function wspLine(): string {
  const wsp = wspCommand(runningWsp());
  const line = [wsp.command, ...wsp.args].map(word => shellQuote(word)).join(" ");
  return `#!/bin/sh\nexec ${line} "$@" --host "$WSP_HOST_URL"\n`;
}

/** The agents on this machine: the ones this computer has, each run where it stands here. A stand-in machine forks
 * from an image this computer sealed, so the agents it is meant to carry are this computer's own; without them a
 * turn's launch reaches a PATH with no agent on it and the reader waits on a run that said nothing. The directory
 * the real command lives in is put back on the path it runs with, since an agent shipped as a script looks for the
 * runtime beside it. */
const guestAgents = (): Record<string, string> =>
  Object.fromEntries(
    CATALOG_AGENTS.flatMap(agent => {
      const found = onPath(agent.bin, thisComputersPath());
      return found === undefined ? [] : [[agent.bin, `#!/bin/sh\nPATH=${shellQuote(dirname(found))}:$PATH\nexport PATH\nexec ${shellQuote(found)} "$@"\n`]];
    }),
  );

/** One path of the guest's inside the folder standing in for its disk; every other path as it was written. */
export const guestPath = (at: string, path: string): string =>
  path === "/" || GUEST_FOLDERS.some(folder => path === `/${folder}` || path.startsWith(`/${folder}/`)) ? join(at, path) : path;

/** Every path of the guest's in one command line, read as the words of a shell line: a word that is `/` alone or
 * begins with one of the guest's own folders. Built off the same table as the reading above, so a folder added
 * there is answered on both roads. */
const GUEST_PATH = new RegExp(`(^|[\\s"'=(])/(?=$|[\\s"')]|(?:${GUEST_FOLDERS.join("|")})(?:$|[\\s"'/)]))`, "g");

export const inGuestRoot = (at: string, cmd: string): string => cmd.replace(GUEST_PATH, (_, before: string) => `${before}${at}/`);

/** The same rewrite in the spelling the landing road reads it in, over one line at a time. An end of line is \Z
 * there, since a bare $ before a | is one of perl's own variables and would read as its value. */
const guestPathsProgram = (at: string): string => `s{${GUEST_PATH.source.replaceAll("$", "\\Z")}}{$1${at}/}g;\n`;

/** Makes that folder tree and the commands in it, at every call: a machine's folder is a throwaway one and may
 * have been taken away between two. */
function layGuestRoot(at: string): void {
  for (const folder of GUEST_FOLDERS) mkdirSync(join(at, folder), { recursive: true });
  mkdirSync(guestBin(at), { recursive: true });
  writeFileSync(guestPaths(at), guestPathsProgram(at));
  for (const [name, text] of Object.entries(guestCommands(at))) {
    const path = join(guestBin(at), name);
    writeFileSync(path, text);
    chmodSync(path, 0o755);
  }
}

/** What a road asking for any other port of a stand-in machine is told: nothing of the person's is behind it, and
 * answering with this computer's own loopback at that port would frame whatever they happen to be running. */
export const fakeNoPortLine = (machineId: string, port: number): string =>
  `nothing is listening on port ${port} of ${machineId}: this is a stand-in machine, and the only port behind it is its own daemon's`;

/** The guest for one folder: a machine's commands run in its folder there and its daemon is started at the first
 * road asked for, so a host nobody opens a pane on binds no port. */
export function fakeGuestAt(root: string): FakeGuest {
  const held = GUESTS.get(root);
  if (held !== undefined) return held;
  const started = new Map<string, Promise<LocalDaemon>>();
  const folder = (machineId: string): string => standInMachinePath(root, machineId);
  const tokenPath = (machineId: string): string => standInTokenPath(root, machineId, process.pid);
  const daemonOn = (machineId: string): Promise<LocalDaemon> => {
    const running = started.get(machineId);
    if (running !== undefined) return running;
    const starting = (async () => {
      const at = folder(machineId);
      mkdirSync(at, { recursive: true });
      // A stand-in machine's folder stands in for a guest's home, so its daemon's files sit where a guest's do,
      // read off the one rule for the paths under a home wsp owns.
      const paths = placeDaemonPaths(at);
      return LocalDaemon.start({ root: at, workFolder: at, rootsPath: paths.rootsPath, inboxDir: paths.inbox, tokenPath: tokenPath(machineId) });
    })();
    started.set(machineId, starting);
    STARTED.push(starting);
    return starting;
  };
  const guest: FakeGuest = {
    folder,
    tokenPath,
    reach: async (machineId: string, port: number): Promise<PreviewReach> => {
      if (port !== DAEMON_PORT) throw new Error(fakeNoPortLine(machineId, port));
      const daemon = await daemonOn(machineId);
      return { url: daemon.road.url, token: NO_EDGE_TOKEN, expiresAt: NEVER };
    },
    shell: (machineId: string, cmd: string) => {
      const at = folder(machineId);
      layGuestRoot(at);
      return {
        cmd: inGuestRoot(at, cmd),
        cwd: guestHome(at),
        env: { HOME: guestHome(at), PATH: `${guestBin(at)}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
      };
    },
    putBytes: async (machineId: string, path: string, bytes: Uint8Array): Promise<void> => {
      const at = folder(machineId);
      layGuestRoot(at);
      const to = guestPath(at, path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, bytes);
    },
  };
  GUESTS.set(root, guest);
  return guest;
}

/** Closes every daemon this process started for a stand-in machine. The command that ran is what calls this: a
 * listening socket keeps a process alive, and a verb that dialled one of these machines printed everything it had
 * to say and then sat there. A host that is serving never reaches this, since its own command does not return. */
export async function closeStandInGuests(): Promise<void> {
  const held = STARTED.splice(0);
  GUESTS.clear();
  await Promise.all(held.map(starting => starting.then(daemon => daemon.close(), () => {})));
}
