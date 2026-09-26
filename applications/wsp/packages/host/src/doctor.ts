// SPDX-License-Identifier: AGPL-3.0-only
// wsp doctor: proves the whole reach path against one live machine and prints
// a timing table. fork -> deploy daemon -> previewUrl -> heartbeat client ->
// inbox round trip -> kill, with a check at the end that this host left none.

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { agentName, CATALOG_AGENTS, CLAUDE_CONFIG_DIR, GOLDEN_SETUP, GOLDEN_SMOKE, keyEnvOf, mintsToken, VAULT_VARIABLES } from "@wsp/catalog";
import { CREATED_AT_LABEL, DAEMON_ENV_FILE, DAEMON_LISTENING_CHECK, DAEMON_PORT, DOCTOR_LABEL, EXEC_ENV, GUEST_USER_ENV, OWNER_LABEL, RUN_DIR, TOOLS_PATH, WSP_LABEL, clientWords, isMissing, isReserved, landBytes, presenceTests, presentElsewhere, presentSteps, whoseMachine, type DaemonSupervisor, type Machine, type MachineBackend, type ProvisionPlan } from "@wsp/engine";
import { ALREADY_JOINED_LINE, absentComputer, agentSignInWord, agentVersionWord, awayMsOf, boxRoomLines, doctorComputerRowLine, DoctorLineEvent, EXIT_CODES, exitClassOf, hereDaemonBehindLine, HERE_PLACE_ID, isJoinedComputer, noSuchProjectLine, placeBehindLine, placeDaemonBehind, plural, projectNeedsReaddLine, DAEMON_MEMORY_MAX_PERCENT, DAEMON_ROOTS_PATH, DAEMON_TOKEN_PATH, DAEMON_VERSION, GUEST_DAEMON_DIR, GUEST_INBOX_DIR, GUEST_MANIFEST_PATH, GUEST_WSP_PATH, guestWspShim, LOOPBACK, WSP_WORKSPACE_APPARMOR_PATH, machineLacking, machineUnanswered, NO_LINGER_LINE, NO_NODE_LINE, PLACE_NEEDS_ROOT_LINE, NO_SNAPSHOT_LISTING, NO_SYSTEMD_LINE, NO_TEMPLATES_LINE, OPEN_SOCKET_PATH, THIS_COMPUTER, isLocalWorkspace, otherHostsMachinesLine, PLACE_WORKSPACE_PATH, placeDaemonPaths, placeOwnedPaths, rootsPathIn, shellQuote, workFolderIn, sshDaemonPaths, templateRecordedLine, templateSkippedLine, wspBinIn, wspPackageIn, type PlaceProvision, type PlaceView, type ProjectView, type SnapshotStorage, type DaemonKind } from "@wsp/protocol";
import { goldenHead, writeDaemonTokenScript, type AccountOrphans, type GoldenVersion, type HereDaemon, type Runtime } from "@wsp/runtime";
import { keyIn } from "./env-keys.js";
import WebSocket from "ws";
import { assetDir, assetName, assetProof, copyAsset, stagedAsset } from "./assets.js";
import { daemonBinaryIn, GUEST_DAEMON_TARGETS, type DaemonTarget } from "./daemon-binary.js";
import { ANTHROPIC_KEY, KEY_LAYER_WORDS } from "./env-keys.js";
import { describeDeleted, describeOrphanOffer, describeOrphans, describeStorage } from "./storage.js";
import type { CliIO } from "./cli.js";
import type { HostClient } from "./verbs.js";

const execFileAsync = promisify(execFile);

// --- where a daemon lives on a machine ------------------------------------

/** Everywhere one machine's daemon keeps something, how it binds and who supervises it. A fork wsp made is root's,
 * so everything sits under /root behind a system unit reachable through the preview edge; a machine the person
 * already owns is reached under their own login, so every path sits under their home, the unit is their own
 * login's, and the daemon binds that machine's own loopback. One value per place, read by the bundle, the unit,
 * the stop and the deploy, so no line below compares a kind. */
export interface DaemonPlace {
  /** Which machine this daemon's own readings describe, which picks the two modules behind them. */
  kind: DaemonKind;
  /** Where the bundle is unpacked and the daemon runs from. */
  dir: string;
  /** Where the packed bundle lands before it is unpacked. */
  bundle: string;
  inbox: string;
  tokenPath: string;
  /** The file naming the imported project folders the daemon may browse beside its root. */
  rootsPath: string;
  /** The folder every fs and git op resolves inside, beside the folders the roots file names. */
  root: string;
  /** Made before anything lands: every folder a path here needs that the machine may not already have. */
  make: readonly string[];
  /** Exported before the deploy runs. A guest exec carries PATH and nothing else, while an ssh login arrives as
   * the person it belongs to and needs only what its own session manager wants. */
  exportEnv: readonly string[];
  /** Whether the paths here came from the machine rather than from wsp. A fork chose its own and its script is
   * pinned byte for byte by the golden's content hash; a machine somebody owns answered with a home wsp did not
   * choose, and isPlainPath admits a space in one, so every path there is quoted in each language the deploy
   * writes: the shell for its scripts and systemd's own for the unit. */
  quotePaths: boolean;
  /** Whether the deploy's own script may carry this host's daemon token. A fork and a container are root's alone,
   * so it is written in the script; a machine somebody else may hold an account on would have it in a world
   * readable /proc/<pid>/cmdline for the length of that exec, so there the deploy lands it over the byte road and
   * the script never names it. Only the deploy reads this: a rotation later takes whichever road the machine
   * carries bytes on, which is the machine's own question and answered by hasByteRoad. */
  tokenRoad: "script" | "bytes";
  /** The whole of what this place asks of a machine before anything is installed on it, what keeps its daemon up
   * included; empty where wsp built the machine and already knows, which is every fork. Each line ends the script
   * itself when it refuses, since the exit status of a guard behind || is not what set -e acts on. */
  preflight: readonly string[];
  /** Where a run's script, streams and exit code live on this machine. */
  runDir: string;
  /** Which wsp a process on this machine runs: the shim to the daemon binary, which carries a line to the host over
   * this machine's own daemon, or the node command bundled beside it, which dials a host of its own. A fork takes
   * the shim and needs no node; a computer somebody owns keeps the bundle until the command line story there says
   * what runs on it. */
  wsp: "shim" | "bundle";
  /** Where the browser shim and its xdg-open name go; a folder already on the machine's own PATH. */
  binDir: string;
  openShim: string;
  openSocket: string;
  /** Where the daemon keeps the manifest of what a person started on the machine, read back after a restart. */
  manifestPath: string;
  /** The file wsp owns and rewrites on every deploy, holding the BROWSER export. */
  profileFile: string;
  /** The person's own login file one guarded source line is added to. A guest reads its whole profile.d folder and
   * needs none; .profile rather than .bashrc on a machine that is somebody's, since bash reads .bashrc only for an
   * interactive shell that is not a login, and every road onto the machine that reads a dotfile at all is a login. */
  profileSource?: string;
  /** What keeps the daemon running here: the lines that start it, wait for it and read its log. Every line of the
   * deploy that used to ask which supervisor this was reads this instead. The module itself, and no id beside it:
   * an id would be the second copy of the fact, and the next reader would branch on it. */
  supervise: DaemonSupervision;
  /** Whose systemd runs the unit: the machine's, or the login's own. Read by the systemd module alone. */
  scope: "system" | "user";
  unitPath: string;
  /** The PATH the daemon and every pty under it get, stated on the unit rather than inherited. */
  toolsPath: string;
  /** The rest of the unit's environment, stated the same way. */
  unitEnv: Readonly<Record<string, string>>;
  /** The file the unit reads the machine's environment from, for a provider that cannot hand it over at create and
   * writes it there instead; the unit may lack the file. Absent on a place whose unit reads no such file. */
  envFile?: string;
  /** What the unit is enabled under, which differs between a machine's systemd and a login's. */
  wantedBy: string;
  /** The address the daemon binds. */
  bind: string;
  /** The port it binds; 0 asks the machine for a free one. */
  port: number;
  /** Where the daemon writes the port it bound, for a place that gave it none to bind. */
  portFile?: string;
  /** Quarter seconds the deploy waits for the daemon to answer before it reads the log instead. */
  upTries: number;
  /** Which wsp this computer is to join, on a place whose daemon is held up by its own join rather than by a unit
   * this deploy writes. Absent everywhere else, and the one supervision that reads it says so when it is. */
  join?: DaemonJoin;
  /** What the deploy takes off the machine on its way out, however it ends: armed before anything lands, so a
   * deploy that dies halfway leaves none of it behind. Empty on a fork, whose disk goes with the machine. */
  onExit?: readonly string[];
}

/** What a computer needs told to join a wsp: the address it dials this host at, the file the single-use code was
 * landed in, the name the host is to know it by, and the two files the join leaves behind, which are the proof it
 * landed and where the agent prints. */
export interface DaemonJoin {
  /** Every address this host answers on, tried in order: the first that answers is the one that computer can
   * reach, which is not always the one the host would name first. */
  hostUrls: readonly string[];
  codeFile: string;
  name: string;
  file: string;
  log: string;
}

/** The supervisor's name for the daemon, the one string the unit file, the stop, the start and the log read. */
export const DAEMON_UNIT = "wsp-daemon.service";

/** Where a sealed image keeps the script that keeps its daemon running. The machine's own boot runs it when it is
 * there, so a fork of a sealed image starts its daemon with nothing dialling in, and the deploy is what writes it.
 * The path is the image's rather than the place's: the runtime that boots the image reads the same path to decide
 * whether there is a supervisor to exec. */
export const GUEST_SUPERVISOR_PATH = "/root/wsp-daemon/supervise.sh";

/** Where a machine with no service manager keeps the daemon's output, and the size the supervisor truncates it at.
 * A container has no journal, and nothing else on it would bound a file. The path is the image's rather than the
 * place's, as GUEST_SUPERVISOR_PATH is: the image's own first process runs that script and writes this file, so
 * neither moves with a place. */
export const DAEMON_LOG_PATH = "/var/log/wsp-daemon.log";
export const DAEMON_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Where a supervisor records its own pid, so a deploy knows whether one is already watching the daemon, and where
 * it records the daemon's, which is how a deploy stops the daemon on a machine with no socket tools. Both sit in
 * the place's own folder, so a second place on this module keeps its pids where it keeps everything else. */
export const supervisorPidPath = (place: DaemonPlace): string => `${place.dir}/supervise.pid`;
export const daemonPidPath = (place: DaemonPlace): string => `${place.dir}/daemon.pid`;

/** The script that keeps the daemon running on a guest with no service manager: the machine's own boot runs it, so
 * a fork of a sealed image starts its daemon with nobody dialling in, and a daemon the kernel's memory killer took
 * comes back a second later. It states its environment rather than inheriting one, the way the unit does: a boot
 * hands it nothing. It never execs the daemon, so the loop keeps control of the restart; the container's PID 1
 * reaps what the daemon leaves behind. */
export function daemonSupervisorScript(place: DaemonPlace, target: DaemonTarget, previewHostSuffix?: string): string {
  return [
    "#!/bin/sh",
    `echo $$ > ${supervisorPidPath(place)}`,
    `export PATH=${place.toolsPath}`,
    ...Object.entries(place.unitEnv).map(([name, value]) => `export ${name}=${value}`),
    ...(previewHostSuffix !== undefined ? [`export ${VITE_ALLOWED_HOSTS_ENV}='${previewHostSuffix}'`] : []),
    `cd ${place.dir}`,
    "while :; do",
    `  [ -f ${DAEMON_LOG_PATH} ] && [ "$(wc -c < ${DAEMON_LOG_PATH})" -gt ${DAEMON_LOG_MAX_BYTES} ] && : > ${DAEMON_LOG_PATH}`,
    `  ${daemonExecLine(place, target)} >> ${DAEMON_LOG_PATH} 2>&1 &`,
    // The daemon's own pid, written here because a container ships no socket tools: it is how a deploy stops the
    // daemon it is replacing, and the supervisor puts the new one up a second later.
    `  echo $! > ${daemonPidPath(place)}`,
    `  wait $!`,
    "  sleep 1",
    "done",
    "",
  ].join("\n");
}

/** What keeps the daemon running on a machine and how the deploy learns it came up: one module per way, so no line
 * of the deploy asks which way it is. A machine with a service manager registers a unit with it; a machine whose
 * only lasting process is its own boot gets a script that loop-restarts the daemon. Each reads the place it is
 * given, so the same module serves a fork's root unit and the unit under somebody's own login. */
export interface DaemonSupervision {
  /** The lines that leave the daemon running, the old one stopped first. Written for one chip, since every line
   * that names the binary names the path the bundle left it at, which carries that chip's target triple. */
  start: (place: DaemonPlace, target: DaemonTarget, previewHostSuffix?: string) => string[];
  /** The lines that wait for it and answer DAEMON_UP or DAEMON_DOWN. */
  up: (place: DaemonPlace) => string[];
  /** What the daemon has printed lately, for a deploy that has to say why the port never came up. */
  log: (place: DaemonPlace, lines: number) => string;
}

/** The daemon under the machine's own service manager, a fork's and a login's alike. The journal is the one store
 * on such a machine that bounds itself against a cap it states at boot (395 MB on a 20 GB guest, measured
 * 2026-09-08): the redirect this replaced truncated the file on every deploy, and an appended one under
 * Restart=always with no start limit has no end. */
