// SPDX-License-Identifier: AGPL-3.0-only
// The four words a person types about where their agents run: wsp add, which
// hands out a join line or takes a provider's key; wsp remove, which takes a
// place back out and sweeps wsp off it; wsp join, typed on the computer they
// are sitting at, which dials the host once and then serves the link under
// this computer's own service manager; and wsp leave, the sweep run on a
// computer whose host is gone, which wsp remove cannot reach.
//
// add and remove speak to the host on this computer, at the address its lock
// names and with the token it wrote beside its state file, so neither is a
// road a paired client or an agent can reach: a join code hands out access.
// join and leave touch this computer's own files and dial nobody's host but
// the one the person typed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { addedProjectLine, defaultSeedChoice, kindForComputer, ProjectAddEvent, seedChoiceFrom, seedConsentLines, seedMenuRows, sourceKind, copiesFolder, type ProjectView, type SeedChoice, type SeedPlan,
  ALREADY_JOINED_LINE,
  isHttpUrl,
  machineLacksLine,
  machineNeverAnswered,
  JOIN_ADDRESS_LINE,
  LOOPBACK,
  PLACE_CODE_REFUSAL,
  PLACE_LEAVE_VERB,
  PLACE_LEAVE_LINE,
  parsePlaceFile,
  fmtPrice,
  PLACE_DOOR_UNSERVED,
  PLACE_ADD_WORDS,
  PlaceUpdateReply,
  placeCurrentLine,
  type PlaceProvision,
  provisionLines,
  DAEMON_VERSION,
  JOIN_NO_KEY_REFUSAL,
  joinKeyRefusal,
  joinRoads,
  joinToken,
  readJoinToken,
  placeEngineLine,
  PLACE_LINK_NONCE_BYTES,
  PlaceJoinDevice,
  PlaceJoinReply,
  PlaceStageEvent,
  PlaceView,
  type DeviceView,
  type PlaceBack,
  type PlaceDoorView,
  type PlaceFile,
  type PlaceReport,
  authority,
  fmtBytes,
  fmtDuration,
  fmtSize,
  placeDaemonPaths,
  placeUpdateLine,
  shellQuote,
  shellLine,
  placeNoChipLine,
  MACHINE_PUT_PART_BYTES,
  workFolderIn,
  BACK_OVER_SSH,
  backUrl,
  dialsBackWord,
  hostKeyAsk,
  hostKeyKeptNote,
  hostKeyMatches,
  hostKeyMismatchRefusal,
  hostKeyUnconfirmedRefusal,
  hostKeyUnscannableRefusal,
  KNOWN_HOSTS,
  PLACE_ROOT_SHELLS,
  placeRootShellRefusal,
  hostKeyRefusal,
  isLoopback,
  joinAddressOf,
  placeLinkTranscript,
  twoPlacesRefusal,
  relayUrlOf,
  usageRefusal,
  wsUrlOf,
  PLACE_NEEDS_ROOT_LINE,
  SignInLine,
} from "@wsp/protocol";
import { MissingKnownHostsError, PlaceMachine, SshBackend, SSH_DIAL_MS, SSH_LINE_CAP, boxWord, checkProviderKey, clientWords, keyCheckLine, keyFingerprint, knownHostKey, landBytes, offeredHostKey, parseSshAddress, sshClient, sshDial, sshDialsThisComputer, sshLoginWord, sshMachineName, sshRefusalLine, sshWordReach, type KeyCheck, type MachineBackend, type SshReach, type SshTransport } from "@wsp/engine";
import { PlaceAddTakenBackError, PlaceLoginRefusedError, freshEphemeral, makeSeal, newPlaceKeyPair, openFrame, sealKeys, sharedSecret, signPlaceBytes, verifyPlaceBytes, type Seal, type HerePlace, type PlaceDialler, type PlaceInstaller, type PlaceKeyPair, type PlaceLeaver, type PlaceLogReader, type PlaceUpdateLanded, type PlaceUpdater, type PlaceWiring, type PlaceBackHolder } from "@wsp/runtime";
import { BackCutError, heldPlaceScript, placeBackHolder } from "./place-back.js";
import { writeOwn } from "@wsp/own-file";
import { CATALOG_AGENTS, NO_SIGN_IN, agentName, hasLogin, keyEnvOf, loginSignIn, sharedAgentsOn, sharedOn } from "@wsp/catalog";
import { ADD_TAKEN_LINE, DAEMON_GONE_LINE, PLACE_JOINED_LINE, PlaceAlreadyJoinedError, PlaceJoinedThenFailedError, WSP_READY_LINE, addFound, addFoundScript, addUndoScript, cappedLine, daemonFlags, deployDaemon, joinedAddWrites, joinedLine, joinedPlace, loginFilesStep, placeInstallFailedLine, sshDaemonPlace } from "./doctor.js";
import { assetDir, assetName, daemonBinaryHere } from "./assets.js";
import { DAEMON_BIN, DAEMON_TARGETS, daemonBinaryIn, daemonTargetFor, guestDaemonTarget, guestSystem, noGuestDaemonLine, noPlaceSystemLine, type DaemonTarget } from "./daemon-binary.js";
import { runningWsp, type RunningWsp } from "./mcp-install.js";
import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { CliIO } from "./cli.js";
import { servingHost } from "./host-lock.js";
import { aimName, aimedHost, type HostAim, type HostPick } from "./hosts.js";
import { joinStanding, placeFilePath, placeKeyPath, placeLogPath, placeLogin, placeReport, placeService, readPlaceFile, sweepPlace, sweptLine, sweptSaid, writeExclusive, writePlaceFile, wspArgvOf } from "./place-report.js";
import { PROVIDER_ENV, addedProviders, providerBackendFor, type ProviderEnv } from "./providers.js";
import { placeLink, relaySignIn, type BoxSignIn, type BoxSignedIn, type PlaceLink } from "./place-signin.js";
import { publicHostname } from "./relay-link.js";
import { systemOpener } from "./relay.js";
import type { RelayTerminal } from "./signin-relay.js";
import { advertiseWord, pairOnLoopbackLine, reachAddresses } from "./pairing.js";
import {
  installService,
  runFailureLine,
  serviceEnv,
  serviceManagerFor,
  systemRunner,
  type ServiceAddress,
  type ServiceManager,
  type ServiceRunner,
} from "./service.js";
import { dialHost, hostPlatform, sshAsked, table, type DialOpts, type HostClient } from "./verbs.js";
import type { HostStarter } from "./host-start.js";
import { envFileFor, writeEnvFile } from "./env-keys.js";
import { collect, nodeHost } from "@wsp/collect";
import { readBrewTable } from "./init-brew.js";
import { placeProvisioner } from "./place-provision.js";

/** What this computer is called when the person named no name: its own name lowercased, which is what they would
 * type for it on a command line. The one reading, so the row for this computer and the name a join writes agree. */
export const placeNameHere = (): string => hostname().toLowerCase();

/** What this computer calls itself to a computer that joins it: its own name without the .local a Mac's mDNS name
 * carries, which is the word a person reads on the joined computer from then on. */
export const hostNameHere = (): string => hostname().replace(/\.local$/i, "");

/** Where the host keeps its own ed25519 pair: beside the state file it serves, at the person's own mode, so a
 * second state file on one computer is a second wsp with a key of its own. */
export const hostPlaceKeyPath = (statePath: string): string => join(dirname(statePath), "place-host-key.json");

const isKeyPair = (v: unknown): v is PlaceKeyPair => {
  const k = v as PlaceKeyPair | undefined;
  return typeof k === "object" && k !== null && typeof k.publicKey === "string" && typeof k.privateKeyPem === "string";
};

/** The host's pair, made on the first read and kept. It is the key every place on this host pinned at its join, so
 * losing it means every one of them has to be removed and joined again: it is written once and never rotated here. */
export function hostPlaceKey(statePath: string): PlaceKeyPair {
  const path = hostPlaceKeyPath(statePath);
  if (existsSync(path)) {
    try {
      const held: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isKeyPair(held)) return held;
    } catch {
      // A file that is there and is not a pair is not one this host wrote; a fresh pair goes over it, and every
      // place that pinned the old one refuses the link and says to join again.
    }
  }
  const made = newPlaceKeyPair();
  writeOwn(dirname(path), basename(path), `${JSON.stringify(made, null, 2)}\n`);
  return made;
}

/** The fingerprint of the key the host on this computer proves at a join, read off the pair it signs with. The
 * join line carries it so the computer being joined can tell that host from anything else that answers at the
 * address it dials. */
export const hostKeyHere = (statePath: string): string => keyFingerprint(hostPlaceKey(statePath).publicKey);

/** What a host wires for its places: its own pair and this computer's own row. The provider row is the runtime's,
 * read off the provider pick a saved key moves. */
export function placeWiring(statePath: string, advertise?: string): PlaceWiring {
  const hostKey = hostPlaceKey(statePath);
  // One holder for the installer and the records: the forward an add stood is the one the record keeps.
  const back = placeBackHolder({ hostKey: keyFingerprint(hostKey.publicKey) });
  return {
    hostKey,
    back,
    // The recipe beside that state file, put on every computer this host holds: the same two readers a copy of
    // the image is planned from, since a box is provisioned from the same rows by the same roads.
    provision: placeProvisioner({
      statePath,
      home: homedir(),
      platform: hostPlatform(),
      collect: () => collect(nodeHost()),
      brew: () => readBrewTable(nodeHost()),
    }),
    // The word the person gave --advertise travels to the install, which is the one road that knows the computer
    // being joined is somewhere else and so whether that word could ever be dialled from it.
    install: placeInstaller({ back, ...(advertise === undefined ? {} : { advertise }) }),
    dial: placeDialler(),
    log: placeLogReader(),
    update: placeUpdater(),
    leave: placeLeaver(),
    hostName: hostNameHere,
    // This computer under the name a person would type for it, and what it is off the same read a place sends about
    // itself, so the row for the computer the host runs on carries the facts every other row carries.
    here: () => placeHere(),
  };
}

/** What this computer is, as a row of the list of everywhere work can run: read off the same report a place sends
 * about itself. The one reading, so the row a host keeps for the computer it runs on and the facts a computer is
 * shown right after it joined somebody else's wsp cannot describe the same computer differently. */
/** The name the person gave this Mac in System Settings, read once; elsewhere a computer keeps none worth drawing. */
let labelHere: string | undefined | null = null;
export function placeLabelHere(): string | undefined {
  if (labelHere !== null) return labelHere;
  labelHere = undefined;
  if (platform() !== "darwin") return labelHere;
  try {
    const said = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
    if (said !== "") labelHere = said;
  } catch {
    labelHere = undefined;
  }
  return labelHere;
}

export function placeHere(name: string = placeNameHere()): HerePlace {
  const report = placeReport({ name });
  const label = placeLabelHere();
  return { name: report.name, ...(label !== undefined ? { label } : {}), os: report.os, shape: report.shape, engine: report.engine, ...(report.diskFreeBytes !== undefined ? { diskFreeBytes: report.diskFreeBytes } : {}) };
}

/** How long a join gets to open the socket and finish the handshake. A person is watching, and a host that is not
 * there is a typo in the address as often as it is a network. */
const JOIN_MS = 20_000;

/** What a join says of a host that never answered. The app shows it behind the install's failed step and a person
 * running wsp join on the box reads it as it is, so it asks for another try rather than another add. */
export const joinUnansweredLine = (url: string): string =>
  `the host at ${url} did not answer in ${JOIN_MS / 1000} s; put both computers on one network, or link that host to your relay, and try again`;

/** The whole of what wsp add prints with no argument: the line to type on the computer being joined, at every
 * address this host answers on, and the other two roads in one line each. The token is the code and the host key's
 * fingerprint as one word, off the protocol's own writing of the line, so the terminal and the sheet print one
 * thing. */
export function addLines(token: string, expiresAt: number, now: number, urls: readonly string[], publicAt: string | undefined): string[] {
  return [
    "wsp add: a computer you own joins by dialing this host. On that computer, with wsp installed:",
    ...joinRoads(token, urls, publicAt === undefined ? undefined : relayUrlOf(publicAt)).map(road => `  ${road.line}${road.note === undefined ? "" : `      (${road.note})`}`),
    `The code is spent by the first join and stops working in ${fmtDuration(Math.max(0, expiresAt - now))}. The computer shows in wsp places within a minute of joining.`,
    "Over ssh instead: wsp add user@host --name <name> installs the agent there and joins it for you, and an alias from your ssh config works in place of user@host.",
    `A provider instead: ${addableProviders().map(id => `wsp add ${id}`).join(", ")}.`,
  ];
}

/** The provider ids wsp add takes, off the one table of them: every row that names how it is added. A provider
 * added tomorrow is on this line without anyone editing it. */
export function addableProviders(): string[] {
  return addedProviders().map(m => m.id);
}

/** What a provider that just became a place reads as. */
export const providerPlaceLine = (id: string, rateUsdPerHour: number): string => `place ${id} · ${fmtPrice(rateUsdPerHour)} · forks your image`;

/** The refusal for a word that is neither a provider wsp holds a key for nor an ssh address, naming all three roads. */
export function addRefusal(word: string): string {
  return `wsp add ${word}: that is neither a provider this wsp can be set up for (${addableProviders().join(", ")}) nor an address over ssh (user@host, or an alias your ssh config gives a HostName), and wsp add with no argument prints the line to type on a computer you are sitting at.`;
}

/** The one line `--name`, `--ssh-port` and `--ssh-key` get when no address was typed beside them. All three belong
 * to the road that installs the agent on a computer over ssh; the printed join line is typed on that computer,
 * where `wsp join --name` is what names it. */
