// SPDX-License-Identifier: AGPL-3.0-only
// The places this host holds: the computers somebody joined to it, this
// computer, and the provider it forks on. A joined computer dials in, proves
// itself with the ed25519 key this host learned at its join, and from then on
// this door holds that one socket and drives it with the daemon protocol every
// fork speaks. Nothing here listens: a place opens the socket, always.
//
// The encodings both sides sign and send are pinned in the protocol
// (PlaceNonce, PlacePublicKey, PlaceSignature) and the bytes they sign come
// from placeLinkTranscript, so this file holds the host's half of the
// handshake and no rule of its own about how it is spelled.
import { createPublicKey, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  LOOPBACK,
  HERE_PLACE_ID,
  NO_PLACE_INSTALLER,
  PAIR_CODE_TTL_MS,
  PLACE_KEY_REFUSAL,
  PLACE_UNKNOWN_REFUSAL,
  PLACE_LEAVE_LINE,
  PLACE_LINK_NONCE_BYTES,
  DAEMON_VERSION,
  forkRoom,
  placeLinkTranscript,
  placeRefusalTranscript,
  isPlainPath,
  joinToken,
  absentComputer,
  namesPlace,
  noSuchPlaceRefusal,
  placeHoldsForksRefusal, placeHoldsProjectsRefusal,
  placeForksNowhereLine,
  placeBlocked,
  placeNoDaemonPortLine,
  placeNoLinkLine,
  placeStillInstalledLine,
  placeDialLine,
  placeDialRoad,
  placeNoHomeLine,
  placeNoRecipeLine,
  placeProvisionPaths,
  placeProvisioningLine,
  provisionCountWord,
  provisionLines,
  provisionLogLine,
  sshRoadOf,
  placeNoDialLine,
  BackendFacts,
  type AgentSignInState,
  type DaemonEvent,
  type DaemonResponse,
  type MachineSizeOffer,
  type PlaceAddStep,
  PLACE_LOGIN_REFUSED_KIND,
  type PlaceStageEvent,
  type PlaceAddJob,
  withPlaceStage,
  keptSaid,
  markedCut,
  refusalParts,
  usageRefusal,
  type PlaceAuthRefusal,
  type PlaceAuthReply,
  type PlaceAuthRequest,
  type PlaceJoinReply,
  type PlaceJoinRequest,
  type PlaceEvent,
  type PlaceDial,
  type PlaceDialled,
  type PlaceProvision,
  type PlaceProvisionRow,
  type PlaceReport,
  type PlaceBack,
  type PlaceRoad,
  type PlaceUpdateReply,
  type PlaceView,
  type WorkspaceSize,
  PLACE_CODE_REFUSAL,
  PLACE_UNSEALED_JOIN_REFUSAL,
  twoPlacesRefusal,
  placeBehindLine,
  placeDaemonBehind,
  buildsImages,
  linkedOver,
  type PlaceProveRequest,
} from "@wsp/protocol";
import { LinkBackend, PlaceAbsentError, PlaceMachine, SSH_STORE_VARS, keyFingerprint, machineServerPort, plainPath, provisionCountsOf, putFiles, serversOutLines, unmergeServers, type ExecResult, type Machine, type MachineBackend, type MachineLink, type ProvisionPlan, type ProvisionStage } from "@wsp/engine";
import { CATALOG_AGENTS, keyEnvOf, mintsToken, sharedFileIn, sharedOn } from "@wsp/catalog";
import type { WebSocket } from "ws";
import type { DeviceDoor } from "./devices.js";
import { openPlaceForward, type PlaceForward } from "./place-forward.js";
import type { PlaceBackends } from "./runtime.js";
import type { DaemonChannel } from "./daemon-channel.js";
import { connectDaemon, type DaemonReach } from "./reach.js";
import { freshEphemeral, makeSeal, newPlaceKeyPair, sealKeys, sharedSecret, signPlaceBytes, verifyPlaceBytes, type PlaceKeyPair, type Seal } from "@wsp/keys";
import type { Store } from "./store.js";

/** One document per joined computer, keyed by the id this host knows it by. */
const PLACES = "places";
/** The one document naming which place a verb means when nobody says: the last one added. */
const DEFAULT_COLLECTION = "place-default";
const DEFAULT_ID = "default";

/** What the store keeps about a joined computer. The key is the whole of its identity: a computer whose key moved
 * is not this place, whatever address it dials from. */
export interface PlaceRecord {
  id: string;
  name: string;
  publicKey: string;
  joinedAt: string;
  lastSeenAt: string;
  report: PlaceReport;
  /** What the backend this computer offers said about itself the last time it was linked. Kept on the record so a
   * fork standing on this place can be held at host start, before the computer has dialled in: the capabilities,
   * the sizes and the budgets a road reads are facts about that computer, not about this moment's socket. */
  backendFacts?: BackendFacts;
  /** Where this host expects that computer: the ssh login it was installed over, and the address its last link
   * dialled in from. Written at the install and at every attach, so a row can say which machine it means while
   * the computer is saying nothing. */
  road?: PlaceRecordRoad;
  /** What the last dial of it came to. Kept so the answer outlives the window that asked for it. */
  dialled?: PlaceDialled;
  /** The recipe job on this computer as it last stood; written per row while it runs. */
  provision?: PlaceProvision;
  /** When the report on this record was taken. Not lastSeenAt: that moves every minute while the link is held,
   * and the uptime in the report grows with the computer, so a row dating one by the other reads an hours-old
   * figure as a minutes-old one. */
  reportedAt?: string;
}

/** The road as the record keeps it: what a client is told, and the key file the person named at the add, which is
 * a path on this computer and stays here. */
export interface PlaceRecordRoad extends PlaceRoad {
  keyPath?: string;
}

const isPlaceRecord = (v: unknown): v is PlaceRecord => {
  const r = v as PlaceRecord | undefined;
  return typeof r === "object" && r !== null && typeof r.id === "string" && typeof r.publicKey === "string" && typeof r.name === "string";
};

/** What a client watching the places hears. The four shapes are the protocol's own, so the host hands them straight
 * to the runtime's event bus and the app folds them with no second spelling in between. */
export type { PlaceEvent };

/** What this computer is, as a row of the same list: the list is the whole of where work can run, so the computer
 * the host runs on is on it. The host answers, since its own name and shape are its own to read. */
export interface HerePlace {
  name: string;
  label?: string;
  os?: string;
  shape?: WorkspaceSize;
  engine?: "none" | "docker" | "podman";
  diskFreeBytes?: number;
}

/** What a host wires for the places it holds: its own key pair, what it is set up to fork on, and this computer's
 * own row. Absent, the runtime serves no place and every place op is refused. */
export interface PlaceWiring {
  /** The host's own ed25519 pair, made once beside the state file by the host and never written by the runtime. */
  hostKey: PlaceKeyPair;
  /** The one word for a provider the host is set up for, as a place; nothing, or no reader at all, when it forks
   * nowhere. */
  provider?(): { id: string; rateUsdPerHour: number } | undefined;
  here(): HerePlace;
  /** What this computer calls itself, which is what a joining computer shows its person from then on. */
  hostName(): string;
  /** How the agent is put on a computer over ssh; absent on a runtime served without the road that installs it,
   * where the printed join line is the only way in. */
  install?: PlaceInstaller;
  /** One login over the road a computer was added on, to tell a computer that is off from an agent that is not
   * calling home. Nothing is installed and nothing is left running: it answers or it throws the road's own line.
   * Absent on a runtime served without the ssh road, where a computer that is not linked can only be waited for. */
  dial?: PlaceDialler;
  /** The end of the agent's own log on a computer that took it and has not dialled back, over the road it was
   * installed on. Absent on a runtime served without the ssh road, where a wait that runs out has only its own
   * sentence to give. */
  log?: PlaceLogReader;
  /** How the daemon this host deploys is put on a computer that is already a place. The host wires it because the
   * binary and the table of chips it is picked from are the host's, as the installer above is. */
  update?: PlaceUpdater;
  /** How the agent is taken off a computer this host is holding no link to, over the login the install used.
   * Absent on a runtime served without the ssh road, where a remove of a computer that is not connected says the
   * agent is still installed and leaves it to the person at that computer. */
  leave?: PlaceLeaver;
  /** How the recipe this computer holds is put on a computer you own. Absent, no computer is provisioned and the
   * join and the update say nothing about it. */
  provision?: PlaceProvisioner;
  /** The forwards over ssh this host holds for computers that reach it no other way; the installer holds one before
   * the deploy and the records keep it held. Absent on a runtime served without the ssh road. */
  back?: PlaceBackHolder;
}

/** The forwards a host holds from a computer's own loopback to its door, one per login. */
export interface PlaceBackHolder {
  /** Holds the forward for that login until it is released, making it again each time it ends. Answers where it
   * first stood, or throws the sentence for why the first try did not; a login already held takes the new `moved`
   * and answers where it stands. `moved` hears the port on that computer whenever a remake had to take another,
   * after the place file there names it. */
  hold(login: PlaceLogin, back: PlaceBack, on: { home: string }, moved?: (back: PlaceBack) => void): Promise<PlaceBack>;
  release(login: PlaceLogin): void;
  /** The door every forward lands on, handed over once the host serves: its port on this computer's loopback as it
   * stands when asked, or nothing on a host with no door of its own. Nothing stands before it is handed. */
  door(at: () => Promise<number | undefined>): void;
  close(): void;
}

/** How the recipe on this computer is put on a computer you own. `plan` reads the recipe beside the host's state
 * and this computer and answers the steps, or the recipe path when there is none; `run` puts the plan on `machine`,
 * which is that computer itself over the link its daemon holds. The host wires it because the recipe and the
 * reading of this computer are the host's, as the installer and the daemon binary are. */
export interface PlaceProvisioner {
  /** `on` is the computer the plan is for: its home is what every path of the job hangs off and what the PATH the
   * job's scripts export is read from, since a directory under it is one the workspaces there write. */
  plan(on: { home: string }): Promise<ProvisionPlan | { noRecipe: string }>;
  run(machine: Machine, plan: ProvisionPlan, stage: ProvisionStage, on: { home: string }): Promise<PlaceProvisionRow[]>;
}

/** One login over ssh as this host holds it: the address in the spelling a person would type back, and the key file
 * the add was given where they named one, which is a path on this computer and stays here. */
export interface PlaceLogin {
  ssh: string;
  keyPath?: string;
}

/** One dial of a computer over the login this host holds for it, with the key file the add was given where there
 * was one. Throws with the road's own sentence (ssh's line on the ssh road), which is what a person reads in place
 * of a wsp-shaped refusal. */
export type PlaceDialler = (login: PlaceLogin) => Promise<void>;

/** The last lines the agent wrote on a computer, read over the login it was installed over. Answers nothing where
 * there is no log to read, which is a fact about that computer and not a reason to stop. */
export type PlaceLogReader = (login: PlaceLogin) => Promise<readonly string[]>;

/** What one update is told: which computer, what it last said about itself (its chip picks the binary), whether
 * this one carries a binary, the link this host is holding where it holds one, and the login it was installed
 * over where the record holds one. Which of the two roads it takes is the updater's own reading, since only it
 * knows what each can carry. */
export interface PlaceUpdateRequest {
  placeId: string;
  name: string;
  report: PlaceReport;
  /** Whether a daemon goes with this update: false on a computer already running this wsp's daemon, where the
   * login files are written all the same, since their spelling moves with the host and not with the daemon. */
  daemon: boolean;
  link?: DaemonReach;
  ssh?: PlaceLogin;
}

/** What an update answers: which road carried the binary, where it landed on that computer, and where the one it
 * replaced was kept, which is the first thing to look at on a box whose daemon will not come up. */
export interface PlaceUpdateLanded {
  road: "link" | "ssh";
  at: string;
  kept?: string;
}

/** How the daemon this host deploys is put on a computer already joined, and how wsp's login files there are
 * written on every update. Nothing is answered where no binary was asked for. Absent on a runtime served without
 * it, where a place stays on the daemon it has and its login files stay as the join wrote them. */
export type PlaceUpdater = (req: PlaceUpdateRequest) => Promise<PlaceUpdateLanded | undefined>;

/** What one leave over the ssh road is told: which computer, what it last said about itself (its own line for
 * running wsp there is in that report), and the login it was installed over. */
export interface PlaceLeaveRequest {
  placeId: string;
  name: string;
  report: PlaceReport;
  ssh: PlaceLogin;
}

/** How the agent comes off a computer this host holds no link to: the leave that computer already carries, run
 * over the login the install used. Answers the lines it said it took; throws the road's own sentence where the
 * computer will not answer, which leaves the remove saying the agent is still installed. */
export type PlaceLeaver = (req: PlaceLeaveRequest) => Promise<readonly string[]>;

/** What one install is told: where to log in, what to call the computer, the single-use code it spends on this
 * host, and the addresses that computer is to dial it at, in the order its link tries them. The addresses are the
 * door's own reading, handed down rather than read a second time here. */