export const SYSTEMD: DaemonSupervision = {
  start: (place, target, previewHostSuffix) => [
    stopDaemonScript(place),
    `cat > ${sh(place, place.unitPath)} <<'WSP_UNIT'\n${daemonUnit(place, target, previewHostSuffix)}WSP_UNIT`,
    `${systemctlIn(place)} daemon-reload`,
    // Enabled as well as started: a machine that reboots or comes back from a snapshot brings the daemon with it.
    `${systemctlIn(place)} enable ${DAEMON_UNIT}`,
    `${systemctlIn(place)} restart ${DAEMON_UNIT}`,
  ],
  up: place =>
    place.portFile === undefined
      ? [
          `for _ in $(seq ${place.upTries}); do ss -ltnH 'sport = :${place.port}' | grep -q . && break; sleep 0.25; done`,
          `ss -ltn | grep -q ${place.port} && echo DAEMON_UP || { ${SYSTEMD.log(place, 50)}; echo DAEMON_DOWN; }`,
        ]
      : [
          // A place that let the machine pick the port reads the port it wrote down, which is also the proof it
          // bound, and asks its supervisor whether it is still up: iproute2 is not on every machine somebody owns.
          `for _ in $(seq ${place.upTries}); do [ -s ${sh(place, place.portFile)} ] && break; sleep 0.25; done`,
          `p="$(cat ${sh(place, place.portFile)} 2>/dev/null)"`,
          `[ -n "$p" ] && ${systemctlIn(place)} is-active --quiet ${DAEMON_UNIT} && echo "${DAEMON_PORT_LINE} $p" && echo DAEMON_UP || { ${SYSTEMD.log(place, 50)}; echo DAEMON_DOWN; }`,
        ],
  log: (place, lines) => `journalctl ${place.scope === "user" ? "--user " : ""}-u ${DAEMON_UNIT} -n ${lines} --no-pager`,
};

/** What a machine must already have for the module above to keep a daemon on it: the one systemd predicate in the
 * tree, asked on the preflight road by every place whose machine wsp did not build. An unsupervised daemon is what
 * this deploy exists to stop shipping, so a machine with no service manager says so before a byte of wsp's lands on
 * it rather than as the install reaches for one. It ends the script itself and echoes the whole sentence: what the
 * machine has not got is a line a person reads on a row, and a refusal resting on the shell honouring `set -e` for
 * the last command of an `||` list would be one flag from going on. */
export const NEEDS_SYSTEMD = `if ! command -v systemctl >/dev/null 2>&1; then echo ${shellQuote(NO_SYSTEMD_LINE)}; exit 1; fi`;

/** The daemon under a script the machine's own boot runs, for a machine whose only process that outlives an exec
 * is its PID 1. Nothing here asks a service manager anything, and nothing reads a socket table: a container image
 * ships neither ss nor curl. */
export const BOOT_SCRIPT: DaemonSupervision = {
  start: (place, target, previewHostSuffix) => [
    `cat > ${GUEST_SUPERVISOR_PATH} <<'WSP_SUPERVISOR'\n${daemonSupervisorScript(place, target, previewHostSuffix)}WSP_SUPERVISOR`,
    `chmod 0755 ${GUEST_SUPERVISOR_PATH}`,
    // The daemon being replaced is stopped by the pid the supervisor recorded: a container image ships no socket
    // tools, so nothing here can read the port's holder the way the unit road does.
    // `|| true` on both reads: the script runs under set -e, where an assignment whose command substitution fails
    // ends it, and a machine that never had a daemon has neither file (a live deploy died here, 2026-09-11).
    `old="$(cat ${daemonPidPath(place)} 2>/dev/null || true)"`,
    'if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then kill "$old" 2>/dev/null || true; echo "DAEMON_STOPPED $old"; fi',
    `sup="$(cat ${supervisorPidPath(place)} 2>/dev/null || true)"`,
    'if [ -n "$sup" ] && kill -0 "$sup" 2>/dev/null; then',
    '  echo "DAEMON_SUPERVISED $sup"',
    "else",
    `  setsid nohup ${GUEST_SUPERVISOR_PATH} >> ${DAEMON_LOG_PATH} 2>&1 &`,
    "fi",
  ],
  up: place => [
    // A service manager restarts the daemon at once; a supervisor that was already watching sleeps a second first,
    // so this road waits longer for the port than a unit's does, which is the place's own upTries.
    `for _ in $(seq ${place.upTries}); do ${DAEMON_LISTENING_CHECK} && break; sleep 0.25; done`,
    `${DAEMON_LISTENING_CHECK} && echo DAEMON_UP || { ${BOOT_SCRIPT.log(place, 50)}; echo DAEMON_DOWN; }`,
  ],
  log: (_place, lines) => `tail -n ${lines} ${DAEMON_LOG_PATH}`,
};

/** What a computer joined as a place is held up by: its own `wsp join`, which writes the place file, installs the
 * unit under that login's own service manager and dials the host from it. Nothing here writes a unit: the join on
 * that computer writes the one that starts the daemon binary with the place flags, on that computer's loopback,
 * and the socket to this host is one the daemon opens outward. The deploy's part ends when the place file is on
 * disk.
 *
 * The wsp the join runs is the one in the bundle, on the node the computer carries, which the preflight asked for
 * before a byte landed. */
export const JOINED: DaemonSupervision = {
  start: place => {
    const join = joinOf(place);
    return [
      // Said once the computer has everything wsp needs of it and before its own join runs, so a person watching
      // reads the install and the join apart.
      `echo ${WSP_READY_LINE}`,
      `node ${sh(place, wspBinIn(place.dir))} join ${join.hostUrls.map(at => shellQuote(at)).join(" ")} --code-file ${sh(place, join.codeFile)} --name ${shellQuote(join.name)}`,
      `echo ${PLACE_JOINED_LINE}`,
    ];
  },
  // The join itself ends the deploy when it fails, since the script runs under set -e; what this reads is whether
  // the computer came out of it belonging to a wsp.
  up: place => [`[ -s ${sh(place, joinOf(place).file)} ] && echo DAEMON_UP || echo DAEMON_DOWN`],
  log: (place, lines) => `tail -n ${lines} ${sh(place, joinOf(place).log)} 2>/dev/null || true`,
};

/** What the install says once that computer carries wsp and the node it runs on, and what its own join says once
 * it belongs to a wsp. Two words on stdout, read by whoever is watching the install. */
export const WSP_READY_LINE = "WSP_READY";
export const PLACE_JOINED_LINE = "PLACE_JOINED";

/** The join a place names, or the one sentence for a place built without one: every line of this supervision reads
 * it, so the fault is named once rather than at each. */
function joinOf(place: DaemonPlace): DaemonJoin {
  if (place.join === undefined) throw new Error(`the place at ${place.dir} names no wsp to join, so nothing could tell that computer which host to dial`);
  return place.join;
}

/** The protocol's own reading of the folder, since the wsp command the runtime hands every fork sits under it:
 * two spellings of one path would have those two agreeing by luck. */
const GUEST_DIR = GUEST_DAEMON_DIR;
const GUEST_BIN = "/usr/local/bin";

/** The place a machine wsp forked keeps its daemon: root's own, under a system unit, bound on every address
 * because the preview edge dials the guest's eth0 and loopback answers 502. */
export const CLOUD_PLACE: DaemonPlace = {
  kind: "cloud",
  dir: GUEST_DIR,
  bundle: `${GUEST_DIR}.tgz`,
  inbox: GUEST_INBOX_DIR,
  tokenPath: DAEMON_TOKEN_PATH,
  rootsPath: DAEMON_ROOTS_PATH,
  root: "/root",
  make: [GUEST_DIR, GUEST_INBOX_DIR],
  exportEnv: [EXEC_ENV],
  wsp: "shim",
  quotePaths: false,
  tokenRoad: "script",
  preflight: [],
  runDir: RUN_DIR,
  binDir: GUEST_BIN,
  openShim: `${GUEST_BIN}/wsp-open`,
  openSocket: OPEN_SOCKET_PATH,
  manifestPath: GUEST_MANIFEST_PATH,
  profileFile: "/etc/profile.d/wsp-open.sh",
  supervise: SYSTEMD,
  scope: "system",
  unitPath: `/etc/systemd/system/${DAEMON_UNIT}`,
  toolsPath: TOOLS_PATH,
  unitEnv: GUEST_USER_ENV,
  envFile: DAEMON_ENV_FILE,
  wantedBy: "multi-user.target",
  bind: "0.0.0.0",
  port: DAEMON_PORT,
  upTries: 20,
};

/** The same place under the other supervision, for a machine whose only process that outlives an exec is its own
 * PID 1, which is every workspace a box's own runtime boots. Every path is a fork's, since it is the same image;
 * what differs is what keeps the daemon up, and that a supervisor already watching sleeps a second before it
 * restarts, so the wait for the port is longer. */
export const CONTAINER_PLACE: DaemonPlace = { ...CLOUD_PLACE, supervise: BOOT_SCRIPT, upTries: 40 };

/** The place a guest wsp made keeps its daemon, by what that machine answered keeps a process running on it. The
 * one place a supervisor id is matched to a place, so adding a way to supervise is a module and a row here. */
export function guestPlace(supervisor: DaemonSupervisor): DaemonPlace {
  return supervisor === "entrypoint" ? CONTAINER_PLACE : CLOUD_PLACE;
}

/** The place a machine reached over ssh keeps its daemon: under the login's own home, behind that login's systemd,
 * bound on loopback and on whatever port the machine had free, which it writes down beside itself for whatever on
 * that machine reads it. Nothing here needs root, and nothing on the machine listens beyond its own loopback.
 * Where each file sits is the protocol's rule, since the same layout is read back off the machine. */
export function sshDaemonPlace(login: { home: string; path: string }): DaemonPlace {
  const at = sshDaemonPaths(login.home);
  return {
    kind: "ssh",
    dir: at.dir,
    bundle: at.bundle,
    inbox: at.inbox,
    tokenPath: at.tokenPath,
    rootsPath: at.rootsPath,
    root: login.home,
    make: [at.dir, at.inbox, at.binDir, at.unitDir],
    wsp: "bundle",
    // A login that arrives without its own session manager's address cannot talk to its systemd at all, and every
    // line below would fail at the bus rather than at the thing it was doing.
    exportEnv: ['export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"'],
    quotePaths: true,
    tokenRoad: "bytes",
    preflight: [...DAEMON_PREFLIGHT, NO_LINGER_CHECK],
    runDir: at.runDir,
    binDir: at.binDir,
    openShim: at.openShim,
    openSocket: at.openSocket,
    manifestPath: at.manifestPath,
    profileFile: at.profileFile,
    profileSource: `${login.home.replace(/\/+$/, "")}/.profile`,
    // Their own login's systemd, which is the same module a fork's root unit reads, told a different scope.
    supervise: SYSTEMD,
    scope: "user",
    unitPath: `${at.unitDir}/${DAEMON_UNIT}`,
    toolsPath: [at.binDir, login.path].join(":"),
    unitEnv: { HOME: login.home },
    wantedBy: "default.target",
    // Nothing on a machine somebody else owns may listen past its own loopback: what dials this daemon is on that
    // machine, and this host reaches it only over the link that machine dials out on.
    bind: LOOPBACK,
    port: 0,
    portFile: at.portFile,
    upTries: 80,
  };
}

/** The place a computer joined over ssh keeps its agent: everything the ssh road lays down under that login's own
 * home, since the agent and the daemon inside it read the same folder, with the daemon's unit swapped for the
 * join that computer runs for itself. Built off the ssh place rather than beside it, so what a sweep takes off a
 * computer is one list however the agent got there. */
export function joinedPlace(login: { home: string; path: string }, join: Omit<DaemonJoin, "file" | "log">): DaemonPlace {
  const at = placeDaemonPaths(login.home);
  return {
    ...sshDaemonPlace(login),
    kind: "place",
    // Root, and the daemon is the system's: a computer you own runs workspaces, which needs root anyway, so its
    // agent is a service of the machine rather than of one login that has to be told to linger.
    preflight: [...DAEMON_PREFLIGHT, NEEDS_ROOT_CHECK],
    scope: "system",
    unitPath: `/etc/systemd/system/${DAEMON_UNIT}`,
    wantedBy: "multi-user.target",
    supervise: JOINED,
    join: { ...join, file: at.placeFile, log: at.placeLog },
    // The code buys a place in somebody's wsp for the ten minutes it stands: a deploy that dies between landing it
    // and the join that spends it must not leave it on their disk. The join deletes it before it dials, so on the
    // road that works this removes a file that has already gone.
    onExit: [`rm -f ${shellQuote(join.codeFile)}`],
  };
}

export const DAEMON_UNIT_PATH = CLOUD_PLACE.unitPath;

/** The one line wsp adds to the person's own login file, and takes back out: their file is theirs, so what wsp
 * wrote is named once and found again by the file it names. Read by the deploy that writes it, by the removal that
 * runs on a machine this host reaches, and by the sweep a place runs on itself. The line reads the file before it
 * sources it: inside a workspace on a computer somebody owns that computer's /root is bound in while the wsp
 * folder under it is the workspace's own, so the file this names is not there and an unguarded line printed an
 * error on the first line of every login shell opened in one. */
export const profileSourceLine = (profileFile: string): string => `[ -f ${profileFile} ] && . ${profileFile}`;

/** A path as this place's shell scripts write it: quoted where it came from the machine, since a home with a
 * space in it would otherwise make `rm -rf /Users/Jane Doe/.wsp` two words and take /Users/Jane with it. */