export const ADD_FLAGS_REFUSAL =
  "wsp add: --name, --ssh-port and --ssh-key belong to wsp add user@host or wsp add <ssh alias>, which installs the agent on a computer over ssh. On the computer you are sitting at, wsp join <address> --code <code> --name <name> names it.";

/** The refusal an install gets when nothing but this computer's own loopback could be dialled back: the box would
 * have no address to reach this host at, so the agent would be installed and never link. */
export const ADD_LOOPBACK_REFUSAL =
  "wsp add: this host answers on its own loopback alone, which a computer somewhere else cannot dial. Start it with --listen 0.0.0.0, or link it to your relay, and run this again.";

/** The refusal for a box that would not say what chip it runs on: everything wsp puts there is built for one, and
 * guessing it is how a binary for the wrong chip gets installed and dies on its first start. */
export const UNSAID_CHIP_REFUSAL =
  "wsp add: that computer did not say what chip it runs on over ssh, and the daemon wsp would install there is built for one; check that uname -m answers on it and run this again.";

/** The binary a box takes, off what it said over ssh, or the one refusal naming which of the two it cannot be: its
 * system is read first, so a Mac's own chip words never reach the chip sentence. `joined` is the update's road. */
function guestTargetSaid(system: string | undefined, arch: string | undefined, joined = false): DaemonTarget {
  if (system !== undefined && !guestSystem(system)) throw new Error(noPlaceSystemLine(system, "that computer", joined));
  const target = arch === undefined ? undefined : guestDaemonTarget(system, arch);
  if (target === undefined) throw new Error(arch === undefined ? UNSAID_CHIP_REFUSAL : noGuestDaemonLine(arch));
  return target;
}

/** The refusal for an install on another computer while this host advertises an address on its own loopback. The
 * word is the person's, so it is read back to them rather than left out: an install that quietly falls through to
 * an address they did not name is an install reaching somewhere they did not choose, which is how a join ends in
 * twenty seconds of silence at a card nobody meant. */
export const advertisedLoopbackRefusal = (url: string): string =>
  `wsp add: this host is advertising ${url}, which is this computer's own loopback: the computer being joined would dial itself there and reach nothing of this wsp. Start this host with --advertise naming an address that computer can reach, or drop the flag and let it dial what this computer answers on.`;

/** What the install says about where the box will dial back, in the order its link will try them, the forward on
 * its own loopback said as the road it is rather than as an address of this computer's. */
export function dialsBackLine(hostUrls: readonly string[], back?: { boxPort: number; name: string }): string {
  if (back === undefined) return `it dials this computer at ${hostUrls.join(", ")}`;
  const at = hostUrls.filter(url => url !== backUrl(back.boxPort));
  const word = dialsBackWord(back.boxPort, back.name);
  return at.length === 0 ? `it ${word}` : `it dials this computer at ${at.join(", ")}, then ${word}`;
}

/** What a remove says about the device a join bought for that computer's own window. One code bought the place and
 * the device, and a remove takes the place alone: the token is still good until somebody hands it back, from the
 * joined computer's own leave or from here. */
export const deviceLeftLine = (name: string, deviceIds: readonly string[]): string => {
  // One command per id: wsp host devices revoke takes exactly one, so a line joining them would be a line that refuses.
  const revoke = deviceIds.map(id => `wsp host devices revoke ${id}`).join(", ");
  const one = deviceIds.length === 1;
  return `${name} still holds ${one ? "a token" : `${deviceIds.length} tokens`} for this wsp, which its own window signs in with; ${revoke} take${one ? "s it" : " them"} back.`;
};

/** What a remove prints: what came off that computer, the note for a place that was not connected to sweep, and
 * the device a join bought for it where one is still on record. */
export function removeLines(name: string, answer: { swept: readonly string[]; note?: string }, deviceIds: readonly string[] = []): string[] {
  return [
    ...(answer.swept.length === 0 ? [] : [`removed from ${name}:`, ...answer.swept.map(line => sweptLine(line))]),
    ...(answer.note === undefined ? [] : [answer.note]),
    ...(deviceIds.length === 0 ? [] : [deviceLeftLine(name, deviceIds)]),
    `${name} is no longer a place in this wsp.`,
  ];
}

/** The refusal for a name two places share, the protocol's own: the road at the terminal and the road a create
 * takes read one sentence, since a person who picked an id off one of them types it into the other. */
export const twoPlacesLine = twoPlacesRefusal;

/** The refusal for a word no place answers to. */
export const noPlaceLine = (typed: string, names: readonly string[]): string =>
  `${typed}: this host holds no place by that name or id.${names.length === 0 ? " wsp add prints the join line." : ` It holds ${names.join(", ")}.`}`;

/** The one place a word names among the computers joined to this host, or the refusal the line that typed it
 * prints. Every word that names a place reads it, so none of them invents a second reading or a second refusal.
 * The computers it picked from come back with it, so a caller that has to name them later reads no second listing. */
async function onePlace(client: HostClient, typed: string, ref: string): Promise<{ place: PlaceView; joined: PlaceView[] } | { refusal: string }> {
  const { places } = await client.request<{ places: PlaceView[] }>("places.list");
  const joined = places.filter(p => p.kind === "computer" && p.joinedAt !== undefined);
  const found = joined.filter(p => p.id === ref || p.name === ref);
  if (found.length === 0) return { refusal: noPlaceLine(typed, joined.map(p => p.name)) };
  if (found.length > 1) return { refusal: twoPlacesLine(typed, found.map(p => p.id)) };
  return { place: found[0]!, joined };
}

/** The refusal a join gets on a computer whose manager wsp writes no unit for: nothing there would keep the daemon
 * up, so nothing is written. */
export const noPlaceManagerLine = (platform: string): string => `wsp writes no service on ${platform}, so this computer cannot stay joined as a place`;

/** The refusal wsp leave gets on the same computer. */
export const NOTHING_TO_LEAVE_LINE = "this computer is not a place in any wsp, so there is nothing to leave";

/** What is left of a join that did not finish, or a place file that does not parse, is broken rather than joined: a
 * join refuses it and a leave takes it. */
export const brokenJoinLine = (path: string): string => `${path} is left from a wsp join that did not finish or cannot be read; run ${PLACE_LEAVE_LINE} to remove it, then join again`;

/** What a leave says first when what it took was broken, since there is no wsp to name. */
export const brokenPlaceLeftLine = (path: string): string => `${path} was left from a wsp join that did not finish or cannot be read; removed:`;

/** A join a leave cut off between its key and its place file: the leave took the key, so the join takes back its file. */
export const joinCutByLeaveLine = `${PLACE_LEAVE_LINE} ran on this computer while it was joining, so nothing of the join is left; run wsp join again`;

/** Why a join stops at what stands here, or nothing where nothing does. */
function joinRefusal(home: string): string | undefined {
  const standing = joinStanding(home);
  return standing === undefined ? undefined : "joined" in standing ? ALREADY_JOINED_LINE : brokenJoinLine(standing.broken);
}

/** Whether the key at that path is still the one this join wrote. */
function keyIs(key: string, pem: string): boolean {
  try {
    return readFileSync(key, "utf8") === pem;
  } catch {
    return false;
  }
}

/** What a person may name beside the address on wsp add: the name the computer is known by here, and the port and
 * key their own ssh would have been told. */
/** The refusal for --sign-in beside a flag about joining a computer: the computer is already in, so none of them
 * has anything to say about it. */
export const SIGN_IN_FLAGS_REFUSAL =
  "wsp add --sign-in names a computer already in this wsp, so it takes none of the flags a join takes. Drop them, or drop --sign-in to join a computer.";

/** The agents with a sign-in to run on a computer, off the catalog's rows: a token or key this host keeps is none. */
export const signsInOnComputer = (): string[] => CATALOG_AGENTS.filter(a => hasLogin(a.signIn)).map(a => a.id);

/** The refusal for an agent with no sign-in to run on a computer. The list is the catalog's own. */
export const signInAgentRefusal = (agent: string): string => `wsp add --sign-in takes an agent with a sign-in to run on a computer, which ${agent} is not: ${signsInOnComputer().join(", ")}.`;

/** A computer that has not told this host where it keeps the logins its workspaces share. It says so on every
 * link, so the two causes left are a computer that is not connected and one whose agent is older than the one
 * this host deploys, which shared no login at all; the second names its own way out. */
export const placeNoLoginsLine = (name: string): string =>
  `${name} has not said where it keeps the logins its workspaces share, so there is nowhere to sign one in: it is not connected, or the agent on it is older than the one this host deploys. wsp add ${name} --update puts this one on it.`;

/** The question the join puts while the person is still at this terminal. */
export const boxSignInAsk = (name: string, agent: string): string =>
  `Sign ${agentName(agent)} in on ${name} now? The login stays on that computer, outside every workspace, and each of them shares it.`;

export const boxSignedInLine = (name: string, agent: string, detail?: string): string =>
  `${agentName(agent)} is signed in on ${name}${detail === undefined ? "" : ` (${detail})`}${sharedOn(agent) === undefined ? "." : "; every workspace there shares that login."}`;

export const boxNotSignedInLine = (name: string, agent: string, said?: string): string =>
  `${agentName(agent)} is not signed in on ${name}${said === undefined ? "" : `: ${said}`}. wsp add ${name} --sign-in ${agent} runs it again.`;

/** What a person is told when they say not now, or when nobody is at this keyboard: what threads there read in the
 * meantime, which is the key the vault holds on this computer, and the line that signs it in later. */
export const boxSignInLaterLine = (name: string, agent: string): string => {
  const key = keyEnvOf(loginSignIn(agent) ?? NO_SIGN_IN);
  const until = key === undefined ? "" : ` Threads there read ${key} from this computer's vault until it is.`;
  return `${agentName(agent)} is not signed in on ${name}.${until} wsp add ${name} --sign-in ${agent} signs it in.`;
};

export interface AddFlags {
  name?: string;
  sshPort?: number;
  keyPath?: string;
  /** The host key of a computer this computer has never dialled, as the person read it off that computer. Without
   * it the add asks about the key the computer answers a scan with, and refuses off a terminal. */
  hostKey?: string;
  /** The one word for a computer already in this wsp: put the daemon this host deploys on it. Every other flag on
   * this verb is about a computer that is not in yet, so it goes beside none of them. */
  update?: boolean;
  /** Which computer a project lives on, by the name or the id the computers table carries; a folder here needs
   * none, and a repo's url is refused without one. */
  on?: string;
  /** The branch a workspace of the project starts on; absent takes the remote's own default at the clone. */
  base?: string;
  /** The agent to sign in on a computer already in this wsp, once, outside every workspace on it. The join offers
   * this itself while the person is at the terminal; this is the same road for a computer that is already in. */
  signIn?: string;
  /** A folder seeding a project on a computer that clones: what the person answered about what travels. Without
   * `yes` the line prints the menu and sends nothing, since what git ignores in their folder is theirs. */
  yes?: boolean;
  keep?: readonly string[];
  cut?: readonly string[];
  noMemory?: boolean;
  noCommits?: boolean;
  remember?: boolean;
}

/** The words a person gave beside the address, read by the one rule every ssh road on this command line reads
 * them by: a port that is a number and a key that is a path on this computer. */
export function addFlags(
  name?: string,
  port?: string,
  keyPath?: string,
  update?: boolean,
  on?: string,
  base?: string,
  signIn?: string,
  seed: { yes?: boolean; keep?: string[]; cut?: string[]; noMemory?: boolean; noCommits?: boolean; remember?: boolean } = {},
  hostKey?: string,
): AddFlags {
  const asked = sshAsked(name, port, keyPath);
  const pinned = hostKey?.trim();
  return {
    ...(pinned !== undefined && pinned !== "" ? { hostKey: pinned } : {}),
    ...(seed.yes === true ? { yes: true } : {}),
    ...(seed.keep !== undefined ? { keep: seed.keep } : {}),
    ...(seed.cut !== undefined ? { cut: seed.cut } : {}),
    ...(seed.noMemory === true ? { noMemory: true } : {}),
    ...(seed.noCommits === true ? { noCommits: true } : {}),
    ...(seed.remember === true ? { remember: true } : {}),
    ...(asked.name !== undefined ? { name: asked.name } : {}),
    ...(asked.port !== undefined ? { sshPort: asked.port } : {}),
    ...(asked.keyPath !== undefined ? { keyPath: asked.keyPath } : {}),
    ...(update === true ? { update: true } : {}),
    ...(on !== undefined ? { on } : {}),
    ...(base !== undefined ? { base } : {}),
    ...(signIn !== undefined ? { signIn } : {}),
  };
}

/** What an add is refused with on a box that already belongs to a wsp: this one, where a second install would be
 * a second record of one box, or another, whose agent and link a second join would stand beside. */
export function placeHeldRefusal(address: string, file: PlaceFile, ownKey: string | undefined): string {
  const name = boxWord(file.name);
  if (ownKey !== undefined && keyFingerprint(file.hostPublicKey) === ownKey) return `${address} is already a place in this wsp as ${name}`.slice(0, SSH_LINE_CAP);
  const url = file.hostUrls[0];
  const at = isHttpUrl(url) ? ` at ${boxWord(url)}` : "";
  return `${address} already belongs to the wsp on ${boxWord(file.hostName)}${at}; ${PLACE_LEAVE_LINE} on it frees it, or wsp add ${name} --update from that wsp updates it there`.slice(0, SSH_LINE_CAP);
}

/** The word the box prints before each address it was asked to try, with ok or no. */
const REACH_LINE = "WSP_REACH";

/** How long the box gets to try every address at once: each try gives up after three seconds of connecting. */
const REACH_MS = 20_000;

/** The check the box runs before anything of wsp's lands on it: one try of each address its join would be handed,
 * all at once, with curl where the box has it and bash's /dev/tcp under timeout where it does not. A box with
 * neither reads as reaching nothing. */
