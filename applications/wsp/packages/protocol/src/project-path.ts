// SPDX-License-Identifier: AGPL-3.0-only
// Whether one absolute path sits inside another, where a daemon's roots file
// sits, and everywhere wsp keeps something under a login's own home on a
// machine it only reaches. The engine moves a project's agent state by the
// first and the collector weighs a session's folder by it; the host and the
// guest constant both read the second; the host's deploy writes the third and
// the runtime reads them back, so no rule lives in either of them. Paths are
// joined here rather than through node:path: this package is bundled into the
// browser and imports nothing outside itself.

import { TOOLS_PATH } from "./daemon-contract.js";

/** Whether path is the folder itself or sits inside it; a sibling that shares the prefix is not. */
export function underProject(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The folder Claude Code keeps one project's sessions and memory under, its projects directory name: the resolved
 * path with every character outside A-Z a-z 0-9 replaced by a dash. Two paths that differ only in a character the
 * rule replaces collide under one key, which is the CLI's own behaviour and not something to work around. It sits
 * here because the collector reads it for the memory row, the runtime hands it to a launch as the project's key and
 * the engine moves a project's state by it, and none of the three may own the rule.
 * The machine's own copy of this rule is the engine's KEY_PY, for the one place nothing can run this. */
export const claudeProjectKey = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

/** Where Claude Code keeps one project's own memory under a state home: the keyed projects folder, and `memory`
 * inside it. Written once here: the collector reads it on this computer, the runtime binds it into a workspace at
 * the guest's state home and the engine finds it after a move. */
export const claudeMemoryDir = (stateHome: string, key: string): string => `${stateHome.replace(/\/+$/, "")}/projects/${key}/memory`;

/** A folder's own name, its last segment: what a project is called, what the import dialog and the register line
 * call the folder, and what a permission prompt names a file by. */
export const folderName = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1) ?? path;

/** A piece of work's name as a folder name: lowercase, every run of anything else one dash, nothing hanging off
 * either end, and cut short enough that the whole path stays typeable. A name with nothing usable in it reads as
 * `work`, so a copy always has a folder to land in. */
export function folderSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug === "" ? "work" : slug;
}

/** Where a copy of a project folder made for one piece of work lands: beside the folder it was copied from, under
 * its own name with the work's on the end. A sibling and not a folder of wsp's own, because a directory clone
 * needs the same volume as what it clones and because a sibling is where a person's editor and their own
 * worktrees already are. */
export function copyPathFor(folder: string, slug: string): string {
  const at = folder.replace(/\/+$/, "");
  const parent = at.slice(0, at.lastIndexOf("/"));
  return `${parent}/${folderName(at)}-${slug}`;
}

/** The machine a folder browser is walking, as far as the hidden rule cares: the home that machine reports, and
 * whether it is a Mac. Absent either way, the dot rule stands alone, which is every machine wsp forks. */
export interface FolderMachine {
  readonly home?: string | null;
  readonly mac?: boolean;
}

/** Whether a folder browser hides this folder: a dot-named one on any machine, and the Library a Mac keeps in the
 * home itself, which the Finder hides there too. The home decides and not the path's shape, since a Mac home sits
 * wherever the login puts it (a lab account under /Users/Shared holds one), and a Library somebody made inside
 * their own work is theirs. A home holds twenty of these and none is what somebody browsing for their work is
 * looking for; they are folders like any other to everything else, so a path typed or pasted whole still opens one. */
export function hiddenFolder(path: string, machine: FolderMachine = {}): boolean {
  const at = path.replace(/\/+$/, "");
  if (folderName(at).startsWith(".")) return true;
  const home = machine.home?.replace(/\/+$/, "");
  return machine.mac === true && home !== undefined && home !== "" && at === `${home}/Library`;
}

/** The name of the folder a path sits in, empty where it sits at the root or is a bare name. */
export const parentFolderName = (path: string): string => {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts.length < 2 ? "" : parts[parts.length - 2]!;
};

/** The PATH a daemon on a computer that runs workspaces resolves a command through, and the one every script of
 * the recipe job on such a computer exports: the tools PATH with every directory under that computer's home taken
 * out, and nothing of the unit's own PATH, which is the person's login shell's and may name the home too. A
 * workspace there has the computer's home bound in read-write, so a directory under it is a directory a process
 * inside a workspace writes, and a command found through one would run as root outside every namespace. What is
 * left is the computer's own system directories, which a workspace reads through an overlay of its own or a tool
 * root bound in read-only. The daemon's twin is probe_path in the frames crate and the contract fixture holds the
 * two to one text. */
export function probePath(home: string): string {
  const at = home.replace(/\/+$/, "");
  return TOOLS_PATH.split(":").filter(dir => dir !== "" && !underProject(dir, at)).join(":");
}

/** The file naming the imported project folders a daemon may browse, one absolute path per line. It sits beside the
 * home of whichever daemon reads it: DAEMON_ROOTS_PATH is this answered for a guest, whose home is /root, and this
 * computer's own daemon answers it for the person's home. */
export function rootsPathIn(home: string): string {
  return `${home.replace(/\/+$/, "")}/.wsp/roots`;
}

/** The folder every turn and every exec starts in on a computer somebody owns, wsp's own under their home. Not the
 * home itself: a turn that starts there is one `cd` from the checkouts they work in themselves, and the first build
 * thread run on a local workspace committed inside the person's own repo from there (measured 2026-09-08). One rule
 * for this computer and for a computer joined as a place, since both are somebody's own. */
export function workFolderIn(home: string): string {
  return `${home.replace(/\/+$/, "")}/wsp-work`;
}