const sh = (place: DaemonPlace, path: string): string => (place.quotePaths ? shellQuote(path) : path);

/** Every line naming wsp's profile file taken out of the person's own login file, and nothing done at all where
 * they have no such file or it names none: read by the deploy before it appends the line this version spells and
 * by the removal, so a computer joined under an older spelling is left with one line of wsp's and with none once
 * wsp is off it. Their file, so the line is written back through the same path rather than moved over: a .profile
 * symlinked into a dotfiles checkout stays a symlink (measured 2026-09-11, where a move turned one into a plain
 * file). grep says by its exit code whether it selected nothing or could not read the file at all, and only the
 * first of those writes, so a read that failed leaves them neither an empty login file nor a file of wsp's beside
 * their own. Every line of it exits 0, since the deploy runs under set -e. What the take-out writes back is the
 * file line by line, so a last line the person left without a trailing newline comes back with one. */
function unsourceStep(place: DaemonPlace, file: string): string {
  const copy = `${file}.wsp-out`;
  const named = shellQuote(place.profileFile);
  return [
    `if [ -f ${sh(place, file)} ] && grep -qF ${named} ${sh(place, file)}; then`,
    "  kept=0",
    `  grep -vF ${named} ${sh(place, file)} > ${sh(place, copy)} || kept=$?`,
    `  if [ "$kept" -le 1 ]; then cat ${sh(place, copy)} > ${sh(place, file)}; fi`,
    `  rm -f ${sh(place, copy)}`,
    "fi",
  ].join("\n");
}

/** wsp's line in the person's own login file as this version spells it: the lines naming wsp's profile file taken
 * out first, so a second deploy replaces the line rather than sitting beside it, then this one appended, which
 * makes the file where the login has none. Nothing at all for a place whose profile file is wsp's own to load. */
export function profileSourceStep(place: DaemonPlace): string[] {
  const file = place.profileSource;
  if (file === undefined) return [];
  return [unsourceStep(place, file), `printf '%s\\n' ${shellQuote(profileSourceLine(place.profileFile))} >> ${sh(place, file)}`];
}

/** The login files this wsp puts on a machine: its own profile file, holding the browser shim and the display
 * every guest tool reads, and the one line of wsp's in the person's own login file that loads it. Every road that
 * puts this wsp on a computer runs these lines, the deploy at the join and the update after it, so a computer
 * joined under an older spelling takes this one without being joined again. Every line exits 0, so the same text
 * holds under the deploy's `set -e`, under the update's script, which sets none, and under the daemon's own
 * `bash -c`. */
export function loginFilesStep(place: DaemonPlace): string[] {
  return [
    // BROWSER is set by the daemon for its ptys, by this file for login shells, and in a fork's envs only when its
    // golden was sealed with the shim (claudeEnvs), never on a machine that may lack the file.
    `mkdir -p ${sh(place, posix.dirname(place.profileFile))} && printf 'export BROWSER=%s\\nunset DISPLAY\\n' ${sh(place, place.openShim)} > ${sh(place, place.profileFile)}`,
    // A place whose profile file is under the person's own folder is read only if their login file says so, and
    // their login file is theirs: one line of wsp's is in it however many deploys have run.
    ...profileSourceStep(place),
  ];
}

/** The same for a unit file's Environment=, which systemd splits on whitespace into one assignment per word, so
 * a value holding a space is double quoted there. Not every setting wants that: WorkingDirectory= takes the rest
 * of its line as the path and reads a quote as part of it ("path is not absolute", measured on systemd 255,
 * 2026-09-11), and ExecStart= is a command line systemd splits itself, where a double quoted word holds. */
const unitEnvLine = (place: DaemonPlace, value: string): string => (place.quotePaths ? `"${value}"` : value);

/** The systemd this place's unit belongs to. */
const systemctlIn = (place: DaemonPlace): string => (place.scope === "user" ? "systemctl --user" : "systemctl");

// --- daemon bundle --------------------------------------------------------

/** The daemon's command line on a place, one flag per option the binary takes: the address and port it binds, the
 * token file it checks every auth frame against, the folder its fs and git ops resolve inside and the roots file
 * beside it, the kind that picks its readings modules, the inbox, the manifest and the socket the browser shim
 * posts to, and the file it writes its port to where the machine picked one. Words, unquoted: the unit and the
 * supervisor quote them in their own language, and a joined computer's manager takes them as they are. */
export function daemonFlags(place: DaemonPlace): string[] {
  return [
    "--host",
    place.bind,
    "--port",
    String(place.port),
    "--token-path",
    place.tokenPath,
    "--root",
    place.root,
    "--roots-path",
    place.rootsPath,
    "--kind",
    place.kind,
    "--inbox",
    place.inbox,
    "--manifest",
    place.manifestPath,
    "--open-socket",
    place.openSocket,
    ...(place.portFile === undefined ? [] : ["--port-file", place.portFile]),
  ];
}

/** The daemon asset inside a bundle, whether it is still being staged here or unpacked on the machine: the bundle
 * is the wsp command as npm lays it out, so the binaries ride in that command's own assets folder and the asset
 * table's rule is the whole of the path. */
const bundleDaemonDir = (dir: string): string => stagedAsset(wspPackageIn(dir), "daemon");

/** The binary a machine of one chip runs, out of the bundle's own layout. The unit, the supervisor script, the
 * AppArmor profile and the `wsp join` that computer runs for itself all reach this one file, and none of them
 * spells the path a second way: the command in the bundle reads it through the same asset table a command
 * installed from npm reads its own by. */
export const daemonBinaryOn = (bundleDir: string, target: DaemonTarget): string => daemonBinaryIn(bundleDaemonDir(bundleDir), target.triple);

/** The line a unit or a supervisor script starts the daemon with: the binary the bundle left for this machine's
 * chip, then its flags. A path is double quoted where the place quotes paths, which both sh and systemd read as
 * one word. */
export function daemonExecLine(place: DaemonPlace, target: DaemonTarget): string {
  const word = (w: string): string => (place.quotePaths && w.startsWith("/") ? `"${w}"` : w);
  return [daemonBinaryOn(place.dir, target), ...daemonFlags(place)].map(word).join(" ");
}

/** The shim posts to the socket the daemon opens; the protocol names both paths, so the daemon and this agree. */
export const OPEN_SHIM_PATH = CLOUD_PLACE.openShim;
export function openShimScript(place: DaemonPlace): string {
  return `#!/bin/sh
[ "$#" -ge 1 ] || exit 0
printf '%s' "$1" | curl -s -m 1 -o /dev/null --unix-socket ${sh(place, place.openSocket)} -X POST --data-binary @- http://wsp/open >/dev/null 2>&1
exit 0
`;
}

/** The first file the bundle would carry that this computer has not got, named in the words the asset table gives
 * it; nothing when every one is there. Read off disk and nothing else, so a run can ask before it boots anything
 * what the deploy will ask for after the machine is billing. */
export function missingBundleFile(daemonDir = assetDir("daemon"), cliDir = assetDir("cli"), targets: readonly DaemonTarget[] = GUEST_DAEMON_TARGETS): string | undefined {
  for (const target of targets) {
    const from = daemonBinaryIn(daemonDir, target.triple);
    if (!existsSync(from)) return `${assetName("daemon")} missing: ${from}`;
  }
  const cliProof = join(cliDir, assetProof("cli"));
  return existsSync(cliProof) ? undefined : `${assetName("cli")} missing: ${cliProof}`;
}

/** Lay out an installable copy of the daemon for one place: the static binary for each chip a guest can be, the
 * wsp command, and the browser shim. Nothing in it is built on the machine. */
export async function stageDaemonBundle(
  stageDir: string,
  place: DaemonPlace,
  daemonDir = assetDir("daemon"),
  cliDir = assetDir("cli"),
  targets: readonly DaemonTarget[] = GUEST_DAEMON_TARGETS,
): Promise<void> {
  // Read before anything is copied, rather than as a raw copy failure halfway through a bundle. A run that boots a
  // machine asks the same question before the confirm, so nothing bills while this is what stops the deploy.
  const missing = missingBundleFile(daemonDir, cliDir, targets);
  if (missing !== undefined) throw new Error(missing);
  mkdirSync(stageDir, { recursive: true });
  // The wsp of a machine somebody owns is the packed node command, laid out as npm lays it so the command reads its
  // own assets by the table. A fork's is two lines onto the binary in that same layout, written on the machine and
  // not here: the path it names carries the chip, and only the machine says which chip it is.
  if (place.wsp === "bundle") copyAsset("cli", cliDir, wspPackageIn(stageDir));
  // The binaries go in that command's own assets, which is where it reads one: every chip the machine may turn out
  // to be, which is both of them where the host has not read the machine's own word for it yet, and the deploy
  // drops the ones it is not. One layout for the bundle and for the join that computer runs on itself.
  for (const target of targets) {
    const to = daemonBinaryOn(stageDir, target);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(daemonBinaryIn(daemonDir, target.triple), to);
    chmodSync(to, 0o755);
  }
  writeFileSync(join(stageDir, "wsp-open"), openShimScript(place), { mode: 0o755 });
}

/** The least node the wsp command in the bundle runs on, which is the one thing a machine somebody owns still has
 * to carry: the daemon beside it is a static binary and asks for nothing. */
export const WSP_COMMAND_NODE_MAJOR = 22;

/** How a node is asked which major it is. Not read into a variable, since `set -e` ends a script on an assignment
 * whose substitution failed and exempts one inside a test. */
const NODE_MAJOR = `node -p 'process.versions.node.split(".")[0]'`;

/** What every machine wsp reaches over a login must have before a byte of wsp's lands on it: its own systemd to
 * hold the daemon up, and a node new enough for the wsp command beside it, which every turn's agent drives its
 * host through. The daemon itself is one static file and asks nothing. */
const DAEMON_PREFLIGHT: readonly string[] = [
  NEEDS_SYSTEMD,
  `if ! command -v node >/dev/null 2>&1 || [ "$(${NODE_MAJOR} 2>/dev/null || echo 0)" -lt ${WSP_COMMAND_NODE_MAJOR} ]; then echo ${shellQuote(NO_NODE_LINE)}; exit 1; fi`,
];

/** Asked only where the machine can answer: without linger a login's own systemd stops with its last session and
 * takes the daemon with it the moment the host's connection closes, so a deploy that skipped this would look like
 * it worked and be gone by the next dial. */
const NO_LINGER_CHECK = `if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then echo ${shellQuote(NO_LINGER_LINE)}; exit 1; fi`;

/** A join installs a system service under /etc/systemd/system, so a login that is not root reads the one sentence
 * and the join stops with nothing written on that computer. */
const NEEDS_ROOT_CHECK = `if [ "$(id -u)" -ne 0 ]; then echo ${shellQuote(PLACE_NEEDS_ROOT_LINE)}; exit 1; fi`;

/** Everything the deploy can only do once the machine has said which chip it is, by the one word the machine says
 * about itself: the binaries for every other chip go, and the daemon is put up against the one that is left. The
 * unit, the supervisor script and the AppArmor profile each name that binary by its path, which carries the chip's
 * target triple, so they are written in the arm rather than above it: nothing asks a fork what it is before the
 * bundle lands, and this is where the machine answers. A chip wsp builds no daemon for ends the deploy here,
 * before anything is started. */
function onTheChipItIs(place: DaemonPlace, targets: readonly DaemonTarget[], previewHostSuffix?: string): string[] {
  return [
    'case "$(uname -m)" in',
    ...targets.flatMap(target => {
      const others = targets.filter(t => t !== target).map(t => sh(place, dirname(daemonBinaryOn(place.dir, t))));
      return [
        `  ${target.uname})`,
        ...(others.length === 0 ? [] : [`rm -rf ${others.join(" ")}`]),
        // The wsp on this machine's PATH, where the place carries the shim rather than the packed command: two
        // lines onto the binary just named, so a fork needs nothing on its image to answer the word.
        ...(place.wsp !== "shim"
          ? []
          : [`cat > ${sh(place, GUEST_WSP_PATH)} <<'WSP_SHIM'\n${guestWspShim(daemonBinaryOn(place.dir, target))}WSP_SHIM`, `chmod 0755 ${sh(place, GUEST_WSP_PATH)}`]),
        // The profile a box needs before its workspaces can isolate, where AppArmor is enforcing; written once the
        // binary it names is in place, and only on a root install, since a login-scoped daemon owns no /etc and
        // runs its workspaces under the person's own login instead.
        ...(place.scope === "system" ? apparmorStep(place, target) : []),
        ...place.supervise.start(place, target, previewHostSuffix),
        "  ;;",
      ];
    }),
    '  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;',
    "esac",
  ];
}

/** Vite reads this list of extra allowed hosts from the environment (8.2.2, measured 2026-09-05); without it every
 * dev server answers 403 through the preview edge. Next.js and webpack-dev-server have no env equivalent. */
export const VITE_ALLOWED_HOSTS_ENV = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";

/** What the daemon has printed lately on this machine, through whatever supervises it. */
export const daemonLogCommand = (place: DaemonPlace = CLOUD_PLACE, lines = 50): string => place.supervise.log(place, lines);

/** The unit the daemon runs under. Until 2026-09-08 it was started with setsid over the provider's exec and had no
 * supervisor at all: the kernel's memory killer took one and the machine sat with no daemon for five hours while
 * its turns, which go over that same exec, kept running. Restart=always is the whole point of the file, so the
 * start rate limit that would give up after five restarts is off. OOMPolicy=continue keeps a killed child (a test
 * run under a terminal) from taking the daemon with it, which systemd's default of stop would do. MemoryMax is a
 * share of the machine, not a figure, because every terminal the daemon opens sits in its cgroup. Output goes to
 * the journal, the one store on the machine that bounds itself. The environment is stated here rather than
 * inherited: a restart at boot or after a kill inherits nothing from the exec that deployed the daemon. */