export interface PlaceInstallRequest {
  address: string;
  name?: string;
  sshPort?: number;
  keyPath?: string;
  /** The host key the person confirmed or pinned; the install compares what answered the first dial against it
   * before anything of wsp's is sent, and refuses a computer nobody confirmed a key for. */
  hostKey?: string;
  /** The whole token the join on that computer spends: the single-use code and the fingerprint of the key this
   * host will prove, as one word, the same one the printed join line carries. */
  code: string;
  hostUrls: readonly string[];
  /** The door's port on this computer's loopback, where the door is a listener of its own: what a forward over ssh
   * lands on. Absent on a host bound beyond loopback, where a forward would land on the owner's own road. */
  doorPort?: number;
  /** The relay's address among `hostUrls`, when this host is linked to one. */
  relay?: string;
}

/** What the install answers once the computer has run its own join: the name it was given, and the key its ssh
 * answered with, which a person checks against the computer in front of them. */
export interface PlaceInstalled {
  name: string;
  hostKey?: string;
  /** The login it logged in as, in the spelling a person would type back; kept on the record as that computer's
   * address and used by every later dial of it. */
  ssh?: string;
  /** The key file the person named at the add, where they named one. Every ssh child runs with BatchMode on, so a
   * later dial that did not carry it would be refused for the publickey on a computer that is on, which is the
   * confusion this road exists to end. */
  sshKeyPath?: string;
  /** The forward that computer dials back through, where it reached this host no other way. */
  back?: PlaceBack;
}

/** How far one install has got; the words for each step are the protocol's. */
export type PlaceStaging = (step: PlaceAddStep, state: "running" | "done" | "failed", note?: string, placeId?: string) => void;
export type PlaceInstaller = (req: PlaceInstallRequest, stage: PlaceStaging) => Promise<PlaceInstalled>;

/** The one road into the runtime a place needs, handed in because it is the runtime's own: a place holds its forks
 * and the projects recorded on it, and a remove refuses to take the place out from under either. */
export interface PlaceRecording {
  /** The names of the forks standing on this place: the machines wsp made there, which are the only workspaces a
   * place carries. */
  forksOn(placeId: string): Promise<string[]>;
  /** The names of the projects recorded on this place, which every workspace of them is a copy for. */
  projectsOn(placeId: string): Promise<string[]>;
}

export interface PlaceDoorOptions {
  store: Store;
  /** The one code store, so a join code and a pairing code are spent by one road. */
  devices: DeviceDoor;
  wiring: PlaceWiring;
  recording: PlaceRecording;
  /** Where this host can fork beyond the computers joined to it: the provider it is wired to and every other
   * provider whose key it holds. A thunk because the runtime builds that table after this door. Absent leaves the
   * wired provider as the only one, which is what a runtime with no provider table has. */
  providers?: () => PlaceBackends;
  /** Every daemon event a place pushes; the panes and the inbox read these once they ride the link. */
  onDaemonEvent?: (placeId: string, event: DaemonEvent) => void;
  /** How far an install on a computer this host has never met has got; the runtime puts these on its own stream. */
  onStage?: (event: PlaceStageEvent) => void;
  /** What a place's row says about its copy of the image while it is not standing: the stage of the build running
   * there, or the reason the last one stopped. The runtime holds the builds, so it answers; nothing for a copy that
   * stands. `stopped` says which of the two the line is. */
  copyBuild?: (placeId: string) => { line: string; stopped: boolean } | undefined;
  /** How long a computer has to dial back after its join before an install gives up on it. */
  joinWaitMs?: number;
  /** How long a computer that took an update has to dial back running it before the row is answered with what it
   * still reads; tests shrink it. */
  updateWaitMs?: number;
  /** How long one dial of a computer gets before it is an answer of its own. The bound is the runtime's and not
   * the backend's: a road that hangs rather than refusing must still answer the person who pressed the button. */
  dialWaitMs?: number;
  /** How long one machine frame waits for its answer when the caller named no bound of its own; tests shrink it. */
  frameWaitMs?: number;
  /** How long a request that may be asked again waits for a computer's link to come back before it fails as one
   * that may not does; tests shrink it. */
  relinkWaitMs?: number;
  /** How long between the writes of a linked place's last seen, so a link held for a day is not a write a second. */
  seenEveryMs?: number;
  /** What this host holds for the agents, read at every ask as the turns read it: which variable is held decides
   * the sign-in word a computer's row says for an agent that keeps no login of its own there. Absent is a vault
   * holding nothing, which is what a host wired without one has. */
  vault?: () => Readonly<Record<string, string>>;
  now?: () => number;
}

/** The host's half of one handshake: what it answers the other end with, the bytes that end's own signature must
 * cover, and the seal the frames after the answer ride inside. */
export interface PlaceChallenge {
  nonce: string;
  hostPublicKey: string;
  signature: string;
  ephemeral: string;
  expect: Uint8Array;
  seal: Seal;
}

/** The host's side of the place link: the records, the keys, the handshake, the live links and what a remove takes. */
export interface PlaceDoor {
  /** The host's half of a handshake with whoever is on the other end, signed with the key this door holds and
   * nobody outside it reads: a place under its own id, a native client under the client's word. Nothing where the
   * other end sent no half of a key agreement, which only a wsp older than the seal does. */
  answerChallenge(subject: string, nonce: string, ephemeral: string | undefined): PlaceChallenge | undefined;
  /** The first frame of a joining computer. Answers the reply and the bytes its prove must sign, or nothing when
   * the code is not one this host is holding. Throws with its own sentence for a key or a report it cannot take. */
  join(req: PlaceJoinRequest, from: string, now: number): Promise<{ reply: PlaceJoinReply; expect: Uint8Array; seal: Seal; notice?: string } | undefined>;
  /** The first frame of a place that already joined. A place this host holds no record of is refused with this
   * host's own key and a signature over the refusal transcript, which that computer verifies against the key it
   * pinned at join: a refusal it can prove is one it waits ten minutes on rather than dialling every half minute
   * for good. Throws with its own sentence for a computer this host cannot agree a key with. */
  auth(req: PlaceAuthRequest, now: number): Promise<{ reply: PlaceAuthReply; expect: Uint8Array; seal: Seal } | { refusal: string; signed: PlaceAuthRefusal }>;
  /** The fingerprint of the key this door proves at every join, for the token a join line carries. Read off the
   * pair the handshake signs with, so a line can never name a key this door will not answer with. */
  hostKey(): string;
  /** Checks the place's signature over `expect` with the key on record and reads the report it sent by the one rule
   * every report is read by. Answers the report `attach` is to take, or the sentence to refuse the socket with:
   * the key's or the report's own. A join's prove is where its code is spent and its record written, and where
   * the token its own window asked for is answered. Attaches nothing yet. */
  prove(placeId: string, req: PlaceProveRequest, expect: Uint8Array, from: string, now: number): Promise<{ report: PlaceReport; device?: { deviceId: string; deviceToken: string } } | { refusal: string }>;
  /** Takes the proved socket as this place's link, with the report `prove` answered and the seal its frames ride
   * inside; the previous link is cut. */
  attach(placeId: string, socket: WebSocket, report: PlaceReport, from: string, now: number, seal?: Seal): Promise<void>;
  link(placeId: string): DaemonReach | undefined;
  /** A channel to the daemon on one computer this host holds, over the link that computer is holding: frames go
   * up that link and the events it pushes come back to `onEvent`, so a road on this host drives that computer's
   * own terminal. Nothing is dialled and no token is spent: only that computer can open a socket to this host,
   * and this is the one it opened. Undefined on a place that is not connected. */
  channel(placeId: string, onEvent: (event: Record<string, unknown>) => void): DaemonChannel | undefined;
  /** Reads what this host holds about its places into memory, so the backend a fork on one stands on is answered
   * without a read of the store; the hydration calls it once before it reads any workspace record. */
  load(): Promise<void>;
  /** The backend a place offers, off what it last said about it; undefined on a place that has never said. On a
   * place that is not connected the backend is still answered, so a record standing on it can be held without a
   * round trip, and every call on it rejects with PlaceAbsentError. */
  backendOf(placeId: string): MachineBackend | undefined;
  /** The same, asked of the place itself where this host has not heard yet: one frame, remembered on the record, so
   * every road after it is answered without one. Refuses with placeForksNowhereLine on a computer that offers no
   * backend at all. */
  forkingBackend(placeId: string): Promise<MachineBackend>;
  /** The name a place goes by, for the sentences a person reads; the id itself for a place this host holds no
   * record of. Answered without a read, so a refusal built while a road is running names the computer. */
  nameOf(placeId: string): string;
  /** The sign-in word per agent on one computer, off the report it last sent and the vault this host holds: the
   * same reading its row carries, so what a turn is handed and what the screen says cannot part ways. Answered
   * without a read of the store, since every launch on that computer asks it. Nothing for a place this host holds
   * no record of and for a computer whose daemon lists no logins. */
  signInsAt(placeId: string): Record<string, AgentSignInState> | undefined;
  /** An agent's own sign-in on that computer landed, as the tool's status there said: the file its shared login
   * writes is taken as listed, so every word read before that computer's next report says signed in. */
  loginLanded(placeId: string, agent: string): Promise<void>;
  /** Which backend that computer offers, by the id of the row it serves; nothing until it has said. What a fork
   * standing there was forked by, so a row names a real provider and not the one this host happens to be wired
   * for. Answered without a read, since every view of every workspace asks it. */
  offerOf(placeId: string): string | undefined;
  /** A port on this computer's loopback carried to one port on the place's own, for as long as this host runs: the
   * place's own daemon port and every fork's daemon port ride the same code. The same pair answers the same local
   * port every time, and the listener stays bound while the link is down, so nothing cached goes stale. */
  forward(placeId: string, placePort: number): Promise<{ localPort: number }>;
  /** The place a person's word names: an id, a name, or this computer itself, which is answered with no id since
   * the host's own backend is what a fork there lands on. Refuses with noSuchPlaceRefusal naming what is held. */
  placeFor(word: string): Promise<{ placeId?: string }>;
  /** Where a fork lands when nobody says: the last place added or used, or this computer when that mark names a
   * row this host no longer holds. */
  defaultPlace(): Promise<{ placeId?: string }>;
  /** Writes the default mark: the last place a fork landed on. */
  markUsed(placeId: string | undefined): Promise<void>;
  /** Marks the place default where no mark names a place this host holds: where the first image is sealed. */
  markDefaultIfNone(placeId: string): Promise<void>;
  /** Puts the agent on a computer over ssh and waits for it to dial back as a place. Refused in one sentence on a
   * host that wired no installer. */
  add(req: { addId?: string; address: string; name?: string; sshPort?: number; keyPath?: string; hostKey?: string; hostUrls: readonly string[]; doorPort?: number; relay?: string }, now: number): Promise<PlaceAdded>;
  /** Dials one computer once: a frame over the link it is holding, or one login over the road it was added on when
   * it holds none. Answers what came back and writes it on the record, so a window opened later reads the same
   * answer. Nothing is installed and nothing is left running either way. */
  dial(placeId: string, now: number): Promise<PlaceDial>;
  /** The port on this computer's loopback that carries to the daemon on a linked place, opened at the first ask
   * and held with the link. Throws with the place's name when it is not connected or has said no port. */
  road(placeId: string): Promise<number>;
  /** One command on that place over its link; the refusal names the place when it is not connected. */
  exec(placeId: string, cmd: string, opts: { timeoutMs?: number; stdin?: Uint8Array }): Promise<ExecResult>;
  /** What the place last reported about itself, off its record. */
  reportOf(placeId: string): Promise<PlaceReport | undefined>;
  /** The home the place's login lands in, which every path a turn there is built from. */
  homeOf(placeId: string): Promise<string | undefined>;
  list(now: number): Promise<PlaceView[]>;
  /** Every add over ssh still running and the last ADDS_KEPT that finished, oldest first. */
  adds(): PlaceAddJob[];
  /** Puts the daemon this host deploys on one place where it is behind, then runs the recipe job on it. Refuses in
   * one sentence a place this host does not hold, and a computer that is behind on a runtime wired with no
   * updater; a computer already on this daemon takes the job alone. */
  update(placeId: string, addId?: string): Promise<PlaceUpdateReply>;
  remove(placeId: string): Promise<PlaceRemoved>;
  /** Every place a word picks, by id or by the name the person gave it: none, one, or the two that share a name,
   * which is a refusal the caller writes with the ids in it. */
  find(ref: string): Promise<PlaceRecord[]>;
  on(fn: (e: PlaceEvent) => void): () => void;
  close(): Promise<void>;
}

/** The one refusal for a runtime served without places wired, so the ops answer plainly rather than pretending
 * this host holds none. */
export const NO_PLACE_DOOR = "this runtime holds no places; the host that serves the app wires them";

/** The refusal an update gets on a runtime wired with no road to put a daemon on a computer. */
export const NO_PLACE_UPDATER = "this runtime carries no daemon to put on a computer; the host that serves the app wires one";

/** What the answer says about a computer that took the daemon and had not come back on it before the wait ran out.
 * Nothing has failed: the unit restarts it and the row moves on its next link. */
export const placeUpdateSlowLine = (name: string, seconds: number): string =>
  `${name} took the daemon and had not dialled back on it within ${seconds}s; its row reads the new version once it does`;

/** What a remove says about the road the sweep took, which is the one thing a person cannot see from here. Two
 * wordings of the one fact: a computer that was dialling this host was swept over the login all the same, since
 * the agent answering on the link is the one the service restarts and cannot take that service with it, and a
 * computer that was holding no link had nothing but the login to reach it by. */