/** Everywhere the daemon on a computer the person owns keeps something, whether wsp put it there over ssh or the
 * computer dialled in as a place. A machine wsp forked is root's and lays everything under /root; a computer
 * somebody already owns is reached under their own login, so every path sits in one folder of wsp's own under
 * their home and nothing needs root to write. The host's deploy builds the machine side of this and the runtime
 * reads the token and the port back off it, which is why the rule is here and in neither of them. */
export function placeDaemonPaths(home: string): {
  wsp: string;
  dir: string;
  bundle: string;
  inbox: string;
  tokenPath: string;
  /** Where the daemon writes the port it was given, the one thing the host cannot know before it is up. */
  portFile: string;
  /** Where a run's script, log and exit code go: wsp's own folder and not one every login on the machine shares,
   * since another account's temporary folder is theirs and a turn that cannot write in it would launch nothing. */
  runDir: string;
  /** Where the parts of a file arriving over the link are appended before the whole of it is landed on a machine
   * this computer holds. The same folder rule: wsp's own under the login's home, never one every account shares. */
  putDir: string;
  openSocket: string;
  manifestPath: string;
  profileFile: string;
  unitDir: string;
  binDir: string;
  /** The browser shim: what BROWSER names there, posting each page to the daemon's socket. */
  openShim: string;
  rootsPath: string;
  /** What a computer joined as a place keeps beside the daemon's own files: the wsp it belongs to, the key it
   * proves itself with, and what its agent has printed. They sit in the same folder as everything else wsp keeps
   * there, so one sweep takes the lot. */
  placeFile: string;
  placeKey: string;
  placeLog: string;
} {
  const at = home.replace(/\/+$/, "");
  const wsp = `${at}/.wsp`;
  return {
    wsp,
    dir: `${wsp}/daemon`,
    bundle: `${wsp}/daemon.tgz`,
    inbox: `${wsp}/inbox`,
    tokenPath: `${wsp}/daemon-token`,
    portFile: `${wsp}/daemon.port`,
    runDir: `${wsp}/run`,
    putDir: `${wsp}/put`,
    openSocket: `${wsp}/open.sock`,
    manifestPath: `${wsp}/manifest.json`,
    profileFile: `${wsp}/profile.sh`,
    unitDir: `${at}/.config/systemd/user`,
    binDir: `${at}/.local/bin`,
    openShim: `${at}/.local/bin/wsp-open`,
    rootsPath: rootsPathIn(at),
    placeFile: `${wsp}/place.json`,
    placeKey: `${wsp}/place-key.pem`,
    placeLog: `${wsp}/place.log`,
  };
}

/** What the job that puts the recipe on a computer you own keeps there: the scratch its long steps run under, the
 * log it appends a line to as it goes, and the outcome it writes at the end, which is what a person at that
 * computer's own shell reads without the host. All of it under the one folder wsp already owns there, so a
 * workspace on that computer never sees it: every workspace has its own `.wsp` bound over the computer's. */
export function placeProvisionPaths(home: string): { dir: string; runDir: string; log: string; result: string; staging: string; landed: string; landing: string; asked: string } {
  const dir = `${placeDaemonPaths(home).wsp}/provision`;
  // staging: the person's own agent files as they came off their computer, before a single one is landed.
  // landed: what wsp put in the agents' homes there and what it left there, so a later run knows its own copy
  // from a file the person has since written; landing is that list while the run is still going on.
  // asked: the paths one read of what stands there was given, written down because they come over on that read's
  // own input and a shell cannot hold them any other way; the read takes it away again.
  return { dir, runDir: `${dir}/run`, log: `${dir}/log`, result: `${dir}/result.json`, staging: `${dir}/files`, landed: `${dir}/landed`, landing: `${dir}/landing`, asked: `${dir}/asked` };
}

/** Every path a leave takes off a computer joined as a place, in the order they go: the place file, its key and the
 * agent's log, then everything the daemon, an installer over ssh and the recipe's job put under wsp's own folder,
 * then the browser shim and its xdg-open name, and that folder itself last. The folder is named whole as well as
 * by its parts so a leave takes what no row above names, the parts still being named for the line each one puts in
 * front of a person reading the leave. The work folder is not here: what the person's threads wrote there is
 * theirs. The daemon sweeps by this list when its host asks over the link and wsp leave sweeps by it at the
 * terminal. */
export function placeOwnedPaths(home: string): string[] {
  const at = placeDaemonPaths(home);
  return [
    at.placeFile,
    at.placeKey,
    at.placeLog,
    at.dir,
    placeProvisionPaths(home).dir,
    at.bundle,
    at.inbox,
    at.tokenPath,
    at.rootsPath,
    at.profileFile,
    at.openSocket,
    at.runDir,
    at.portFile,
    at.openShim,
    `${at.binDir}/xdg-open`,
    at.wsp,
  ];
}

/** The same paths under the name the ssh road has always called them. One function, two names, so nothing keeps a
 * second copy of where a daemon on somebody's own computer puts its token, its port file and its run folder. */
export const sshDaemonPaths = placeDaemonPaths;

/** What a stand-in provider keeps in the folder a harness names for it: the records every host on that state file
 * reads, so two of them see one fleet, and a folder per machine standing in for that machine's disk. The layout is
 * written here because the harness that seeds the records and the host that answers out of them both name it and
 * neither may guess. */
export const standInRecordsPath = (root: string): string => `${root.replace(/\/+$/, "")}/records.json`;
export const standInMachinePath = (root: string, machineId: string): string => `${root.replace(/\/+$/, "")}/machines/${machineId}`;