export function daemonUnit(place: DaemonPlace, target: DaemonTarget, previewHostSuffix?: string): string {
  return [
    "[Unit]",
    "Description=wsp daemon",
    "After=network.target",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    // The rest of the line is the path, quotes and all, so a space in one needs nothing and a quote would break it.
    `WorkingDirectory=${place.dir}`,
    `Environment=${unitEnvLine(place, `PATH=${place.toolsPath}`)}`,
    ...Object.entries(place.unitEnv).map(([name, value]) => `Environment=${unitEnvLine(place, `${name}=${value}`)}`),
    ...(previewHostSuffix !== undefined ? [`Environment=${VITE_ALLOWED_HOSTS_ENV}=${previewHostSuffix}`] : []),
    // The place's own file, where it has one: missing everywhere else, which the dash says is fine.
    ...(place.envFile !== undefined ? [`EnvironmentFile=-${place.envFile}`] : []),
    `ExecStart=${daemonExecLine(place, target)}`,
    "Restart=always",
    "RestartSec=1",
    `MemoryMax=${DAEMON_MEMORY_MAX_PERCENT}%`,
    "OOMPolicy=continue",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    `WantedBy=${place.wantedBy}`,
    "",
  ].join("\n");
}

/** The name the workspace AppArmor profile loads under. */
export const WSP_WORKSPACE_APPARMOR = "wsp-workspace";

/** The AppArmor profile a box needs on Ubuntu 23.10 and later, where the kernel refuses a plain binary the user
 * namespaces a workspace's own isolation is built from (`kernel.apparmor_restrict_unprivileged_userns=1`, the
 * default there). It attaches to the daemon binary, which is what clones a workspace, and carries the one rule
 * that restriction reads, the road Ubuntu's own podman profile takes. A box without AppArmor enforcing never sees
 * it written. */
export function apparmorProfile(place: DaemonPlace, target: DaemonTarget): string {
  return [
    "abi <abi/4.0>,",
    "include <tunables/global>",
    `profile ${WSP_WORKSPACE_APPARMOR} ${daemonBinaryOn(place.dir, target)} flags=(default_allow) {`,
    "  userns,",
    `  include if exists <local/${WSP_WORKSPACE_APPARMOR}>`,
    "}",
    "",
  ].join("\n");
}

/** The install step that writes the profile above and loads it, only where AppArmor is enforcing and this deploy
 * is root: elsewhere a box has nothing to load it into, or no place to write it, and needs neither. The profile's
 * bytes ride base64 so nothing in it has to be quoted for the shell, and the person watching the install is told
 * it landed. */
/** Takes the workspace profile back off, where this computer has one loaded. Guarded the way the step that wrote
 * it is: a computer with no apparmor_parser and no file of ours never had one, and says nothing about it. */
export function apparmorOffStep(profile = WSP_WORKSPACE_APPARMOR_PATH): string[] {
  return [
    `if [ -f ${shellQuote(profile)} ]; then`,
    `  command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R ${shellQuote(profile)} 2>/dev/null || true`,
    `  rm -f ${shellQuote(profile)}`,
    "fi",
  ];
}

function apparmorStep(place: DaemonPlace, target: DaemonTarget): string[] {
  const bytes = Buffer.from(apparmorProfile(place, target)).toString("base64");
  return [
    'if command -v apparmor_parser >/dev/null 2>&1 && [ -w /etc/apparmor.d ] && [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ]; then',
    `  printf %s '${bytes}' | base64 -d > ${WSP_WORKSPACE_APPARMOR_PATH}`,
    // An older parser (AppArmor 3, Ubuntu 22.04) does not know the userns rule and refuses the profile; leaving it
    // written and unloaded would say nothing, so it is removed and the refusal is said.
    `  if apparmor_parser -r -W ${WSP_WORKSPACE_APPARMOR_PATH} 2>/dev/null; then`,
    `    echo "the ${WSP_WORKSPACE_APPARMOR} apparmor profile is loaded, so workspaces isolate here"`,
    "  else",
    `    rm -f ${WSP_WORKSPACE_APPARMOR_PATH}`,
    `    echo "this computer's apparmor does not take the ${WSP_WORKSPACE_APPARMOR} profile; workspaces here run without it"`,
    "  fi",
    "fi",
  ];
}

/** Stops whatever holds the daemon's place before the new daemon starts: an update lands on a machine whose daemon
 * is running, and a second bind would fail while the port check still read the old one as up. The unit goes first,
 * since an explicit stop is the only thing Restart=always yields to and killing the pid under it would have
 * systemd put the old daemon straight back. On a place with a port of its own, what is left is a daemon from
 * before the unit: its pid comes from the socket table, the one place the guest names it (nothing else may bind
 * the port; the machine context says so). A place whose daemon picks its own port had no such daemon and writes
 * the port it bound, so the file goes instead and the deploy waits for a fresh one. A fresh machine skips through. */
export function stopDaemonScript(place: DaemonPlace = CLOUD_PLACE): string {
  return [
    `${systemctlIn(place)} stop ${DAEMON_UNIT} 2>/dev/null || true`,
    ...(place.portFile !== undefined ? [`rm -f ${sh(place, place.portFile)}`] : []),
    ...(place.port === 0
      ? []
      : [
          `old="$(ss -ltnpH 'sport = :${place.port}' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -n 1)"`,
          'if [ -n "$old" ]; then',
          '  kill "$old" 2>/dev/null || true',
          "  for _ in $(seq 20); do",
          `    ss -ltnH 'sport = :${place.port}' | grep -q . || break`,
          "    sleep 0.25",
          "  done",
          `  ss -ltnH 'sport = :${place.port}' | grep -q . && kill -9 "$old" 2>/dev/null && sleep 0.5`,
          '  echo "DAEMON_STOPPED $old"',
          "fi",
        ]),
  ].join("\n");
}

/** What the deploy prints the bound port under, for a place that let the machine pick one. */
export const DAEMON_PORT_LINE = "DAEMON_PORT";

/** The install and start sequence on the machine. `previewHostSuffix` (".preview.example.com") is what dev servers
 * must accept to answer through the edge; absent on a backend with no route to a machine's port. The daemon is
 * left running under whatever supervises it, so nothing here has to outlive the exec. */
export function deployScript(place: DaemonPlace, token: string, previewHostSuffix?: string, targets: readonly DaemonTarget[] = GUEST_DAEMON_TARGETS): string {
  const profileDir = posix.dirname(place.profileFile);
  return [
    "set -e",
    // Armed before the first line that writes: what this deploy leaves on a machine somebody owns has to go when
    // it dies halfway as surely as when it finishes.
    ...(place.onExit === undefined || place.onExit.length === 0 ? [] : [`trap "${place.onExit.join("; ")}" EXIT`]),
    // A guest exec carries PATH and nothing else (measured 2026-09-05), and the machine's own service manager reads
    // its home. What the daemon itself hands to every pty comes from its unit, not from here.
    ...place.exportEnv,
    ...stepMark(place, "files"),
    `mkdir -p ${place.make.map(dir => sh(place, dir)).join(" ")}`,
    // A root tar keeps the owner the Mac packed the bundle under, which names nobody on that computer.
    `tar --no-same-owner -xzf ${sh(place, place.bundle)} -C ${sh(place, place.dir)}`,
    // Both names: only some tools read BROWSER; the rest exec xdg-open by name, and the place's bin folder is first on PATH.
    `install -m 0755 ${sh(place, `${place.dir}/wsp-open`)} ${sh(place, place.openShim)}`,
    `ln -sfn ${sh(place, place.openShim)} ${sh(place, `${place.binDir}/xdg-open`)}`,
    ...stepMark(place, "login"),
    ...loginFilesStep(place),
    // Login shells read it from the profile file; the daemon's ptys inherit it from the daemon, exported before it starts.
    ...(previewHostSuffix !== undefined
      ? [
          `printf 'export ${VITE_ALLOWED_HOSTS_ENV}=%s\\n' '${previewHostSuffix}' > ${sh(place, `${profileDir}/wsp-preview.sh`)}`,
          `export ${VITE_ALLOWED_HOSTS_ENV}='${previewHostSuffix}'`,
        ]
      : []),
    // A fork is root's alone, so its token is written here; a machine somebody else may hold an account on gets
    // it over the byte road before this runs, since a command sits in a world readable /proc/<pid>/cmdline.
    ...(place.tokenRoad === "script" ? [writeDaemonTokenScript(token, place.tokenPath)] : []),
    ...stepMark(place, "agent"),
    ...onTheChipItIs(place, targets, previewHostSuffix),
    ...place.supervise.up(place)
  ].join("\n");
}

/** Takes the daemon off a machine and everything wsp kept beside it: the unit stopped, disabled and removed, the
 * bundle, the token, the inbox, the port file and the browser shim, and the one line wsp added to the person's
 * own login file, which would otherwise print an error on every login for a file that is gone. What wsp put on a
 * machine somebody already owns goes when the workspace that put it there does, so the machine is left as wsp
 * found it. Nothing here fails the delete: a machine that will not answer is a machine whose record goes anyway. */
export function removeDaemonScript(place: DaemonPlace): string {
  const systemctl = systemctlIn(place);
  return [
    ...place.exportEnv,
    `${systemctl} disable --now ${DAEMON_UNIT} 2>/dev/null || true`,
    `rm -f ${sh(place, place.unitPath)}`,
    `${systemctl} daemon-reload 2>/dev/null || true`,
    `rm -rf ${daemonOwnedPaths(place).map(path => sh(place, path)).join(" ")}`,
    `rm -f ${sh(place, place.openShim)} ${sh(place, `${place.binDir}/xdg-open`)}${place.wsp === "shim" ? ` ${sh(place, GUEST_WSP_PATH)}` : ""}`,
    // The profile the deploy loaded on a root install goes with the binary it names: a profile left loaded for a
    // path nothing is at is something of wsp's still on a computer the remove said it left as it found it. Only on
    // the scope that could write it, and unloaded before the file goes, since the kernel holds it by name.
    ...(place.scope === "system" ? apparmorOffStep() : []),
    // This sweep runs on every machine recorded over ssh, and a machine whose deploy never landed has a login
    // file wsp never wrote to, so the step reads their file before it opens it.
    ...(place.profileSource === undefined ? [] : [unsourceStep(place, place.profileSource)]),
    `echo ${DAEMON_GONE_LINE}`,
  ].join("\n");
}

/** Everything wsp put on the machine, off the place that named each one: nothing is guessed and no path is
 * written twice. wsp's own folder under somebody's home is not swept whole, since other roads of wsp keep things
 * beside the daemon in it. */
export function daemonOwnedPaths(place: DaemonPlace): string[] {
  return [
    place.dir,
    place.bundle,
    place.inbox,
    place.tokenPath,
    place.rootsPath,
    place.profileFile,
    place.openSocket,
    place.runDir,
    ...(place.portFile !== undefined ? [place.portFile] : []),
  ];
}

/** What a failed add's undo answers with when a place file stands that neither the read nor this add's join put
 * there: another add took the box meanwhile. */
export const ADD_TAKEN_LINE = "WSP_ADD_TAKEN";

/** What the removal answers with once the machine carries nothing of wsp's any more. */
export const DAEMON_GONE_LINE = "DAEMON_REMOVED";

/** One thing a joined add writes on a computer, and how taking it back goes: a file or folder of wsp's own goes
 * whole, a folder the add only made on the way to one goes when it is empty, the unit is stopped before its file
 * goes, a unit the computer already held is stopped or disabled only where it was not running or enabled before,
 * the workspace profile is unloaded, wsp's line comes out of the person's login file, and that file goes only when
 * the line was all it held. */
export interface AddWrite {
  path: string;
  as: "own" | "folder" | "unit" | "running" | "enabled" | "apparmor" | "line" | "login";
}

/** A path and each folder above it up to the home, the home and / never among them. */
const underHome = (home: string, path: string): string[] => (path !== "/" && path.startsWith(`${home}/`) ? [path, ...underHome(home, posix.dirname(path))] : []);

/** Everything a joined add can leave on a computer, off the place that names each path: what the deploy lands,
 * what the join on that computer writes, and what its agent writes if it started. The work folder is a folder the
 * join made and is never taken with anything in it; wsp's own folder is never taken whole, since a host on the
 * same login keeps its state there. */
export function joinedAddWrites(place: DaemonPlace, unitPath: string): AddWrite[] {
  const home = place.root.replace(/\/+$/, "");
  const at = placeDaemonPaths(home);
  const own = [...placeOwnedPaths(home).filter(path => path !== at.wsp), `${posix.dirname(place.profileFile)}/wsp-preview.sh`, at.manifestPath, at.putDir, joinOf(place).codeFile];
  const folders = [...new Set([...place.make, workFolderIn(home)].flatMap(path => underHome(home, path)))].filter(path => !own.includes(path)).sort((a, b) => b.split("/").length - a.split("/").length);
  return [
    { path: unitPath, as: "unit" },
    { path: unitPath, as: "running" },
    { path: unitPath, as: "enabled" },
    ...own.map((path): AddWrite => ({ path, as: "own" })),
    { path: WSP_WORKSPACE_APPARMOR_PATH, as: "apparmor" },
    ...(place.profileSource === undefined ? [] : [{ path: place.profileSource, as: "line" } as const, { path: place.profileSource, as: "login" } as const]),
    ...folders.map((path): AddWrite => ({ path, as: "folder" })),
  ];
}