export const placeSweptOverSshLine = (name: string, at: string, linked = false): string =>
  linked
    ? `${name} was connected, and wsp logged in at ${at} over ssh to run the leave there: what answers on the link takes the files it owns and not the service that restarts it`
    : `${name} was holding no link, so wsp logged in at ${at} over ssh and ran the leave there`;

/** Why the leave over the login on the record did not finish it, which is two different things and never one: the
 * login itself would not stand, or that computer took the leave, ran it and stopped before it was done, in which
 * case its own last words are the only reading of how far it got. Every sentence about the road that had to follow
 * carries this one, since a person reading which road finished needs what the first one did. */
export const placeLoginRoadLine = (name: string, at: string, said?: string): string =>
  said === undefined ? `${name} did not answer the login at ${at}` : `${name} ran the leave over the login at ${at} and did not finish it (${said})`;

/** What a remove says when the road that logs in did not finish it and the place swept itself over the link
 * instead. The two roads take different things off, so which one finished is a person's to know: this one left the
 * service that starts the agent on that computer, and nothing here can reach it to take it. */
export const placeSweptOverLinkLine = (name: string, at: string, said?: string): string =>
  `${placeLoginRoadLine(name, at, said)}, so it swept itself over the link: its files came off and the service that starts the agent there did not`;

/** The refusal the login itself got, as against anything the computer at the end of it said: ssh would not take
 * the login, so nothing ran there at all. The roads that log in throw this one for that case alone, and the lines
 * a person reads about them turn on it. */
export class PlaceLoginRefusedError extends Error {
  readonly kind = PLACE_LOGIN_REFUSED_KIND;
}

/** A place that runs no workspaces: a joined computer whose doctor said no, or a provider with nothing to fork on.
 * The one refusal a default place may be passed over for; every other failure on it is the person's to read. */
export class PlaceForksNowhereError extends Error {}

/** An add that failed after bytes landed and whose installer took every one of them back off the computer, so a
 * join that had landed there no longer stands on it either. */
export class PlaceAddTakenBackError extends Error {}

/** A computer that is not forked into while the recipe job on it runs, which is a state of that job and not a
 * fact about the computer: the sentence is the person's own either way, and the class is what tells the roads
 * that only wait for the job apart from the ones that report a refusal. The kind rides the class, so every road
 * that throws one answers the person in the class a create there has always been refused in. */
export class PlaceProvisioningError extends Error {
  readonly kind = "conflict";
}

/** What an install answers once the computer has dialled in: which stream of steps it was, the place it became,
 * the key its ssh answered with, and why the recipe job did not start where it did not. The place's own row
 * carries that job while it runs, so a caller reads one or the other and never both. */
export interface PlaceAdded {
  addId: string;
  place: PlaceView;
  hostKey?: string;
  said?: string;
}

/** What a remove answers: whether a place of that id was there, what the sweep took off that computer, what the
 * workspaces standing on it said as they went, and the one line for a place that was not connected to sweep. */
export interface PlaceRemoved {
  removed: boolean;
  swept: string[];
  note?: string;
}

/** One promise with a bound of its own: a place that took a frame and went quiet fails the call rather than
 * leaving a road waiting on a socket nothing is coming back on. */
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} was not answered in ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
    work.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** The pair each end of a link proves itself with, the fingerprint a person copies and the signatures over the
 * transcript both ends build: they live in their own package, since the command line holds a host to its key
 * before it sends a token and cannot load this one to do it. Named here too, where every reader of the link
 * already looks for them. */
export { newPlaceKeyPair, signPlaceBytes, verifyPlaceBytes, type PlaceKeyPair } from "@wsp/keys";

/** Whether a public key off the wire is an ed25519 one this host can verify against later. Read before the code is
 * spent, so a key that opens nothing never costs somebody their join code. */