export function reachScript(urls: readonly string[]): string {
  const q = shellQuote;
  const tries = urls.map(url => {
    const u = new URL(url);
    return `reach ${q(url)} ${q(u.hostname.replace(/^\[|\]$/g, ""))} ${u.port === "" ? (u.protocol === "https:" ? "443" : "80") : u.port} &`;
  });
  return [
    "reach() {",
    "  if command -v curl >/dev/null 2>&1; then curl -s -o /dev/null --noproxy '*' --connect-timeout 3 --max-time 5 \"$1\"",
    "  elif command -v timeout >/dev/null 2>&1; then timeout 3 bash -c 'exec 3<>\"/dev/tcp/$0/$1\"' \"$2\" \"$3\" 2>/dev/null",
    `  else false; fi && echo "${REACH_LINE} ok $1" || echo "${REACH_LINE} no $1"`,
    "}",
    ...tries,
    "wait",
  ].join("\n");
}

/** The addresses the box said it reached, in the order they were handed to it. */
export function reachedUrls(said: string, urls: readonly string[]): string[] {
  const ok = new Set(said.split("\n").flatMap(line => /^WSP_REACH ok (\S+)$/.exec(line.trim())?.[1] ?? []));
  return urls.filter(url => ok.has(url));
}

/** A sentence naming a list of addresses: as many as fit the line and a count of the rest, so a host on many cards
 * still keeps what comes after the list. */
function fittedList(urls: readonly string[], line: (list: string) => string): string {
  for (let n = urls.length; n > 1; n--) {
    const said = line(n === urls.length ? urls.join(", ") : `${urls.slice(0, n).join(", ")} and ${urls.length - n} more`);
    if (said.length <= SSH_LINE_CAP) return said;
  }
  return line(urls.length > 1 ? `${urls[0]} and ${urls.length - 1} more` : (urls[0] ?? "")).slice(0, SSH_LINE_CAP);
}

/** What an add says when the box tried every address this host answers on and reached none, on a host that has no
 * forward over ssh to offer it. */
export const unreachedLine = (address: string, urls: readonly string[]): string =>
  fittedList(urls, list => `${address} cannot reach this computer at ${list}, so nothing of wsp's went onto it; link this host to your relay, or start it with --advertise naming an address ${address} can reach`);

/** What an add says when the box reached none of this host's addresses and the forward over ssh did not stand
 * either: sshd refused it, or put it beyond the box's loopback, in ssh's or wsp's own words. */
export function backRefusedLine(address: string, urls: readonly string[], why: string): string {
  const line = (list: string, said: string): string =>
    `${address.slice(0, 64)} cannot reach this computer at ${list} and the forward back over ssh did not stand (${said}); link this host to your relay, or start it with --advertise naming an address it can reach`;
  // ssh's line gives way before the fix does: it gets what one address and a count leave of the line.
  const room = SSH_LINE_CAP - line(urls.length > 1 ? `${urls[0]} and ${urls.length - 1} more` : (urls[0] ?? ""), "").length;
  const said = boxWord(why, Math.max(0, Math.min(100, room)));
  return fittedList(urls, list => line(list, said));
}

/** The reach step's note for a box that dials back over the forward: after the relay where it reached that. */
export const dialsBackOverSshNote = (urls: readonly string[], relay: string | undefined): string =>
  relay !== undefined ? `${relay}, and ${BACK_OVER_SSH}` : fittedList(urls, list => `cannot reach this computer at ${list}, so it dials ${BACK_OVER_SSH}`);

/** How long taking a failed add back off a box may run, as long as the ssh road's own removal. */
const UNDO_MS = 120_000;

/** What an add says of a box whose login has / for its home: every file wsp keeps there sits under that home, and
 * the undo of a failed add takes back folders up to it. */
export const placeRootHomeRefusal = (address: string): string => `${address.slice(0, 64)} answered with / for its login's home folder; wsp keeps its files in a home folder of their own, so give that login one and add the box again`;

/** A failed add's sentence where another add took the box between the read and the undo, which then took nothing. */
export const addTakenLine = (said: string): string => {
  const tail = "another add took the box meanwhile, so nothing was taken back off it";
  return `${cappedLine(said, SSH_LINE_CAP - tail.length - 2)}; ${tail}`;
};

/** A failed add's sentence with what taking it back off the box came to, the box's line cut first so the end stands. */
export function addUndoneLine(said: string, undone: boolean, agentWasRunning = false): string {
  const kept = agentWasRunning ? "wsp's agent was running there before this add and is left running, and " : "";
  const other = agentWasRunning ? " else" : "";
  const tail = `${kept}${undone ? `nothing${other} this add put on it is left there` : `what${other} this add put on it may still be there`}`;
  return `${cappedLine(said, SSH_LINE_CAP - tail.length - 2)}; ${tail}`;
}

/** What an add says when the box did not run the check at all. */
export const reachUnsaidLine = (address: string, said: string): string => `${address} did not run the check for whether it can reach this computer: ${said.slice(-SSH_LINE_CAP)}`;

/** How a typed word becomes a dial: the engine's one reading unless a test hands its own. */
type SshWordReader = (word: string, opts: { port?: number; keyPath?: string }) => Promise<SshReach>;

/** How the daemon is put on a computer over ssh, for the host that wires the runtime: the ssh road the workspace
 * kind already had, reused as one function. The dial and the login read are one call (`adopt`), the bundle and
 * the join code go over the same connection, and the join itself is run on that computer by the deploy, so wsp
 * never writes a unit of its own there. The steps are marked off the lines that deploy prints: WSP_READY once the
 * bundle is on the computer, PLACE_JOINED once its own join has written the place file and the unit.
 *
 * Nothing waits here for the link: the computer dials this host on its own, and the place door is what knows when
 * it has. */
export function placeInstaller(deps: { backend?: SshBackend; sshWord?: SshWordReader; daemonDir?: string; cliDir?: string; advertise?: string; back?: PlaceBackHolder } = {}): PlaceInstaller {
  return async (req, stage) => {
    // A word naming no login is the one refusal before the dial where the user and the address are the fix.
    const reach = await (deps.sshWord ?? sshWordReach)(req.address, {
      ...(req.sshPort !== undefined ? { port: req.sshPort } : {}),
      ...(req.keyPath !== undefined ? { keyPath: req.keyPath } : {}),
    }).catch((e: unknown) => {
      throw new PlaceLoginRefusedError(e instanceof Error ? e.message : String(e));
    });
    const backend = deps.backend ?? new SshBackend();
    // A computer somewhere else cannot dial this computer's own loopback, so an install that would leave the agent
    // there with no address to come back on is refused before anything lands on it. The computer being joined is
    // sometimes this one under another name, and there loopback is the address that works. Read off the address
    // the client dials, since an alias names nothing about where it lands, and a dial through a jump is never here.
    const dials = await backend.hostNameFor(reach).catch(() => reach.host);
    const here = dials !== undefined && sshDialsThisComputer({ ...reach, host: dials }, [hostname()]);
    // Read off the word itself and not off what is left after the filter: a host bound to this computer alone
    // behind a relay also carries a loopback address in that list, and nobody typed that one.
    const named = joinAddressOf(advertiseWord(deps.advertise) ?? "");
    if (!here && named !== undefined && isLoopback(new URL(named).hostname)) throw new Error(advertisedLoopbackRefusal(named));
    const hostUrls = here ? req.hostUrls : req.hostUrls.filter(at => !isLoopback(new URL(at).hostname));
    if (hostUrls.length === 0) throw new Error(ADD_LOOPBACK_REFUSAL);
    stage("connect", "running");
    // A computer this computer's ssh client has never met is dialled only once somebody has seen its key: the dial
    // writes whatever answers into this computer's known_hosts and every later dial of that computer trusts it, so
    // a stranger who controls the route or the name during this one would be recorded as the person's own box. The
    // key rides the request where the person confirmed or pinned it; where it does not and the client holds none of
    // its own, the refusal carries the key the computer answers a scan with and the line that pins it. Read before
    // anything is dialled, so the app's sheet and an older client meet the same wall the command line does.
    if (req.hostKey === undefined && (await backend.keyFor(reach).catch(() => undefined)) === undefined) {
      const offered = await backend.offeredKeyFor(reach).catch((): { key?: string; stoppedBy?: string } => ({}));
      throw new Error(offered.key === undefined ? hostKeyUnscannableRefusal(req.address, offered.stoppedBy) : hostKeyUnconfirmedRefusal(req.address, offered.key));
    }
    // The dial writes the box's key into this computer's own known_hosts on its way in, whether or not the login
    // that follows it stands, so the step is ticked off what the client holds afterwards and not off the login's
    // outcome: this is the one thing the add does to the computer the person is sitting at, and since the refusal
    // no longer carries ssh's own note about it, a failed login has nothing else that would say so. The file is
    // the client's own answer rather than the default the plan line names, so a config that points it elsewhere is
    // read out. A dial that never got far enough to exchange a key leaves the step where it was: nothing was written.
    const sayKey = async (key: string | undefined): Promise<void> => {
      if (key === undefined) return;
      const entry = await backend.knownHostsEntry(reach).catch((): { file?: string; target?: string } => ({}));
      stage("host-key", "done", hostKeyKeptNote(key, entry.file));
    };
    // Every refusal from the dial on says the key it wrote here; only a login that did not stand is the login's own.
    const stood = async () => {
      const adopted = await backend.adopt(reach).catch((e: unknown) => {
        throw new PlaceLoginRefusedError(e instanceof Error ? e.message : String(e));
      });
      const { machine, login, system, arch, shell, hostKey } = adopted;
      // What answered is held against what the person pinned before anything else is asked of it. The read that has
      // already run sent nothing of the person's beyond the ssh identity every dial offers and printed the machine's
      // own facts; accept-new wrote its key here on the way in, so the refusal names that key, the file it went into
      // and the line that takes it out again. Nothing of wsp's has left this computer yet.
      if (req.hostKey !== undefined && !hostKeyMatches(req.hostKey, hostKey ?? "")) {
        // The file and the name the entry was written under come off the client's own one reading of the dial, never
        // off the word that was typed: a config naming a HostName or a HostKeyAlias writes the entry somewhere else,
        // and a line built here from the address would tell the person to remove an entry that is not there.
        const entry = await backend.knownHostsEntry(reach).catch((): { file?: string; target?: string } => ({}));
        throw new Error(
          hostKeyMismatchRefusal({
            address: req.address,
            pinned: req.hostKey,
            ...(hostKey !== undefined ? { wrote: hostKey } : {}),
            target: entry.target ?? reach.host,
            file: entry.file ?? KNOWN_HOSTS,
          }),
        );
      }
      // Which shell root runs, read off the box's own passwd entry with nothing of root's run to read it. sshd hands
      // every command the host sends to that shell with -c before wsp's own bash -c inside it, so a root running zsh
      // or fish reads a file under the /root every workspace on that box writes, as root, on every dial wsp makes.
      // The read that has just run already went through it once; what this stops is the deploy and every dial after.
      // A box that named no shell at all is one this rule says nothing about, and is taken as it always was.
      if (shell !== undefined && !PLACE_ROOT_SHELLS.includes(shell)) throw new Error(placeRootShellRefusal(req.address, shell));
      if (login.HOME === "/") throw new Error(placeRootHomeRefusal(req.address));
      // The binary that lands is picked off the word the box just said about its own chip, never off this computer's:
      // the two are different computers as often as they are alike, and a binary for the wrong one starts and dies.
      // Read before anything is sent, so a chip wsp builds no daemon for leaves the box exactly as it was found.
      const target = guestTargetSaid(system, arch);
      // The join on the box refuses a computer that already holds a place file, and only after the bundle landed; read
      // by the same rule here so a box in another wsp is refused with nothing of this one's sent.
      const held = parsePlaceFile((await machine.run(heldPlaceScript(login.HOME), { deadlineMs: SSH_DIAL_MS })).stdout);
      if (held !== undefined) throw new Error(placeHeldRefusal(req.address, held, readJoinToken(req.code).hostKey));
      return { machine, login, hostKey, target };
    };
    const { machine, login, hostKey, target } = await stood().catch(async (e: unknown) => {
      await sayKey(await backend.keyFor(reach).catch(() => undefined));
      throw e;
    });
    const name = req.name?.trim() !== undefined && req.name.trim() !== "" ? req.name.trim() : sshMachineName(reach);
    stage("connect", "done", await osSaid(machine));
    await sayKey(hostKey);
    stage("reach", "running");
    const probed = await machine.run(reachScript(hostUrls), { deadlineMs: REACH_MS });
    if (!probed.stdout.includes(REACH_LINE)) throw new Error(reachUnsaidLine(req.address, clientWords(probed.stderr) || `exit ${probed.exitCode}`));
    const reached = reachedUrls(probed.stdout, hostUrls);
    const road = { ssh: sshLoginWord(reach), ...(reach.keyPath !== undefined ? { keyPath: reach.keyPath } : {}) };
    // No address of the door answered, so the box dials back through a forward on its own loopback, after the relay
    // where it reached that. A host bound beyond loopback names no door port and gets none: a forward into its main
    // port would land as the owner's own road.
    let back: PlaceBack | undefined;
    if (req.doorPort !== undefined && deps.back !== undefined && reached.every(url => url === req.relay)) {
      const held = await deps.back.hold(road, { boxPort: req.doorPort }, { home: login.HOME }).catch((e: unknown) => {
        deps.back!.release(road);
        return e instanceof Error ? e : new Error(String(e));
      });
      if (held instanceof Error) {
        // A refusal that names its own fix is said whole; ssh's own line goes inside the sentence that names ours.
        if (reached.length === 0) throw new Error(held instanceof BackCutError || held instanceof MissingKnownHostsError ? held.message : backRefusedLine(req.address, hostUrls, held.message));
        stage("reach", "done", `${reached.join(", ")}; the forward back over ssh did not stand: ${held.message}`.slice(0, SSH_LINE_CAP));
      } else {
        back = held;
        stage("reach", "done", dialsBackOverSshNote(hostUrls.filter(url => url !== req.relay), reached[0]));
      }
    } else if (reached.length === 0) {
      throw new Error(unreachedLine(req.address, hostUrls));
    } else {
      stage("reach", "done", reached.join(", "));
    }
    const joinUrls = back === undefined ? reached : [...reached, backUrl(back.boxPort)];
    const at = placeDaemonPaths(login.HOME);
    const place = joinedPlace({ home: login.HOME, path: login.PATH }, { hostUrls: joinUrls, codeFile: `${at.wsp}/join-code`, name });
    stage("wsp", "running", target.uname);
    // What the box already holds of the add's list, read before anything lands: a failed add takes back only what
    // it wrote, and a box that would not say keeps everything.
    const unit = placeUnit(login.HOME);
    const writes = joinedAddWrites(place, unit.path);
    const found = addFound((await machine.run(addFoundScript(place, writes, unit.systemctl.join(" ")), { deadlineMs: SSH_DIAL_MS }).catch(() => undefined))?.stdout ?? "", writes.length);
    await deployDaemon(machine, {
      place,
      target,
      // The code goes over the byte road and never into a command: what sits in a command line sits in a world
      // readable /proc/<pid>/cmdline for as long as it runs, and this one buys a place in somebody's wsp.
      land: [{ path: place.join!.codeFile, bytes: new TextEncoder().encode(`${req.code}\n`) }],
      onLine: line => {
        if (line.includes(WSP_READY_LINE)) {
          stage("wsp", "done", target.uname);
          // The addresses the box is about to dial, said as its join starts rather than after the wait it ends in:
          // a wrong one is twenty seconds of silence followed by a sentence naming it, and this is the same fact
          // read while it can still be stopped.
          stage("service", "running", dialsBackLine(joinUrls, back === undefined ? undefined : { boxPort: back.boxPort, name }));
        } else if (line.includes(PLACE_JOINED_LINE)) {
          stage("service", "done");
        }
      },
      ...(deps.daemonDir !== undefined ? { daemonDir: deps.daemonDir } : {}),
      ...(deps.cliDir !== undefined ? { cliDir: deps.cliDir } : {}),
    }).catch(async (e: unknown) => {
      if (back !== undefined) deps.back?.release(road);
      // A box that refused at the preflight, or never answered it, was sent nothing. A join refused as already joined
      // stands beside another add that won the box between the read and the deploy, and what is there is that add's.
      if (machineLacksLine(e) !== undefined || machineNeverAnswered(e) || e instanceof PlaceAlreadyJoinedError) throw e;
      const said = e instanceof Error ? e.message : String(e);
      const answer =
        found === undefined
          ? undefined
          : await machine.run(addUndoScript(place, writes, found, unit.systemctl.join(" "), e instanceof PlaceJoinedThenFailedError), { deadlineMs: UNDO_MS }).catch(() => undefined);
      if (answer?.stdout.includes(ADD_TAKEN_LINE) === true) throw new Error(addTakenLine(said));
      const undone = answer !== undefined && answer.exitCode === 0 && answer.stdout.includes(DAEMON_GONE_LINE);
      const agentWasRunning = found !== undefined && writes.some((w, i) => w.as === "running" && found.has(i));
      const line = addUndoneLine(said, undone, agentWasRunning);
      throw undone ? new PlaceAddTakenBackError(line) : new Error(line);
    });
    return { name, ssh: road.ssh, ...(reach.keyPath !== undefined ? { sshKeyPath: reach.keyPath } : {}), ...(hostKey !== undefined ? { hostKey } : {}), ...(back !== undefined ? { back } : {}) };
  };
}