/** What the read of a computer's own holdings ends with, so a read cut short is never taken for one that found nothing. */
export const ADD_FOUND_END = "WSP_HAD_END";
const ADD_FOUND_LINE = "WSP_HAD";

/** Asked before a byte of the add lands: which of those writes the computer already holds, each by its place in
 * the list, so a path's own characters never have to survive the trip back. */
export function addFoundScript(place: DaemonPlace, writes: readonly AddWrite[], systemctl: string): string {
  return [...place.exportEnv, ...writes.map((w, i) => `${stillThere(place, w, systemctl)} && echo '${ADD_FOUND_LINE} ${i}'`), `echo ${ADD_FOUND_END}`].join("\n");
}

/** The test that holds where the computer has this write, read before the add and again once the undo ran. */
function stillThere(place: DaemonPlace, w: AddWrite, systemctl: string): string {
  const unit = shellQuote(posix.basename(w.path));
  if (w.as === "running") return `${systemctl} is-active --quiet ${unit} 2>/dev/null`;
  if (w.as === "enabled") return `${systemctl} is-enabled --quiet ${unit} 2>/dev/null`;
  if (w.as === "line") return `grep -qF ${shellQuote(place.profileFile)} ${sh(place, w.path)} 2>/dev/null`;
  return `{ [ -e ${sh(place, w.path)} ] || [ -L ${sh(place, w.path)} ]; }`;
}

/** Which writes the computer held, or nothing where it never finished saying, which leaves every write its own. */
export function addFound(stdout: string, count: number): ReadonlySet<number> | undefined {
  const lines = stdout.split("\n").map(line => line.trim());
  if (!lines.includes(ADD_FOUND_END)) return undefined;
  const held = lines.flatMap(line => {
    const m = new RegExp(`^${ADD_FOUND_LINE} (\\d+)$`).exec(line);
    return m === null || Number(m[1]) >= count ? [] : [Number(m[1])];
  });
  return new Set(held);
}

/** Takes back what a failed add wrote and the computer did not hold before it, and nothing else: the unit first,
 * so its agent lets go of the files, then the files, the profile, wsp's line in the login file and the folders it
 * made, deepest first. A path under a folder that has become a link since the read is left, as both leave roads
 * leave one. The last line is said only when every write taken back is gone; a folder left holding what is not
 * the add's is not one of them. A place file this add's join did not write and the read did not find is another
 * add's, so the undo stops before its first removal. A unit this add wrote fresh counts as left while it runs. */
export function addUndoScript(place: DaemonPlace, writes: readonly AddWrite[], found: ReadonlySet<number>, systemctl: string, joined: boolean): string {
  const home = place.root.replace(/\/+$/, "");
  const unitHeld = writes.some((w, i) => w.as === "unit" && found.has(i));
  const taken = writes.filter((w, i) => !found.has(i) && (unitHeld || (w.as !== "running" && w.as !== "enabled")));
  const checked = [...taken.filter(w => w.as !== "folder"), ...(unitHeld ? [] : writes.filter((w, i) => w.as === "running" && !found.has(i)))];
  const placeFile = joinOf(place).file;
  const raced = joined ? [] : writes.filter((w, i) => w.path === placeFile && w.as === "own" && !found.has(i));
  const at = (as: AddWrite["as"]): string[] => taken.flatMap(w => (w.as === as ? [w.path] : []));
  const unit = (path: string): string => shellQuote(posix.basename(path));
  const unlinked = (path: string, line: string): string => {
    const links = underHome(home, posix.dirname(path)).map(folder => `[ ! -L ${sh(place, folder)} ]`);
    return links.length === 0 ? line : `if ${links.reverse().join(" && ")}; then ${line}; fi`;
  };
  return [
    ...place.exportEnv,
    ...raced.map(w => `if ${stillThere(place, w, systemctl)}; then echo ${ADD_TAKEN_LINE}; exit 0; fi`),
    ...at("unit").flatMap(path => [`${systemctl} disable --now ${unit(path)} 2>/dev/null || true`, `rm -f ${sh(place, path)}`, `${systemctl} daemon-reload 2>/dev/null || true`]),
    ...at("running").map(path => `${systemctl} stop ${unit(path)} 2>/dev/null || true`),
    ...at("enabled").map(path => `${systemctl} disable ${unit(path)} 2>/dev/null || true`),
    ...at("own").map(path => unlinked(path, `rm -rf ${sh(place, path)}`)),
    ...(at("apparmor").length === 0 ? [] : apparmorOffStep()),
    ...at("line").map(path => unsourceStep(place, path)),
    ...at("login").map(path => `[ -s ${sh(place, path)} ] || rm -f ${sh(place, path)}`),
    ...at("folder").map(path => unlinked(path, `rmdir ${sh(place, path)} 2>/dev/null || true`)),
    "left=0",
    ...checked.map(w => (w.as === "login" ? `[ -e ${sh(place, w.path)} ] && [ ! -s ${sh(place, w.path)} ] && left=1` : `${stillThere(place, w, systemctl)} && left=1`)),
    `[ "$left" = 0 ] && echo ${DAEMON_GONE_LINE}`,
  ].join("\n");
}

/** Runs that removal and says what the machine answered, for the one caller that has to report a machine which
 * would not let go of it. */
export async function removeDaemon(machine: Machine, place: DaemonPlace): Promise<void> {
  const res = await machine.run(removeDaemonScript(place), { deadlineMs: 120_000 });
  if (res.exitCode !== 0 || !res.stdout.includes(DAEMON_GONE_LINE)) {
    throw new Error(`the daemon would not come off ${machine.id}: ${res.stdout.slice(-200)} ${res.stderr.slice(-200)}`.trim());
  }
}

/** What must hold on the machine, asked on its own before a single byte of wsp's lands there: a machine that
 * refuses is a machine wsp leaves exactly as it found it, and the person is told what it needs without waiting on
 * an upload first. A place with nothing to ask skips the round trip. */
export function preflightScript(place: DaemonPlace): string {
  return [...place.exportEnv, ...place.preflight, `echo ${PREFLIGHT_OK_LINE}`].join("\n");
}

/** What that check answers with when the machine can take a daemon. */
export const PREFLIGHT_OK_LINE = "PREFLIGHT_OK";

/** Runs it and throws, marked with which of the two ways it ended. A refusing line echoes its sentence and exits
 * 1, so a last line on stdout under that code is the machine's own words about what it has not got and is marked
 * as such; anything else is a check that never ran there, where the words are the ssh client's own (a machine that
 * is off answers nothing on stdout and 255) and say nothing about that machine. Telling them apart here is what
 * keeps a box someone switched off out of the row that says what a machine lacks. */
export async function preflight(machine: Machine, place: DaemonPlace): Promise<void> {
  if (place.preflight.length === 0) return;
  const res = await machine.run(preflightScript(place), { deadlineMs: 60_000 });
  if (res.exitCode === 0 && res.stdout.includes(PREFLIGHT_OK_LINE)) return;
  const said = res.stdout.split("\n").filter(line => line.trim() !== "").at(-1)?.trim();
  if (res.exitCode === 1 && said !== undefined) throw machineLacking(said);
  throw machineUnanswered(`the machine did not answer what a daemon needs: ${(said ?? res.stderr.slice(-200)).trim()}`);
}

/** The preview host with its machine-and-port label cut off ("<id>-7070.preview.example.com" gives
 * ".preview.example.com"): the suffix every port on this machine is served under, read off the backend
 * rather than assumed. Undefined on a backend with no route to a guest port, on a host with no dot to cut at, and
 * on a route to an address rather than a name, which is what a machine reached at a published port answers with:
 * an allowlist entry is for the name a browser would ask for. */
export async function previewHostSuffix(machine: Machine): Promise<string | undefined> {
  if (machine.previewUrl === undefined) return undefined;
  const { hostname } = new URL((await machine.previewUrl(DAEMON_PORT)).url);
  if (isIP(hostname) !== 0) return undefined;
  const dot = hostname.indexOf(".");
  return dot > 0 ? hostname.slice(dot) : undefined;
}

/** macOS tar writes com.apple.provenance as pax xattr headers; GNU tar in the
 * guest warns once per file and buries real errors. Measured on bsdtar 3.5.3:
 * --no-xattrs strips them, --no-mac-metadata alone does not and is bsdtar-only. */
export function tarPackCommand(
  stage: string,
  tgz: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const flags = platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : ["--no-xattrs"];
  return {
    file: "tar",
    args: [...flags, "-czf", tgz, "-C", stage, "."],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  };
}

export async function packBundle(stage: string, tgz: string): Promise<void> {
  const { file, args, env } = tarPackCommand(stage, tgz);
  await execFileAsync(file, args, { env });
}

/** What a build or a dial prints once the daemon is on a machine: the version this host deploys, which is the one
 * the machine's hello announces from then on. */
export const DAEMON_DEPLOYED_LINE = `daemon v${DAEMON_VERSION}`;

/** A joined computer's deploy echoes `WSP_STEP <step>` before each step; WSP_READY opens the join and the join's
 * own joinedLine opens the service. */
const PLACE_DEPLOY_STEPS = {
  files: "did not take wsp's files",
  login: "did not take wsp's login files",
  agent: "did not set up wsp's agent",
  join: "took wsp but could not connect back",
  service: "connected back but its agent did not start",
} as const;
type PlaceDeployStep = keyof typeof PLACE_DEPLOY_STEPS;
const WSP_STEP_LINE = "WSP_STEP";
const isDeployStep = (word: string): word is PlaceDeployStep => Object.hasOwn(PLACE_DEPLOY_STEPS, word);

/** A joined computer's deploy alone: a fork's script is hashed into the daemon's content. */
const stepMark = (place: DaemonPlace, step: "files" | "login" | "agent"): string[] => (place.join === undefined ? [] : [`echo ${WSP_STEP_LINE} ${step}`]);

/** What `wsp join` prints once the place file is written, before it installs the service. */
export const joinedLine = (name: string, url: string): string => `${name} joined the wsp at ${url}; it dials that host on its own from now on.`;

/** The engine's readers of a box's words bound them at this length. */
const SAID_MAX = 300;

export const cappedLine = (line: string, max = SAID_MAX): string => (line.length <= max ? line : `${line.slice(0, max - 1)}…`);

export const placeInstallFailedLine = (name: string, step: PlaceDeployStep, said: string): string => cappedLine(`${name} ${PLACE_DEPLOY_STEPS[step]}: ${said}`);

/** A tool's closing line after the one that said why, which is not the box's reason. */
const TOOL_TRAILER = /^tar: (Exiting with failure status due to previous errors|Error is not recoverable: exiting now)$/;

/** The step a joined deploy reached, off the marks it printed; "service" is past the join writing its place file. */
function joinedStep(join: DaemonJoin, stdout: string): PlaceDeployStep {
  let step: PlaceDeployStep = "files";
  // Whichever address answered: the join may spell it as it normalised it.
  const [joinedHead, joinedTail] = joinedLine(join.name, "\0").split("\0") as [string, string];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const word = line.startsWith(`${WSP_STEP_LINE} `) ? line.slice(WSP_STEP_LINE.length + 1) : undefined;
    if (word !== undefined && isDeployStep(word)) step = word;
    else if (line === WSP_READY_LINE) step = "join";
    else if (line.startsWith(joinedHead) && line.endsWith(joinedTail)) step = "service";
  }
  return step;
}

/** Under set -e the line that ended the script is the last the box wrote on stderr. */
function joinedFailureLine(join: DaemonJoin, res: { stdout: string; stderr: string; exitCode: number }): string {
  const step = joinedStep(join, res.stdout);
  const said = clientWords(res.stderr.replace(/\r/g, ""))
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "" && !TOOL_TRAILER.test(line))
    .at(-1);
  return placeInstallFailedLine(join.name, step, said ?? `it said nothing about why (exit ${res.exitCode})`);
}

/** Everything a deploy that would not come up printed: the machine's own last words, then the commands the deploy
 * was running on it when they stopped, which on a joined computer is its own `wsp join`. Named so the next person
 * runs them on the machine rather than working out what wsp ran there first. The token is never among them: it is
 * landed over the byte road or written by a line of its own, and no supervision's start lines carry it. */
function deployFailureDetail(place: DaemonPlace, res: { stdout: string; stderr: string }, previewHostSuffix?: string, targets: readonly DaemonTarget[] = GUEST_DAEMON_TARGETS): string {
  const said = `daemon deploy failed: ${res.stdout.slice(-300)} ${res.stderr.slice(-200)}`.trim();
  return [said, "it stopped in these commands, which run on that computer:", ...onTheChipItIs(place, targets, previewHostSuffix)].join("\n");
}

/** A fork's failure is the whole detail; a joined computer's is one sentence, its detail going to the host's log. */
export function deployFailureLine(place: DaemonPlace, res: { stdout: string; stderr: string; exitCode: number }, previewHostSuffix?: string, targets: readonly DaemonTarget[] = GUEST_DAEMON_TARGETS): string {
  return place.join === undefined ? deployFailureDetail(place, res, previewHostSuffix, targets) : joinedFailureLine(place.join, res);
}

/** A joined deploy whose own join refused the computer as already in a wsp, read off the join's line on stderr
 * before any sentence is capped: what stands there is another add's, and nothing of it is this add's to take back. */
export class PlaceAlreadyJoinedError extends Error {}