function readsAsEd25519(publicKeyBase64: string): boolean {
  try {
    return createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" }).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/** How long a join that has been answered has to send its prove before this host forgets it was asked. Longer
 * than any handshake and shorter than a code's own life, so nothing a person is still typing is swept. */
const JOIN_PROVE_MS = 2 * 60_000;

/** The one sentence a join whose key this host cannot verify against is refused with. */
export const PLACE_BAD_KEY_REFUSAL = "that join sent a key this host cannot verify a signature against; a place's key is ed25519, as SPKI DER in base64";

/** The one sentence a report naming a home wsp cannot build a path under is refused with, on a join and on every
 * link after it. Everything a turn there runs is built from that path, so it is held to the rule every machine's
 * home is held to. */
export const placeHomeRefusal = (said: string | undefined): string =>
  `that computer reported ${said === undefined || said === "" ? "no home folder" : `${JSON.stringify(said)}, which is not a plain path`} for its login, so nothing on it could be reached; wsp holds a machine's home to a plain absolute path`;

/** Every report this host will build a path out of goes through here, and a report reaches this host on three
 * frames: the join, the prove that follows it, and the prove of every relink after that. The rule is the ssh read's
 * own, since what is in a report lands in the commands the host runs on that computer: the home a path is built
 * from is refused when it is not a plain path, the PATH is held to the folders that are ones, and a harness's store
 * folder is kept only where it is one. Answers the report this host will keep, or throws the refusal.
 *
 * The door's two entry points for a report, `join` and `prove`, are its only callers; `attach` takes what `prove`
 * answered, so no road can hand this host a report nothing read. */
export function takenReport(report: PlaceReport): PlaceReport {
  const home = report.login["HOME"];
  if (home === undefined || !isPlainPath(home)) throw new Error(placeHomeRefusal(home));
  const login: Record<string, string> = { ...report.login, HOME: home, PATH: plainPath(report.login["PATH"]) };
  for (const name of SSH_STORE_VARS) {
    const folder = login[name];
    if (folder !== undefined && !isPlainPath(folder)) delete login[name];
  }
  return { ...report, login };
}

/** What stands for each agent a computer reported, in the one word a person reads: its own login on that computer
 * when the file that login shares is under the logins folder the computer listed, else the vault's variable for
 * that agent when this host holds one, else nothing. Nothing at all where the report carries no logins list, which
 * is a daemon older than that field: unknown reads as unknown and not as none.
 *
 * The computer knows no catalog and the host does, so the list of files goes on the wire and the words are worked
 * out here, off the same sign-in rows the sign-in screens and the turns read. */
export function signInsOf(
  report: Pick<PlaceReport, "agents" | "logins">,
  vault: Readonly<Record<string, string>>,
): Record<string, AgentSignInState> | undefined {
  if (report.logins === undefined) return undefined;
  const stands = new Set(report.logins);
  const words: Record<string, AgentSignInState> = {};
  for (const id of report.agents) {
    const file = sharedLoginFile(id);
    if (file !== undefined && stands.has(file)) {
      words[id] = "signed-in";
      continue;
    }
    words[id] = vaultSignIn(id, vault);
  }
  return words;
}

/** The file under a computer's logins folder that an agent's shared login writes, named as the report lists it;
 * nothing for an agent whose login no workspace shares. */
function sharedLoginFile(agentId: string): string | undefined {
  const shared = sharedOn(agentId);
  return shared === undefined ? undefined : sharedFileIn(shared);
}

/** The word for an agent whose own login is not on the computer: this host's vault holds the token or the key it
 * reads, which every turn there is handed, or nothing stands for it. The one reading every sign-in word falls to. */
export function vaultSignIn(agentId: string, vault: Readonly<Record<string, string>>): AgentSignInState {
  const signIn = CATALOG_AGENTS.find(a => a.id === agentId)?.signIn;
  const token = signIn !== undefined && mintsToken(signIn) ? vault[signIn.tokenEnv] : undefined;
  const keyEnv = signIn === undefined ? undefined : keyEnvOf(signIn);
  return token !== undefined || (keyEnv !== undefined && vault[keyEnv] !== undefined) ? "vault-key" : "none";
}

/** How long between writes of a linked place's last seen. */
const SEEN_EVERY_MS = 60_000;

/** What a socket is closed with when a newer link for the same place arrives: a laptop that slept and came back is
 * the common case, and the old socket is a connection nothing is on the other end of. */
const REPLACED = "replaced by a newer link";

interface Live {
  socket: WebSocket;
  reach: DaemonReach;
  seen: NodeJS.Timeout;
  /** The loopback port carrying to that computer's daemon, opened at the first pane that asks for one. */
  forward?: Promise<PlaceForward>;
}

/** One port on this computer carried to one port on a place: the listener, which stays bound while the link comes
 * and goes, and the connections riding it right now by the id the far side knows each by. */
interface Forward {
  server: Server;
  localPort: number;
  conns: Map<string, Socket>;
}

/** How long a machine frame waits for its answer when the caller named no bound of its own. A link that dies fails
 * every frame on it at once, so this is the backstop for a place that took the frame and went quiet. No frame does
 * minutes of work: a snapshot is a job the place names at once and is asked after a frame at a time. */
const LINK_FRAME_MS = 300_000;

/** How long a request the host may ask again waits for the computer to open a socket again. A daemon whose link
 * dropped dials this host back in seconds and its own backoff is bounded well under this, so a gap this long is a
 * computer that went away rather than a socket that blinked, and the stage waiting on it says so and stops. */
const RELINK_WAIT_MS = 120_000;

/** How long a place gets to say what its backend is, and how long the table asking what room it has left waits;
 * a person is watching both, and a place that does not answer in time shows what this host already knows. */
const BACKEND_FACTS_MS = 10_000;
/** How long an install waits for that answer before it answers the person: one round trip on a socket the
 * computer has just opened, and no more, since the row it prints is a line at a terminal. */
const ADD_FACTS_MS = 2_000;
const CAPACITY_MS = 5_000;
/** How long one dial of a computer gets before it is an answer of its own: a person is watching the button they
 * pressed, and a road that is going to answer answers in well under this. */
const DIAL_MS = 20_000;

/** How long a computer has to dial back after its own join wrote its place file. A join that landed and a link
 * that never arrives is a network between the two, which is what the sentence says. */
const JOIN_WAIT_MS = 90_000;

/** Finished adds kept beside the running ones, for a sheet opened after one ended to read what it came to. */
const ADDS_KEPT = 20;
/** An add names its own stream so its steps can arrive before its answer; a second add under a running one's name
 * would land its steps on the first's job. */
const ADD_RUNNING_LINE = "an add under that id is still running";
const ADD_RUNNING_FIX = "Leave the id out, or name the add afresh.";

/** What the box itself said while that wait ran out, where this host holds a login to it and the road to read it:
 * the agent's log names the address it could not dial and why. A read that will not take adds nothing, since the
 * sentence above it is the one the person came for. */
async function boxSaid(wiring: PlaceWiring, installed: PlaceInstalled): Promise<readonly string[]> {
  if (wiring.log === undefined || installed.ssh === undefined) return [];
  const login = { ssh: installed.ssh, ...(installed.sshKeyPath !== undefined ? { keyPath: installed.sshKeyPath } : {}) };
  return await wiring.log(login).catch(() => []);
}

/** What a job the host was driving reads as once that host is gone: nothing outlives the process that drove it,
 * so the record is not left saying a run is under way that nothing is running. */
export const PROVISION_HOST_STOPPED = "the host stopped while it ran";

/** How often the job's lines are appended to the log on the computer, and how many lines go without waiting for
 * that: one exec per line would be one frame per line on a run of hundreds. */
const PROVISION_LOG_EVERY_MS = 2_000;
const PROVISION_LOG_LINES = 50;

/** How long a computer that took an update has to come back up running it. The unit restarts the daemon within
 * seconds and its link backs off from two, so a minute is the row reading the new version as the ticket asks
 * rather than a wait a person sits through; a computer slower than that is answered with what it still reads and
 * the reason. */
const UPDATE_WAIT_MS = 60_000;
/** How often the record is read while that wait runs. */
const UPDATE_POLL_MS = 500;

/** How long the servers wsp merged into the agents' own files on a computer get to come out before the leave goes
 * on without them: a leave is a decision already made, and one frame of the several this takes may sit out the
 * whole link wait on a computer that is connected and answering nothing. */
const UNMERGE_MS = 60_000;

export function makePlaceDoor(opts: PlaceDoorOptions): PlaceDoor {
  const { store, devices, wiring, recording } = opts;
  const clockNow = opts.now ?? Date.now;
  const seenEveryMs = opts.seenEveryMs ?? SEEN_EVERY_MS;
  const dialWaitMs = opts.dialWaitMs ?? DIAL_MS;
  const frameWaitMs = opts.frameWaitMs ?? LINK_FRAME_MS;
  const relinkWaitMs = opts.relinkWaitMs ?? RELINK_WAIT_MS;
  const live = new Map<string, Live>();
  /** The records as they stand, by id: `load` fills it and every write below keeps it, so the one road that must
   * answer without waiting (which backend a fork's record stands on) can. */
  const kept = new Map<string, PlaceRecord>();
  /** The backend each place offers, built once from what that place said about it and swapped when it says
   * something else; the link under it is the door's, so the same object serves a place that comes and goes. */
  const backends = new Map<string, MachineBackend>();
  const forwards = new Map<string, Forward>();
  /** The read of one place's backend facts that is in flight, so two roads asking at once send one frame. */
  const asking = new Map<string, Promise<MachineBackend>>();
  const watchers = new Set<(e: PlaceEvent) => void>();
  let tunnelSeq = 0;
  const emit = (e: PlaceEvent): void => {
    for (const fn of watchers) fn(e);
  };

  const records = async (): Promise<PlaceRecord[]> => (await store.list(PLACES)).filter(isPlaceRecord).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  /** The provider this host forks on when nobody names a place: the place a record with no place word stands on.
   * The wiring is what says whether this host forks on a provider at all; a runtime served with no wiring of its
   * own has a one-row table standing for its backend, which is no place a person names. */
  const wiredProvider = (): string | undefined => wiring.provider?.()?.id;
  /** Every provider a fork can land at, in the table's own order, the wired one among them. A host wired to one
   * cloud that holds the key for another can fork at either, so both are rows a person names; a host wired to
   * nowhere still lists every other provider it holds a key for. */
  const providerIds = (): readonly string[] => {
    const wired = wiredProvider();
    const table = opts.providers?.();
    const listed = table?.list() ?? [];
    if (wired === undefined) return listed.filter(id => id !== table?.wired);
    return listed.includes(wired) ? listed : [wired];
  };
  /** The backend of a provider row, or nothing when the word names no provider this host holds a key for. */
  const providerBackend = (placeId: string): MachineBackend | undefined => opts.providers?.().backend(placeId);
  /** What one provider charges an hour for its default size, read off the backend the host built for it, so a row
   * added by saving a key carries its price with no second table. */
  const providerRate = (placeId: string): number | undefined => {
    const at = placeId === wiredProvider() ? undefined : providerBackend(placeId);
    if (at === undefined) return placeId === wiredProvider() ? wiring.provider?.()?.rateUsdPerHour : undefined;
    return at.pricing.rateUsdPerHour(at.pricing.defaultSize);
  };
  /** The sizes one provider offers, each at that provider's own rate, read off the backend the host built for it.
   * A picker that took one list for every row quoted one provider's prices under another's name. Empty where this
   * host holds no backend for the row, which is a row with no pick to offer rather than a row of free sizes. */
  const providerSizes = (placeId: string): readonly MachineSizeOffer[] => providerBackend(placeId)?.capabilities.sizes ?? [];
  /** What a row says about the image there: whether a copy can stand on it at all, and the build running or stopped
   * there. Nothing about the first for a place whose backend this host has not heard yet. */
  const imageFacts = (placeId: string, at: MachineBackend | undefined): Pick<PlaceView, "build" | "buildStopped" | "buildsImages"> => {
    const build = opts.copyBuild?.(placeId);
    return {
      ...(at !== undefined ? { buildsImages: buildsImages(at.capabilities) } : {}),
      ...(build !== undefined ? { build: build.line, ...(build.stopped ? { buildStopped: true } : {}) } : {}),
    };
  };
  const recordOf = async (placeId: string): Promise<PlaceRecord | undefined> => {
    const found = await store.get(PLACES, placeId);
    return isPlaceRecord(found) ? found : undefined;
  };
  /** The version the place reports once it has dialled back, or what it still reads when the wait runs out. The
   * record is what a link writes its report onto, so this reads the one fact every other row reads. */
  const untilDaemonVersion = async (placeId: string, from: number, waitMs: number): Promise<number> => {
    const until = clockNow() + waitMs;
    for (;;) {
      const version = (await recordOf(placeId))?.report.daemonVersion ?? from;
      if (version >= DAEMON_VERSION || clockNow() >= until) return version;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, UPDATE_POLL_MS);
        timer.unref?.();
      });
    }
  };

  /** The installs waiting on a computer to dial in, keyed by the code each handed it: the join notes which place
   * the code became and the attach that follows wakes the install. The login the install logged in over is here
   * too, from the moment its ssh answered, since the record is written by whichever of the two lands second. */
  const awaiting = new Map<string, { placeId?: string; login?: PlaceLogin; back?: PlaceBack; woken?: (placeId: string) => void }>();

  /** The adds over ssh, oldest first, for the host's life: a finished one past the last ADDS_KEPT goes. */
  const adds = new Map<string, PlaceAddJob>();
  const putAdd = (addId: string, next: (job: PlaceAddJob) => PlaceAddJob): void => {
    const job = adds.get(addId);
    if (job === undefined) return;
    adds.set(addId, next(job));
    const finished = [...adds.values()].filter(j => j.state !== "running");
    for (const gone of finished.slice(0, Math.max(0, finished.length - ADDS_KEPT))) adds.delete(gone.addId);
  };

  /** The road the install came in over, written onto a record: the join frame the record is made from says nothing
   * about how the computer was reached, and every later dial, update and read of its log rides this login. */
  const withRoad = (record: PlaceRecord, install: { login?: PlaceLogin; back?: PlaceBack } | undefined): PlaceRecord =>
    install?.login === undefined
      ? record
      : { ...record, road: { ...record.road, ssh: install.login.ssh, ...(install.login.keyPath !== undefined ? { keyPath: install.login.keyPath } : {}), ...(install.back !== undefined ? { back: install.back } : {}) } };

  /** The login this host holds for a computer, as every road that logs in to one takes it: the address in the
   * spelling a person would type and the key file the add named beside it, off the record's own road. Nothing
   * where the record carries none, which is a computer that joined by typing a code. */
  const loginOf = (record: PlaceRecord): PlaceLogin | undefined => {
    const ssh = sshRoadOf(record.road);
    return ssh === undefined ? undefined : { ssh, ...(record.road?.keyPath === undefined ? {} : { keyPath: record.road.keyPath }) };
  };

  /** Whether the login this host holds for a computer answers at all, over the one probe that installs nothing and
   * leaves nothing running, bounded as every other dial of a computer is. Its point is what it saves: the leave
   * that follows waits out systemd's own stop, which is minutes, and a computer whose ssh answers nothing would
   * charge a person watching a button all of it. A runtime wired with no probe has nothing to say against trying,
   * so it answers yes. */
  const loginAnswers = async (login: PlaceLogin): Promise<boolean> => {
    if (wiring.dial === undefined) return true;
    try {
      await bounded(wiring.dial(login), dialWaitMs, `ssh ${login.ssh}`);
      return true;
    } catch {
      return false;
    }
  };

  /** The login an install in flight logged in over, by the place its code became; nothing for every computer no
   * install is putting the agent on right now, whose record already carries whatever road it has. */
  const roadOfInstall = (placeId: string): { login?: PlaceLogin; back?: PlaceBack } | undefined => {
    for (const waiting of awaiting.values()) if (waiting.placeId === placeId) return waiting;
    return undefined;
  };

  /** Keeps the forward a record dials back through held, and writes the port it moved to onto every record of that
   * login. Nothing for a record with no forward, or a host wired with no holder. */
  const holdBack = (record: PlaceRecord): void => {
    const login = loginOf(record);
    const back = record.road?.back;
    const home = record.report.login["HOME"];
    if (wiring.back === undefined || login === undefined || back === undefined || home === undefined) return;
    const moved = (to: PlaceBack): void => {
      void (async () => {
        for (const id of [...kept.keys()]) {
          const current = await recordOf(id);
          // A remove that landed during the read deleted it: a write now would put the removed record back.
          if (current !== undefined && kept.has(id) && loginOf(current)?.ssh === login.ssh && current.road !== undefined) await keep({ ...current, road: { ...current.road, back: to } });
        }
      })().catch(() => undefined);
    };
    // The holder makes it again for as long as it is held, so a first try that failed is not the last.
    void wiring.back.hold(login, back, { home }, moved).catch(() => undefined);
  };

  /** The one write of a place record: the store and the memory the sync roads read both move, so a backend answered
   * without a read is never answered off a record the store has moved past. An install still in flight has its
   * login written on every one of them, so the join's own record and the link's first write carry the road back
   * rather than a write after the wait having to add it. */
  const keep = async (record: PlaceRecord): Promise<PlaceRecord> => {
    const held = withRoad(record, roadOfInstall(record.id));
    kept.set(held.id, held);
    await store.put(PLACES, held.id, held);
    return held;
  };
  const defaultId = async (): Promise<string | undefined> => {
    const held = (await store.get(DEFAULT_COLLECTION, DEFAULT_ID)) as { placeId?: unknown } | undefined;
    return typeof held?.placeId === "string" ? held.placeId : undefined;
  };
  // Every write of the mark takes its turn here, so a check-then-write at a seal never lands over a mark set meanwhile.
  let marking: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(write: () => Promise<T>): Promise<T> => {
    const run = marking.then(write);
    marking = run.catch(() => {});
    return run;
  };
  const markDefault = (placeId: string): Promise<void> => inTurn(() => store.put(DEFAULT_COLLECTION, DEFAULT_ID, { placeId }));
  /** The mark while it names this computer or a place this host still holds; a mark on a row since gone is none. */
  const markHeld = async (): Promise<string | undefined> => {
    const marked = await defaultId();
    if (marked === undefined) return undefined;
    return marked === HERE_PLACE_ID || providerIds().includes(marked) || (await records()).some(r => r.id === marked) ? marked : undefined;
  };

  /** The host's half of the handshake, the one place it is built and the one place its private key is read: a
   * fresh nonce and a fresh key agreement, the signature over the transcript the other end challenged with, the
   * bytes that end's own signature must cover, and the seal every frame after this reply rides inside. The
   * ephemerals are inside both transcripts, so the key the two ends agree is one both signatures cover and a
   * carrier that swapped either has signed nothing. `subject` is the place id for a link and the client's word
   * for a native client, which holds no record here and signs nothing back. Nothing where the other end sent no
   * key of its own to agree with. */
  const challenge = (subject: string, theirNonce: string, theirEphemeral: string | undefined): PlaceChallenge | undefined => {
    if (theirEphemeral === undefined) return undefined;
    const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
    const mine = freshEphemeral();
    let secret: Buffer;
    try {
      secret = sharedSecret(mine.privateKey, theirEphemeral);
    } catch {
      return undefined;
    }
    return {
      nonce,
      hostPublicKey: wiring.hostKey.publicKey,
      ephemeral: mine.publicKey,
      signature: signPlaceBytes(wiring.hostKey.privateKeyPem, placeLinkTranscript("host", subject, theirNonce, nonce, { challenger: theirEphemeral, answerer: mine.publicKey })),
      expect: placeLinkTranscript("place", subject, nonce, theirNonce, { challenger: mine.publicKey, answerer: theirEphemeral }),
      seal: makeSeal(sealKeys(secret, subject), "host"),
    };
  };

  /** This host's word on a refusal it sends before it has proved anything else: its key, and its signature over
   * the place id, the nonce that dial challenged with and the sentence. */
  const signedRefusal = (placeId: string, placeNonce: string, sentence: string): PlaceAuthRefusal => ({
    hostPublicKey: wiring.hostKey.publicKey,
    signature: signPlaceBytes(wiring.hostKey.privateKeyPem, placeRefusalTranscript(placeId, placeNonce, sentence)),
  });

  const writeSeen = async (placeId: string, at: number): Promise<void> => {
    const held = await recordOf(placeId);
    if (held === undefined) return;
    await keep({ ...held, lastSeenAt: new Date(at).toISOString() });
  };

  /** Who is reading one computer's daemon events, by place id: the channels a road on this host opened over that
   * computer's link. A channel is the one road the events it asked for come back on, so a pty on one computer is
   * never pushed at a reader of another. */
  const channels = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  /** What is waiting for one computer to open a socket again, by its place id: every ask that may be made a second
   * time parks here for the gap, and the attach that takes the next socket wakes them. */
  const waiting = new Map<string, Set<(back: boolean) => void>>();
  /** When each computer's last socket closed under this host, by place id. A gap is a computer between sockets, and
   * this is the only reading that tells one from a computer that is simply off: an ask made into the gap is waited
   * out from the close, and an ask made at a computer this host holds no closed socket for is refused at once, as
   * every ask at an absent computer was before anything waited. */
  const closedAt = new Map<string, number>();
  /** Ends every wait on one computer: true for the socket it just opened, false for a place this host is letting
   * go, which leaves each held request failing with what it failed with the first time. */
  const woken = (placeId: string, back: boolean): void => {
    const held = waiting.get(placeId);
    waiting.delete(placeId);
    for (const wake of held ?? []) wake(back);
  };
  /** Waits for that computer to dial in again, up to `until`. False on a link that is up, which is what says a
   * frame failed on the far side's own answer rather than on the road, and false on a computer that did not come
   * back inside the wait. A socket that is closing is not up: its frames are already refused and its close event is
   * on its way, so a wait on it waits for the socket after it. */
  const dialsBack = (placeId: string, until: number): Promise<boolean> =>
    new Promise(resolve => {
      const up = live.get(placeId);
      if (up !== undefined && up.socket.readyState === up.socket.OPEN) return resolve(false);
      const left = until - Date.now();
      if (left <= 0) return resolve(false);
      const held = waiting.get(placeId) ?? new Set<(back: boolean) => void>();
      waiting.set(placeId, held);
      const wake = (back: boolean): void => {
        held.delete(wake);
        clearTimeout(timer);
        resolve(back);
      };
      const timer = setTimeout(() => wake(false), left);
      timer.unref?.();
      held.add(wake);
    });

  /** The computers a recipe job is going on, by place id: one per computer, so a second run is refused rather than
   * two runs installing over each other. A computer is in here from before the recipe is read, which is a read of
   * this whole computer, until its rows are done. */
  const provisioning = new Set<string>();

  /** The sentence another run of the recipe on this computer is refused with, naming the row under way where the
   * job has reached one; nothing when none is going on. The one reading, so the start, the update and the gate a
   * create passes cannot disagree about whether a computer is busy. */
  const provisioningNow = (record: PlaceRecord): string | undefined =>
    provisioning.has(record.id) || record.provision?.state === "running" ? placeProvisioningLine(record.name, record.provision?.at) : undefined;

  /** The one write of a place's provision: onto the record as it stands rather than as it was when the row landed,
   * since an attach's write of lastSeenAt is going on beside it. */
  const writeProvision = async (placeId: string, provision: PlaceProvision): Promise<void> => {
    const now = await recordOf(placeId);
    if (now === undefined) return;
    await keep({ ...now, provision });
  };

  /** One step of the recipe job on the stream whoever asked for it is watching. The computer rides every one of
   * them: this job is on a computer this host already holds, so a reader that acts on the job's end rather than
   * printing it reads the row off the event and not off the stream's own id. */
  const provisionStage = (placeId: string, addId: string, state: "running" | "done" | "failed", note?: string, failed?: number): void => {
    opts.onStage?.({ type: "place.stage", addId, placeId, step: "provision", state, ...(note !== undefined ? { note } : {}), ...(failed !== undefined ? { failed } : {}) });
  };

  /** The job's own log and outcome on the computer itself, so a person at its shell reads what happened without
   * this host: the lines appended in batches, the outcome written whole at the end. Nothing here fails the job; a
   * computer that will not take its own log is still a computer the recipe landed on. */
  const provisionRecord = (machine: Machine, home: string, header: string) => {
    const at = placeProvisionPaths(home);
    // The time goes on the line as it is written, not as its batch goes up: the lines travel in batches, and a
    // batch's own moment says nothing about when the job reached the line.
    const stamped = (line: string): string => provisionLogLine(clockNow(), line);
    let lines: string[] = [stamped(header)];
    let timer: NodeJS.Timeout | undefined;
    let writing: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const sending = lines;
      lines = [];
      if (sending.length === 0) return writing;
      writing = writing.then(() => putFiles(machine, [{ path: at.log, text: `${sending.join("\n")}\n`, append: true }]).then(() => undefined)).catch(() => undefined);
      return writing;
    };
    return {
      write: (line: string): void => {
        lines.push(stamped(line));
        if (lines.length >= PROVISION_LOG_LINES) void flush();
        else if (timer === undefined) {
          timer = setTimeout(() => void flush(), PROVISION_LOG_EVERY_MS);
          timer.unref?.();
        }
      },
      close: async (provision: PlaceProvision): Promise<void> => {
        await flush();
        await putFiles(machine, [{ path: at.result, text: `${JSON.stringify(provision, null, 2)}\n` }]).catch(() => undefined);
      },
    };
  };

  /** The run itself, behind whoever asked for it: every row onto the record as its outcome arrives, every line on
   * the place's own stage stream and in the log on that computer, and the state at the end. A throw is the
   * computer having stopped answering, which leaves the job stopped with its first line. */
  const runProvision = async (placeId: string, addId: string, planned: ProvisionPlan, machine: Machine, home: string, started: PlaceProvision): Promise<void> => {
    const provisioner = wiring.provision;
    if (provisioner === undefined) return;
    const log = provisionRecord(machine, home, `wsp ${wiring.hostName()} put the recipe of ${planned.recipeAt} on this computer at ${started.startedAt}: ${provisionCountWord(provisionCountsOf(planned))}`);
    let held = started;
    let writing: Promise<void> = Promise.resolve();
    const push = (next: PlaceProvision): void => {
      held = next;
      writing = writing.then(() => writeProvision(placeId, next)).catch(() => undefined);
    };
    const stage: ProvisionStage = (detail, at, row) => {
      log.write(detail);
      provisionStage(placeId, addId, "running", detail);
      // The record is written when the job moved, not on every line a step prints: a step's output is hundreds of
      // lines and each write is the whole state file.
      const moved = at !== undefined && (held.at?.index !== at.index || held.at.label !== at.label);
      if (row === undefined && !moved) return;
      push({ ...held, rows: row === undefined ? held.rows : [...held.rows, row], ...(at === undefined ? {} : { at }) });
    };
    try {
      const rows = await provisioner.run(machine, planned, stage, { home });
      const { at: _under, ...rest } = held;
      push({ ...rest, state: "done", finishedAt: new Date(clockNow()).toISOString(), rows });
      await writing;
      provisionStage(placeId, addId, "done", provisionLines(kept.get(placeId)?.name ?? placeId, held).join("; "), rows.filter(r => r.outcome === "failed").length);
    } catch (e) {
      const said = (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
      const { at: _under, ...rest } = held;
      push({ ...rest, state: "stopped", said, finishedAt: new Date(clockNow()).toISOString() });
      await writing;
      provisionStage(placeId, addId, "failed", said);
    }
    // Behind the job rather than inside it: the outcome on that computer is the last write and a link that has
    // gone waits out its own retries, and a second update is refused only while rows are actually going on.
    void log.close(held);
  };

  /** Starts the recipe job on one computer and answers how it stands the moment it is under way, so a person who
   * asked for a join or an update reads a row that is already running. The plan is read here, which is this
   * computer being read; everything after it happens behind the answer. Nothing at all on a host that wired no
   * provisioner, which is what every runtime outside the app has. */
  const startProvision = async (placeId: string, addId: string): Promise<{ provision?: PlaceProvision; said?: string }> => {
    const provisioner = wiring.provision;
    if (provisioner === undefined) return {};
    const record = await recordOf(placeId);
    if (record === undefined) return {};
    // The one answer a busy computer gets, whoever asked: the same conflict the update throws, from the same
    // reading. A join takes it as the sentence its reply carries, since a computer that just joined is nobody's
    // to be running the recipe on and a join that reached here is not failed by it.
    const busy = provisioningNow(record);
    if (busy !== undefined) throw Object.assign(new Error(busy), { kind: "conflict" });
    const home = record.report.login["HOME"];
    // Every path the job builds comes off that home, so a computer that reported none gets no recipe and says so.
    if (home === undefined) return { said: placeNoHomeLine(record.name) };
    // The slot is taken before the recipe is read, and that read is a read of this whole computer: two starts
    // inside it would both have passed the check above and installed over each other on that box.
    provisioning.add(placeId);
    try {
      const planned = await provisioner.plan({ home });
      if ("noRecipe" in planned) {
        provisioning.delete(placeId);
        return { said: placeNoRecipeLine(record.name, planned.noRecipe) };
      }
      const provision: PlaceProvision = { state: "running", addId, recipeAt: planned.recipeAt, startedAt: new Date(clockNow()).toISOString(), rows: [] };
      await writeProvision(placeId, provision);
      provisionStage(placeId, addId, "running", `${provisionCountWord(provisionCountsOf(planned))} from the recipe of ${planned.recipeAt}`);
      // The computer itself, not a workspace on it: the link it is holding to this host, driven as a machine.
      const machine = new PlaceMachine(linkTo(placeId), { id: record.name, home });
      void runProvision(placeId, addId, planned, machine, home, provision).finally(() => provisioning.delete(placeId));
      return { provision };
    } catch (e) {
      provisioning.delete(placeId);
      throw e;
    }
  };

  /** The start above with its own refusal as a sentence: a recipe this host cannot read is a computer that got no
   * agents, not a join or an update that failed after the daemon landed. */
  const startedOrSaid = (placeId: string, addId: string): Promise<{ provision?: PlaceProvision; said?: string }> =>
    startProvision(placeId, addId).catch((e: unknown) => ({ said: (e instanceof Error ? e.message : String(e)).split("\n")[0]! }));

  /** The servers wsp merged into the agents' own files on that computer, taken back out over the link before the
   * leave takes the rest: the computer itself driven as a machine, the way the recipe's job drives it. Nothing
   * here fails the leave, which is a decision already made by the time it runs. */
  const unmergedOver = async (placeId: string, held: PlaceRecord): Promise<string[]> => {
    const home = held.report.login["HOME"];
    if (home === undefined) return [];
    const machine = new PlaceMachine(linkTo(placeId), { id: held.name, home });
    const took = await bounded(unmergeServers(machineServerPort(machine), home), UNMERGE_MS, `the servers wsp merged into the agents' files on ${held.name}`).catch(() => []);
    return took.flatMap(serversOutLines);
  };

  /** The record with what that computer forks with on it, waited for no longer than one round trip on a link
   * that is up: the read behind this writes the record whenever the answer lands, so a computer slower than
   * that is joined, or updated, all the same and its row fills in at the read after. Where the facts are already
   * on the record this answers at once, since the read is dropped for a computer that has said. */
  const factsOn = async (placeId: string, held: PlaceRecord): Promise<PlaceRecord> => {
    const read = door
      .forkingBackend(placeId)
      .then(async () => (await recordOf(placeId)) ?? held)
      .catch(() => held);
    return Promise.race([
      read,
      new Promise<PlaceRecord>(resolve => {
        const timer = setTimeout(() => resolve(held), ADD_FACTS_MS);
        timer.unref?.();
      }),
    ]);
  };

  /** The road the engine drives one place's machines over: one frame and its answer, and the loopback forward a
   * route into a machine there is taken by. A place that is not connected is PlaceAbsentError on every call, which
   * is the one answer every road on an absent place reads.
   *
   * A frame the caller named an idempotency key for is the one thing that outlives a gap: the socket under it going
   * away is waited out for `relinkWaitMs` from the first gap and the frame is sent again on the socket that computer
   * opens next. Nothing else is, since the far side runs what it is sent; a frame with no key fails on the gap as it
   * always has, and so does one whose wait ran out, with the sentence it failed with. */
  const linkTo = (placeId: string): MachineLink => ({
    request: async (op, params, o) => {
      // The bound runs from the gap, not from the ask: a frame may be in flight for minutes before the link under
      // it goes, and a frame asked into a gap that is already open has however much of the wait is left. Read once,
      // at the first gap this request meets.
      let until = 0;
      const waitingFrom = (from: number): number => (until === 0 ? (until = from + relinkWaitMs) : until);
      for (;;) {
        const held = live.get(placeId);
        if (held === undefined) {
          const absent = new PlaceAbsentError(absentComputer(kept.get(placeId)?.name ?? placeId, null).sentence);
          // A computer whose socket closed inside the wait is between sockets; one this host holds no closed socket
          // for is off, or was never here, and nothing is coming that waiting would catch.
          const closed = closedAt.get(placeId);
          if (o?.idempotencyKey === undefined || closed === undefined || !(await dialsBack(placeId, waitingFrom(closed)))) throw absent;
          continue;
        }
        try {
          return await bounded(held.reach.request(op, params), o?.timeoutMs ?? frameWaitMs, `${op} on ${kept.get(placeId)?.name ?? placeId}`);
        } catch (e) {
          // The socket this frame rode is still the one this host holds and is still open, so the place answered
          // for itself: a refusal, or a silence the frame's own bound ended. Neither is a gap to wait out. A socket
          // that is closing is already a gap, and is read as one before its close event lands.
          const now = live.get(placeId);
          if (o?.idempotencyKey === undefined || (now?.reach === held.reach && now.socket.readyState === now.socket.OPEN)) throw e;
          // A computer that dialled back while the frame was failing is here already; the rest wait for it.
          if (now !== undefined && now.reach !== held.reach && Date.now() < waitingFrom(Date.now())) continue;
          if (!(await dialsBack(placeId, waitingFrom(Date.now())))) throw e;
        }
      }
    },
    dialsBack: () => dialsBack(placeId, Date.now() + relinkWaitMs),
    forward: placePort => door.forward(placeId, placePort),
  });

  /** The backend a place offers, off the facts it last sent. Built once per place and kept: the link under it reads
   * the live socket at every call, so one backend serves a computer that comes and goes. */
  const backendFrom = (placeId: string, facts: BackendFacts): MachineBackend => {
    const made = LinkBackend.of(linkTo(placeId), facts);
    backends.set(placeId, made);
    return made;
  };

  /** A frame the forward owns rather than the panes: the bytes of one connection riding a tunnel, or its end.
   * Answers whether it was taken; a tunnel another road on this link opened is that road's to read. */
  const tunnelled = (placeId: string, e: DaemonEvent): boolean => {
    if (e.type !== "tunnel.data" && e.type !== "tunnel.end") return false;
    const conn = connOf(placeId, e.tunnelId);
    if (conn === undefined) return false;
    if (e.type === "tunnel.data") conn.write(Buffer.from(e.data, "base64"));
    else conn.end();
    return true;
  };
  const connOf = (placeId: string, tunnelId: string): Socket | undefined => {
    for (const [key, f] of forwards) {
      if (!key.startsWith(`${placeId}:`)) continue;
      const conn = f.conns.get(tunnelId);
      if (conn !== undefined) return conn;
    }
    return undefined;
  };

  /** Frees what this host holds about one link: the poller, the reach and the socket. The place's own redial is
   * what brings the next one. */
  const cut = (placeId: string, reason: string): void => {
    const held = live.get(placeId);
    if (held === undefined) return;
    live.delete(placeId);
    clearInterval(held.seen);
    void held.forward?.then(f => f.close()).catch(() => undefined);
    held.reach.close();
    held.socket.close(1000, reason);
  };

  /** How many forks run on a place and how many more it takes now, off what its own backend says about the computer
   * it runs on. Only what this host already knows is waited for: a table is something a person is watching, so a
   * place that has not yet said what it forks with shows nothing in that column and is asked behind the listing, and
   * one that does not answer in time shows nothing rather than a guess. */
  const forksOf = async (record: PlaceRecord): Promise<{ running: number; room: number } | undefined> => {
    const linked = live.has(record.id);
    const backend = linked ? door.backendOf(record.id) : undefined;
    if (backend === undefined) {
      if (linked) void door.forkingBackend(record.id).catch(() => undefined);
      return undefined;
    }
    if (backend.capacity === undefined) return undefined;
    try {
      const capacity = await bounded(backend.capacity(), CAPACITY_MS, `machine.capacity on ${record.name}`);
      const image = capacity.images.reduce((most, i) => Math.max(most, i.sizeBytes), 0);
      return {
        // What runs there now. A napping fork holds the disk its copy takes and no cpu or memory, so counting it
        // here would say a slot is taken that a create can have; the workspace list is where a napping one is
        // counted and its state said, and the disk it holds is the row's own disk free column.
        running: capacity.machines.running,
        // What a fork takes there, not what it would be asked for: a computer clamps a machine to its own share.
        room: forkRoom(capacity, Math.min(backend.pricing.defaultSize.memMb, capacity.machineMemMb), image === 0 ? undefined : image),
      };
    } catch {
      return undefined;
    }
  };

  const viewOf = (record: PlaceRecord, defaulted: string | undefined): PlaceView => {
    const blocked = placeBlocked(record.name, record.report);
    return {
      id: record.id,
      kind: "computer",
      name: record.name,
      default: defaulted === record.id,
      os: record.report.os,
      shape: record.report.shape,
      ...(record.report.diskFreeBytes !== undefined ? { diskFreeBytes: record.report.diskFreeBytes } : {}),
      engine: record.report.engine,
      ...(record.report.copies !== undefined ? { copies: record.report.copies } : {}),
      present: live.has(record.id),
      joinedAt: record.joinedAt,
      lastSeenAt: record.lastSeenAt,
      daemonVersion: record.report.daemonVersion,
      agents: record.report.agents,
      ...(record.report.agentVersions !== undefined ? { agentVersions: record.report.agentVersions } : {}),
      // One word per agent for whether a turn there needs a sign-in first, worked out from what that computer listed
      // under its logins folder and what this host's vault holds. Nothing from a daemon that lists neither.
      ...((): { signIns?: Record<string, AgentSignInState> } => {
        const words = signInsOf(record.report, opts.vault?.() ?? {});
        return words === undefined ? {} : { signIns: words };
      })(),
      ...(record.backendFacts?.logins !== undefined ? { logins: record.backendFacts.logins } : {}),
      // A joined computer boots the image or it never joined: the daemon's self check is the gate at the join, so
      // every computer on this list forks.
      takesForks: true,
      // Field by field rather than spread: the key file on the record is a path on this computer and no client's
      // business, and a road copied whole would hand it over.
      ...(record.road === undefined
        ? {}
        : { road: { ...(record.road.ssh !== undefined ? { ssh: record.road.ssh } : {}), ...(record.road.from !== undefined ? { from: record.road.from } : {}), ...(record.road.back !== undefined ? { back: record.road.back } : {}) } }),
      // The folder a turn there starts in and how long it had been up: read off the same report the system name is
      // read from, so a computer that stopped answering shows what it last was rather than nothing at all.
      ...(record.report.login["HOME"] !== undefined ? { home: record.report.login["HOME"] } : {}),
      ...(record.report.uptimeMs !== undefined ? { uptimeMs: record.report.uptimeMs } : {}),
      ...(record.reportedAt !== undefined ? { reportedAt: record.reportedAt } : {}),
      ...(record.dialled !== undefined ? { dialled: record.dialled } : {}),
      ...(blocked !== undefined ? { blocked } : {}),
      ...(record.provision !== undefined ? { provision: record.provision } : {}),
    };
  };

  /** What a join has told this host before its prove: the key it will sign with and when it opened. The record is
   * written on the prove, so a join whose prove never arrives leaves nothing behind but this, and the next join
   * sweeps whatever stood past the wait. */
  const joining = new Map<string, { publicKey: string; at: number }>();

  /** The join's own half of the prove: the code is spent here, inside the seal and after this host has proved the
   * key the join line named, and the record is written only once all of it stood. */
  const joined = async (
    placeId: string,
    pending: { publicKey: string },
    req: PlaceProveRequest,
    expect: Uint8Array,
    from: string,
    at: number,
  ): Promise<{ report: PlaceReport; device?: { deviceId: string; deviceToken: string } } | { refusal: string }> => {
    joining.delete(placeId);
    if (!verifyPlaceBytes(pending.publicKey, expect, req.signature)) return { refusal: PLACE_KEY_REFUSAL };
    let taken: PlaceReport;
    try {
      taken = takenReport(req.report);
    } catch (e) {
      return { refusal: e instanceof Error ? e.message : String(e) };
    }
    // A computer that cannot boot the image is not a place: the daemon's own doctor says why in one sentence and
    // the join stops on it, before the code is spent and before a record exists.
    const blocked = placeBlocked(taken.name, taken);
    if (blocked !== undefined) return { refusal: blocked };
    if (req.code === undefined || !(await devices.spend(req.code, at))) return { refusal: PLACE_CODE_REFUSAL };
    const stamp = new Date(at).toISOString();
    // An install that handed this computer the code is waiting on the link it will open next; which place the
    // code became is noted before the first write of the record, so that write carries the road it came in over.
    const waiting = awaiting.get(req.code);
    if (waiting !== undefined) waiting.placeId = placeId;
    const record = await keep({ id: placeId, name: taken.name, publicKey: pending.publicKey, joinedAt: stamp, lastSeenAt: stamp, reportedAt: stamp, report: taken });
    // Last added is the default, which is what makes the computer somebody just joined the one a verb means.
    await markDefault(placeId);
    // One code buys the place and, when the app asked, the token the joining computer's own window holds: the
    // person's intent was one act. The socket stays the place link and is bound to no device.
    const client = req.client === undefined ? undefined : await devices.admit(req.client.name, at);
    emit({ type: "place.joined", place: viewOf(record, placeId), from });
    return { report: taken, ...(client === undefined ? {} : { device: { deviceId: client.deviceId, deviceToken: client.deviceToken } }) };
  };

  /** Takes a place off this host: its link, its record, the default it may be, and anyone waiting on its dial. */
  const forget = async (placeId: string): Promise<void> => {
    if (live.has(placeId)) cut(placeId, "removed from this host");
    kept.delete(placeId);
    backends.delete(placeId);
    await store.delete(PLACES, placeId);
    await inTurn(async () => {
      if ((await defaultId()) === placeId) await store.delete(DEFAULT_COLLECTION, DEFAULT_ID);
    });
    woken(placeId, false);
    closedAt.delete(placeId);
    emit({ type: "place.removed", placeId });
  };

  const door: PlaceDoor = {
    answerChallenge: challenge,

    async join(req, _from, at) {
      // The key is read before anything else: a frame that names no key this host can hold is a join that was
      // never going to stand, and nothing of the person's has crossed yet either way.
      if (!readsAsEd25519(req.publicKey)) throw new Error(PLACE_BAD_KEY_REFUSAL);
      // Eight bytes: the id keys the store, so two places that drew the same one would be one record and the older
      // computer's link would replace the newer's on every dial.
      const id = `p_${randomBytes(8).toString("hex")}`;
      const opened = challenge(id, req.nonce, req.ephemeral);
      if (opened === undefined) throw new Error(PLACE_UNSEALED_JOIN_REFUSAL);
      // Nothing is written and no code is spent until the prove: the code, the report and the window this
      // computer wants ride inside the seal, after this host has proved the key the join line named.
      for (const [waiting, held] of joining) if (at - held.at > JOIN_PROVE_MS) joining.delete(waiting);
      joining.set(id, { publicKey: req.publicKey, at });
      return {
        reply: { placeId: id, hostPublicKey: opened.hostPublicKey, nonce: opened.nonce, signature: opened.signature, ephemeral: opened.ephemeral, hostName: wiring.hostName() },
        expect: opened.expect,
        seal: opened.seal,
      };
    },

    async auth(req) {
      const held = await recordOf(req.placeId);
      // The sentence signed before it is sent: the key is this host's own and the place pinned it at join, so
      // this host can give its word on a place it holds nothing of, which is the whole of what the refusal says.
      if (held === undefined) {
        return { refusal: PLACE_UNKNOWN_REFUSAL, signed: signedRefusal(req.placeId, req.nonce, PLACE_UNKNOWN_REFUSAL) };
      }
      const opened = challenge(req.placeId, req.nonce, req.ephemeral);
      // A daemon older than the seal agrees no key: the row already says it is behind and why, and that is the
      // sentence its link is refused with rather than one about a field.
      if (opened === undefined) throw new Error(placeBehindLine(held.name, placeDaemonBehind(held.report) ?? ""));
      return { reply: { nonce: opened.nonce, hostPublicKey: opened.hostPublicKey, signature: opened.signature, ephemeral: opened.ephemeral }, expect: opened.expect, seal: opened.seal };
    },

    hostKey() {
      return keyFingerprint(wiring.hostKey.publicKey);
    },

    async prove(placeId, req, expect, from, at) {
      const pending = joining.get(placeId);
      if (pending !== undefined) return joined(placeId, pending, req, expect, from, at);
      const held = await recordOf(placeId);
      if (held === undefined || !verifyPlaceBytes(held.publicKey, expect, req.signature)) return { refusal: PLACE_KEY_REFUSAL };
      const report = req.report;
      // The report on this frame is the one the record takes, on a join's second frame and on every relink alike,
      // so it is read by the same rule the join's own frame was.
      let taken: PlaceReport;
      try {
        taken = takenReport(report);
      } catch (e) {
        return { refusal: e instanceof Error ? e.message : String(e) };
      }
      return { report: taken };
    },

    async attach(placeId, socket, report, from, at, seal) {
      // A second link replaces the first: a laptop that slept and came back dials before the host has noticed the
      // old socket is a connection to nothing.
      cut(placeId, REPLACED);
      const held = await recordOf(placeId);
      if (held === undefined) {
        socket.close(1000, "this host no longer holds that place");
        return;
      }
      // Where the link dialled in from is the only address this host has for a computer that joined with a code,
      // so it is kept rather than only announced on the event. What the last dial of this computer said goes with
      // the link that arrived: the computer is here now, and a refusal from before it came back is not news.
      // The name is the one this computer joined under and is never taken off a report again: a box whose own
      // place file a hostile process edited would otherwise answer to another computer's name and take its
      // creates, its checkout and the keys of the turns that run there.
      const moved: PlaceRecord = { ...held, report, lastSeenAt: new Date(at).toISOString(), reportedAt: new Date(at).toISOString(), road: { ...held.road, from }, dialled: undefined };
      // What a computer forks with belongs to the daemon that said it: one that dialled back on another version
      // is asked again rather than read off an answer the version before it gave, since a newer daemon can carry
      // a field the older one never did and an older one can have lost it. The read is the attach's own, below.
      const newDaemon = held.report.daemonVersion !== report.daemonVersion;
      if (newDaemon) {
        delete moved.backendFacts;
        backends.delete(placeId);
        asking.delete(placeId);
      }
      await keep(moved);
      const reach = connectDaemon({
        socket,
        ...(seal === undefined ? {} : { seal }),
        onEvent: e => {
          // A tunnel's bytes belong to the connection riding the forward that opened it and to nothing else on
          // this host: the road a fork's daemon is reached by reads its own frames, the pane's road reads the
          // rest, and neither is pushed at every watcher of the place.
          if (tunnelled(placeId, e)) return;
          void live.get(placeId)?.forward?.then(f => f.event(e)).catch(() => undefined);
          for (const read of channels.get(placeId) ?? []) read(e as unknown as Record<string, unknown>);
          opts.onDaemonEvent?.(placeId, e);
        },
      });
      const seen = setInterval(() => void writeSeen(placeId, clockNow()).catch(() => undefined), seenEveryMs);
      // The poller must not hold a host that is otherwise done open.
      seen.unref?.();
      live.set(placeId, { socket, reach, seen });
      // Before anything else this attach does: a request held over the gap is sent again on this socket, and the
      // stage waiting on it was told to wait rather than told the computer was gone.
      woken(placeId, true);
      // What the computer forks with is asked behind the attach and not in front of it, so the link is held whether
      // or not that answer comes and the first listing after a join carries the room it has left.
      // A computer whose recipe is running has said nothing wrong: that job's own end asks again, so the read is
      // quiet about it rather than logging a computer that would not say.
      void door.forkingBackend(placeId).catch((e: unknown) => {
        if (e instanceof PlaceProvisioningError) return;
        console.warn(`${moved.name} did not say what it forks with: ${e instanceof Error ? e.message : String(e)}`);
      });
      socket.once("close", () => {
        const mine = live.get(placeId);
        if (mine?.socket !== socket) return;
        live.delete(placeId);
        closedAt.set(placeId, Date.now());
        clearInterval(seen);
        // The port this host opened for that computer's panes goes with the link that carried them: a listener
        // left standing would answer a pane with a connection to nothing.
        void mine.forward?.then(f => f.close()).catch(() => undefined);
        reach.close();
        void writeSeen(placeId, clockNow()).catch(() => undefined);
        emit({ type: "place.absent", placeId });
      });
      emit({ type: "place.present", placeId, from });
      // Not taken off the list here: the join's own socket attaches and closes before the agent's link dials, and
      // an install that has not reached its wait yet would otherwise never be woken by the link that follows.
      for (const waiting of awaiting.values()) {
        if (waiting.placeId === placeId) waiting.woken?.(placeId);
      }
    },

    link: placeId => live.get(placeId)?.reach,

    channel(placeId, onEvent) {
      const held = live.get(placeId);
      if (held === undefined) return undefined;
      const reading = channels.get(placeId) ?? new Set<(event: Record<string, unknown>) => void>();
      channels.set(placeId, reading);
      reading.add(onEvent);
      let end: (gone: { code: number; reason: string }) => void = () => {};
      const closed = new Promise<{ code: number; reason: string }>(r => (end = r));
      // The link going away ends the channel, as a daemon socket closing ends the host's own: whatever was
      // running behind it on that computer is no longer something this host can read or stop. The listener comes
      // off with the channel, so a road that opens and closes many never piles them on one socket.
      const gone = (code: number, reason: Buffer): void => {
        forget();
        end({ code, reason: reason.toString("utf8") });
      };
      const forget = (): void => {
        reading.delete(onEvent);
        if (reading.size === 0) channels.delete(placeId);
        held.socket.off("close", gone);
      };
      held.socket.once("close", gone);
      return {
        send: frame => {
          const { op, ...params } = frame;
          const on = live.get(placeId);
          if (on?.reach !== held.reach) return Promise.reject(new PlaceAbsentError(absentComputer(kept.get(placeId)?.name ?? placeId, null).sentence));
          return on.reach.request(op, params) as Promise<DaemonResponse>;
        },
        closed,
        close: () => {
          forget();
          end({ code: 1000, reason: "closed here" });
        },
      };
    },

    async load() {
      for (const record of await records()) {
        kept.set(record.id, record);
        if (record.backendFacts !== undefined && !backends.has(record.id)) backendFrom(record.id, record.backendFacts);
        holdBack(record);
        // No job outlives the host that drove it, so a record left running is stopped here rather than holding
        // the gate on that computer shut for good.
        if (record.provision?.state === "running") {
          const { at: _under, ...rest } = record.provision;
          await writeProvision(record.id, { ...rest, state: "stopped", said: PROVISION_HOST_STOPPED, finishedAt: new Date(clockNow()).toISOString() });
        }
      }
    },

    nameOf: placeId => kept.get(placeId)?.name ?? placeId,

    signInsAt: placeId => {
      const report = kept.get(placeId)?.report;
      return report === undefined ? undefined : signInsOf(report, opts.vault?.() ?? {});
    },

    async loginLanded(placeId, agent) {
      const file = sharedLoginFile(agent);
      // Read and written with no wait between, so a remove or a newer report landing meanwhile is never written over.
      const record = kept.get(placeId);
      const listed = record?.report.logins;
      if (file === undefined || record === undefined || listed === undefined || listed.includes(file)) return;
      await keep({ ...record, report: { ...record.report, logins: [...listed, file].sort() } });
    },

    offerOf: placeId => kept.get(placeId)?.backendFacts?.offer ?? (providerIds().includes(placeId) ? placeId : undefined),

    backendOf(placeId) {
      const made = backends.get(placeId);
      if (made !== undefined) return made;
      const facts = kept.get(placeId)?.backendFacts;
      if (facts !== undefined) return backendFrom(placeId, facts);
      // No record and no facts: the word names a provider row rather than a computer, and its backend is the one
      // the host built for that provider.
      return kept.has(placeId) ? undefined : providerBackend(placeId);
    },

    async forkingBackend(placeId) {
      const record = (await recordOf(placeId)) ?? kept.get(placeId);
      // A place that is no joined computer is a provider row: it forks by its own module and there is no link to
      // ask what it forks with.
      if (record === undefined) {
        const at = providerBackend(placeId);
        if (at !== undefined) return at;
      }
      const name = record?.name ?? placeId;
      if (record === undefined) {
        backends.delete(placeId);
        throw new PlaceForksNowhereError(placeForksNowhereLine(name));
      }
      // A computer whose recipe is still going on is not forked into while it runs: the workspace would come up
      // without the agent the job is putting there. The running workspaces on it are untouched, since they read
      // backendOf and not this.
      const busy = provisioningNow(record);
      if (busy !== undefined) throw new PlaceProvisioningError(busy);
      const made = door.backendOf(placeId);
      if (made !== undefined) return made;
      // The first fork on this computer is where the host learns what it forks with; every road after it reads the
      // answer off the record, so this frame is sent once per computer and not once per fork.
      const inflight = asking.get(placeId);
      if (inflight !== undefined) return inflight;
      const read = (async () => {
        const answer = await bounded(linkTo(placeId).request("machine.backend"), BACKEND_FACTS_MS, `machine.backend on ${name}`);
        const facts = BackendFacts.parse(answer);
        // Onto the record as it stands rather than as it was when the frame went out, and only while the daemon
        // that answered is still the one running there: a computer that dialled back on another version while
        // this was out has a read of its own behind that attach, and this answer is not its facts any more.
        const now = (await recordOf(placeId)) ?? record;
        if (now.report.daemonVersion !== record.report.daemonVersion) return LinkBackend.of(linkTo(placeId), facts);
        await keep({ ...now, backendFacts: facts });
        return backendFrom(placeId, facts);
      })().finally(() => asking.delete(placeId));
      asking.set(placeId, read);
      return read;
    },

    async forward(placeId, placePort) {
      const key = `${placeId}:${placePort}`;
      const already = forwards.get(key);
      if (already !== undefined) return { localPort: already.localPort };
      const conns = new Map<string, Socket>();
      const server = createServer(conn => {
        const tunnelId = `p${++tunnelSeq}`;
        const reach = live.get(placeId)?.reach;
        conn.on("error", () => {});
        if (reach === undefined) {
          // The listener stays bound while the place is away: the route this host handed out keeps its port, and a
          // connection made meanwhile is refused rather than held.
          conn.destroy();
          return;
        }
        conns.set(tunnelId, conn);
        conn.pause();
        conn.on("close", () => {
          conns.delete(tunnelId);
          void reach.request("tunnel.close", { tunnelId }).catch(() => undefined);
        });
        reach.request("tunnel.open", { tunnelId, port: placePort }).then(
          () => {
            conn.on("data", (d: Buffer) => void reach.request("tunnel.write", { tunnelId, data: d.toString("base64") }).catch(() => conn.destroy()));
            conn.resume();
          },
          () => {
            conns.delete(tunnelId);
            conn.destroy();
          },
        );
      });
      const localPort = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, () => {
          server.unref();
          const addr = server.address();
          resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
        });
      });
      forwards.set(key, { server, localPort, conns });
      return { localPort };
    },

    async placeFor(word) {
      const all = await records();
      const found = all.filter(r => namesPlace(r, word));
      // Two computers by one word is two a person joined under one name: a relink cannot take another's, so this
      // is theirs to tell apart, and every create and image build that names the word reads the ids rather than
      // landing on whichever record joined first.
      if (found.length > 1) throw new Error(twoPlacesRefusal(word, found.map(r => r.id)));
      if (found[0] !== undefined) return { placeId: found[0].id };
      const here = wiring.here().name;
      const providers = providerIds();
      // The wired provider is where a record with no place word already stands, so naming it is that same road and
      // the record stays as every record before joined computers existed.
      if (word === HERE_PLACE_ID || word === here || word === wiredProvider()) return {};
      if (providers.includes(word)) return { placeId: word };
      throw new Error(noSuchPlaceRefusal(word, [here, ...all.map(r => r.name), ...providers]));
    },

    async defaultPlace() {
      const marked = await defaultId();
      if (marked === undefined) return {};
      const found = (await records()).find(r => r.id === marked);
      if (found !== undefined) return { placeId: found.id };
      // A provider the last fork landed on that is not the one this host is wired to is still that place.
      return marked !== wiredProvider() && providerIds().includes(marked) ? { placeId: marked } : {};
    },

    async markUsed(placeId) {
      await markDefault(placeId ?? wiredProvider() ?? HERE_PLACE_ID);
    },

    async markDefaultIfNone(placeId) {
      await inTurn(async () => {
        if ((await markHeld()) === undefined) await store.put(DEFAULT_COLLECTION, DEFAULT_ID, { placeId });
      });
    },

    async add(req, at) {
      const install = wiring.install;
      if (install === undefined) throw new Error(NO_PLACE_INSTALLER);
      const addId = req.addId ?? `a_${randomBytes(6).toString("hex")}`;
      if (adds.get(addId)?.state === "running") throw usageRefusal(ADD_RUNNING_LINE, ADD_RUNNING_FIX);
      let step: PlaceAddStep = "connect";
      const stage: PlaceStaging = (which, state, note, placeId) => {
        if (state === "running") step = which;
        const said: PlaceStageEvent = { type: "place.stage", addId, step: which, state, ...(note !== undefined ? { note } : {}), ...(placeId !== undefined ? { placeId } : {}) };
        putAdd(addId, job => withPlaceStage(job, said));
        opts.onStage?.(said);
      };
      const { code } = await devices.issue({ now: at, ttlMs: PAIR_CODE_TTL_MS });
      // Kept from here, where the catch below ends every add it starts: a job that never ends would read as running.
      adds.delete(addId);
      adds.set(addId, { addId, address: req.address, ...(req.sshPort !== undefined ? { sshPort: req.sshPort } : {}), startedAt: new Date(at).toISOString(), state: "running", steps: [] });
      const waiting: { placeId?: string; login?: PlaceLogin; back?: PlaceBack; woken?: (placeId: string) => void } = {};
      awaiting.set(code, waiting);
      let installing = true;
      try {
        const { addId: _stream, ...asked } = req;
        const installed = await install({ ...asked, code: joinToken(code, keyFingerprint(wiring.hostKey.publicKey)) }, stage);
        installing = false;
        // The road back to this computer is the host's the moment the install answers, and what the wait comes to
        // does not change it: the computer that most needs a login held here is the one whose agent never dials.
        // A join still to land carries it off this entry; one that already landed has its record written again.
        waiting.login = installed.ssh === undefined ? undefined : { ssh: installed.ssh, ...(installed.sshKeyPath !== undefined ? { keyPath: installed.sshKeyPath } : {}) };
        if (installed.back !== undefined) waiting.back = installed.back;
        const early = waiting.login === undefined || waiting.placeId === undefined ? undefined : await recordOf(waiting.placeId);
        if (early !== undefined) await keep(early);
        stage("join", "running");
        const placeId = await new Promise<string>((woken, fail) => {
          // The link may already be up: the computer dials the moment its own join has written its place file, and
          // that can land before the install's own ssh command has answered.
          if (waiting.placeId !== undefined && live.has(waiting.placeId)) {
            woken(waiting.placeId);
            return;
          }
          const timer = setTimeout(() => fail(new Error(placeNoLinkLine(installed.name))), opts.joinWaitMs ?? JOIN_WAIT_MS);
          timer.unref?.();
          waiting.woken = id => {
            clearTimeout(timer);
            woken(id);
          };
        }).catch(async (e: unknown) => {
          // The host still holds the road it installed over, and the agent on that computer has been writing why
          // its dial does not land every ten seconds. Its own sentence beats a person guessing at routes.
          throw new Error([e instanceof Error ? e.message : String(e), ...(await boxSaid(wiring, installed))].join("\n"));
        });
        const held = await recordOf(placeId);
        if (held === undefined) throw new Error(placeNoLinkLine(installed.name));
        holdBack(held);
        // The size the box reported is not here: every road that draws this line draws the box's row beside it, and
        // a fact already in the row costs the line the room it needs to read whole.
        stage("join", "done", [linkedOver(held.report.dialed, held.road?.back, req.hostUrls), `engine ${held.report.engine}`].filter(Boolean).join(", "), placeId);
        // What that computer forks with, read over the link it has just opened and before this answers: the row a
        // join prints carries where that computer keeps the logins its workspaces share, which is what the
        // sign-in offered right after it reads. Waited for no longer than one frame on a fresh link takes: a
        // computer slower than that is joined all the same, its answer lands on the record behind this add, and
        // its row carries nothing about its forks until then, as every row did before any of this was asked.
        const facts = await factsOn(placeId, held);
        // The recipe starts before this answers and runs on behind it, on the add's own stream: the steps ride
        // where the join's steps rode. Started rather than fired and forgotten, so the row this answers with says
        // whether a job is under way and whoever asked knows whether there is one to follow.
        const started = await startedOrSaid(placeId, addId);
        const row = { ...facts, ...(started.provision !== undefined ? { provision: started.provision } : {}) };
        return { addId, place: viewOf(row, await defaultId()), ...(installed.hostKey !== undefined ? { hostKey: installed.hostKey } : {}), ...(started.said !== undefined ? { said: started.said } : {}) };
      } catch (e) {
        // The step the install was on when it stopped is the one that failed, so a person reads the sentence
        // against the line it belongs to rather than under the list. One line of it: a note is printed after the
        // step's own marker at a terminal and inside one span in the sheet, and what a failure says beyond its
        // first line rides the throw, which both roads print whole.
        const message = e instanceof Error ? e.message : String(e);
        const { said, fix, kind } = refusalParts(e);
        putAdd(addId, job => ({ ...job, said: keptSaid(said), ...(fix === undefined ? {} : { fix }), ...(kind === undefined ? {} : { kind }) }));
        stage(step, "failed", markedCut(message.split("\n")[0]!));
        // The code went to the box as a file, so an add that failed spends it rather than leave it good for ten minutes.
        await devices.spend(code, at).catch(() => false);
        // The install took its join back off the box, so the record that join made names a computer that no longer
        // carries it. One it could not take back keeps its record, which is the road a remove sweeps it by.
        if (installing && waiting.placeId !== undefined && e instanceof PlaceAddTakenBackError) await forget(waiting.placeId);
        // A forward stays held for as long as a record dials back through it, and goes with an add that left none.
        if (waiting.login !== undefined && waiting.back !== undefined) {
          const landed = waiting.placeId === undefined ? undefined : await recordOf(waiting.placeId);
          if (landed?.road?.back === undefined) wiring.back?.release(waiting.login);
          else holdBack(landed);
        }
        throw e;
      } finally {
        awaiting.delete(code);
      }
    },

    async dial(placeId, at) {
      const held = await recordOf(placeId);
      if (held === undefined) throw new Error(noSuchPlaceRefusal(placeId, [...kept.values()].map(r => r.name)));
      const stamp = new Date(at).toISOString();
      const linked = live.get(placeId)?.reach;
      const started = clockNow();
      const took = (): number => Math.max(0, Math.round(clockNow() - started));
      let dialled: PlaceDialled;
      // Which road there is, off the one reading of it the app also draws its button from: a road here and no
      // button there would be a press nobody could make, and a button there with no road here is one that answers
      // only that there was nowhere to dial. Both halves are taken off that one reading rather than asked again.
      const road = placeDialRoad({ present: linked !== undefined, road: held.road });
      const link = road === "link" ? linked : undefined;
      const ssh = road === "ssh" ? loginOf(held) : undefined;
      if (link !== undefined) {
        // The link's own heartbeat op: the cheapest frame that proves the computer at the other end is still
        // answering, rather than that this host is still holding a socket to it.
        try {
          await bounded(link.request("ping"), dialWaitMs, `ping on ${held.name}`);
          dialled = { at: stamp, answered: true, roundTripMs: took() };
        } catch (e) {
          dialled = { at: stamp, answered: false, said: e instanceof Error ? e.message : String(e) };
        }
      } else if (ssh !== undefined && wiring.dial !== undefined) {
        try {
          await bounded(wiring.dial(ssh), dialWaitMs, `ssh ${ssh.ssh}`);
          dialled = { at: stamp, answered: true, roundTripMs: took() };
        } catch (e) {
          dialled = { at: stamp, answered: false, said: e instanceof Error ? e.message : String(e) };
        }
      } else {
        dialled = { at: stamp, answered: false, said: placeNoDialLine(held.name) };
      }
      // A frame the computer itself answered is that computer heard from, so the silence is dated from it; an ssh
      // login that answered is the box speaking and not the agent, and it does not move that date.
      const moved: PlaceRecord = { ...held, dialled, ...(dialled.answered && linked !== undefined ? { lastSeenAt: stamp } : {}) };
      await keep(moved);
      return { dialled, line: placeDialLine({ name: held.name, road: held.road, linked: linked !== undefined, dialled }), place: viewOf(moved, await defaultId()) };
    },

    async road(placeId) {
      const held = live.get(placeId);
      const name = (await recordOf(placeId))?.name ?? placeId;
      if (held === undefined) throw new Error(absentComputer(name, null).sentence);
      const port = (await recordOf(placeId))?.report.daemonPort;
      if (port === undefined) throw new Error(placeNoDaemonPortLine(name));
      // One port per link, opened at the first pane that asks and closed with the link it rides.
      held.forward ??= openPlaceForward(held.reach, port);
      try {
        return (await held.forward).port;
      } catch (e) {
        if (live.get(placeId) === held) delete held.forward;
        throw e;
      }
    },

    async exec(placeId, cmd, execOpts) {
      const reach = live.get(placeId)?.reach;
      if (reach === undefined) throw new Error(absentComputer((await recordOf(placeId))?.name ?? placeId, null).sentence);
      const answer = await reach.request("exec", {
        cmd,
        ...(execOpts.timeoutMs !== undefined ? { timeoutMs: execOpts.timeoutMs } : {}),
        ...(execOpts.stdin !== undefined ? { stdin: Buffer.from(execOpts.stdin).toString("base64") } : {}),
      });
      return { exitCode: Number(answer["exitCode"] ?? -1), stdout: String(answer["stdout"] ?? ""), stderr: String(answer["stderr"] ?? "") };
    },

    adds: () => [...adds.values()],

    reportOf: async placeId => (await recordOf(placeId))?.report,
    homeOf: async placeId => (await recordOf(placeId))?.report.login["HOME"],

    async list() {
      const here = wiring.here();
      const providers = providerIds();
      const held = await records();
      // This computer first, the computers joined to it after, the providers last; exactly one default, which falls
      // to this computer when the mark names a row that is no longer here.
      const marked = (await markHeld()) ?? HERE_PLACE_ID;
      const room = new Map(await Promise.all(held.map(async r => [r.id, await forksOf(r)] as const)));
      return [
        {
          id: HERE_PLACE_ID,
          kind: "computer" as const,
          name: here.name,
          ...(here.label !== undefined ? { label: here.label } : {}),
          default: marked === HERE_PLACE_ID,
          ...(here.os !== undefined ? { os: here.os } : {}),
          ...(here.shape !== undefined ? { shape: here.shape } : {}),
          ...(here.diskFreeBytes !== undefined ? { diskFreeBytes: here.diskFreeBytes } : {}),
          ...(here.engine !== undefined ? { engine: here.engine } : {}),
          present: true,
          // This computer is where the person's own agents run, never something the host forks into: a copy of the
          // image on a runtime here is that place's own row, which is the one that says it forks.
          takesForks: false,
          buildsImages: false,
        },
        ...held.map(r => {
          const forks = room.get(r.id);
          return { ...viewOf(r, marked), ...(forks !== undefined ? { forks } : {}), ...imageFacts(r.id, door.backendOf(r.id)) };
        }),
        ...providers.map(id => {
          const rate = providerRate(id);
          const sizes = providerSizes(id);
          return {
            id,
            kind: "provider" as const,
            name: id,
            default: marked === id,
            takesForks: true,
            ...(rate !== undefined ? { rateUsdPerHour: rate } : {}),
            ...(sizes.length > 0 ? { sizes: [...sizes] } : {}),
            ...imageFacts(id, providerBackend(id)),
          };
        }),
      ];
    },

    async update(placeId, addId) {
      const held = await recordOf(placeId);
      if (held === undefined) throw new Error(noSuchPlaceRefusal(placeId, (await records()).map(r => r.name)));
      // Read before anything: another run of the recipe on that computer is refused as the op's own refusal, so
      // whoever asked reads one sentence and the line returns rather than following a job it did not start.
      const busy = provisioningNow(held);
      if (busy !== undefined) throw Object.assign(new Error(busy), { kind: "conflict" });
      const from = held.report.daemonVersion;
      // A binary goes only where that computer is behind: a computer already running this wsp's daemon is the
      // common case for a recipe that changed, and the recipe half below is what the person asked for.
      const moving = from < DAEMON_VERSION;
      let daemon: PlaceUpdateReply["daemon"];
      if (wiring.update === undefined) {
        // A runtime outside the app and the host wires none, so nothing there writes the login files either; a
        // computer that needs a daemon it cannot be given is the one refusal.
        if (moving) throw new Error(NO_PLACE_UPDATER);
      } else {
        const link = live.get(placeId)?.reach;
        const ssh = loginOf(held);
        // Asked on every update, behind or not: wsp's login files on that computer are spelled by this host, so a
        // host that moved alone writes them here and a computer joined under an older spelling takes this one.
        const landed = await wiring.update({
          placeId,
          name: held.name,
          report: held.report,
          daemon: moving,
          ...(link === undefined ? {} : { link }),
          ...(ssh === undefined ? {} : { ssh }),
        });
        if (landed !== undefined) {
          // The row is the answer, not the landing: the computer restarts its agent and dials back, and what it says
          // about itself then is the only reading that proves the new daemon is the one running there.
          const to = await untilDaemonVersion(placeId, from, opts.updateWaitMs ?? UPDATE_WAIT_MS);
          // The attach on the new daemon dropped what the old one said it forks with and asked again; this waits for
          // that answer, so the row after an update carries the new daemon's facts rather than nothing while they are
          // still in flight. It joins the read behind the attach instead of sending a second frame.
          if (to !== from) await factsOn(placeId, held);
          daemon = {
            ...landed,
            from,
            to,
            ...(to >= DAEMON_VERSION ? {} : { note: placeUpdateSlowLine(held.name, Math.round((opts.updateWaitMs ?? UPDATE_WAIT_MS) / 1000)) }),
          };
        }
      }
      // A stream of its own: this is not an install, and the rows ride it the way a join's steps ride the add's.
      const started = await startedOrSaid(placeId, addId ?? `a_${randomBytes(6).toString("hex")}`);
      return { name: held.name, ...(daemon === undefined ? {} : { daemon }), ...started };
    },

    async remove(placeId) {
      const held = await recordOf(placeId);
      if (held === undefined) return { removed: false, swept: [] };
      // The forks on it are wsp's own machines and the person's to delete: a place taken out from under them would
      // leave containers on that computer nothing here can name again.
      const forks = await recording.forksOn(placeId);
      if (forks.length > 0) throw new Error(placeHoldsForksRefusal(held.name, forks));
      // A project is one computer's: taken out from under its projects, the place id on each record would name
      // nothing. The forks are refused first, since a workspace of a project is a machine standing on this place.
      const projects = await recording.projectsOn(placeId);
      if (projects.length > 0) throw new Error(placeHoldsProjectsRefusal(held.name, projects));
      const reach = live.get(placeId)?.reach;
      const leaver = wiring.leave;
      const login = loginOf(held);
      let swept: string[] = [];
      let note: string | undefined;
      // What the road that logs in did where it did not finish the job, for the lines about the road that followed.
      let loginRoad: { at: string; said?: string } | undefined;
      // The leave that computer already carries, run over the login the install used, is the road a remove takes
      // wherever this host holds one, link or no link: it stops the service holding the agent up before the files
      // go, and what answers over the link cannot. Running it there rather than spelling it here is what keeps one
      // copy of the sweep.
      if (leaver !== undefined && login !== undefined) {
        if (!(await loginAnswers(login))) {
          // The login did not stand, so nothing ran on that computer at all.
          loginRoad = { at: login.ssh };
        } else {
          try {
            swept = [...(await leaver({ placeId, name: held.name, report: held.report, ssh: login }))];
            note = placeSweptOverSshLine(held.name, login.ssh, reach !== undefined);
          } catch (e) {
            // Two different things, and the line a person reads says which: the login would not stand, or that
            // computer took the leave, ran it and stopped, whose own last words ride with it.
            loginRoad = { at: login.ssh, ...(e instanceof PlaceLoginRefusedError ? {} : { said: e instanceof Error ? e.message : String(e) }) };
          }
        }
      }
      // Either that login was never there to take or it did not finish the job, which leaves the two roads there
      // always were: the place's own sweep over the link, and the sentence for a computer nothing here reaches.
      if (note === undefined) {
        if (reach === undefined) {
          note = loginRoad?.said === undefined ? placeStillInstalledLine(held.name) : `${placeLoginRoadLine(held.name, loginRoad.at, loginRoad.said)}; ${placeStillInstalledLine(held.name)}`;
        } else {
          try {
            // Before the folder holding the list goes with the leave: the servers wsp merged into the agents' own
            // files there are keys inside files that are theirs, which the daemon knows no format to take out.
            const took = await unmergedOver(placeId, held);
            const answer = await reach.request("place.leave");
            swept = [...took, ...(Array.isArray(answer["swept"]) ? (answer["swept"] as unknown[]).map(String) : [])];
            if (loginRoad !== undefined) note = placeSweptOverLinkLine(held.name, loginRoad.at, loginRoad.said);
          } catch (e) {
            const failed = `${held.name} was connected but did not finish the sweep: ${e instanceof Error ? e.message : String(e)}; run ${PLACE_LEAVE_LINE} on that computer`;
            note = loginRoad === undefined ? failed : `${placeLoginRoadLine(held.name, loginRoad.at, loginRoad.said)}, and ${failed}`;
          }
        }
      }
      if (reach !== undefined) cut(placeId, "removed from this host");
      // After the sweep, since the link that sweep may ride comes in through the forward.
      if (login !== undefined && held.road?.back !== undefined) wiring.back?.release(login);
      await forget(placeId);
      return { removed: true, swept, ...(note !== undefined ? { note } : {}) };
    },

    find: async ref => (await records()).filter(r => r.id === ref || r.name === ref),

    on: fn => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },

    close: async () => {
      wiring.back?.close();
      for (const placeId of [...live.keys()]) cut(placeId, "this host is stopping");
      for (const placeId of [...waiting.keys()]) woken(placeId, false);
      for (const [key, f] of forwards) {
        for (const conn of f.conns.values()) conn.destroy();
        f.conns.clear();
        f.server.close();
        forwards.delete(key);
      }
      awaiting.clear();
    },
  };
  return door;
}