/** The unit the join on that computer installed and the words that reach the manager holding it, both read off the
 * one rule that writes them: the manager for a Linux box, asked about that box's own place service. A second
 * spelling of `wsp-place-<tag>` here would leave this road behind the day the unit scheme moves. The scope comes
 * from the same manager: a unit it says must be installed by root is the machine's, so it is driven without --user.
 * The uid decides nothing about either, and 0 is passed rather than this computer's, which is another computer's. */
export function placeUnit(home: string): { name: string; path: string; systemctl: readonly string[]; journalctl: readonly string[] } {
  const manager = serviceManagerFor("linux");
  if (manager === undefined) throw new Error(noPlaceManagerLine("linux"));
  const at = placeService(home, 0);
  const scoped = manager.needsRoot?.(at) === true ? [] : ["--user"];
  const unit = manager.unit(at);
  return { name: unit.name, path: unit.path, systemctl: ["systemctl", ...scoped], journalctl: ["journalctl", ...scoped] };
}

/** What a computer answers once the daemon the host sent is the one its unit runs, and what it says instead when
 * the unit did not come back up. Read off stdout, as every other deploy's lines are. */
export const PLACE_UPDATED_LINE = "PLACE_UPDATED";
export const PLACE_UPDATE_DOWN_LINE = "PLACE_UPDATE_DOWN";
/** What the box says when its own service manager holds no unit for this place: the update stops there rather than
 * writing a binary nothing would start. */
export const PLACE_NO_UNIT_LINE = "PLACE_NO_UNIT";
/** What it says when the binary it is replacing could not be kept, which is the one refusal both roads share: the
 * link road's install refuses there too, so a box is never left with the new daemon and no way back to the old. */
export const PLACE_NO_KEEP_LINE = "PLACE_NO_KEEP";

/** The update over the ssh road, run on the computer itself once the binary has landed beside its files. The path
 * the new binary is moved over is the one the unit itself names, read back out of systemd rather than worked out
 * here: the join wrote that unit with whatever path the wsp on that computer resolved, and a second reading of that
 * rule here would be a second copy of it. The old binary is kept beside the new one, as the coordinator kept it by
 * hand, and a keep that fails ends the update as it does on the link road. Nothing is swept: the workspaces'
 * records stay on the box and the daemon that comes up reads them again. */
export function placeUpdateScript(home: string, landed: string, unit = placeUnit(home)): string {
  const at = placeDaemonPaths(home);
  const q = shellQuote;
  const systemctl = unit.systemctl.join(" ");
  return [
    // systemd prints ExecStart as a record with the binary under path=; the first is the one it runs.
    `exe="$(${systemctl} show -p ExecStart --value ${q(unit.name)} 2>/dev/null | sed -n 's/.*path=\\([^ ;]*\\).*/\\1/p' | head -n 1)"`,
    `if [ -z "$exe" ]; then echo ${PLACE_NO_UNIT_LINE}; exit 1; fi`,
    `cp -f "$exe" "$exe.old" || { echo ${PLACE_NO_KEEP_LINE}; exit 1; }`,
    // A move, never a write into it: the file is running, and a kernel refuses a write to a mapped executable.
    `mv -f ${q(landed)} "$exe"`,
    'chmod 0755 "$exe"',
    // Before the restart, never after: a Type=simple restart returns the moment the process forks, so a daemon that
    // binds and writes its port quickly would have that file removed out from under it and the wait below would
    // read a daemon that is up as one that never came.
    `rm -f ${q(at.portFile)}`,
    `${systemctl} restart ${q(unit.name)}`,
    `for _ in $(seq 80); do [ -s ${q(at.portFile)} ] && break; sleep 0.25; done`,
    `if [ -s ${q(at.portFile)} ] && ${systemctl} is-active --quiet ${q(unit.name)}; then echo ${PLACE_UPDATED_LINE} "$exe"; else ${unit.journalctl.join(" ")} -u ${q(unit.name)} -n 50 --no-pager; echo ${PLACE_UPDATE_DOWN_LINE}; fi`,
  ].join("\n");
}

/** What the box said when wsp's own login files could not be written there: the update stops on it, since the
 * lines exit 0 by design and a failure is the link going or the login file being unreadable, and the person runs
 * the line again. */
export const placeLoginFilesFailedLine = (name: string, said: string): string => placeInstallFailedLine(name, "login", said);

/** The refusal an update gets on a computer this host is holding no link to and was never installed over ssh: a
 * computer joined by typing a code is reached over its link alone. */
export const placeNoUpdateRoadLine = (name: string): string =>
  `${name} is not connected and this wsp has no login for it, so there is no road to put a daemon on it; switch it on and run the line again`;

/** What the box said when its update did not come back up, for the one sentence a person reads. */
export const placeUpdateFailedLine = (name: string, said: string): string => `${name} took the daemon and its agent did not come back up: ${said}`;

/** How the daemon this host deploys is put on a computer that is already a place, for the host that wires the
 * runtime. Which binary is the computer's own word about its chip, never this computer's: the two are different
 * computers as often as they are alike, and a binary for the wrong one starts and dies.
 *
 * Two roads, one rule about which: the link the place is holding, which carries the bytes as frames and ends in the
 * agent restarting itself, and the ssh road the install used where there is no link. Neither carries the binary on
 * a command line.
 *
 * wsp's own login files on that computer are written first on whichever road this holds, and on every update
 * rather than only where a binary goes: their text is this host's and moves with it. Over the link they are one
 * exec on the daemon the box is running now, sent before the first frame of the swap, since the swap restarts
 * that daemon and drops the link; over ssh they are the lines ahead of the swap in the one script. A computer
 * whose report records no home is passed over, and the update's own answer says the recipe got none.
 */
export function placeUpdater(deps: { backend?: SshBackend; daemonDir?: string } = {}): PlaceUpdater {
  /** The binary this wsp holds for one target, refused by the file's own name where this command carries none. */
  const binaryFor = (target: DaemonTarget): Uint8Array => {
    const bin = daemonBinaryIn(deps.daemonDir ?? assetDir("daemon"), target.triple);
    if (!existsSync(bin)) throw new Error(`${assetName("daemon")} missing: ${bin}`);
    return new Uint8Array(readFileSync(bin));
  };
  /** wsp's login files as this host spells them, run on that computer: the one home of the text, read here and by
   * the deploy at the join. The place is built off the login given, so the two roads write the one home on a box
   * whose login has not moved, and the road that adopted afresh writes where it now is. */
  const loginFiles = (login: { home: string; path: string }): string => loginFilesStep(sshDaemonPlace(login)).join("\n");
  return async req => {
    const home = req.report.login["HOME"];
    if (req.link !== undefined) {
      // Every check before the first thing that writes: a chip this wsp has no daemon for, or a command carrying
      // no binary for it, leaves the box exactly as it was found.
      const target = req.daemon ? daemonTargetFor(req.report.platform, req.report.arch) : undefined;
      if (req.daemon && target === undefined) throw new Error(placeNoChipLine(req.name, req.report.platform, req.report.arch));
      const bytes = target === undefined ? undefined : binaryFor(target);
      // Ahead of the frames: the swap restarts the daemon under this link, so an exec sent after it would reach
      // a link that is gone. The daemon the box runs now takes it, whatever version that is.
      if (home !== undefined) {
        const said = await new PlaceMachine(req.link, { id: req.name, home }).exec(loginFiles({ home, path: req.report.login["PATH"] ?? "" }));
        if (said.exitCode !== 0) throw new Error(placeLoginFilesFailedLine(req.name, `${said.stdout.slice(-300)} ${said.stderr.slice(-200)}`.trim()));
      }
      if (bytes === undefined) return undefined;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const uploadId = randomBytes(8).toString("hex");
      const parts = Math.max(1, Math.ceil(bytes.length / MACHINE_PUT_PART_BYTES));
      let landed: PlaceUpdateLanded = { road: "link", at: "" };
      for (let seq = 0; seq < parts; seq++) {
        const part = bytes.subarray(seq * MACHINE_PUT_PART_BYTES, (seq + 1) * MACHINE_PUT_PART_BYTES);
        const answer = await req.link.request("place.update", {
          uploadId,
          seq,
          last: seq === parts - 1,
          data: Buffer.from(part).toString("base64"),
          sha256,
        });
        if (typeof answer["at"] === "string") landed = { road: "link", at: answer["at"], ...(typeof answer["kept"] === "string" ? { kept: answer["kept"] } : {}) };
      }
      return landed;
    }
    if (req.ssh === undefined) throw new Error(placeNoUpdateRoadLine(req.name));
    const reach = parseSshAddress(req.ssh.ssh, req.ssh.keyPath === undefined ? {} : { keyPath: req.ssh.keyPath });
    const { machine, login, system, arch } = await (deps.backend ?? new SshBackend()).adopt(reach);
    // The login this road just read rather than the one the record kept, as the join builds its place from: a box
    // whose login moved takes wsp's files where it now is.
    const files = loginFiles({ home: login.HOME, path: login.PATH });
    if (!req.daemon) {
      const wrote = await machine.run(files, { deadlineMs: 180_000 });
      if (wrote.exitCode !== 0) throw new Error(placeLoginFilesFailedLine(req.name, `${wrote.stdout.slice(-300)} ${wrote.stderr.slice(-200)}`.trim()));
      return undefined;
    }
    // The chip the box says now rather than the one the record kept, read before a byte is sent: a computer that
    // was rebuilt on another chip since it joined takes the binary it can run or none at all.
    const said = guestTargetSaid(system, arch, true);
    const landing = `${placeDaemonPaths(login.HOME).putDir}/${DAEMON_BIN}`;
    await landBytes(machine, landing, binaryFor(said));
    const res = await machine.run([files, placeUpdateScript(login.HOME, landing)].join("\n"), { deadlineMs: 180_000 });
    const printed = res.stdout.split("\n").map(line => line.trim()).filter(line => line !== "");
    const landed = printed.find(line => line.startsWith(PLACE_UPDATED_LINE));
    if (landed === undefined) throw new Error(placeUpdateFailedLine(req.name, `${res.stdout.slice(-300)} ${res.stderr.slice(-200)}`.trim()));
    const exe = landed.slice(PLACE_UPDATED_LINE.length).trim();
    // The script keeps the old one beside the new under this name, and refuses the update where it could not.
    return { road: "ssh", at: exe, kept: `${exe}.old` };
  };
}