/** A joined deploy that failed after its own join wrote the place file, so the place file on the box is this add's. */
export class PlaceJoinedThenFailedError extends Error {}

const joinSaidAlreadyJoined = (stderr: string): boolean => stderr.split("\n").some(line => line.replace(/\r/g, "").trim() === ALREADY_JOINED_LINE);

/** Upload and start the daemon on a machine, replacing one already running there; returns the token it starts
 * with (the runtime replaces it the first time a client reaches the daemon) and, where the machine picked the port,
 * the port it bound. The bytes go by the one road that reads the machine
 * for how bytes reach it, so a machine whose provider mints no signed URL is deployed to over its own connection. */
export async function deployDaemon(
  machine: Machine,
  opts: {
    token?: string;
    daemonDir?: string;
    cliDir?: string;
    place?: DaemonPlace;
    land?: readonly { path: string; bytes: Uint8Array }[];
    onLine?: (line: string) => void;
    /** The chip the machine itself said it is, where the caller read it before this ran. The bundle then carries
     * that one binary, so a host holding the machine's own target deploys to it whether or not it holds the other.
     * Absent where the machine cannot be asked before the bundle lands, which is every fork of an image. */
    target?: DaemonTarget;
  } = {},
): Promise<{ token: string; port?: number }> {
  const place = opts.place ?? guestPlace(machine.daemonSupervisor ?? "systemd");
  const targets = opts.target === undefined ? GUEST_DAEMON_TARGETS : [opts.target];
  const token = opts.token ?? randomBytes(24).toString("hex");
  const stage = mkdtempSync(join(tmpdir(), "wsp-daemon-bundle-"));
  const tgz = `${stage}.tgz`;
  try {
    // Before the bundle is even packed: what wsp puts on a machine somebody owns goes when the record does, and
    // the surest way to keep that promise for a machine that refuses is to have put nothing there at all.
    await preflight(machine, place);
    await stageDaemonBundle(stage, place, opts.daemonDir, opts.cliDir, targets);
    await packBundle(stage, tgz);
    await landBytes(machine, place.bundle, new Uint8Array(readFileSync(tgz)));
    // Before the script rather than in it, where the place says the machine may carry other accounts: the bytes
    // go over the connection and no command on that machine ever names the token.
    if (place.tokenRoad === "bytes") await landBytes(machine, place.tokenPath, new TextEncoder().encode(token));
    // Whatever else this place's script reads off disk rather than off its own command line, by the same road and
    // for the same reason: a join code in a command sits in a world readable /proc/<pid>/cmdline while it runs.
    for (const { path, bytes } of opts.land ?? []) await landBytes(machine, path, bytes);

    const suffix = await previewHostSuffix(machine);
    const res = await machine.run(deployScript(place, token, suffix, targets), { deadlineMs: 180_000, ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}) });
    if (res.exitCode !== 0 || !res.stdout.includes("DAEMON_UP")) {
      if (place.join !== undefined) console.warn(deployFailureDetail(place, res, suffix, targets));
      const line = deployFailureLine(place, res, suffix, targets);
      if (place.join === undefined) throw new Error(line);
      if (joinSaidAlreadyJoined(res.stderr)) throw new PlaceAlreadyJoinedError(line);
      throw joinedStep(place.join, res.stdout) === "service" ? new PlaceJoinedThenFailedError(line) : new Error(line);
    }
    const port = Number(new RegExp(`${DAEMON_PORT_LINE} (\\d+)`).exec(res.stdout)?.[1] ?? 0);
    return { token, ...(port > 0 ? { port } : {}) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(tgz, { force: true });
  }
}

// --- preview-socket client ------------------------------------------------

export interface DaemonSocket {
  op(op: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
  readonly closed: Promise<number>;
  /** Completed heartbeat round trips. */
  readonly beats: number;
  readonly open: boolean;
}

/** The dial, the auth frame and the op that proves it, before a connect is given up. */
export const DAEMON_CONNECT_TIMEOUT_MS = 15_000;

export interface ConnectOptions {
  /** Preview URL (pt_token in the query) or a plain local daemon URL. */
  url: string;
  /** The daemon's own token, sent as the socket's first frame; the second gate behind the edge's pt_token. */
  token: string;
  /** App-level beat cadence; the edge's idle sweep kills quiet sockets ~30s
   * out and browsers cannot send protocol pings. Default 10s (measured). */
  heartbeatMs?: number;
  onEvent?: (event: Record<string, unknown>) => void;
  /** A throw out of onEvent lands here instead of the process: an event from the machine must never end the host. */
  onEventError?: (error: unknown) => void;
  connectTimeoutMs?: number;
}

/** Connect through the preview edge, send the auth frame and prove it with one
 * op round trip before resolving; then keep the socket warm with app-level heartbeats. */
export function connectDaemonSocket(opts: ConnectOptions): Promise<DaemonSocket> {
  const u = new URL(opts.url);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u.toString());
    const pending = new Map<number, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    let beats = 0;
    let settled = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let resolveClosed: (code: number) => void = () => {};
    const closed = new Promise<number>(r => (resolveClosed = r));

    const connectTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error(`daemon connect timed out after ${opts.connectTimeoutMs ?? DAEMON_CONNECT_TIMEOUT_MS}ms`));
      }
    }, opts.connectTimeoutMs ?? DAEMON_CONNECT_TIMEOUT_MS);

    const op = (name: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      // ws neither throws nor calls back for a send on a closed socket, and the close handler already emptied pending.
      if (ws.readyState !== ws.OPEN) return Promise.reject(new Error(`daemon socket is not open (${name})`));
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, op: name, ...extra }));
      });
    };

    const socket: DaemonSocket = {
      op,
      close: () => {
        if (heartbeat) clearInterval(heartbeat);
        ws.close(1000);
      },
      closed,
      get beats() {
        return beats;
      },
      get open() {
        return ws.readyState === ws.OPEN;
      },
    };

    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      const id = m["id"];
      if (typeof id === "number" && pending.has(id)) {
        pending.get(id)!.resolve(m);
        pending.delete(id);
      } else if (typeof m["type"] === "string") {
        try {
          opts.onEvent?.(m);
        } catch (e) {
          opts.onEventError?.(e);
        }
      }
    });

    ws.on("open", () => {
      // The daemon accepts the upgrade before reading the frame, so only a
      // successful op proves we are in (a bad token closes 4401 instead).
      op("auth", { token: opts.token })
        .then(() => op("manifest.get"))
        .then(
        () => {
          clearTimeout(connectTimer);
          settled = true;
          heartbeat = setInterval(() => {
            op("manifest.get").then(
              () => {
                beats++;
              },
              () => {},
            );
          }, opts.heartbeatMs ?? 10_000);
          resolve(socket);
        },
        e => {
          clearTimeout(connectTimer);
          if (!settled) {
            settled = true;
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
      );
    });
    ws.on("close", (code, reason) => {
      if (heartbeat) clearInterval(heartbeat);
      const err = new Error(`daemon connection closed ${code} ${String(reason)}`);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      resolveClosed(code);
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(err);
      }
    });
    ws.on("error", e => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

// --- the doctor loop ------------------------------------------------------

function fmtMs(ms: number): string {
  return ms < 10_000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

class Timings {
  rows: { step: string; ms: number; note: string }[] = [];
  async time<T>(step: string, fn: () => Promise<T>, note?: (v: T) => string): Promise<T> {
    const start = Date.now();
    const v = await fn();
    this.rows.push({ step, ms: Date.now() - start, note: note ? note(v) : "" });
    return v;
  }
  add(step: string, ms: number, note = ""): void {
    this.rows.push({ step, ms, note });
  }
  print(log: (line: string) => void): void {
    const w1 = Math.max(...this.rows.map(r => r.step.length), 4) + 2;
    log("");
    log("step".padEnd(w1) + "time".padEnd(10) + "note");
    log("-".repeat(w1 + 10 + 44));
    for (const r of this.rows) log(r.step.padEnd(w1) + fmtMs(r.ms).padEnd(10) + r.note);
    log("-".repeat(w1 + 10 + 44));
    log("TOTAL".padEnd(w1) + fmtMs(this.rows.reduce((a, r) => a + r.ms, 0)));
  }
}

/** Envs every guest needs: a PATH that reaches the daemon's node, the harness
 * install, and what the golden import's tools stage puts on the machine. */
export const GUEST_ENVS: Record<string, string> = {
  IS_SANDBOX: "1",
  PATH: TOOLS_PATH,
};

/** What a machine is created with for Claude Code: the config dir and the guest's own variables, and nothing of a
 * sign-in. No key and no token is among them, since anything of that kind in a machine's environment outranks the
 * token the vault sets on each turn inside the CLI, and a sign-in never sits on a machine.
 * BROWSER rides along only for a golden sealed with the shim: Claude Code in an
 * agent session (no TTY, no BROWSER) opens nothing at all, so a remote MCP
 * sign-in from an agent run needs it; a golden without the shim would point
 * every tool at a missing file. */
export function claudeEnvs(golden?: Pick<GoldenVersion, "browserShim">): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR,
    ...GUEST_ENVS,
    ...(golden?.browserShim === true ? { BROWSER: OPEN_SHIM_PATH } : {}),
  };
}

/** The doctor's first check: every version of the golden is made durable, so a gateway restart at the provider
 * cannot take the image a person built. Each version is a line, recorded or not; the note is the counts. It never
 * fails the doctor: a version whose snapshot is gone is one line here and the rebuild road below deals with it. */
export async function promoteGoldens(rt: Runtime, io: Pick<CliIO, "log">): Promise<string> {
  let rows: Awaited<ReturnType<Runtime["golden"]["promote"]>>;
  try {
    rows = await rt.golden.promote();
  } catch (e) {
    return `not made durable: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (rows === undefined) return NO_TEMPLATES_LINE;
  for (const r of rows) io.log("error" in r ? templateSkippedLine(r.golden, r.version, r.error) : templateRecordedLine(r.golden, r.version, r.templateId, r.sharing));
  if (rows.length === 0) return (await rt.golden.get()) === undefined ? "no image to make durable" : "every version already has a template";
  const counts = [
    [rows.filter(r => !("error" in r)).length, "promoted"],
    [rows.filter(r => "error" in r).length, "not made durable"],
  ] as const;
  return counts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(", ");
}

/** The doctor's storage step: the account listing split by who made each row, every orphan of this host named, and
 * the offer to delete them, taken on --yes. Rows without this host's mark are named and never passed to a delete,
 * so another host's golden and a person's own snapshot survive a doctor run with --yes. */
export async function cleanOrphans(rt: Runtime, io: Pick<CliIO, "log">, yes: boolean, statePath?: string): Promise<string> {
  let storage: SnapshotStorage | undefined;
  let plan: AccountOrphans | undefined;
  try {
    storage = await rt.golden.storage();
    plan = await rt.golden.orphans();
  } catch (e) {
    return `listing not read: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (storage === undefined || plan === undefined) return NO_SNAPSHOT_LISTING;
  io.log(describeStorage(storage));
  for (const line of describeOrphans(plan)) io.log(line);
  if (plan.snapshots.length === 0 && plan.templates.length === 0) return "no orphan of this host";
  const offer = describeOrphanOffer(plan, yes, statePath);
  if (!yes) return offer;
  io.log(offer);
  const done = await rt.golden.deleteOrphans();
  return done === undefined ? NO_SNAPSHOT_LISTING : describeDeleted(done);
}

/** The doctor's box row: what the computer this fork landed on has left once this run's own machine is on it. A
 * box holds every fork down to a size that leaves the computer itself room, so the room is worth reading back
 * here rather than after the first fork that would not start. Empty where the place counts no room or will not
 * answer, which the caller reads as no row at all: a reading is not a step, and a computer that stays quiet about
 * its room costs this run nothing. Returns the step's note. */
export async function roomLeft(backend: Pick<MachineBackend, "capacity">): Promise<string> {
  if (backend.capacity === undefined) return "";
  return (await backend.capacity().then(boxRoomLines, () => [])).join("; ");
}

/** The doctor's teardown check. Only machines this host made count, by the owner stamp every machine wsp creates
 * wears: a second computer on the same account stands its own, and the doctor deleted none of them. Those are one
 * line, named and left alone; this host's own leftovers fail the run. Returns the step's note. */
export async function verifyNoneLeft(backend: MachineBackend, owner: string, log: (line: string) => void): Promise<string> {
  const rows = (await backend.list()).filter(m => !isReserved(m.labels) && m.state !== "gone");
  const mine = rows.filter(m => whoseMachine(m.labels, owner) === "own");
  const others = rows.filter(m => whoseMachine(m.labels, owner) !== "own");
  if (others.length > 0) log(otherHostsMachinesLine(others.map(m => ({ id: m.id, ...(m.labels[OWNER_LABEL] !== undefined ? { owner: m.labels[OWNER_LABEL]! } : {}) }))));
  if (mine.length > 0) throw new Error(`machines still up: ${mine.map(m => m.id).join(", ")}`);
  return others.length > 0 ? "workspace deleted, no machines of this host left" : "workspace deleted, no machines left on the account";
}

export interface DoctorOptions {
  /** Envs a golden build and its forks are created with: config dirs and the guest's own, never a sign-in. */
  envs?: Record<string, string>;
  daemonDir?: string;
  /** Deletes this host's orphan snapshots and templates instead of only naming them. */
  yes?: boolean;
  /** The state file whose records decided which rows are orphans; named in the offer, since a run under a different
   * --state reads the usual file's goldens as recorded by nothing. */
  statePath?: string;
  /** The repo the fork's project clones. A workspace is one project's copy, so the doctor records one for its run
   * and the clone inside the fork is part of what it proves; a run behind a proxy or on a private network names
   * one its machines can reach. */
  repo?: string;
  /** The computer this run proves, off the places list: a computer somebody joined takes the computer road below,
   * a cloud account the fork road, which is the only one that bills. Absent proves this computer and then every
   * computer joined to it, and forks nothing. */
  computer?: PlaceView;
  /** The project a computer road's workspace is made of, by name or id, on the computer named; the first project
   * there whose checkout stands without one. */
  project?: string;
  /** What the vault holds right now, read at the ask rather than copied, for the line that says which keys this
   * computer holds by name. Absent leaves the step saying no vault was wired. */
  vault?: () => Readonly<Record<string, string>>;
  /** The recipe on this computer planned for a computer somebody owns, the same plan the recipe job runs, or the
   * path a recipe would be written to where there is none: what the tools inside a workspace are read against. */
  plan?: () => Promise<ProvisionPlan | { noRecipe: string }>;
  /** The daemon this host runs for its own computer's workspace, for the line that says it is behind. */
  hereDaemon?: HereDaemon;
  /** The newest release as the command line read it off the host's file, worded; absent where none was kept. */
  latest?: string;
}

/** The repo the doctor's own project clones when nobody names one: a public repo of one commit, small enough that
 * the clone is a reach test and not a download. */
export const DOCTOR_REPO = "https://github.com/octocat/Hello-World.git";

/** The word the local road asks the agent for and reads back: random per run, so a reply that carries it was written
 * by a turn this run started rather than left in a store by an earlier one. */
export const localPrompt = (word: string): string => `Reply with exactly this word and nothing else: ${word}`;

/** The doctor's local road: no machine, no provider and no bill. This computer is the workspace, a thread runs on it
 * through the harness whose binary answered here, and its reply is read. It proves the half of wsp a person with no
 * provider key has: the local backend, the turn's child process, the adapter, the transcript. A workspace this run
 * made is forgotten at the end; the one this host already holds is left where it is. */
export async function localDoctor(rt: Runtime, io: CliIO, opts: Pick<DoctorOptions, "hereDaemon"> = {}): Promise<number> {
  const timings = new Timings();
  let failed: string | undefined;
  let made: string | undefined;
  let madeProject: string | undefined;
  let madeFolder: string | undefined;
  try {
    io.log(`doctor: proving a thread on ${THIS_COMPUTER}, with no machine and nothing billing`);
    // Before anything else: the daemon staged beside this wsp is what a copy here runs, and one that is behind is
    // the reading a person came for whether or not the rest of the run stands.
    for (const line of await hereDaemonLines(opts.hereDaemon)) io.log(line);

    const workspace = await timings.time(
      "local workspace",
      async () => {
        const held = (await rt.workspaces.list()).find(isLocalWorkspace);
        if (held !== undefined) return held;
        // A workspace is one project's copy, so the run records a repo of its own on this computer and works it
        // in place; both go at the end.
        const folder = mkdtempSync(join(tmpdir(), "wsp-doctor-"));
        execFileSync("git", ["init", "-q", folder]);
        madeFolder = folder;
        const project = await rt.projects.add({ source: folder });
        madeProject = project.id;
        const fresh = await rt.workspaces.create({ project: project.id, name: project.name });
        made = fresh.id;
        return fresh;
      },
      w => `${w.name} (${made === undefined ? "already here" : "made for this run"})`,
    );

    const harness = await timings.time(
      "harness here",
      async () => {
        const rows = await rt.harnesses.list(workspace.id);
        const answered = rows.find(r => r.source === "harness");
        if (answered === undefined) {
          const refused = rows.filter(r => r.refusal !== undefined).map(r => `${r.label}: ${r.refusal!}`);
          throw new Error(`no agent on this computer described itself${refused.length > 0 ? ` (${refused.join("; ")})` : ", so none of the ones wsp knows is installed and signed in here"}`);
        }
        return answered;
      },
      h => `${h.label} ${h.version ?? "version unknown"}`,
    );

    const word = `wsp-${randomBytes(3).toString("hex")}`;
    await timings.time(
      "thread and its reply",
      async () => {
        const handle = await rt.sessions.start(workspace.id, { prompt: localPrompt(word), harness: harness.harness });
        const result = await handle.finished;
        const why = result.error ?? result.text;
        if (result.status !== "completed") throw new Error(`the turn ended ${result.status}${why === undefined ? "" : `: ${why.slice(0, 200)}`}`);
        if (result.text === undefined || !result.text.includes(word)) throw new Error(`the reply did not carry the word this run asked for: ${JSON.stringify(result.text?.slice(0, 200) ?? null)}`);
        return result;
      },
      () => `${harness.label} answered with the word it was asked for`,
    );

    await timings.time(
      "tidy",
      async () => {
        // Delete on this kind drops the record and nothing else: this computer is not a machine to stop.
        if (made !== undefined) await rt.workspaces.delete(made);
        if (madeProject !== undefined) await rt.projects.remove(madeProject);
        if (madeFolder !== undefined) rmSync(madeFolder, { recursive: true, force: true });
      },
      () => (made === undefined ? "the workspace was already here and stays" : "the workspace, the project and the folder this run made are gone"),
    );
    made = undefined;
    madeProject = undefined;
    madeFolder = undefined;
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
    if (made !== undefined) await rt.workspaces.delete(made).catch(() => {});
    if (madeProject !== undefined) await rt.projects.remove(madeProject).catch(() => {});
    if (madeFolder !== undefined) rmSync(madeFolder, { recursive: true, force: true });
  }

  timings.print(io.log);
  if (failed !== undefined) {
    io.error(`\nDOCTOR FAIL: ${failed}`);
    return 1;
  }
  io.log(`\nDOCTOR PASS: ${THIS_COMPUTER} is a workspace, a thread ran on it and its reply came back.`);
  return 0;
}

/** One line per place running an older daemon than this wsp deploys, each naming the line that moves it. Read
 * before anything is forked, so the reading a person came for is printed whether or not the rest of the run stands;
 * it dials nothing and bills nothing, since every fact on it is what that computer last reported. The computer the
 * host runs on is first where the binary staged beside this wsp is behind, read off the same daemon a copy here
 * would run. A host holding no places, or none behind, prints nothing. */
export async function placesBehindLines(rt: Pick<Runtime, "places">, now = Date.now(), here?: HereDaemon): Promise<string[]> {
  const mine = await hereDaemonLines(here);
  if (rt.places === undefined) return mine;
  const places = await rt.places.list(now);
  return [
    ...mine,
    ...places.flatMap(place => {
      const word = placeDaemonBehind(place);
      return word === undefined ? [] : [placeBehindLine(place.name, word)];
    }),
  ];
}

/** This computer's own behind line, or none. A daemon that will not start at all is not this line's business: the
 * roads that need it say so themselves, and a doctor run must not fail on the reading it opens with. */
export async function hereDaemonLines(here?: HereDaemon): Promise<string[]> {
  if (here === undefined) return [];
  let version: number;
  try {
    version = await here.version();
  } catch {
    return [];
  }
  return version >= DAEMON_VERSION ? [] : [hereDaemonBehindLine(version, DAEMON_VERSION, here.fix)];
}

/** What the doctor says about the vault: every variable it may hold, by name, said held or not held, and which
 * agent reads which, in the order a turn's own reader picks them, so a person with both a token and a key set
 * reads which one a turn takes. Never a value, and nothing is sent anywhere to check one: a key the provider
 * refuses is what a turn's own sentence says, and this line is about what this computer holds. */
export function vaultKeysLines(vault: () => Readonly<Record<string, string>>): string[] {
  const held = vault();
  const reads = CATALOG_AGENTS.map(agent => ({ name: agent.name, vars: vaultVariablesOf(agent.signIn) })).filter(a => a.vars.length > 0);
  return [...VAULT_VARIABLES].sort().map(name => {
    const readers = reads.flatMap(a => {
      const at = a.vars.indexOf(name);
      if (at === -1) return [];
      if (a.vars.length === 1) return [`${a.name} reads it`];
      return [at === 0 ? `${a.name} reads it first` : `${a.name} reads it after ${a.vars[0]}`];
    });
    return `${name} ${keyIn(held, name) === undefined ? "not held" : "held"}${readers.length === 0 ? "" : ` (${readers.join(", ")})`}`;
  });
}

/** The variables one agent's sign-in row names, in the order a turn's own reader picks them: the token its own
 * command mints first, then the key. Off the row and nowhere else, so an agent that declares another variable is
 * read here without a line of its own. */
const vaultVariablesOf = (signIn: Parameters<typeof keyEnvOf>[0]): string[] => {
  const key = keyEnvOf(signIn);
  return [...(mintsToken(signIn) ? [signIn.tokenEnv] : []), ...(key === undefined ? [] : [key])];
};

/** The tools the recipe plans, read from inside the workspace this run made, by the one presence read the recipe
 * job runs on the same planned steps: a tool that answers on the computers row and not here is the bug this step
 * exists to catch, and one rule for both readings is what keeps them from disagreeing. The read the spoo proof of
 * 2026-09-18 had to be done by hand, where gh and every other Homebrew row was on the box and in no workspace of
 * it, because the prefix that road installs into is outside the trees a workspace carries.
 *
 * A step nothing can be asked about is not read: an index refresh answers no read of its own, and what it was for
 * is the rows behind it. A command answering from outside its own road's directories is a note and not a failure;
 * a row that did not answer fails the step, and where the computer's own record read that row present the line
 * that reads the computer again is said with it. */
export async function toolsInside(machine: Pick<Machine, "exec">, plan: Pick<ProvisionPlan, "steps" | "prefix">, recorded?: { name: string; provision?: PlaceProvision }): Promise<string> {
  const asked = plan.steps.filter(step => presenceTests(step).length > 0);
  if (asked.length === 0) return "the recipe plans no tool this can ask a workspace for, so there is nothing to read inside";
  // On the order a workspace on a computer somebody owns boots with, and under the same managers' knobs the job
  // ran: a row's version read is its manager's own command and answers about the folder that manager was told to
  // use, and a copy of that tool under the shared home does not answer ahead of it here either.
  const present = await presentSteps(machine as Machine, asked, PLACE_WORKSPACE_PATH, plan.prefix);
  const notes = asked.flatMap(step => {
    const note = presentElsewhere(step, present.get(step.id));
    return note === undefined ? [] : [note];
  });
  const missing = asked.filter(step => !present.has(step.id));
  if (missing.length > 0) {
    const rows = recorded?.provision;
    const said = missing.map(step => {
      const row = rows?.rows.find(r => r.id === step.id);
      const also = row?.outcome === "present" && rows?.finishedAt !== undefined ? ` (${doctorComputerRowLine(recorded!.name, rows.finishedAt)})` : "";
      return `${step.label}${also}`;
    });
    throw new Error(`${said.join(", ")} did not answer inside the workspace, though the recipe installed ${missing.length === 1 ? "it" : "them"} on the machine`);
  }
  return `${asked.length} answered inside${notes.length === 0 ? "" : `; ${notes.join("; ")}`}`;
}

/** What a computer road needs of the runtime: the places it holds, the projects on them and the workspaces it can
 * make, run one read inside and delete. Narrower than the whole runtime so this road is drivable against a fake. */
export type DoctorRuntime = Pick<Runtime, "places" | "projects" | "workspaces">;

/** The plan the tools step reads, or the sentence that stands in its place: a host that wired no recipe reader,
 * and a computer whose recipe has never been written here. */
async function planToRead(opts: DoctorOptions): Promise<ProvisionPlan | string> {
  if (opts.plan === undefined) return "this host wired no recipe plan, so there is nothing to read inside";
  const plan = await opts.plan();
  return "noRecipe" in plan ? `this computer holds no recipe at ${plan.noRecipe}, so there is nothing to read inside` : plan;
}

/** The project the doctor's workspace on that computer is made of: the one `--project` names, else the first
 * project there whose checkout stands, since a workspace is a copy of one and a project recorded before its
 * computer cloned it once has nothing to copy. Throws the line that records it again, for that person's own first
 * project there, and the line that adds one where the computer holds none. */
export function doctorProject(projects: readonly ProjectView[], computer: Pick<PlaceView, "id" | "name">, named?: string): ProjectView {
  const here = projects.filter(p => p.computer === computer.id);
  const pick = named === undefined ? (here.find(p => p.checkout !== undefined) ?? here[0]) : here.find(p => p.id === named || p.name === named);
  if (pick === undefined) {
    if (named !== undefined) throw new Error(noSuchProjectLine(named, here.map(p => p.name)));
    throw new Error(`${computer.name} holds no project, and a workspace is a copy of one; wsp add <url> --on ${computer.name} records one`);
  }
  if (pick.checkout === undefined) throw new Error(projectNeedsReaddLine(pick.name, computer.name, pick.source));
  return pick;
}

/** The doctor's computer road: the computer you named, proved end to end through the product and nothing else. It
 * answers on its link and runs the daemon this wsp deploys; the vault says which keys this computer holds; the
 * computer says which agents stand on it; a workspace is made there of a project already on it, the recipe's tools
 * are read from inside that workspace by the same rule the computers row reads them, and the workspace is deleted,
 * on the way out of a failure too. Nothing is forked at a provider and nothing bills. */
export async function computerDoctor(rt: DoctorRuntime, io: CliIO, computer: PlaceView, opts: DoctorOptions = {}, now = Date.now()): Promise<number> {
  const timings = new Timings();
  let failed: string | undefined;
  let made: string | undefined;
  try {
    io.log(`doctor: proving ${computer.name}, a computer you added, from its link to a workspace made there and back`);

    await timings.time(
      `${computer.name} answers`,
      async () => {
        if (computer.present !== true) throw new Error(absentComputer(computer.name, awayMsOf(computer, now)).sentence);
        // A computer on an older daemon than this wsp deploys is said and the run goes on: every step below it is
        // the daemon it has, and what it cannot do is the reading a person came here for.
        const behind = placeDaemonBehind(computer);
        if (behind !== undefined) io.log(placeBehindLine(computer.name, behind));
        return behind;
      },
      behind => behind ?? `daemon ${computer.daemonVersion ?? "unknown"}, this wsp ${DAEMON_VERSION}`,
    );

    await timings.time("the vault's keys", async () => vaultStep(io, opts.vault), note => note);

    timings.add("agents there", 0, agentsStepNote(io, computer));

    const workspace = await timings.time(
      "a workspace made there",
      async () => {
        const project = doctorProject(await rt.projects.list(), computer, opts.project);
        // No size: the workspace the doctor makes is the one anybody gets on that computer without asking.
        const fresh = await rt.workspaces.create({ project: project.id, name: `doctor-${now.toString(36)}` });
        made = fresh.id;
        return { view: fresh, project };
      },
      w => `${w.view.name} on ${w.project.name}`,
    );

    await timings.time(
      "the recipe's tools inside",
      async () => {
        const plan = await planToRead(opts);
        if (typeof plan === "string") return plan;
        return toolsInside({ exec: (cmd, o) => rt.workspaces.exec(workspace.view.id, cmd, o) }, plan, {
          name: computer.name,
          ...(computer.provision !== undefined ? { provision: computer.provision } : {}),
        });
      },
      note => note,
    );

    await timings.time(
      "deleted",
      async () => {
        await rt.workspaces.delete(made!);
        made = undefined;
      },
      () => `the workspace this run made on ${computer.name} is gone`,
    );
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
    if (made !== undefined) await rt.workspaces.delete(made).catch(() => {});
  }

  timings.print(io.log);
  if (failed !== undefined) {
    io.error(`\nDOCTOR FAIL: ${computer.name}: ${failed}`);
    return 1;
  }
  io.log(`\nDOCTOR PASS: ${computer.name} answers, a workspace was made there, the recipe's tools answered inside it and it is gone again.`);
  return 0;
}

/** The vault step on every road: the lines above, or the one sentence for a host that wired no vault at all. */
function vaultStep(io: Pick<CliIO, "log">, vault?: () => Readonly<Record<string, string>>): string {
  if (vault === undefined) return "this host wired no vault, so no turn here is handed a key";
  const lines = vaultKeysLines(vault);
  for (const line of lines) io.log(line);
  // Off the lines themselves, so the tally and what a person reads above it cannot disagree.
  return `${lines.filter(line => !line.includes("not held")).length} of ${lines.length} held`;
}

/** The agents the computer says stand on it, one line each by their catalog names, with the version that computer
 * answered and the one word for its sign-in where it reported them; never a failure, since an agent a person has
 * not installed there is theirs to install and not this run's to refuse. Both words are the protocol's own, so
 * this step, the computers table and the agents block under a row cannot say them three ways, and a computer whose
 * daemon reports neither reads as the name alone. */
function agentsStepNote(io: Pick<CliIO, "log">, computer: PlaceView): string {
  const agents = computer.agents ?? [];
  for (const id of agents) {
    const version = computer.agentVersions?.[id];
    const state = computer.signIns?.[id];
    const said = [version === undefined ? undefined : agentVersionWord(version), state === undefined ? undefined : agentSignInWord(state)].filter(word => word !== undefined);
    io.log(`${agentName(id)} on ${computer.name}${said.length === 0 ? "" : `: ${said.join(", ")}`}`);
  }
  return agents.length === 0 ? "the computer reported no agent" : `${plural(agents.length, "agent")}`;
}

/** What the computer road asks of the host that holds the link: one request, the frames it pushes while the road
 * runs, and the subscription that starts them. Narrower than the whole client so this road is drivable against a
 * fake. */
export type DoctorClient = Pick<HostClient, "request" | "events" | "onFrame">;

/** The doctor's computer road as a terminal walks it: the host holding that computer's link runs the six steps and
 * says each line as it lands, and this prints them where the person typed. The id is minted here and not read off
 * the reply, since the first line is said before the reply comes; the listener goes on before the request for the
 * same reason. What the line exits with is what the host's road came to, and a socket that closes mid-road is the
 * host's own sentence in the class its error carries. */
export async function hostDoctor(client: DoctorClient, io: CliIO, computer: Pick<PlaceView, "id" | "name">, opts: Pick<DoctorOptions, "project"> = {}): Promise<number> {
  const doctorId = `d_${randomBytes(6).toString("hex")}`;
  const off = client.onFrame(frame => {
    const said = DoctorLineEvent.safeParse(frame);
    if (!said.success || said.data.doctorId !== doctorId) return;
    if (said.data.stream === "err") io.error(said.data.line);
    else io.log(said.data.line);
  });
  try {
    await client.events();
    const reply = await client.request<{ code: number }>("places.doctor", {
      placeId: computer.id,
      doctorId,
      ...(opts.project !== undefined ? { project: opts.project } : {}),
    });
    return reply.code;
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e));
    return EXIT_CODES[exitClassOf(e)];
  } finally {
    off();
  }
}