/** One login over ssh and nothing else: the road the app's Try now takes on a computer whose agent has stopped
 * dialling in. It reads what that computer says about itself, which is one connection's worth of printf, and it
 * installs nothing and leaves nothing running. ssh's own refusal is what a person reads when it will not take.
 *
 * The key file the add was given is carried here: every ssh child this host starts runs with BatchMode on, so a
 * dial without it would be refused for the publickey on a computer that is switched on and answering. What a
 * refusal reads as is ssh's own line and not a reading of the machine wrapped around it: a person needs the
 * sentence their own terminal would have shown them. */
export function placeDialler(deps: { transport?: SshTransport } = {}): PlaceDialler {
  return async login => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    await sshDial(reach, ...(deps.transport === undefined ? [] : [deps.transport]));
  };
}

/** How long the leave over ssh is given. The stop it starts with is systemd's own, which waits a unit's
 * TimeoutStopSec (90 seconds where nothing names another) before it kills what is left of a daemon writing its
 * last frames, and the rest of the sweep follows that stop. */
const PLACE_LEAVE_MS = 180_000;

/** What the ssh client itself exits with when the login would not stand, which is the one exit that is the road
 * talking rather than the computer at the end of it. */
const SSH_REFUSED_EXIT = 255;

/** What a computer said when the leave on it did not finish: its own last words, since a person reading why the
 * agent is still on it needs that computer's sentence and not a reading of it. A computer that said nothing at all
 * is one the wait ran out on, and the line says so with the wait rather than ending on a colon. */
export const placeLeaveFailedLine = (name: string, said: { stdout: string; stderr: string }): string => {
  const words = `${said.stdout.slice(-300)} ${said.stderr.slice(-200)}`.trim();
  return words === ""
    ? `${name} ran the leave and had not finished it within ${Math.round(PLACE_LEAVE_MS / 1000)}s`
    : `${name} ran the leave and did not finish it: ${words}`;
};

/** How the agent is taken off a computer this host holds no link to, for the host that wires the runtime: the
 * leave that computer already carries, run over the login the install used. What comes off, in what order, and
 * what stays is that computer's own wsp, the same code a person at its terminal runs, so nothing of the sweep is
 * spelled here. The line that starts it is the one the box itself reported for running wsp there, word for word,
 * and what came off is read back by the rule that leave prints those lines by. */
export function placeLeaver(deps: { transport?: SshTransport } = {}): PlaceLeaver {
  return async req => {
    const reach = parseSshAddress(req.ssh.ssh, req.ssh.keyPath === undefined ? {} : { keyPath: req.ssh.keyPath });
    const line = shellLine([...req.report.wsp, PLACE_LEAVE_VERB]);
    const said = await (deps.transport ?? sshClient)(reach, line, { timeoutMs: PLACE_LEAVE_MS });
    // ssh's own line where the login would not stand, which is what a person would have read in their own
    // terminal; a leave that ran and stopped carries that computer's own words instead.
    if (said.exitCode === SSH_REFUSED_EXIT) throw new PlaceLoginRefusedError(sshRefusalLine(said, reach));
    if (said.exitCode !== 0) throw new Error(placeLeaveFailedLine(req.name, said));
    return sweptSaid(said.stdout);
  };
}

/** How many of the agent's own last lines go under a wait that ran out: enough to carry the address it refused and
 * the one that did not answer, short enough to read under one sentence. */
export const PLACE_LOG_TAIL = 10;

/** The end of the agent's own log on a computer that took it and has not dialled back, over the login the install
 * used. The daemon writes the address it could not dial and why into that log every ten seconds, so this is the
 * fact a person would otherwise go looking for by hand on a box they just met.
 *
 * The path is the one placeDaemonPaths writes, spelled against the box's own HOME rather than a home read here: a
 * second ssh child to ask what that home is costs a person who is already past a wait that ran out. A box with no
 * log yet answers nothing, which leaves the wait's own sentence exactly as it stood. */
export function placeLogReader(deps: { transport?: SshTransport } = {}): PlaceLogReader {
  return async login => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    const at = placeDaemonPaths("$HOME").placeLog;
    const said = await (deps.transport ?? sshClient)(reach, `tail -n ${PLACE_LOG_TAIL} "${at}" 2>/dev/null`, { timeoutMs: SSH_DIAL_MS });
    return said.stdout.split("\n").map(line => line.trimEnd()).filter(line => line !== "").slice(-PLACE_LOG_TAIL);
  };
}

/** What the computer says it is, for the line beside the step that reached it; nothing when it will not say, which
 * is a fact about that computer and not a reason to stop. */
async function osSaid(machine: { facts(): Promise<{ os: string }> }): Promise<string | undefined> {
  try {
    return (await machine.facts()).os;
  } catch {
    return undefined;
  }
}

interface PlaceDeps {
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  now(): number;
  run: ServiceRunner;
  platform: string;
  /** How a provider is put the key this computer holds; the one check every other road takes, unless a test hands
   * its own, since a real provider is nobody's to call from a unit test. */
  checkKey(backend: MachineBackend): Promise<KeyCheck>;
  /** This terminal, for the one thing here that shows another computer's: the sign-in that runs on it. */
  terminal: RelayTerminal;
  /** Opens the tool's page on this computer when the person presses o, as a builder's sign-in does. */
  open(url: string): Promise<boolean>;
  /** The pty road to one computer's own daemon, through the host that holds its link. */
  placeLink(client: HostClient, placeId: string): Promise<PlaceLink>;
  /** Runs the tool's own sign-in on that computer; a test hands its own rather than a pty on a real box. */
  signIn(o: BoxSignIn): Promise<BoxSignedIn>;
  /** The key this computer's ssh client already holds for a computer, read with nothing dialled: a computer it
   * holds one for is one it has met, and the add proceeds as it always did. */
  heldHostKey(reach: SshReach): Promise<string | undefined>;
  /** The key a computer answers a scan with, and what in the person's own ssh config stopped the scan. */
  offeredHostKey(reach: SshReach): Promise<{ key?: string; stoppedBy?: string }>;
  /** The dial a typed word names, a login or an alias out of the person's ssh config. */
  sshWord: SshWordReader;
}

const systemDeps: PlaceDeps = {
  dial: dialHost,
  now: Date.now,
  run: systemRunner,
  platform: platform(),
  checkKey: checkProviderKey,
  terminal: { input: process.stdin, output: process.stdout },
  open: systemOpener(platform()),
  placeLink,
  signIn: relaySignIn,
  heldHostKey: reach => knownHostKey(reach),
  offeredHostKey: reach => offeredHostKey(reach),
  sshWord: (word, opts) => sshWordReach(word, opts),
};

/** What the two host-side words work on: the state file the host on this computer serves, and where this run would
 * aim a line, which is read to refuse anywhere but here. */
export interface PlaceOpts extends HostPick {
  statePath: string;
  /** The environment the provider is picked out of, carrying every registered row's key off the three layers a key
   * is read through: a provider added as a place is put the key this computer already holds under its own variable. */
  providerEnv?: ProviderEnv;
  /** What brings a host up when none serves this state file here, as every verb is handed one: these two words are
   * the host's work too, so a person who has not typed wsp up gets a host rather than a refusal. Absent starts
   * nothing, which is what a caller that wants the refusal hands in. */
  start?: HostStarter;
}

/** Where a line that works on this computer's own host dials and what brings one up if none does: the aim is this
 * computer, never a word in the environment or the account's one host, the starter is the line's own, and the one line a
 * start prints goes where everything else this line says goes. Written once, so no road out of here can dial
 * somewhere else by accident or dial without offering to start the host the others start. A caller that read the
 * aim already for its own refusal hands it back rather than reading it twice. */
export function dialHere(io: CliIO, opts: PlaceOpts, aim: HostAim = { kind: "here" }): DialOpts {
  return { aim, say: line => io.error(line), ...(opts.start !== undefined ? { start: opts.start } : {}) };
}

/** Handing out a join code and taking a place back out happen at the host's own terminal and nowhere else, the same
 * rule wsp host pair and wsp host devices read. */
function aimHere(word: string, opts: PlaceOpts): HostAim {
  const aim = aimedHost(opts.statePath, opts);
  if (aim.kind !== "here") {
    throw usageRefusal(
      `wsp ${word} runs on the computer the host runs on, and this line is aimed at ${aimName(aim)}.`,
      "Run it in a terminal over there. Which computers a wsp runs on is handed out and taken away at that host's own terminal.",
    );
  }
  return aim;
}

export async function addCommand(io: CliIO, opts: PlaceOpts, args: readonly string[], flags: AddFlags = {}, deps: PlaceDeps = systemDeps): Promise<number> {
  const [word] = args;
  if (args.length > 1) throw usageRefusal("wsp add takes one provider or one address, or nothing at all.", ADD_USAGE);
  const aim = aimHere("add", opts);
  if (flags.signIn !== undefined) {
    if (word === undefined) throw usageRefusal("wsp add --sign-in names the computer to sign the agent in on.", ADD_USAGE);
    if (flags.update === true || flags.name !== undefined || flags.sshPort !== undefined || flags.keyPath !== undefined || flags.hostKey !== undefined) {
      io.error(SIGN_IN_FLAGS_REFUSAL);
      return 1;
    }
    return signInOnPlace(io, opts, aim, word, flags.signIn, deps);
  }
  if (flags.update === true) {
    if (word === undefined) throw usageRefusal("wsp add --update takes the place to move onto this wsp's daemon.", ADD_USAGE);
    if (flags.name !== undefined || flags.sshPort !== undefined || flags.keyPath !== undefined || flags.hostKey !== undefined) {
      io.error(UPDATE_FLAGS_REFUSAL);
      return 1;
    }
    return updatePlace(io, opts, aim, word, deps);
  }
  const named = flags.name !== undefined || flags.sshPort !== undefined || flags.keyPath !== undefined || flags.hostKey !== undefined;
  // What one word names is read once, in the protocol: a computer of the person's own over ssh, a repo a computer
  // clones, or a folder this computer holds. A provider's own word is neither and is read first.
  const provider = word !== undefined && addableProviders().includes(word);
  const kind = word === undefined || provider ? undefined : sourceKindOf(word);
  if (kind === "computer") return addOverSsh(io, opts, aim, word!, flags, deps);
  // Every other kind a word can name is a project's source, whichever of them it is: the host reads the word again
  // and records it, so a source added to the protocol's own reading needs no second list here.
  if (kind !== undefined) return addProject(io, opts, aim, word!, flags, deps);
  // A bare word is a computer when the person's ssh config renames it, and the login its block names is what is sent.
  const alias = word === undefined || provider ? undefined : await deps.sshWord(word, sshFlags(flags)).catch(() => undefined);
  if (alias !== undefined) return addOverSsh(io, opts, aim, sshLoginWord(alias), flags, deps);
  if (named) {
    io.error(ADD_FLAGS_REFUSAL);
    return 1;
  }
  if (provider) return addProvider(io, opts, word!, deps);
  if (word !== undefined) {
    io.error(addRefusal(word));
    return 1;
  }
  const lock = servingHost(opts.statePath);
  const address = lock?.address ?? LOOPBACK;
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  try {
    const { code, expiresAt } = await client.request<{ code: string; expiresAt: number }>("pair.issue");
    const publicAt = publicHostname(opts.statePath);
    // The door a computer you own dials is the host's to open, and asking for it is what opens it: a host on
    // loopback alone can be joined once it has one, so the loopback refusal is only for a host that serves none.
    // A host that serves one and could not open it says why in its own words; pointing at --listen there would send
    // the person to fix the wrong thing.
    const asked = await client.request<{ door: PlaceDoorView }>("places.door").then(
      answer => ({ door: answer.door }),
      (e: unknown) => ({ refusal: e instanceof Error ? e.message : String(e) }),
    );
    const door = "door" in asked ? asked.door : undefined;
    if ("refusal" in asked && asked.refusal !== PLACE_DOOR_UNSERVED) io.error(asked.refusal);
    else if (door === undefined && isLoopback(address) && publicAt === undefined) io.error(pairOnLoopbackLine(address));
    const urls = door?.addresses ?? reachAddresses(address).map(at => `http://${authority(at, lock?.port ?? 0)}`);
    // Off the key file beside the state file this line is aimed at, which is the pair the host serving it signs
    // with: a door that would not open still prints a line naming the key that will answer once one does.
    for (const line of addLines(joinToken(code, hostKeyHere(opts.statePath)), expiresAt, deps.now(), urls, publicAt)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}

/** The whole of what this verb answers to, printed by every refusal it has about its own shape. */
const ADD_USAGE = [
  "usage: wsp add",
  "       wsp add <provider>",
  "       wsp add <user@host|ssh alias> [--name <name>] [--ssh-port <port>] [--ssh-key <path>]",
  "       wsp add <place> --update",
  "       wsp add <place> --sign-in <agent>",
].join("\n");

/** The refusal for the update flag beside a flag about joining a computer that is not in yet. */
export const UPDATE_FLAGS_REFUSAL =
  "wsp add --update names a computer already in this wsp, so it takes none of the flags a join takes. Drop them, or drop --update to join a computer.";

/** What the line prints about the daemon half of an update: the versions either side and the road the binary took,
 * so a person reading it can tell the link road from the ssh one without asking, or the one line for a computer
 * that already runs this wsp's daemon and took the recipe alone. */
export function updatedLines(answer: PlaceUpdateReply): string[] {
  const daemon = answer.daemon;
  if (daemon === undefined) return [placeCurrentLine(answer.name, DAEMON_VERSION)];
  return [
    `${answer.name}: daemon ${daemon.from} to ${daemon.to}, over the ${daemon.road === "ssh" ? "ssh road" : "link"}`,
    `its binary      ${daemon.at}`,
    // Where the one it replaced was kept: the first thing to look at on a box whose daemon will not come up.
    ...(daemon.kept === undefined ? [] : [`the old one     ${daemon.kept}`]),
    ...(daemon.note === undefined ? [] : [daemon.note]),
  ];
}

/** One line of the recipe job as it runs: what the row under way said, under the step's own mark. The step's words
 * are not repeated per row; the job says one row at a time and the mark is what a person reads down. */
export function provisionStageLine(event: PlaceStageEvent): string {
  const mark = event.state === "done" ? "·" : event.state === "failed" ? "x" : " ";
  return `  ${mark} ${event.note ?? PLACE_ADD_WORDS.provision}`;
}

/** What is watched while the recipe goes on a computer: every line the job says, printed as it arrives, and the
 * event that ends it. Registered before the request that starts the job, so no row is lost between the answer to
 * that request and the wait for the job. */
function watchProvision(io: CliIO, client: HostClient, addId: string): { ended: Promise<void>; off: () => void } {
  let end: () => void = () => {};
  const ended = new Promise<void>(resolve => (end = resolve));
  const off = client.onFrame(frame => {
    const stage = PlaceStageEvent.safeParse(frame);
    if (!stage.success || stage.data.addId !== addId || stage.data.step !== "provision") return;
    io.log(provisionStageLine(stage.data));
    if (stage.data.state !== "running") end();
  });
  return { ended, off };
}

/** Waits out the recipe job this line started and prints what it came to, off the row the host keeps rather than
 * off the last event: the rows are what a failed row is named from, and they outlive the run. `job` is the one the
 * answer said it started and never the row's own, since a row may carry a job another line is running, whose
 * events ride a stream this one is not reading and whose end would never come. Answers what the line exits with:
 * 1 where a row failed or the job stopped. */
async function followProvision(io: CliIO, client: HostClient, place: Pick<PlaceView, "id" | "name">, job: PlaceProvision | undefined, watch: { ended: Promise<void> }): Promise<number> {
  if (job === undefined) return 0;
  if (job.state === "running") await watch.ended;
  const rows = await client.request<{ places: PlaceView[] }>("places.list");
  const now = rows.places.find(p => p.id === place.id)?.provision;
  // The row's job, but only while it is the one this line started: a fresh one on that computer is somebody
  // else's run and its rows are not this line's to tally.
  const provision = now?.addId === job.addId ? now : job;
  for (const line of provisionLines(place.name, provision)) io.log(line);
  return provision.state === "done" && provision.rows.every(r => r.outcome !== "failed") ? 0 : 1;
}

/** One place moved onto this wsp's daemon. The work is the host's, over the socket this line opens, as the install
 * is: the binary goes over the link that place is holding, or over the ssh road the install used when it holds
 * none, and the workspaces on it are kept either way. */
async function updatePlace(io: CliIO, opts: PlaceOpts, aim: HostAim, ref: string, deps: PlaceDeps): Promise<number> {
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  try {
    const picked = await onePlace(client, placeUpdateLine(ref), ref);
    if ("refusal" in picked) {
      io.error(picked.refusal);
      return 1;
    }
    // Minted here rather than read off the reply: the job's rows come back while it runs and the reply lands once
    // it is under way, so a line printed as it happens has to know which stream is this one's. The host is told
    // which id to put them on, as the join tells it.
    const addId = `a_${randomBytes(6).toString("hex")}`;
    const watch = watchProvision(io, client, addId);
    await client.events();
    try {
      const answer = PlaceUpdateReply.parse(await client.request<Record<string, unknown>>("places.update", { placeId: picked.place.id, addId }));
      for (const line of updatedLines(answer)) io.log(line);
      // A computer that got no recipe says so and the line is over: there is no job of this line's to follow.
      if (answer.said !== undefined) io.log(answer.said);
      return await followProvision(io, client, picked.place, answer.provision, watch);
    } catch (e) {
      // The host's own refusal: a recipe already going on that computer is one sentence, and this line is over
      // rather than waiting on a run somebody else started.
      if ((e as { kind?: unknown }).kind !== "conflict") throw e;
      io.error(e instanceof Error ? e.message : String(e));
      return 1;
    } finally {
      watch.off();
    }
  } finally {
    client.close();
  }
}

/** What one word to wsp add names, with the verb's own refusal for a word that names none of the forms. */
function sourceKindOf(word: string): ReturnType<typeof sourceKind> | undefined {
  try {
    return sourceKind(word);
  } catch {
    return undefined;
  }
}

/** One typed folder or repo url: a project recorded on a computer, which is what every workspace is a copy for.
 * The work is the host's, over the socket this line opens, so the app and the command line record one project the
 * same way. */
async function addProject(io: CliIO, opts: PlaceOpts, aim: HostAim, source: string, flags: AddFlags, deps: PlaceDeps): Promise<number> {
  if (flags.sshPort !== undefined || flags.keyPath !== undefined) {
    io.error(ADD_FLAGS_REFUSAL);
    return 1;
  }
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  try {
    // A folder of the person's seeding a project on a computer that clones: the menu first, and nothing is sent
    // until they have said what travels. A folder this computer copies seeds nothing and reads no menu, which the
    // computer's own kind says rather than this line: naming this computer with --on is the same road as naming
    // none, and both copy the folder where it already is.
    const onComputer = flags.on;
    const seeding = sourceKindOf(source) === "folder" && onComputer !== undefined && !(await copiesFolderOn(client, onComputer));
    let seed: SeedChoice | undefined;
    if (seeding && onComputer !== undefined) {
      const { plan } = await client.request<{ plan: SeedPlan }>("project.seed.plan", { source });
      // What would travel: their own words where they gave any, else what the catalogue ticks itself. Read before
      // the menu is drawn, so a word naming a path that never travels is refused rather than shown as ticked.
      const choice = flags.yes === true ? choiceFrom(plan, flags) : defaultSeedChoice(plan);
      for (const line of table(seedMenuRows(plan, choice))) io.log(line);
      if (flags.yes !== true) {
        for (const line of seedConsentLines(plan, onComputer, more => `wsp add ${shellQuote(source)} --on ${shellQuote(onComputer)} ${more}`)) io.log(line);
        return 0;
      }
      seed = choice;
    }
    // The computer by the name this wsp holds for it, off the same list every table reads; read before the add,
    // since the stages below land while it runs and each names the computer by its id.
    const { places } = await client.request<{ places: PlaceView[] }>("places.list").catch(() => ({ places: [] as PlaceView[] }));
    const onId = places.find(p => p.id === onComputer || p.name === onComputer)?.id;
    // The add's own stages as they land on that computer: a clone, a seed and an install take minutes there, and
    // a person watching a line that says nothing cannot tell a slow clone from a wedged one. Only that computer's,
    // and nothing at all where this line named none: a host serves every session at once, so a filter that let
    // every computer through would print another session's add into this terminal, and a folder worked where it
    // sits has no stages of its own anyway. The last of them says where the project is and the ones before it say
    // what did not land the way it was asked, so a terminal that read them says none of it again.
    const said = new Set<string>();
    const off = client.onFrame(frame => {
      const stage = ProjectAddEvent.safeParse(frame);
      if (!stage.success || onId === undefined || stage.data.computer !== onId) return;
      if (stage.data.stage === "done") said.add(stage.data.projectId);
      // A failed stage's sentence is the failure's own, which the terminal prints as the command's error.
      if (stage.data.stage !== "failed") io.log(stage.data.message);
    });
    await client.events();
    try {
      const { project, notice } = await client.request<{ project: ProjectView; notice?: string }>("projects.add", {
        source,
        ...(flags.on !== undefined ? { on: flags.on } : {}),
        ...(flags.name !== undefined ? { name: flags.name } : {}),
        ...(flags.base !== undefined ? { base: flags.base } : {}),
        ...(seed !== undefined ? { seed } : {}),
      });
      // A record that stood with nothing to land on that computer runs no stage at all, so this terminal says
      // both itself: the folder worked where it sits, and a repo a workspace of it clones inside its own copy.
      // By the project's own id, since another session's add on the same computer prints into this terminal too.
      if (!said.has(project.id)) {
        io.log(addedProjectLine(project, new Map(places.map(p => [p.id, p.name])), hostPlatform()));
        if (notice !== undefined) io.log(notice);
      }
    } finally {
      off();
    }
    return 0;
  } finally {
    client.close();
  }
}

/** Whether the computer a word names copies a folder here by directory rather than cloning onto its own disk: the
 * kind table's own answer for the computer that word is, off the same places listing every other row reads. A
 * word naming no computer is left to the host, which refuses it naming the computers there are. */
async function copiesFolderOn(client: HostClient, word: string): Promise<boolean> {
  const { places } = await client.request<{ places: PlaceView[] }>("places.list").catch(() => ({ places: [] as PlaceView[] }));
  const found = places.find(p => p.id === word || p.name === word);
  return found !== undefined && copiesFolder(kindForComputer(found.id));
}

/** What the person's own words make of the menu: the ticks the catalog decided, then their keeps and cuts and the
 * two words that drop the memory folder and the patch. The rules are the protocol's, read the same way by the app. */
function choiceFrom(plan: SeedPlan, flags: AddFlags): SeedChoice {
  return seedChoiceFrom(plan, flags.keep ?? [], flags.cut ?? [], {
    ...(flags.noMemory === true ? { memory: false } : {}),
    ...(flags.noCommits === true ? { commits: false } : {}),
    ...(flags.remember === true ? { remember: true } : {}),
  });
}

/** One typed address: the host logs in over ssh, installs the agent and waits for that computer to dial back. The
 * work is the host's, over the socket this line opens, so what the app does and what this prints are one road; the
 * steps come back as events and each is printed as it lands. */
async function addOverSsh(io: CliIO, opts: PlaceOpts, aim: HostAim, address: string, flags: AddFlags, deps: PlaceDeps): Promise<number> {
  const confirmed = await confirmedHostKey(io, address, flags, deps);
  if (confirmed === undefined) return 1;
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  // Minted here rather than read off the reply: the steps come back while the install runs and the reply lands
  // only once it is over, so a line printed as it happens has to know which stream is this one's.
  const addId = `a_${randomBytes(6).toString("hex")}`;
  try {
    const off = client.onFrame(frame => {
      const stage = PlaceStageEvent.safeParse(frame);
      if (!stage.success || stage.data.addId !== addId || stage.data.step === "provision") return;
      for (const line of stageLines(stage.data)) io.log(line);
    });
    // The recipe's own lines ride the same stream and are watched from here too, since the job starts inside the
    // add and its first rows land before the add answers.
    const watch = watchProvision(io, client, addId);
    await client.events();
    try {
      const added = await client.request<{ place: PlaceView; hostKey?: string; said?: string }>("places.add", {
        addId,
        address,
        ...(flags.name !== undefined ? { name: flags.name } : {}),
        ...(flags.sshPort !== undefined ? { sshPort: flags.sshPort } : {}),
        ...(flags.keyPath !== undefined ? { keyPath: flags.keyPath } : {}),
        ...confirmed,
      });
      for (const line of addedLines(added.place, added.hostKey)) io.log(line);
      if (added.said !== undefined) io.log(added.said);
      // The recipe before the sign-in: signing an agent in on that computer needs the agent on that computer,
      // which is what the job just put there. The job this add started is the row's, since the add is what wrote
      // it; a reply that says why none started carries no job and nothing is followed.
      await followProvision(io, client, added.place, added.said === undefined ? added.place.provision : undefined, watch);
      await offerBoxSignIn(io, client, added.place, deps);
      return 0;
    } finally {
      watch.off();
      off();
    }
  } finally {
    client.close();
  }
}

/** What this add sends about the computer's key, decided before anything is dialled: the one the person pinned on
 * the line, else nothing at all where this computer's ssh client already holds a key for that computer, since it
 * has met it. A computer it has never met is scanned and the key it answers with is put to the person; off a
 * terminal, and on a no, the add refuses with that key and the line that pins it, and nothing is sent. Nothing
 * back at all where the add is not to go on. */
async function confirmedHostKey(io: CliIO, address: string, flags: AddFlags, deps: PlaceDeps): Promise<{ hostKey?: string } | undefined> {
  if (flags.hostKey !== undefined) return { hostKey: flags.hostKey };
  const reach = await deps.sshWord(address, sshFlags(flags));
  if ((await deps.heldHostKey(reach).catch(() => undefined)) !== undefined) return {};
  const offered = await deps.offeredHostKey(reach).catch((): { key?: string; stoppedBy?: string } => ({}));
  if (offered.key === undefined) {
    io.error(hostKeyUnscannableRefusal(address, offered.stoppedBy));
    return undefined;
  }
  if (io.isTTY === true && (await io.ask(hostKeyAsk(address, offered.key))) === "yes") return { hostKey: offered.key };
  io.error(hostKeyUnconfirmedRefusal(address, offered.key));
  return undefined;
}

/** The port and key a person typed beside an address, in the shape every ssh reading takes them. */
function sshFlags(flags: AddFlags): { port?: number; keyPath?: string } {
  return { ...(flags.sshPort !== undefined ? { port: flags.sshPort } : {}), ...(flags.keyPath !== undefined ? { keyPath: flags.keyPath } : {}) };
}

/** One step of an install as a terminal prints it: the step's own words, a tick where it is done and what the
 * computer answered beside it. */
export function stageLines(event: PlaceStageEvent): string[] {
  const mark = event.state === "done" ? "·" : event.state === "failed" ? "x" : " ";
  // A running step says its note as a finished one does: what the box was read as and where it will dial back are
  // read while the step they belong to is still running, and holding them until it ends is holding them too long.
  // A failed step's note is the failure's first line, which the terminal prints whole as the command's error.
  const note = event.note === undefined || event.state === "failed" ? "" : `: ${event.note}`;
  return [`  ${mark} ${PLACE_ADD_WORDS[event.step]}${note}`];
}

/** What an install prints once the computer is in: what it is, the key its ssh answered with so a person can check
 * it against the computer in front of them, and what it can do. */
export function addedLines(place: PlaceView, hostKey: string | undefined): string[] {
  return [
    `${place.name} joined this wsp${place.shape === undefined ? "" : ` · ${fmtSize(place.shape, "cores")}`}${place.diskFreeBytes === undefined ? "" : ` · ${fmtBytes(place.diskFreeBytes)} free`}`,
    ...(hostKey === undefined ? [] : [`its ssh key      ${hostKey}`]),
    ...[placeEngineLine(place)].filter((line): line is string => line !== undefined),
    `wsp remove ${place.name} takes it back out and sweeps wsp off it.`,
  ];
}

/** A provider as a place: the words name it, and the key that opens it is put to the provider before anything is
 * written. The key is read under the variable that provider's row declares, off the same three layers every other
 * road reads a key through, and is never written here. Every row a person can add declares one, which is what
 * addedProviders answers with. */
async function addProvider(io: CliIO, opts: PlaceOpts, id: string, deps: PlaceDeps): Promise<number> {
  const env: ProviderEnv = { ...(opts.providerEnv ?? process.env), [PROVIDER_ENV]: id };
  const backend = providerBackendFor(env);
  const check = await deps.checkKey(backend);
  const said = keyCheckLine(check, id, true);
  if (check.state === "refused" && said !== undefined) {
    io.error(said);
    return 1;
  }
  // A check nothing answered says nothing about the key: it is taken, and the first fork says its own piece.
  if (said !== undefined) io.error(said);
  writeEnvFile(envFileFor(opts.statePath), { [PROVIDER_ENV]: id });
  const { pricing } = backend;
  io.log(providerPlaceLine(id, pricing.rateUsdPerHour(pricing.defaultSize)));
  if (servingHost(opts.statePath) !== undefined) io.log(`the host serving ${opts.statePath} reads that at its next start; wsp down and wsp up pick it up now.`);
  return 0;
}

/** One agent signed in on one computer already in this wsp. The work runs at this terminal: the tool's own flow is
 * shown here while it runs on that computer, over the link that computer is holding. */
async function signInOnPlace(io: CliIO, opts: PlaceOpts, aim: HostAim, ref: string, agent: string, deps: PlaceDeps): Promise<number> {
  if (!signsInOnComputer().includes(agent)) {
    io.error(signInAgentRefusal(agent));
    return 1;
  }
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  try {
    const picked = await onePlace(client, `wsp add ${ref} --sign-in ${agent}`, ref);
    if ("refusal" in picked) {
      io.error(picked.refusal);
      return 1;
    }
    return (await runBoxSignIn(io, client, picked.place, agent, deps)) ? 0 : 1;
  } finally {
    client.close();
  }
}

/** The join's own offer, put to the person while they are still at this terminal: a computer that reported an agent
 * whose login lives there is offered that sign-in. Nothing is asked where nobody is at the keyboard; the line then
 * says what threads there read until it is signed in. */
async function offerBoxSignIn(io: CliIO, client: HostClient, place: PlaceView, deps: PlaceDeps): Promise<void> {
  for (const agent of sharedAgentsOn(place.agents ?? [])) {
    const asked = place.logins !== undefined && io.isTTY === true && (await io.ask(boxSignInAsk(place.name, agent))) === "yes";
    if (!asked) {
      io.log(boxSignInLaterLine(place.name, agent));
      continue;
    }
    await runBoxSignIn(io, client, place, agent, deps);
  }
}

/** The sign-in itself and the one line it comes to. Whether it landed is what the caller answers with. */
async function runBoxSignIn(io: CliIO, client: HostClient, place: PlaceView, agent: string, deps: PlaceDeps): Promise<boolean> {
  if (sharedOn(agent) !== undefined && place.logins === undefined) {
    io.error(placeNoLoginsLine(place.name));
    return false;
  }
  // The host plans the line: a shared login at that computer's logins folder, any other as the owner of its home.
  const { line } = await client.request<{ line: unknown }>("agents.signInLine", { target: { placeId: place.id }, agent });
  const road = await deps.placeLink(client, place.id);
  try {
    const answer = await deps.signIn({ link: road.link, agent, line: SignInLine.parse(line), terminal: deps.terminal, open: deps.open });
    io.log(answer.signedIn ? boxSignedInLine(place.name, agent, answer.detail) : boxNotSignedInLine(place.name, agent, answer.said));
    // That computer lists its logins only when it dials, so the host notes this one as the app's own sign-in does.
    if (answer.signedIn) await client.request("places.loginLanded", { placeId: place.id, agent });
    return answer.signedIn;
  } finally {
    await road.close();
  }
}

export async function removeCommand(io: CliIO, opts: PlaceOpts, args: readonly string[], deps: PlaceDeps = systemDeps): Promise<number> {
  const [ref] = args;
  if (ref === undefined || args.length !== 1) throw usageRefusal("wsp remove takes one place.", "usage: wsp remove <place>");
  const aim = aimHere("remove", opts);
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  const typed = `wsp remove ${ref}`;
  try {
    const picked = await onePlace(client, typed, ref);
    if ("refusal" in picked) {
      io.error(picked.refusal);
      return 1;
    }
    const place = picked.place;
    const answer = await client.request<{ removed: boolean; swept: string[]; note?: string }>("places.remove", { placeId: place.id });
    if (!answer.removed) {
      // The list this place was picked out of, so a host that holds others still names them: the record went
      // between the listing and the remove, which is the one way this is answered false.
      io.error(noPlaceLine(typed, picked.joined.map(p => p.name)));
      return 1;
    }
    // The place's own name is what a join names the device it buys, so a device still wearing it is that computer's
    // window token. Read after the remove: a host that answers no device list simply names none.
    const held = await client.request<{ devices: DeviceView[] }>("devices.list").then(
      answered => answered.devices.filter(d => d.name === place.name).map(d => d.id),
      () => [],
    );
    for (const line of removeLines(place.name, answer, held)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}

/** The two lines wsp join answers to, in one place, since both its refusals print them. */
const JOIN_USAGE = "usage: wsp join <address>... --code <code> [--name <name>]";

/** Which of the two things a person typed a join refusal is about, where it is about one of them: an address
 * nothing answered at, or a code the host would not take. A refusal about neither (a host that would not prove its
 * key, a computer already in a wsp) carries none. */
export type JoinRefusalAbout = "address" | "code" | "host";

/** A join that did not happen, carrying what it was about where that is known. It is thrown where the reason is
 * known, so a screen with one slot per field puts a refusal under the right field rather than reading it back out
 * of the sentence. */
export class JoinRefused extends Error {
  constructor(
    readonly about: JoinRefusalAbout,
    message: string,
  ) {
    super(message);
    this.name = "JoinRefused";
  }
}

export interface JoinFlags {
  code?: string;
  codeFile?: string;
  name?: string;
}

export interface JoinDeps {
  /** How the socket to the host is opened; the ws client unless a test hands its own. */
  dial(url: string): WebSocket;
  run: ServiceRunner;
  platform: string;
  home: string;
  now(): number;
  /** Which manager holds the unit and which login is running this, for a caller that is not this process; this
   * computer's own by default, which is what every terminal means. */
  manager?: ServiceManager;
  uid?: number;
}

const joinDeps = (): JoinDeps => ({
  dial: url => new WebSocket(wsUrlOf(url)),
  run: systemRunner,
  platform: platform(),
  home: process.env["HOME"] ?? "",
  now: Date.now,
});

/** The daemon's line on a computer joined as a place: the flags every daemon under a login takes, told the place
 * kind, then the place file it dials its host off, the home it keeps its files under and sweeps on a leave, the
 * folder its turns start in, the line that runs wsp here word by word, and the agents to look for on PATH at each
 * dial, as catalog id and command. Only the list of ids is fixed at the join; PATH is read at every dial. */
export function placeDaemonFlags(home: string, file: string, run: RunningWsp = runningWsp()): string[] {
  return [
    ...daemonFlags({ ...sshDaemonPlace({ home, path: "" }), kind: "place" }),
    "--home",
    home,
    "--work-folder",
    workFolderIn(home),
    "--place-file",
    file,
    ...wspArgvOf(run).flatMap(word => ["--wsp-argv", word]),
    "--agents",
    CATALOG_AGENTS.map(a => `${a.id}=${a.bin}`).join(","),
  ];
}

/** What the daemon on a place needs on disk before it starts: wsp's own folder, the inbox and the work folder, and
 * a token file, minted fresh here; the host replaces it through the ordinary rotation on its first reach, which is
 * the road every other daemon's token takes. */
export function preparePlaceHome(home: string): void {
  const at = placeDaemonPaths(home);
  mkdirSync(at.wsp, { recursive: true, mode: 0o700 });
  mkdirSync(at.inbox, { recursive: true, mode: 0o700 });
  mkdirSync(workFolderIn(home), { recursive: true });
  writeFileSync(at.tokenPath, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
}

/** The join token, off the flag or off the file the installer landed it in, which is deleted before the dial: a
 * token left on a computer's disk is a join somebody else could spend. It carries the code and the fingerprint of
 * the key the host is to prove; a token that names no key is refused here, before anything is dialled. */
function joinCode(flags: JoinFlags): { code: string; hostKey: string } {
  if (flags.code !== undefined && flags.codeFile !== undefined) throw usageRefusal("wsp join takes --code or --code-file, not both.", "Drop one of them.");
  if (flags.code !== undefined) return withHostKey(readJoinToken(flags.code));
  if (flags.codeFile === undefined) throw usageRefusal("wsp join needs the code the host printed.", JOIN_USAGE);
  const path = resolve(flags.codeFile);
  const read = readJoinToken(readFileSync(path, "utf8"));
  rmSync(path, { force: true });
  if (read.code === "") throw usageRefusal(`${path} held no join code.`, "Run wsp add on the host again and write the code it prints into that file.");
  return withHostKey(read);
}

/** The one rule for a token whichever road it came by: a code with no key beside it is a line this computer cannot
 * hold a host to, so it says so rather than pinning whatever answers. */
function withHostKey(read: { code: string; hostKey?: string }): { code: string; hostKey: string } {
  if (read.hostKey === undefined) throw new Error(JOIN_NO_KEY_REFUSAL);
  return { code: read.code, hostKey: read.hostKey };
}

/** Every address in turn until one answers: a host on a network answers on several, and the one a person typed or
 * an installer picked may be the one this computer cannot route to. An address that answered nothing is skipped;
 * anything the host itself said, about the code or about its own key, ends the walk, since its other addresses are
 * the same host and would say the same. */
async function handshakeAt(
  io: CliIO,
  urls: readonly string[],
  code: string,
  hostKey: string,
  name: string,
  home: string,
  client: boolean,
  dial: (url: string) => WebSocket,
): Promise<Awaited<ReturnType<typeof handshake>> & { dialed: string }> {
  let last: Error | undefined;
  for (const url of urls) {
    try {
      return { ...(await handshake(io, url, code, hostKey, name, home, client, dial)), dialed: url };
    } catch (e) {
      if (!(e instanceof JoinRefused) || e.about !== "address") throw e;
      last = e;
      // Said as it happens rather than kept: a person watching a join wants to read which address went nowhere.
      if (urls.length > 1) io.error(e.message);
    }
  }
  throw last ?? usageRefusal("wsp join needs an address to dial.", JOIN_USAGE);
}

/** One dial that joins this computer to a wsp: the key is made here, the host's own key is held to the fingerprint
 * the join line carried, and nothing is written or sent until the host has proved that key back. */
async function handshake(
  io: CliIO,
  url: string,
  code: string,
  /** The fingerprint the join line named, which the key the host answers with has to match. */
  hostKey: string,
  name: string,
  home: string,
  /** Whether this join also buys the device token this computer's own window holds; it wears `name`. */
  client: boolean,
  dial: (url: string) => WebSocket,
): Promise<{ placeId: string; hostPublicKey: string; hostName: string; privateKeyPem: string; report: PlaceReport; device?: { deviceId: string; deviceToken: string } }> {
  const pair = newPlaceKeyPair();
  const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
  // One key agreement per join, thrown away with the socket: from the prove on every frame rides inside it, so
  // the code this computer spends and the report it sends are read by the host and by nobody carrying the bytes.
  const mine = freshEphemeral();
  const report = { ...placeReport({ name, home }), dialed: url };
  const ws = dial(url);
  let seal: Seal | undefined;
  let answered: { placeId: string; hostPublicKey: string; hostName: string } | undefined;
  try {
    return await new Promise((done, fail) => {
      const deadline = setTimeout(() => fail(new JoinRefused("address", joinUnansweredLine(url))), JOIN_MS);
      const end = (e: Error): void => {
        clearTimeout(deadline);
        fail(e);
      };
      ws.on("error", (e: Error) => end(new JoinRefused("address", `${url} could not be reached: ${e.message}`)));
      ws.once("close", () => end(new JoinRefused("address", `${url} closed the socket before this computer had joined`)));
      // Frame one carries public values only: the key this computer will prove, its nonce and its half of the
      // agreement. Nothing of the person's crosses before the host has proved the key the join line named.
      ws.once("open", () => ws.send(JSON.stringify({ id: 1, op: "place.join", publicKey: pair.publicKey, nonce, ephemeral: mine.publicKey })));
      ws.on("message", raw => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(openFrame(seal, raw)) as Record<string, unknown>;
        } catch {
          end(new JoinRefused("address", `${url} sent something that is not a frame`));
          return;
        }
        if (frame["ok"] !== true) {
          const said = String(frame["error"] ?? `${url} refused this join`);
          // The one refusal a host has for a code it is not holding, spent or expired or never minted, is the
          // protocol's own constant; every other refusal from over there is about this computer rather than about
          // a field, and travels as the host's own sentence so a screen can print it instead of guessing.
          end(new JoinRefused(said === PLACE_CODE_REFUSAL ? "code" : "host", said));
          return;
        }
        if (frame["id"] === 1) {
          const reply = PlaceJoinReply.safeParse(frame);
          if (!reply.success) {
            end(new Error(`${url} answered the join with something this computer cannot read: ${reply.error.message.replace(/\s+/g, " ").trim()}`));
            return;
          }
          const { placeId, hostPublicKey, nonce: hostNonce, signature, ephemeral, hostName } = reply.data;
          // Nothing of this computer's is written or sent past here: not its report, not its own signature. The key
          // is read before the signature it came with, since a stranger answering at this address signs for itself
          // perfectly well and the only thing that tells it from the host is which key it is.
          if (keyFingerprint(hostPublicKey) !== hostKey) {
            end(new Error(joinKeyRefusal(url)));
            return;
          }
          if (!verifyPlaceBytes(hostPublicKey, placeLinkTranscript("host", placeId, nonce, hostNonce, { challenger: mine.publicKey, answerer: ephemeral }), signature)) {
            end(new Error(hostKeyRefusal(url)));
            return;
          }
          answered = { placeId, hostPublicKey, hostName };
          if (frame["notice"] !== undefined) io.error(String(frame["notice"]));
          // The key both signatures cover, since the transcript named both ephemerals: the prove and everything
          // after it ride inside it, and a carrier that swapped either of them has signed nothing.
          const sealed = makeSeal(sealKeys(sharedSecret(mine.privateKey, ephemeral), placeId), "place");
          ws.send(
            sealed.seal(
              JSON.stringify({
                id: 2,
                op: "place.prove",
                signature: signPlaceBytes(pair.privateKeyPem, placeLinkTranscript("place", placeId, hostNonce, nonce, { challenger: ephemeral, answerer: mine.publicKey })),
                report,
                code,
                ...(client ? { client: { name } } : {}),
              }),
            ),
          );
          seal = sealed;
          return;
        }
        if (frame["id"] === 2 && answered !== undefined) {
          clearTimeout(deadline);
          const device = PlaceJoinDevice.safeParse(frame["device"]);
          done({ ...answered, ...(device.success ? { device: device.data } : {}), privateKeyPem: pair.privateKeyPem, report });
        }
      });
    });
  } finally {
    // The join's own socket is not the link: the service that starts below dials one of its own, and this one would
    // otherwise sit as a place the host thinks is present with nothing serving it.
    ws.close(1000, "the join is done; the agent dials the link");
  }
}

/** What one join needs, whoever asked for it. The road below is the whole of a join, so the command line and the
 * app's shell take the same one; the app hands the shim it writes as the wsp this computer runs. */
export interface JoinPlaceOptions {
  /** The home holding place.json and the key beside it. */
  home: string;
  /** Every address this host answers on, as joinAddressOf gave them, tried in the order they are in: one host is
   * on several networks, and the first that answers is the one this computer can reach. The place file keeps them
   * all, so it keeps dialling when the one it reached stops answering. */
  addresses: readonly string[];
  code: string;
  /** The fingerprint of the key the host is to prove, as the join line carried it beside the code. A host that
   * answers with any other key is refused before this computer sends its own report or signature. */
  hostKey: string;
  /** What the host will call this computer; its own name lowercased when nobody says. */
  name?: string;
  /** Also buy a device token for this computer's own window with the same code. The device is named after the
   * place, off the one `name` below: `wsp remove` finds the token a computer still holds by that name, so the two
   * cannot be two words. An ask rather than a name, so no caller can pass a second one. */
  client?: boolean;
  /** The wsp this computer runs, which the daemon reports as the line a turn's agent is given: this process's own
   * unless the caller runs behind a shim, as the app does. */
  wsp?: RunningWsp;
  /** Which computer this is, for the manager that holds the unit and the line said where there is none; this
   * process's own unless a caller names another. */
  platform?: string;
  /** The login running the join, for the manager that says whether its unit needs root; this process's own unless
   * a caller names another. */
  uid?: number;
  /** Which manager holds the unit: the one that platform has unless the caller names another, and a caller that
   * means none names the key with nothing in it, as the sweep's own option already reads. */
  manager?: ServiceManager | undefined;
  run?: ServiceRunner;
  /** How the socket to the host is opened, and the clock the joined stamp is read off; the real ones by default. */
  dial?: (url: string) => WebSocket;
  now?: () => number;
}

/** What a join answers its caller: enough for the app to open its window on the other wsp with no second read. */
export interface JoinedPlace {
  placeId: string;
  hostName: string;
  hostUrls: string[];
  report: PlaceReport;
  device?: { deviceId: string; deviceToken: string };
}

/** The whole of a join, as a function: the key, the handshake, the two files at the person's own mode, and the unit
 * that dials again at every start. It refuses a computer that already belongs to a wsp, since a place file is the
 * one wsp this computer is in. Throws the host's own sentence on a refusal; the caller decides what a person reads. */
export async function joinPlace(io: CliIO, opts: JoinPlaceOptions): Promise<JoinedPlace> {
  const { home, addresses, code, hostKey } = opts;
  if (home === "") throw new Error("a join needs this login's home folder, and this process has none");
  const file = placeFilePath(home);
  const standing = joinRefusal(home);
  if (standing !== undefined) throw new Error(standing);
  // Before the handshake: a computer nothing would keep the daemon up on is refused with nothing written on it.
  const on = opts.platform ?? platform();
  const row = DAEMON_TARGETS.find(t => t.platform === on);
  if (row !== undefined && !guestSystem(row.system)) throw new Error(noPlaceSystemLine(row.system, "this computer"));
  const manager = "manager" in opts ? opts.manager : serviceManagerFor(on);
  if (manager === undefined) throw new Error(noPlaceManagerLine(on));
  // The agent here is the machine's own service, so a login that cannot write one reads the sentence and stops:
  // before the handshake, before the key, before the place file, before anything of wsp's is on this computer.
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  if (manager.needsRoot?.({ role: "place", statePath: file, home, uid }) === true && uid !== 0) throw new Error(PLACE_NEEDS_ROOT_LINE);
  const bin = daemonBinaryHere();
  const name = opts.name?.trim() !== undefined && opts.name.trim() !== "" ? opts.name.trim() : placeNameHere();
  const now = opts.now ?? Date.now;
  const dial = opts.dial ?? ((url: string) => new WebSocket(wsUrlOf(url)));
  const joined = await handshakeAt(io, addresses, code, hostKey, name, home, opts.client === true, dial);
  const address = joined.dialed;
  const key = placeKeyPath(home);
  const placeFile: PlaceFile = {
    placeId: joined.placeId,
    name,
    hostName: joined.hostName,
    // The one that answered first, then the rest: that is the order the link tries them in from now on.
    hostUrls: [address, ...addresses.filter(at => at !== address)],
    hostPublicKey: joined.hostPublicKey,
    keyPath: key,
    joinedAt: new Date(now()).toISOString(),
  };
  // The handshake ran since the check above, so another join may be writing meanwhile. The key is the claim: of two
  // joins one creates it and the other stops here with nothing written, and the create never follows a link. The
  // place file is the last write, so a join cut off between the two leaves a key alone, which reads as broken.
  if (!writeExclusive(key, joined.privateKeyPem)) throw new Error(ALREADY_JOINED_LINE);
  if (!writePlaceFile(file, placeFile)) {
    if (keyIs(key, joined.privateKeyPem)) rmSync(key, { force: true });
    throw new Error(joinRefusal(home) ?? ALREADY_JOINED_LINE);
  }
  if (!keyIs(key, joined.privateKeyPem)) {
    rmSync(file, { force: true });
    throw new Error(joinCutByLeaveLine);
  }
  io.log(joinedLine(name, address));
  const answer: JoinedPlace = {
    placeId: joined.placeId,
    hostName: joined.hostName,
    hostUrls: placeFile.hostUrls,
    report: joined.report,
    ...(joined.device === undefined ? {} : { device: joined.device }),
  };
  const at: ServiceAddress = { role: "place", statePath: file, home, uid };
  const logPath = placeLogPath(home);
  // HOME is stated rather than inherited: the daemon keeps every file it has under the home its place file sits in,
  // and a manager that hands it the login's own default would put them somewhere else entirely. PATH is the one a
  // login shell here gives, which is what the daemon reports and what a turn on this computer finds: a service
  // starts with almost none, and the app that asked for this join may hold a bare one itself.
  const env = { ...serviceEnv(process.env), HOME: home, PATH: placeLogin(process.env, home)["PATH"]! };
  preparePlaceHome(home);
  const { unit, installed, failure } = await installService(manager, { ...at, argv: [bin, ...placeDaemonFlags(home, file, opts.wsp)], cwd: home, env, logPath }, opts.run ?? systemRunner);
  if (failure !== undefined) {
    if (installed) io.error(`the ${manager.words} ${unit.name} is still there at ${unit.path}; wsp leave takes it away.`);
    throw new Error(runFailureLine(failure));
  }
  io.log(`${manager.words} ${unit.name} is loaded; it dials again at every start`);
  io.log(`log         ${logPath}`);
  const after = manager.afterLoad?.(at);
  if (after !== undefined) io.log(after);
  io.log("wsp leave takes this computer back out.");
  return answer;
}

/** The place file as it stands on this computer, or nothing when it belongs to no wsp. */
export function placeStanding(home: string): PlaceFile | undefined {
  return readPlaceFile(placeFilePath(home));
}

/** The sweep a computer runs on itself, and the lines naming what it took. The host's own remove asks the agent for
 * this over the link; this is the road for a wsp that cannot be reached. */
export async function leavePlace(home: string, run?: ServiceRunner, forPlatform: string = platform()): Promise<string[]> {
  const manager = serviceManagerFor(forPlatform);
  const swept = await sweepPlace({ home, ...(manager !== undefined ? { manager } : {}), ...(run !== undefined ? { run } : {}) });
  return swept.removed;
}


/** The road wsp join takes, and the one the app's own join screen takes through the same function. A caller that
 * is not a terminal hands the parts of it that differ there (the line its service runs, the home it works under)
 * and takes the rest as it stands, so nothing about a join is written twice. */
export async function joinCommand(io: CliIO, args: readonly string[], flags: JoinFlags, given: Partial<JoinDeps> = {}): Promise<number> {
  const deps: JoinDeps = { ...joinDeps(), ...given };
  const home = deps.home;
  if (home === "") throw new Error("wsp join needs this login's home folder, and this process has none");
  if (args.length === 0) throw usageRefusal("wsp join takes one address or more.", JOIN_USAGE);
  // One host answers on several addresses, and the one an installer picked may be the one this computer cannot
  // route to: every word is read, and the join tries them in the order they were given.
  const addresses = args.map(typed => {
    const at = joinAddressOf(typed);
    if (at === undefined) throw new JoinRefused("address", `${JOIN_ADDRESS_LINE.what} ${JOIN_ADDRESS_LINE.fix}`);
    return at;
  });
  const standing = joinRefusal(home);
  if (standing !== undefined) {
    io.error(standing);
    return 1;
  }
  const { code, hostKey } = joinCode(flags);
  await joinPlace(io, {
    home,
    addresses,
    code,
    hostKey,
    ...(flags.name !== undefined ? { name: flags.name } : {}),
    platform: deps.platform,
    ...(deps.manager !== undefined ? { manager: deps.manager } : {}),
    ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
    run: deps.run,
    dial: deps.dial,
    now: deps.now,
  });
  return 0;
}

export async function leaveCommand(io: CliIO, args: readonly string[], deps: { home: string; run: ServiceRunner; platform: string } = { home: process.env["HOME"] ?? "", run: systemRunner, platform: platform() }): Promise<number> {
  if (args.length !== 0) throw usageRefusal("wsp leave takes no positional arguments.", "Run wsp leave on its own; it takes wsp off the computer you are sitting at.");
  const home = deps.home;
  if (home === "") throw new Error("wsp leave needs this login's home folder, and this process has none");
  const standing = joinStanding(home);
  if (standing === undefined) {
    io.error(NOTHING_TO_LEAVE_LINE);
    return 1;
  }
  const held = "joined" in standing ? standing.joined : undefined;
  const manager = serviceManagerFor(deps.platform);
  // The agent is another process from this one, so the sweep stops it before taking its unit file, and the lines
  // below say so.
  const swept = await sweepPlace({ home, ...(manager !== undefined ? { manager } : {}), run: deps.run });
  io.log("broken" in standing ? brokenPlaceLeftLine(standing.broken) : `${standing.joined.name} left the wsp at ${standing.joined.hostUrls.join(", ")}; removed:`);
  for (const line of swept.removed) io.log(sweptLine(line));
  for (const line of swept.kept) io.log(line);
  if (held !== undefined) io.log("The host over there still lists it until somebody runs wsp remove on it.");
  return 0;
}