/** Every computer joined to this host, proved one after another on the host that holds their links, over the one
 * socket the line opened. The exit is the worst of them, as a run that named no computer has always answered. */
export async function doctorOverHost(client: DoctorClient, io: CliIO, places: readonly PlaceView[], opts: Pick<DoctorOptions, "project"> = {}): Promise<number> {
  let code = 0;
  for (const place of places.filter(isJoinedComputer)) {
    const said = await hostDoctor(client, io, place, opts);
    if (said !== 0) code = said;
  }
  return code;
}

/** The doctor's two roads at the terminal: this computer, whose files and threads are here and nowhere else, and a
 * cloud account, whose fork bills while it runs and whose key is asked for where a person is sitting. A computer
 * somebody joined takes neither: its link is held by the host it dials, so that host runs its road and the line
 * prints what it says. */
export async function doctor(rt: Runtime, io: CliIO, opts: DoctorOptions = {}): Promise<number> {
  if (opts.latest !== undefined) io.log(`latest release ${opts.latest}`);
  // This computer's own row takes the local road, and so does a line that named nothing: a workspace here is a
  // copy of a folder on this computer, so the proof forks no machine and bills nothing.
  return opts.computer?.kind === "provider" ? forkDoctor(rt, io, opts) : localDoctor(rt, io, opts);
}

/** The doctor's fork road: this host's own image, a machine forked from it at the provider, wsp deployed on that
 * machine, the connection, a file coming back and the teardown. It forks a live machine and bills while it runs,
 * which is why only a named cloud row takes it. */
export async function forkDoctor(rt: Runtime, io: CliIO, opts: DoctorOptions = {}): Promise<number> {
  const timings = new Timings();
  let failed: string | undefined;
  let workspaceId: string | undefined;
  let socket: DaemonSocket | undefined;
  const eventListeners: ((e: Record<string, unknown>) => void)[] = [];

  const buildGolden = async (): Promise<string> => {
    if (!opts.envs) {
      throw new Error(`no image here, and no ${ANTHROPIC_KEY} to build one from this computer; run wsp init to build your image, or put the key in ${KEY_LAYER_WORDS}`);
    }
    const { version } = await rt.golden.build({
      setup: GOLDEN_SETUP,
      smoke: GOLDEN_SMOKE,
      envs: opts.envs,
      labels: { [WSP_LABEL]: "1", [DOCTOR_LABEL]: "1", [CREATED_AT_LABEL]: new Date().toISOString() },
    });
    return version.snapshotId;
  };

  try {
    io.log("doctor: proving one live workspace end to end, from your image to the machine it forks and back");

    // Before the first thing that bills: a computer on an older daemon than this wsp deploys is a fact a person
    // came here for, and a run that stops later must still have said it.
    for (const line of await placesBehindLines(rt, Date.now(), opts.hereDaemon)) io.log(line);

    await timings.time("image versions made durable", () => promoteGoldens(rt, io), note => note);
    await timings.time("snapshot storage", () => cleanOrphans(rt, io, opts.yes === true, opts.statePath), note => note);

    let golden = "";
    const head = goldenHead(await rt.golden.get());
    if (head) {
      golden = head.snapshotId;
      timings.add("your image", 0, `reused v${head.version} (${golden})`);
    } else {
      golden = await timings.time("your image", buildGolden, id => `built fresh (${id})`);
    }

    const view = await timings.time(
      "a workspace forked from it",
      async () => {
        // A workspace is one project's copy, so this run records one on the computer this host forks at and the
        // clone inside the fork is part of what the run proves.
        const computers = (await rt.places?.list(Date.now())) ?? [];
        const on = (computers.find(c => c.takesForks === true) ?? computers.find(c => c.kind === "provider"))?.id;
        const project = await rt.projects.add({ source: opts.repo ?? DOCTOR_REPO, ...(on !== undefined ? { on } : {}) });
        const spec = {
          golden,
          project: project.id,
          name: `doctor-${Date.now().toString(36)}`,
          ...(opts.envs !== undefined ? { envs: opts.envs } : {}),
          labels: { [WSP_LABEL]: "1", [DOCTOR_LABEL]: "1", [CREATED_AT_LABEL]: new Date().toISOString() },
        };
        try {
          return await rt.workspaces.create(spec);
        } catch (e) {
          if (!isMissing(e)) throw e;
          io.log("your image is gone at the provider; building it again");
          const rebuilt = await buildGolden();
          return rt.workspaces.create({ ...spec, golden: rebuilt });
        }
      },
      w => `machine ${w.machineId.slice(0, 24)}…`,
    );
    workspaceId = view.id;
    const machine = await rt.backend.get(view.machineId);

    const room = await roomLeft((view.place !== undefined ? rt.places?.backendOf(view.place) : undefined) ?? rt.backend);
    if (room !== "") timings.add("room left where it landed", 0, room);

    const { token } = await timings.time(
      "wsp on that machine",
      () => deployDaemon(machine, opts.daemonDir !== undefined ? { daemonDir: opts.daemonDir } : {}),
      () => `${DAEMON_DEPLOYED_LINE}: tar upload + start on 0.0.0.0:${DAEMON_PORT}`,
    );

    if (!machine.previewUrl) {
      throw new Error("this provider gives no address to reach a machine at, which is the half this run proves; wsp add <provider> connects one that does, and wsp doctor --local proves the other half here with no machine at all");
    }
    const reach = await timings.time(
      "an address to reach it at",
      () => machine.previewUrl!(DAEMON_PORT),
      r => `expires in ${Math.round((r.expiresAt - Date.now()) / 60_000)}min, host ${new URL(r.url).host}`,
    );

    socket = await timings.time(
      "connected to it and asked it something",
      () =>
        connectDaemonSocket({
          url: reach.url,
          token,
          onEvent: e => {
            for (const l of eventListeners) l(e);
          },
        }),
      () => "TLS + upgrade + authed manifest.get through the preview edge",
    );

    const beatTarget = 3;
    await timings.time(
      `still connected after ${beatTarget} heartbeats`,
      async () => {
        const s = socket!;
        const start = Date.now();
        while (s.beats < beatTarget) {
          if (!s.open) throw new Error("the machine stopped answering between heartbeats, which is what an idle network sweep does to a quiet connection");
          if (Date.now() - start > 60_000) throw new Error("the machine stayed connected and sent no heartbeat for a minute");
          await new Promise(r => setTimeout(r, 250));
        }
      },
      () => "socket alive past the ~30s idle sweep",
    );

    await timings.time(
      "a file written there reaches this computer",
      async () => {
        const s = socket!;
        const got = new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("a file written on the machine did not reach this computer within 20s")), 20_000);
          eventListeners.push(e => {
            if (e["type"] === "inbox.file") {
              clearTimeout(t);
              resolve();
            }
          });
        });
        await s.op("inbox.watch");
        await rt.workspaces.exec(workspaceId!, `echo doctor > ${GUEST_INBOX_DIR}/doctor-ping.txt`);
        await got;
      },
      () => "REST touch -> inbox.file over the preview socket (~2s watcher quiet window)",
    );

    await timings.time(
      "the recipe's tools inside",
      async () => {
        const plan = await planToRead(opts);
        if (typeof plan === "string") return plan;
        return toolsInside({ exec: (cmd, o) => rt.workspaces.exec(workspaceId!, cmd, o) }, plan);
      },
      note => note,
    );

    socket.close();
    await timings.time(
      "deleted, with nothing of this run left running",
      async () => {
        await rt.workspaces.delete(workspaceId!);
        workspaceId = undefined;
        return verifyNoneLeft(rt.backend, await rt.owner(), io.log);
      },
      note => note,
    );
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
    socket?.close();
    if (workspaceId !== undefined) {
      await rt.workspaces.delete(workspaceId).catch(() => {});
    }
  }

  timings.print(io.log);
  if (failed !== undefined) {
    io.error(`\nDOCTOR FAIL: ${failed}`);
    return 1;
  }
  io.log("\nDOCTOR PASS: your image, a workspace forked from it, wsp on its machine, the connection, a file coming back and the teardown all answered.");
  return 0;
}
