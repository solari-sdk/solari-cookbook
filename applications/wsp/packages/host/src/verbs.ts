// SPDX-License-Identifier: AGPL-3.0-only
// The verbs a person or a local agent runs beside the app: thin clients of
// the host's protocol on localhost, authenticated with the token the host
// wrote to the state dir. One verb table with two doors on every entry: the
// command line (its usage, its flags, a run from the parsed line to an exit
// code) and the MCP tool (its description, the zod shape it takes and answers,
// a call from the parsed arguments to a result). The parser, the help and the
// tool list all read the table, so a verb is added in one place. Nothing here
// reads a key or imports the runtime: the host is the only process that talks
// to the provider.
import { hostname, platform } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Transform, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { z } from "zod";
import { CATALOG_AGENTS, ROAD_MODULES, THREAD_AGENTS, agentName, catalogEntry, isRoad } from "@wsp/catalog";
import { nodeHost, readGhosttyConfig, type Platform } from "@wsp/collect";
import { freshEphemeral, keyFingerprint, makeSeal, openFrame, sealKeys, sharedSecret, signPlaceBytes, verifyPlaceBytes, SEAL_REFUSAL, type PlaceKeyPair, type Seal } from "@wsp/keys";
import {
  AFTER_CUT_LINE,
  COORDINATOR_HANDOFF,
  EMPTY_TASK_LINE,
  EXIT_CODES,
  HOST_STOPPING_CLOSE,
  HOST_CLOSED_LINE,
  HOST_STOPPING_LINE,
  HostFolderListing,
  AgentRow,
  AgentsReport,
  AgentsTarget,
  McpRow,
  McpScope,
  commandWords,
  unclosedQuoteRefusal,
  McpTool,
  ServerToolsAnswer,
  SkillAdded,
  SkillHit,
  SkillPreview,
  SkillRow,
  SKILL_PREVIEW_BYTES,
  agentSignInWord,
  InitSetup,
  initSetupLines,
  IMAGES_MAX,
  IMAGE_ALREADY_NEWEST,
  IMAGE_MAX_WORDS,
  IMAGE_MOVE_CONFIRM,
  IMAGE_TYPE_WORDS,
  LOGIN_CHOICES,
  NOTIFY_CALLER,
  NOTIFY_ME,
  NOTIFY_WORDS,
  PLACE_LINK_NONCE_BYTES,
  SEAL_CLIENT,
  SealOpenReply,
  deviceAuthOldHostLine,
  pairKeyRefusal,
  placeLinkTranscript,
  ProjectExportResult,
  ProjectGolden,
  ProjectGoldenRemoved,
  SealedImage,
  SealedImageBuilt,
  SealedImageCopy,
  SealedImageView,
  SealedProjectImage,
  NO_SEALED_IMAGE,
  IMAGE_PASSPHRASE_ENV,
  IMAGE_PASSPHRASE_MIN,
  GOLDEN_STAGE_WORDS,
  sealedBuiltLine,
  sealedCopyLine,
  sealedPinLine,
  sealedExportLine,
  sealedImageLine,
  sealedProjectLine,
  noProjectImageLine,
  projectImageRemoveNotice,
  projectImageRemovedLine,
  type GoldenStageEvent,
  type SealedImageExport,
  ProjectImportResult,
  PlaceView,
  ProjectPlan,
  RECIPE_TICKS,
  RecipeTick,
  SessionInterruptOutcome,
  SessionInterruptResult,
  SessionRenameOutcome,
  SessionRenameResult,
  SessionStartOutcome,
  SessionStartResult,
  type SessionSteerEvent,
  TURN_END_WORDS,
  TerminalConfig,
  TerminalScheme,
  ThreadMessage,
  ThreadView,
  TurnStatus,
  UpgradeResult,
  WorkspaceAgents,
  type WorkspaceKind,
  WorkspaceListing,
  WorkspaceOut,
  WorkspaceView,
  actionRefusal,
  agentsKindRefusal,
  agentsLine,
  agentsMayDrive,
  agentsWord,
  authRefusal,
  authority,
  canTravel,
  defaultAgents,
  defaultConsent,
  deleteNotice,
  onDeleteOf,
  execFolderLine,
  folderLevelLine,
  fmtBytes,
  plural,
  fmtThreads,
  foldThreads,
  threadWordOf,
  BringBackResult,
  foreignFlagLine,
  forgetNotice,
  goldenHead,
  goneRefusal,
  goneRoadRefusal,
  guestNamesWorkspaceLine,
  guestNoFileLine,
  imageKeptLine,
  imageLine,
  imageTypeOf,
  imagesRefusal,
  importConsented,
  importRequest,
  fmtSize,
  kindWords,
  type MachineOnDelete,
  machineWord,
  needsRebuild,
  noAdapterLine,
  noMessagesLine,
  noReplyLine,
  noWorkspaceRefusal,
  notFoundRefusal,
  needsYouLine,
  openAsk,
  askingLine,
  type PermissionEffect,
  type PermissionOption,
  type SessionAnswerOutcome,
  SessionAnswerResult,
  type SessionPermissionEvent,
  notAFileLine,
  notAnImageLine,
  type NotifyLength,
  notifyLine,
  notifyTail,
  offeredSize,
  sayOnce,
  secretOffer,
  secretSignalsLine,
  sizeFromWord,
  sizeRefusal,
  startPicks,
  stillWorkingLine,
  terminalConfigLines,
  threadMessages,
  threadReplyRows,
  threadReadText,
  threadResult,
  threadStateWord,
  toolActivityLine,
  toolAnsweredLine,
  turnSettledLine,
  turnTokenOf,
  unknownAgentLine,
  usageRefusal,
  validatorRefusal,
  verbFailure,
  waitTimedOutLine,
  whereWord,
  workspaceAsleepAgainLine,
  workspaceKind,
  workspaceState,
  workspaceStateLine,
  type PauseMode,
  workspaceStateOf,
  workspaceStaysAwakeLine,
  workspaceWord,
  type Capabilities,
  type ExecEvent,
  type GoldenManifest,
  type HarnessCatalog,
  type ImageAttachment,
  type ProjectExportEvent,
  type ProjectImportEvent,
  type ProjectImportRequest,
  type SessionEvent,
  type SessionOrigin,
  type SessionView,
  type TurnRefusal,
  type TurnResult,
  type WorkspaceCreateResult,
  type WorkspaceCreatingEvent,
  Preferences,
  WorkspaceProject,
  type WorkspaceSize,
  type WorkspaceState,
  homeShortened,
  noImportRoadLine,
  noThreadTargetLine,
  noWorkspaceForFolderLine,
  goldenForkName,
  projectsInPlace,
  registerTakesNoConsentLine,
  shellQuote,
  fmtPrice,
  threadOpenedLine,
  threadWithoutIdRefusal,
  threadWord,
  workspaceForFolder,
  ProjectView,
  addedProjectLine,
  computerNamed,
  copyTakesNone,
  copiesFolder,
  madeOfWord,
  portsWord,
  kindForComputer,
  computerKindWord,
  MEMORY_KEPT_CLAUSE,
  nameTheProjectLine,
  noSuchProjectLine,
  sourceKind,
  sourceWord,
  HERE_PLACE_ID,
  isLocalWorkspace,
  turnSpendWord,
  agentsCell,
  placeDaemonBehind,
  provisionWord,
  namesPlace,
  noSuchPlaceRefusal,
  placeForksNowhereLine,
  localRunsOneFix,
  localRunsOneLine,
  packageOf,
  addToolsHereRefusal,
  SignInLine,
  THIS_COMPUTER,
  type SealedPin,
  escapeC1,
  jsonLine,
  withoutControlChars,
} from "@wsp/protocol";
import type { CliIO } from "./cli.js";
import { relaySignIn, targetLink, type BoxSignedIn } from "./place-signin.js";
import type { RelayTerminal } from "./signin-relay.js";
import { gitRootOf } from "./repo-root.js";
import { dialAddress, hostTokenFor, hostTokenPath, servingHost } from "./host-lock.js";
import type { HostStarter } from "./host-start.js";
import { addressNotPairedLine, aimAddress, aimHolds, aimName, aimedHost, deviceRefusedLine, dialWindowMs, hostSideOnlyFix, hostSideOnlyLine, noAnswerRefusal, noAnswerWithin, READ_THE_HOSTS, stateIgnoredLine, wsUrlOf, wspHome, writeHost, type HostAim, type HostPick } from "./hosts.js";
import { readDeviceKeyPair } from "./account.js";
import { colourDepth, isTTY, wrap } from "./init-layout.js";
import { watchBlock, watchOn, type WatchSignals } from "./watch.js";
import { RecipeAnswer, RecipeScan, recipePrintout, scanPrintout } from "./recipe-answer.js";
import { isRecipeTick, runRecipe, runScan, type ScanInput } from "./recipe-command.js";
import { historyCache, smallRecipePath } from "./recipe-file.js";

type Frame = Record<string, unknown> & { id?: string | number | null; ok?: boolean; type?: string };

export interface HostClient {
  request<T extends Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T>;
  /** Asks for the runtime's events once; a second call is a no-op, since each subscription would push every event again. */
  events(): Promise<void>;
  /** Every frame that is not a reply: events after events(), the frames an exec pushes. */
  onFrame(fn: (frame: Frame) => void): () => void;
  /** Settles when the socket is gone, however it went. */
  readonly closed: Promise<void>;
  /** Why the socket is gone, in the words the person reads: a host that let it go as it stopped says the turn goes
   * on, since the run is the machine's; anything else is a host that went. */
  closeWords(): string;
  /** The device token a host on the account answered this computer's key with, on the dial that proved it. */
  readonly paired?: { deviceId: string; deviceToken: string };
  close(): void;
  /** Drops the socket without waiting for the host to answer the close. A graceful close on a road that is carrying
   * nothing waits on an answer that is not coming, and the operating system holds the connection long after the
   * line has said its last word: measured on a stalled road, a close held the process 30.6 s where this took
   * 0.6 s. A caller that has given up on the road takes this rather than close. */
  terminate(): void;
}

/** The close code the runtime sends with every token refusal, the one fact an older host still carries. */
const UNAUTHORIZED_CLOSE = 4401;
/** How long a refused auth waits for the close that follows its frame before the frame's own class stands. */
const CLOSE_GRACE_MS = 500;

/** What a dial takes beside the state file: which host, how long to wait, and on a dial to a host on the account,
 * the key to prove instead of a token this computer does not have yet. */
export interface DialOpts extends HostPick {
  /** How long the socket and the first frame's answer may take; the road's own window when no caller names one. */
  deadlineMs?: number;
  /** Resolved already by a caller that had to read it anyway, so the hosts file is read once per line. */
  aim?: HostAim;
  /** Proves this computer's own device key as the first frame inside the seal, for a host on the account that
   * admitted it: no code is spent, and the host answers a device token of its own.
   * The name is what the host's listing calls this computer. */
  admit?: { name: string; hostKey: string; key: PlaceKeyPair };
  /** What brings a host up when none serves this state file here. A line that hands none in starts nothing and
   * reads the refusal, which is what a line about to serve a host itself wants. */
  start?: HostStarter;
  /** Where the starter's one line goes; stderr when nobody names a reader, since the line rides beside whatever
   * the verb prints on stdout. */
  say?: (line: string) => void;
}

/** No host holds this state file's lock, said once: a line that asked for none to be started reads it, and so does
 * a wait that ran out somewhere a starter could not run. It ends with the line that serves that file, as every
 * refusal ends with the command that fixes it, and the flag is always spelled: which file a bare wsp up would
 * serve is one rule and it lives where the state is picked, not in a second reading here. */
export const noHostServingLine = (statePath: string): string => `no wsp host is serving ${statePath}; start one with wsp up --state ${statePath}`;

/** Where a line dials and what it presents there: a host on this computer is the address its lock records (one
 * bound to a single address answers only there) and the token it wrote beside its state file, a host somewhere
 * else is its own address on the runtime's path and the device token this computer holds for it, and an address
 * carries the token a turn's launch left for it or none. */
export function hostAddress(statePath: string, pick: HostPick & { aim?: HostAim } = {}): { url: string; token: string } {
  const aim = pick.aim ?? aimedHost(statePath, pick);
  if (aim.kind === "url") return { url: wsUrlOf(aim.url), token: aim.token ?? "" };
  if (aim.kind === "alias") return { url: wsUrlOf(aim.record.url), token: aim.record.deviceToken };
  const lock = servingHost(statePath);
  if (lock === undefined) throw new Error(noHostServingLine(statePath));
  const token = hostTokenFor(statePath);
  if (token === undefined) throw authRefusal(`the host's token file is missing: ${hostTokenPath(statePath)}`);
  return { url: `ws://${authority(dialAddress(lock), lock.wsPort)}`, token };
}

/** Where the wsp command's forwarder dials for a line aimed at the host serving this state file on this computer:
 * the address and the token a line's own dial reads for it. Nothing for every other aim, since each of them pins a
 * key or spends a token the forwarder holds no road for, and nothing where no host serves the file. */
export function hereDoor(statePath: string, pick: HostPick = {}): { url: string; token: string } | undefined {
  if (aimedHost(statePath, pick).kind !== "here" || servingHost(statePath) === undefined) return undefined;
  return hostAddress(statePath, { aim: { kind: "here" } });
}

/** One socket to the host, and for a host on the account the one re-admission it may need on the way: a record
 * whose token that host no longer takes is a computer the account still trusts, so this computer proves its device
 * key once, writes the token the host answers into the record and carries on. The dial itself is below. */
export async function dialHost(statePath: string, opts: DialOpts = {}): Promise<HostClient> {
  const aim = opts.aim ?? aimedHost(statePath, opts);
  const home = opts.home ?? wspHome(opts.env ?? process.env);
  // A record written off the account's listing holds no token until its first dial, so the first line aimed at it
  // is admitted rather than refused: the key this computer signs with is the one the host was told to trust.
  const account = aim.kind === "alias" ? aim : undefined;
  const admitting = (): DialOpts["admit"] => {
    if (account === undefined || account.record.hostKey === undefined) return undefined;
    const key = readDeviceKeyPair(home);
    return key === undefined ? undefined : { name: hostname(), hostKey: account.record.hostKey, key };
  };
  const admit = account !== undefined && account.record.deviceToken === "" ? admitting() : undefined;
  // Which road this dial ended up taking, so a token is written into the record only where this computer proved
  // its key for it.
  let proved = admit;
  const client = await dialOnce(statePath, { ...opts, aim, ...(admit === undefined ? {} : { admit }) }, refused => {
    // The token this computer holds was taken away over there while the account still names it: one more dial,
    // this time proving the key, and the record carries what that host answers.
    if (admit !== undefined) throw refused;
    proved = admitting();
    return proved === undefined ? undefined : { ...opts, aim, admit: proved };
  });
  if (account !== undefined && proved !== undefined && client.paired !== undefined) {
    writeHost(home, account.alias, { ...account.record, deviceId: client.paired.deviceId, deviceToken: client.paired.deviceToken });
  }
  return client;
}

/** One socket to the host: the token rides in the first frame, never in the URL; then request and reply by id.
 * Open and auth share one deadline, so a port that accepts and never answers fails in one line, and that deadline
 * is the window the road gets rather than one number for every road. `again` is the one retry above: it is handed
 * the refusal of the frame that carried the token and answers the options to dial once more with, or nothing. */
async function dialOnce(statePath: string, opts: DialOpts, again?: (refused: unknown) => DialOpts | undefined): Promise<HostClient> {
  const aim = opts.aim ?? aimedHost(statePath, opts);
  // Nothing serves this state file here and the line needs one: start it rather than telling the person to. Every
  // other aim is a host somewhere else, which this computer cannot start and must not try to.
  if (aim.kind === "here" && opts.start !== undefined && servingHost(statePath) === undefined) {
    await opts.start(statePath, opts.say ?? (line => void process.stderr.write(`${line}\n`)));
  }
  // An address with no token beside it opens nothing: this computer holds a token only under a name.
  if (aim.kind === "url" && aim.token === undefined && opts.admit === undefined) throw usageRefusal(addressNotPairedLine(aim.url), READ_THE_HOSTS);
  const { url, token } = hostAddress(statePath, { aim });
  const deadlineMs = opts.deadlineMs ?? dialWindowMs(aim);
  const ws = new WebSocket(url);
  const opened = new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  let closeCode: number | undefined;
  const closed = new Promise<void>(done =>
    ws.once("close", code => {
      closeCode = code;
      done();
    }),
  );
  let next = 1;
  /** Set once the host has proved the key this computer pinned: every frame after that reply is sealed under the
   * key both ends agreed, so the token, the code and everything the line asks for cross a road whose carrier
   * reads nothing and writes nothing into it. */
  let seal: Seal | undefined;
  const pending = new Map<number, { settle: (f: Frame) => void; fail: (e: Error) => void }>();
  const listeners = new Set<(f: Frame) => void>();
  ws.on("message", raw => {
    let frame: Frame;
    try {
      frame = JSON.parse(openFrame(seal, raw)) as Frame;
    } catch {
      // A frame that will not open under that key, and one sent in the clear after the seal began, are the same
      // thing: somebody carrying the bytes writing into the socket. It ends, and every waiting reply fails with it.
      if (seal !== undefined) ws.close(1002, SEAL_REFUSAL);
      return;
    }
    const waiter = typeof frame.id === "number" ? pending.get(frame.id) : undefined;
    if (waiter !== undefined) {
      pending.delete(frame.id as number);
      waiter.settle(frame);
      return;
    }
    for (const fn of listeners) fn(frame);
  });
  const closeWords = (): string => (closeCode === HOST_STOPPING_CLOSE ? HOST_STOPPING_LINE : HOST_CLOSED_LINE);
  ws.on("close", () => {
    for (const w of pending.values()) w.fail(new Error(closeWords()));
    pending.clear();
  });
  ws.on("error", () => {});
  const request = async <T extends Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = next++;
    const frame = await new Promise<Frame>((settle, fail) => {
      pending.set(id, { settle, fail });
      const text = JSON.stringify({ id, op, ...params });
      ws.send(seal === undefined ? text : seal.seal(text));
    });
    if (frame.ok !== true) throw Object.assign(new Error(typeof frame["error"] === "string" ? frame["error"] : `${op} failed`), typeof frame["kind"] === "string" ? { kind: frame["kind"] } : {});
    return frame as T;
  };
  let timer: NodeJS.Timeout | undefined;
  // What the person reads as the host's address: the authority a host on this computer answers on, and the address
  // as they gave it for one anywhere else, never the ws url the dial builds out of it.
  const where = aim.kind === "here" ? new URL(url).host : aimAddress(aim);
  const deadline = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(noAnswerWithin(where, deadlineMs)), deadlineMs);
  });
  let paired: { deviceId: string; deviceToken: string } | undefined;
  /** Whether the refusal that ended this dial was the answer to the frame that carried the token or the code: the
   * one refusal a second dial can do anything about, since a host that never proved the key this computer pinned
   * refuses the same way however often it is asked. */
  let refusedTheToken = false;
  /** The first frame of every dial that holds a key: this computer's nonce and its half of a fresh key agreement,
   * answered by the host with the key it proves. The fingerprint is read before the signature, since anything
   * answering at this address signs for itself perfectly well and the only thing that tells it from the host is
   * which key it is; both checks stand before a token or a code has crossed, and one refusal covers either, so a
   * stranger learns nothing from which caught it. */
  const openSeal = async (hostKey: string): Promise<Uint8Array> => {
    const mine = freshEphemeral();
    const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
    // Whatever came back that was not the key: a refusal of the frame, a shape this computer cannot read, an
    // older host whose door does not know the op. Every one of them is a host that did not prove the key, and
    // the sentence is the same for all of them, which is also why the refusal is built here and not below,
    // where a token this computer never sent would be read as one the host took away.
    const answer = SealOpenReply.safeParse(await request("seal.open", { nonce, ephemeral: mine.publicKey }).catch(() => undefined));
    if (!answer.success) throw authRefusal(pairKeyRefusal(where));
    const { hostPublicKey, nonce: hostNonce, signature, ephemeral } = answer.data;
    if (keyFingerprint(hostPublicKey) !== hostKey) throw authRefusal(pairKeyRefusal(where));
    if (!verifyPlaceBytes(hostPublicKey, placeLinkTranscript("host", SEAL_CLIENT, nonce, hostNonce, { challenger: mine.publicKey, answerer: ephemeral }), signature)) {
      throw authRefusal(pairKeyRefusal(where));
    }
    seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, ephemeral), SEAL_CLIENT), "place");
    // The bytes the host expects this end to sign, built from the same transcript the other way round: what a
    // device on the account signs to come in, and what a joined computer signs at place.prove.
    return placeLinkTranscript("place", SEAL_CLIENT, hostNonce, nonce, { challenger: ephemeral, answerer: mine.publicKey });
  };
  /** What a refusal of the frame that carried the token or the code means to the person. A refusal whose frame
   * carries no kind is classed by the close code that follows it, so a host of an older version that sends the
   * code alone still reads as auth; a frame with a kind is the source when there is one. A host somewhere else
   * says so with its alias and the line that pairs again, since its token is this computer's to renew. Only those
   * two frames come here: a host that did not prove its key was answered before either of them was sent. */
  const tokenRefused = async (e: unknown): Promise<never> => {
    refusedTheToken = true;
    const kind = (e as { kind?: unknown }).kind;
    if (kind === undefined) {
      await Promise.race([closed, new Promise(r => setTimeout(r, CLOSE_GRACE_MS))]);
      if (closeCode !== UNAUTHORIZED_CLOSE) throw e;
      // A frame with no kind behind an unauthorized close, where this computer sent device.auth: the host's own
      // door does not know that frame, so it is an older wsp.
      if (opts.admit !== undefined) throw authRefusal(deviceAuthOldHostLine(where));
    } else if (kind !== "auth") throw e;
    // A host that refused an admission said why in its own sentence, and there is no token of this computer's to
    // pair again for: the sentence is printed as it came.
    if (opts.admit !== undefined) throw authRefusal(e instanceof Error ? e.message : String(e));
    // A host that refused an alias's token has revoked this computer, whatever words it used.
    if (aim.kind !== "alias") throw authRefusal(e instanceof Error ? e.message : String(e));
    throw authRefusal(deviceRefusedLine(aim.alias));
  };
  const authed = opened
    .catch((e: unknown) => {
      throw noAnswerRefusal(where, e instanceof Error ? e.message : String(e));
    })
    .then(async () => {
      // Before the token or the code: the host proves the key this computer pinned, and everything after that
      // reply rides inside the seal both ends agreed. A host on this computer is reached over its own loopback,
      // where there is no road for anybody to stand on, and dials as it always did.
      const pinned = opts.admit?.hostKey ?? (aim.kind === "here" ? undefined : aimHolds(aim).hostKey);
      const expect = pinned === undefined ? undefined : await openSeal(pinned);
      if (opts.admit !== undefined) {
        // A computer the account admitted: it proves the key that host was told to trust over this socket's own
        // handshake, so the signature stands for this dial and no other, and takes a token of its own back.
        if (expect === undefined) throw authRefusal(pairKeyRefusal(where));
        const admitted = await request<{ deviceId: string; deviceToken: string }>("device.auth", {
          publicKey: opts.admit.key.publicKey,
          name: opts.admit.name,
          signature: signPlaceBytes(opts.admit.key.privateKeyPem, expect),
        }).catch(tokenRefused);
        paired = { deviceId: admitted.deviceId, deviceToken: admitted.deviceToken };
        return;
      }
      await request("auth", { token }).catch(tokenRefused);
    });
  try {
    await Promise.race([authed, deadline]);
  } catch (e) {
    ws.terminate();
    // The one road that tries again: a host that refused the token this computer holds, where the caller above
    // knows another first frame to send. Anything else, and any second refusal, is the person's to read.
    if (again !== undefined && refusedTheToken && (e as { kind?: unknown }).kind === "auth") {
      const next = again(e);
      if (next !== undefined) return dialOnce(statePath, next);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let subscribed: Promise<void> | undefined;
  return {
    request,
    events: () => (subscribed ??= request("events.subscribe").then(() => undefined)),
    onFrame: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    closed,
    closeWords,
    ...(paired !== undefined ? { paired } : {}),
    close: () => ws.close(),
    terminate: () => ws.terminate(),
  };
}

/** A follower's promise, or a failure when the host goes away first: a director waiting on a turn must never hang. */
function untilSettled<T>(client: HostClient, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    client.closed.then((): never => {
      throw new Error(client.closeWords());
    }),
  ]);
}

/** Frames pushed to the socket, held from before the request that names what to wait for: the id to match is
 * only known once the reply lands, and the host may push the first frame right behind it. A stop from inside `on`
 * drops the held frames not yet replayed too: a whole turn may sit in them when the harness answered at once. */
function pushedFrames(client: HostClient): { follow(pick: (f: Frame) => boolean, on: (f: Frame) => void): void; stop(): void } {
  const held: Frame[] = [];
  let sink: ((f: Frame) => void) | undefined;
  const off = client.onFrame(f => (sink !== undefined ? sink(f) : held.push(f)));
  return {
    follow: (pick, on) => {
      sink = f => {
        if (pick(f)) on(f);
      };
      for (const f of held.splice(0)) sink(f);
    },
    stop: () => {
      off();
      sink = () => {};
    },
  };
}

/** Every verb speaks through this. With --json each value is one JSON line on stdout and nothing else is
 * printed; without it the line is printed when there is one, and a reply streams to stderr as it arrives. */
export interface Out {
  emit(value: unknown, line?: string): void;
  stream(text: string): void;
}

function formatter(io: CliIO, json: boolean): Out {
  return {
    emit: (value, line) => {
      if (json) io.log(jsonLine(value));
      else if (line !== undefined) io.log(line);
    },
    stream: text => {
      if (!json) io.stream?.(text);
    },
  };
}

/** The agent's end of stdio with every C1 control escaped: JSON.stringify leaves C1 raw, where a script printing the
 * answer would hand it to a terminal. */
export function c1Escaped(out: Writable): Writable {
  const text = new StringDecoder("utf8");
  const safe = new Transform({ transform: (chunk: Buffer, _encoding, done) => done(null, escapeC1(text.write(chunk))), flush: done => done(null, escapeC1(text.end())) });
  safe.pipe(out);
  return safe;
}

/** The rows wsp places prints. Every fact is what the place last reported; a provider row carries its rate and no
 * shape, since nothing about a machine exists there until one is forked. */
export function placeLines(places: readonly PlaceView[]): string[] {
  if (places.length === 0) return ["This host holds no place. wsp add prints the join line for a computer you are sitting at."];
  const rows = places.map(p => [
    p.name,
    p.kind,
    p.shape === undefined ? "" : String(p.shape.cpu),
    p.shape === undefined ? "" : fmtBytes(p.shape.memMb * 1024 * 1024),
    p.diskFreeBytes === undefined ? "" : fmtBytes(p.diskFreeBytes),
    p.engine === undefined ? "" : p.engine,
    // How a project's files get into a workspace there: beside the engine, since both are what that computer
    // brings to a workspace rather than what the workspace asked for.
    p.copies === undefined ? "" : p.copies,
    p.kind === "provider" ? fmtPrice(p.rateUsdPerHour ?? 0) : p.present === true ? "yes" : "no",
    p.forks === undefined ? "" : `${p.forks.running} of ${p.forks.running + p.forks.room}`,
    p.kind === "provider" ? "" : (p.lastSeenAt ?? ""),
    p.default ? "default" : "",
    // The one word about a computer running an older daemon than this wsp deploys, built in the protocol so this
    // row and the app's table say it the same way; empty on a row that is level, ahead, or has never reported.
    placeDaemonBehind(p) ?? "",
    p.build ?? "",
  ]);
  return table([["PLACE", "KIND", "CORES", "MEMORY", "DISK FREE", "ENGINE", "COPIES", "PRESENT", "FORKS", "LAST SEEN", "DEFAULT", "BEHIND", "IMAGE"], ...rows]);
}

/** The computer every screen and every reader here is told it is on; the one reading, so a run, its hand-off and
 * the init job a host serves never disagree about which of the two this is. */
export const hostPlatform = (): Platform => (platform() === "darwin" ? "darwin" : "linux");

/** The rows wsp computers prints: this computer, each box joined to it and each cloud account, in the words a
 * person uses for them. Every fact is what that computer last reported; a cloud row carries its rate and no shape,
 * since nothing about a machine exists there until one is forked. No row is marked default: which computer a
 * workspace lands on is its project's to say. The platform is handed in, since what this computer is called is
 * read where the host runs and not guessed here. */
export function computerLines(places: readonly PlaceView[], platform: "darwin" | "linux"): string[] {
  if (places.length === 0) return ["This host holds no computer. wsp add prints the join line for a computer you are sitting at."];
  const rows = places.map(p => [
    p.name,
    computerKindWord(p, platform),
    p.shape === undefined ? "" : String(p.shape.cpu),
    p.shape === undefined ? "" : fmtBytes(p.shape.memMb * 1024 * 1024),
    p.diskFreeBytes === undefined ? "" : fmtBytes(p.diskFreeBytes),
    p.engine === undefined ? "" : p.engine,
    p.copies === undefined ? "" : p.copies,
    p.kind === "provider" ? fmtPrice(p.rateUsdPerHour ?? 0) : p.present === true ? "yes" : "no",
    p.forks === undefined ? "" : `${p.forks.running} of ${p.forks.running + p.forks.room}`,
    p.kind === "provider" ? "" : (p.lastSeenAt ?? ""),
    placeDaemonBehind(p) ?? "",
    p.build ?? "",
    // The recipe on that computer: what is being put on it, then what stands and what failed. Empty on a cloud
    // and on this computer, which wsp installs nothing on.
    provisionWord(p.provision),
    // The agents on that computer, each at the version it answered with and the word for its sign-in. Empty on a
    // cloud account and on this computer, neither of which reports an agent.
    agentsCell(p),
  ]);
  return table([["COMPUTER", "KIND", "CORES", "MEMORY", "DISK FREE", "ENGINE", "COPIES", "PRESENT", "WORKSPACES", "LAST SEEN", "BEHIND", "IMAGE", "TOOLS", "AGENTS"], ...rows]);
}

/** Columns padded to their widest cell, two spaces apart; the last column is never padded. */
export function table(rows: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const widths = rows.reduce<number[]>((w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)), []);
  return rows.map(row => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd());
}

export type Flags = Record<string, string | boolean | string[] | undefined>;

/** What both doors are handed beside the line or the arguments: the state file the host serves, which the recipe
 * verbs write beside, and the scanner for tools outside the catalog when the caller has one (it reaches the engine,
 * which the MCP server may not import, so each door decides whether it runs). */
export interface VerbDeps {
  statePath: string;
  alsoHere?: ScanInput["alsoHere"];
  /** The folder the caller runs in: the shell's for the command line, the client's for the tool server, which the
   * agent starts in its own folder. What a thread opened with no workspace named is placed by. Absent where the
   * caller has none. */
  cwd?: string;
  /** The environment the caller runs in, which is where the token of the turn a verb is running inside comes from.
   * Both doors hand in this process's; a test hands in the one it means, never the shell that started it. */
  env: Readonly<Record<string, string | undefined>>;
  /** The socket to the host: a verb's own dial, closed when it returns; a tool server's one dial across calls. */
  client(): Promise<HostClient>;
  /** What brings the host up when nothing serves the state file here; both doors hand in the one built from how
   * this process was started. Absent starts nothing, which is what a caller with no wsp to spawn has. */
  start?: HostStarter;
  /** Where a --watch's stop arrives. This process by default; a test hands in its own, since a real signal would
   * take the test runner with it. */
  signals?: WatchSignals;
  /** How the socket to the host is opened. dialHost by default; a caller hands in its own to count the dials a line
   * makes, which is the whole of whether a watch holds one socket or opens one per frame. */
  dial?: typeof dialHost;
  /** Whether the caller is somewhere other than the computer this process runs on: a line or a tool call typed
   * inside a machine and carried here over the guest road. Every rule that would read a path or resolve a folder
   * against this computer reads it, since what such a caller names is on its own machine and answering off this
   * one would hand it the person's files. */
  elsewhere?: boolean;
  /** The terminal a sign-in run on a computer is shown in, and what opens its page here; this process's own
   * terminal and this computer's opener by default, which a test replaces. */
  terminal?: RelayTerminal;
  open?(url: string): Promise<boolean>;
}

/** What a person names when they record a machine of their own: where it is, and the port, key and name they give
 * it where those are not what the address and the machine already say. */
export interface SshAsked {
  name?: string;
  port?: number;
  keyPath?: string;
}

interface VerbContext extends VerbDeps {
  args: string[];
  flags: Flags;
  io: CliIO;
  out: Out;
  /** Which host this line runs against, read once by the command line; the verbs that can work without one read it
   * to tell a state file nothing serves from a host somewhere else, which is served and is not this computer's. */
  aim: HostAim;
  /** The verb's own usage, for the fix half of a refusal about what the line takes: the shape of the line is the
   * answer to a line with the wrong number of words, and it is written once, in the table above. */
  usage: string;
}

/** The fix half of a refusal about what a line takes: the verb's own usage, as the help prints it. */
const usageIs = (ctx: VerbContext): string => `usage: ${ctx.usage}`;

/** The verb as an MCP tool: what it does in the agent's words, the zod shape of what it takes and of what it
 * answers, and the call. The shapes are what tools/list serves and what the parity test holds the skill to. */
export interface Tool {
  description: string;
  input: z.ZodRawShape;
  output: z.ZodRawShape;
  /** The output fields the command line prints as frames under --json, one per line ahead of the result, which leaves
   * them out; a result with nothing left is not printed. */
  stream?: readonly string[];
  call(args: Record<string, unknown>, deps: VerbDeps): Promise<CallToolResult>;
}

/** Types the call's arguments from the input shape, then lets the entry sit in the table beside every other. */
function tool<In extends z.ZodRawShape, Out extends z.ZodRawShape>(spec: {
  description: string;
  input: In;
  output: Out;
  stream?: readonly (keyof Out & string)[];
  call(args: z.objectOutputType<In, z.ZodTypeAny>, deps: VerbDeps): Promise<CallToolResult>;
}): Tool {
  return spec;
}

/** Which page a line prints on. `front` is the sixteen words a person meets; `agent` the verbs an agent reaches
 * for, behind `wsp --help agent`; `host` the plumbing under `wsp host`; `dev` the doctor, behind `wsp --help dev`;
 * `app` a line the app's own screens stand on, printed on no page, still parsed and still served as a tool. Every
 * line declares one, so a line added prints somewhere or says in the table that it prints nowhere. */
export type Page = "front" | "agent" | "host" | "dev" | "app";

/** A verb on both doors: the words that select it on the command line, its usage and one phrase on what it does in
 * every help, the page it prints on, the flags it reads beside COMMON, its run, and its tool. */
/** One flag of a verb's table: the parser's own row, and `valueWith` where the flag's value is optional: alone it
 * stands bare, and it takes the word after it as its value only on a line that also carries the flag named there. */
export type FlagRow = NonNullable<ParseArgsConfig["options"]>[string] & { valueWith?: string };
export type FlagTable = Readonly<Record<string, FlagRow>>;

/** The line with each flag whose row makes its value optional written `--<flag>=` where it stands bare, so the parser
 * reads it alone: where its row's other flag is not on the line, or no word follows it. */
export function optionalValues(argv: readonly string[], table: FlagTable): string[] {
  const cut = argv.indexOf("--");
  const words = cut === -1 ? argv : argv.slice(0, cut);
  const has = (name: string): boolean => words.some(w => w === `--${name}` || w.startsWith(`--${name}=`));
  const bare = new Set<number>();
  for (const [name, row] of Object.entries(table)) {
    if (row.valueWith === undefined) continue;
    const alone = !has(row.valueWith);
    words.forEach((w, i) => {
      if (w === `--${name}` && (alone || words[i + 1] === undefined || words[i + 1]!.startsWith("-"))) bare.add(i);
    });
  }
  return argv.map((w, i) => (bare.has(i) ? `${w}=` : w));
}

export interface CliVerb {
  name: string;
  usage: string;
  about: string;
  page: Page;
  options: FlagTable;
  run(ctx: VerbContext): Promise<number>;
  tool: Tool;
  readsHere?: string;
}

/** A verb the tool door alone offers, with why the command line has no such line. */
export interface ToolOnlyVerb {
  name: string;
  tool: Tool;
  toolOnly: string;
  readsHere?: string;
}

/** A verb the command line alone offers, with why no tool serves it: a line only a person at this terminal has any
 * business running. The parity test holds the reason as it holds a tool-only verb's. */
export interface CliOnlyVerb extends Omit<CliVerb, "tool"> {
  cliOnly: string;
  /** Why this line runs at its own host's terminal and nowhere else. The flag is still parsed, so a typed --host
   * reads this sentence rather than the parser's unknown option, and so does WSP_HOST and the account's one host. */
  hostSide?: string;
}

export type Verb = CliVerb | ToolOnlyVerb | CliOnlyVerb;

/** Why a verb's work is on the computer the wsp process runs on rather than on the host it drives: it reads this
 * computer's own package managers, agent history or terminal config. Read by the doors that serve a caller which is
 * not on this computer, since there "this computer" would be the person's and not the machine the caller is on. */
export function readsHere(verb: Verb): string | undefined {
  return "readsHere" in verb ? verb.readsHere : undefined;
}

/** Whether this verb is served as a tool; a cli-only one says in its own words why not. */
export function hasTool<V extends Verb>(verb: V): verb is Extract<V, { tool: Tool }> {
  return "tool" in verb;
}

/** The one rule that names a verb's tool: its words joined by underscores, so `thread read` is `thread_read`. */
export function toolName(words: string): string {
  return words.replace(/ /g, "_");
}

/** The flags every verb takes beside its own. */
export const COMMON: NonNullable<ParseArgsConfig["options"]> = {
  host: { type: "string" },
  state: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

/** The letter each shared flag also answers to. */
const COMMON_SHORTS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(COMMON).flatMap(([name, option]) => (typeof option.short === "string" ? [[option.short, name]] : [])));

/** The shared flags read off a whole line, each with the value it carries, and the rest of the words in the order
 * they were typed. This runs before the verb's words select it, so a shared flag sits as readily in front of them as
 * behind, and whatever is left is the verb's to parse: a word this pass does not know stays where it was typed, for
 * the parse that does know the line to refuse by name. From `--` on the words are the line's own, never flags. */
export function takeCommon(argv: ReadonlyArray<string>): { common: string[]; rest: string[] } {
  const common: string[] = [];
  const rest: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "--") {
      rest.push(...argv.slice(at));
      break;
    }
    const name = word.startsWith("--") ? word.slice(2).split("=")[0]! : word.startsWith("-") ? COMMON_SHORTS[word.slice(1)] : undefined;
    const option = name === undefined ? undefined : COMMON[name];
    if (option === undefined) {
      rest.push(word);
      continue;
    }
    const value = option.type === "string" && !word.includes("=") ? argv[at + 1] : undefined;
    // A flag needing a value and given none by the end of the line stays where it was typed: moved in front of the
    // words that follow it, the parse would read one of them as its value instead of refusing the flag by name.
    if (option.type === "string" && !word.includes("=") && value === undefined) {
      rest.push(word);
      continue;
    }
    common.push(word);
    if (value !== undefined) common.push(argv[++at]!);
  }
  return { common, rest };
}

/** The model, effort and access mode flags, on every verb that opens a thread. */
const PICK_FLAGS = ["model", "effort", "access"] as const;
/** What a message into a thread that has run may name. Its access is not one: a thread's access is the thread's
 * own, changed where the person changes it and never by a message, so the flag reads here as a flag this verb
 * does not take rather than as a pick that is quietly dropped. */
const SEND_FLAGS = ["model", "effort"] as const;
const optionsFor = (names: readonly string[]): NonNullable<ParseArgsConfig["options"]> => Object.fromEntries(names.map(name => [name, { type: "string" }]));
const PICK_OPTIONS = optionsFor(PICK_FLAGS);
const SEND_OPTIONS = optionsFor(SEND_FLAGS);

const flag = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
export const flagList = (flags: Flags, name: string): string[] => (Array.isArray(flags[name]) ? (flags[name] as string[]) : []);

/** Rule one on the front page: the workspace comes first. Two words the other way round are named rather than run,
 * since the second would otherwise be read as a workspace nothing lists. The swap is only called when the second
 * word is a workspace the host lists and the first is not, so a line whose first word is a real workspace is taken
 * as typed whatever follows it. */
export const wordsSwappedLine = (verb: string, first: string, second: string, what: string): string =>
  `wsp ${verb} takes the workspace first; ${JSON.stringify(first)} reads as one and ${second} as ${what}`;
export const wordsSwappedFix = (verb: string, first: string, second: string): string => `Run wsp ${verb} ${second} ${JSON.stringify(first)}.`;

/** The workspace and the word that follows it, off a line of one or two words: one word is the word alone, with the
 * workspace left for the caller to infer. */
export async function workspaceFirst(client: HostClient, verb: string, args: readonly string[], what: string): Promise<[string | undefined, string]> {
  const [first, second] = args;
  if (second === undefined) return [undefined, first!];
  const listed = await workspaces(client);
  const names = (ref: string): boolean => listed.some(w => w.name === ref || w.id === ref);
  if (!names(first!) && names(second)) throw usageRefusal(wordsSwappedLine(verb, first!, second, what), wordsSwappedFix(verb, first!, second));
  return [first, second];
}

export async function workspaces(client: HostClient): Promise<WorkspaceOut[]> {
  return (await client.request<{ workspaces: WorkspaceOut[] }>("workspaces.list")).workspaces;
}

/** Every workspace with what the app's rail reads live beside it: the provider's word for the machine and the daemon
 * reach, without the route the reach carries, which the runtime keeps off this door. The listing above is what every
 * verb that only needs to name a workspace takes, since this one probes. */
export async function workspaceStatuses(client: HostClient): Promise<WorkspaceListing[]> {
  return (await client.request<{ statuses: WorkspaceListing[] }>("status.list")).statuses;
}

async function threads(client: HostClient, workspaceId?: string): Promise<ThreadView[]> {
  const { sessions } = await client.request<{ sessions: SessionView[] }>("sessions.list", workspaceId !== undefined ? { workspaceId } : {});
  return foldThreads(sessions);
}

/** A workspace as a person names it: by id, else by its name when exactly one carries it. The host reads the name off
 * the same list it prints, so a workspace the listing shows is never denied here as absent, and one this caller may
 * not drive is refused in the words of the rule that hides it. */
export async function workspaceOf(client: HostClient, ref: string): Promise<WorkspaceOut> {
  const { workspace } = await client.request<{ workspace?: unknown }>("workspaces.resolve", { ref });
  const read = WorkspaceOut.safeParse(workspace);
  if (!read.success) throw new Error(otherVersion("workspaces.resolve"));
  return read.data;
}

/** The thread a reference names among these rows: by id, or by a prefix of it that names exactly one. */
function pickThread(all: readonly ThreadView[], ref: string): ThreadView {
  const exact = all.find(t => t.id === ref);
  if (exact !== undefined) return exact;
  const prefixed = all.filter(t => t.id.startsWith(ref));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) throw new Error(`${prefixed.length} threads start with ${ref}; give more of the id`);
  throw notFoundRefusal(`no thread ${ref}`);
}

/** A thread by id, or by a prefix of it that names exactly one. */
export async function threadOf(client: HostClient, ref: string): Promise<ThreadView> {
  return pickThread(await threads(client), ref);
}

/** Several threads by the same rule, off one listing, in the order named. */
export async function threadsOf(client: HostClient, refs: readonly string[]): Promise<ThreadView[]> {
  const all = await threads(client);
  return refs.map(ref => pickThread(all, ref));
}

export type ThreadRow = ThreadView & { projectName: string; workspaceName: string; computerName: string };

/** The sidebar's rows with the project, the workspace and the computer each thread is on, within one workspace when
 * named, as every director lists them. The three names come off one reading of the workspaces and one of the
 * computers, so a table is never half of two. */
export async function threadRows(client: HostClient, within?: string): Promise<ThreadRow[]> {
  const all = await workspaces(client);
  const scope = within !== undefined ? await workspaceOf(client, within) : undefined;
  const rows = await threads(client, scope?.id);
  // The names a person gave their computers are the person's to read: a caller the host answers as a thread is
  // refused that list, and its rows carry the computer's id instead of falling over.
  const named = rows.length === 0 ? new Map<string, string>() : await placeNames(client).catch(() => new Map<string, string>());
  return rows.map(t => {
    const workspace = all.find(w => w.id === t.workspaceId);
    return {
      ...t,
      projectName: workspace?.project.name ?? "",
      workspaceName: workspace?.name ?? t.workspaceId,
      computerName: workspace === undefined ? "" : (named.get(workspace.project.computer) ?? workspace.project.computer),
    };
  });
}

/** How the computer a workspace's project lands on pauses a machine, for every line that prints a state word: the
 * landing's own flags, which is the reading the app's rows take it from too, so the table and the sidebar cannot
 * say two things about one nap. Nothing where the landing is refused, which reads the stopping words as every
 * caller holding no mode does. */
export async function pauseModeOf(client: HostClient, project: string): Promise<PauseMode | undefined> {
  try {
    return (await client.request<{ capabilities: Capabilities }>("workspaces.landing", { project })).capabilities.pauseMode;
  } catch {
    return undefined;
  }
}

/** The workspace's name and its state word, the line a pause prints once the runtime has answered: the phase is the
 * whole of what a pause changed, and the machine's own state follows it. The computer's pause mode rides, so a nap
 * at a provider that keeps the machine's memory reads paused and a stop reads stopped. */
export function stateLine(workspace: WorkspaceView, pauseMode?: PauseMode): string {
  return workspaceStateLine(workspace.name, workspaceState({ phase: workspace.phase }), pauseMode);
}

/** The line a wake prints: the word the next `wsp workspaces` will print for this workspace, read back off the
 * listing once the wake has settled rather than off the phase the wake wrote. A wake that says running while the
 * table says unreachable is two answers about one machine, and the phase alone cannot tell them apart. */
export async function wokeLine(client: HostClient, workspace: WorkspaceOut): Promise<string> {
  const listed = (await workspaceStatuses(client)).find(w => w.id === workspace.id);
  const mode = await pauseModeOf(client, workspace.project.id);
  return workspaceStateLine(workspace.name, listed === undefined ? workspaceState({ phase: workspace.phase }) : workspaceStateOf(listed, listed), mode);
}

/** Naps the workspace a person names; the view after, as every director shows it. */
export async function nap(client: HostClient, ref: string): Promise<WorkspaceOut> {
  const source = await workspaceOf(client, ref);
  return (await client.request<{ workspace: WorkspaceOut }>("workspaces.nap", { workspaceId: source.id })).workspace;
}

/** Replaces the machine under a workspace the provider no longer has, the road out of gone that the app's row
 * action takes. The status is read beside the record so the refusal is the row's own: the record alone carries no
 * reach, and a workspace whose machine stopped answering would read as answering here while every pane on it read
 * that it had not. The runtime alone knows the machine is replaced, and the view it returns carries the new one. */
export async function rebuild(client: HostClient, ref: string): Promise<WorkspaceOut> {
  const source = await workspaceOf(client, ref);
  const listed = (await workspaceStatuses(client)).find(w => w.id === source.id) ?? null;
  const state = { phase: source.phase, machineState: listed?.machineState, reach: listed?.reach.state, wakeRefused: source.wakeRefused };
  if (!needsRebuild(state)) throw new Error(goneRoadRefusal(workspaceState(state), "rebuild"));
  return (await client.request<{ workspace: WorkspaceOut }>("workspaces.rebuild", { workspaceId: source.id })).workspace;
}

/** The state line every director prints after a rebuild, with the machine now under the workspace: the id changed,
 * so a caller that held the old one is told. No pause mode rides: a machine forked a moment ago is running, and the
 * mode only ever picks between the words for a machine that is not. */
export function rebuiltLine(workspace: WorkspaceView): string {
  return `${stateLine(workspace)} on ${workspace.machineId}`;
}

/** The image and its copies as this host serves them, parsed and not trusted, for every director that draws them. */
async function imageView(client: HostClient): Promise<SealedImageView> {
  const { view } = await client.request<{ view: unknown }>("image.get", {});
  return SealedImageView.parse(view);
}

/** Builds this host's image at a place, streaming the build's lines as the runtime reports them: one line per stage,
 * the same words the creation log prints. The record is read back after it, so the copy is said in the words `wsp
 * image` says it in; every refusal is the host's. */
export async function buildImageAt(client: HostClient, out: Out, word: string, force?: boolean): Promise<{ image: SealedImage; built: SealedImageBuilt }> {
  // The build's frames carry the place's id, whichever word the person typed for it, and the lines read its name. A
  // word the list does not hold goes to the host as typed: the host is the one judge of what it names.
  const listed = (await client.request<{ places: PlaceView[] }>("places.list")).places.find(p => namesPlace(p, word));
  const place = listed ?? { id: word, name: word };
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "golden.stage" && (f as unknown as GoldenStageEvent).place === place.id,
    f => {
      const e = f as unknown as GoldenStageEvent;
      const words = e.stage === "failed" ? "Failed" : GOLDEN_STAGE_WORDS[e.stage];
      out.stream(`${[`${place.name}: ${words}`, ...(e.detail !== undefined ? [e.detail] : [])].join(" · ")}\n`);
    },
  );
  try {
    const { build } = await client.request<{ build: unknown }>("image.build", { place: place.id, ...(force === true ? { force } : {}) });
    const view = await imageView(client);
    if (view.image === null) throw new Error(NO_SEALED_IMAGE);
    return { image: view.image, built: SealedImageBuilt.parse(build) };
  } finally {
    pushed.stop();
  }
}

/** A pin's row by name: the catalog's for a catalog id, else the package a row outside the catalog names. */
const pinName = (pin: SealedPin): string => catalogEntry(pin.id)?.name ?? packageOf(pin);

/** What every director prints for the image: the record, a row per place, what each row installed at the seal, and
 * the project images under it. */
function imageLines(view: SealedImageView): string[] {
  if (view.image === null) return [NO_SEALED_IMAGE];
  const image = view.image;
  return [
    sealedImageLine(image),
    ...view.copies.map(c => sealedCopyLine(image, c)),
    ...(image.pins ?? []).map(p => `  ${sealedPinLine(pinName(p), p, isRoad(p.road) ? ROAD_MODULES[p.road].words : undefined)}`),
    ...view.projects.map(sealedProjectLine),
  ];
}

/** Why an export runs at its own host's terminal: the bytes it writes are the person's sign-ins, so the file lands
 * on the computer whose terminal asked for it and the passphrase never crosses to another. */
export const HOST_SIDE_VAULT = "The vault leaves the host only as a sealed file on the computer that typed the line.";

/** The passphrase an export is sealed to: typed twice at a terminal, read from the environment where there is none,
 * and never taken from the command line, which every process on this computer can read. */
async function imagePassphrase(ctx: VerbContext): Promise<string> {
  const short = (word: string): string => (word.length < IMAGE_PASSPHRASE_MIN ? `the passphrase is ${IMAGE_PASSPHRASE_MIN} characters at least` : "");
  if (ctx.io.isTTY !== true) {
    const held = ctx.env[IMAGE_PASSPHRASE_ENV];
    if (held === undefined || held === "") throw usageRefusal("nobody is at this terminal to type a passphrase.", `Set ${IMAGE_PASSPHRASE_ENV} for this run instead.`);
    const why = short(held);
    if (why !== "") throw usageRefusal(`${IMAGE_PASSPHRASE_ENV} is too short: ${why}.`, "Set a longer one and run this again.");
    return held;
  }
  // Through the run's own io, as every other question this command line asks is: it is what a terminal answers
  // without echo and what a test answers in its place.
  const typed = await ctx.io.askSecret(`A passphrase for this export\n${IMAGE_PASSPHRASE_MIN} characters at least; it is the only way back into the file`);
  const why = short(typed);
  if (why !== "") throw usageRefusal(`${why}.`, "Nothing was exported; run it again and type a longer one.");
  const again = await ctx.io.askSecret("The same passphrase again");
  if (again !== typed) throw usageRefusal("the two passphrases are not the same.", "Nothing was exported; run it again and type the same one twice.");
  return typed;
}

/** Moves a workspace onto the newest version of the image it stands on, by the id a caller already resolved. The
 * runtime alone knows which of the image's own files the workspace changed, so the whole answer, the kept list
 * included, comes back from it. */
export async function moveImage(client: HostClient, workspaceId: string): Promise<UpgradeResult> {
  const { workspace, moved, kept, fallback } = await client.request<UpgradeResult>("workspaces.updateImage", { workspaceId });
  return { workspace, moved, kept, ...(fallback === true ? { fallback: true } : {}) };
}

/** What every director prints after the move: where the workspace stands, on which machine, and what of the image's
 * own files came across as this workspace's rather than the new image's. One that had nowhere to go says that
 * instead of naming files nothing judged, off the answer's own word for it. */
export function imageMovedLine(moved: UpgradeResult): string {
  return `${rebuiltLine(moved.workspace)}; ${moved.moved ? imageKeptLine(moved.kept, moved.fallback) : IMAGE_ALREADY_NEWEST}`;
}

/** What a workspace rename came to, as every director prints it: the name it went in under and the record after. */
export interface RenamedWorkspace {
  was: string;
  workspace: WorkspaceOut;
}

/** Names the workspace a person names, through the runtime, which holds the name on this computer. The name is
 * unique here, so a duplicate and a blank one come back as the runtime's own refusal. */
export async function renameWorkspace(client: HostClient, ref: string, name: string): Promise<RenamedWorkspace> {
  const source = await workspaceOf(client, ref);
  const { workspace } = await client.request<{ workspace: WorkspaceOut }>("workspaces.rename", { workspaceId: source.id, name });
  return { was: source.name, workspace };
}

export function renamedWorkspaceLine(r: RenamedWorkspace): string {
  return `${r.was} is now ${r.workspace.name} ${r.workspace.id}`;
}

/** A workspace a verb woke to do its work on, and whether this call is what woke it: a machine the person already
 * had running is theirs, and only the caller that took it off its nap owes it one back. */
export interface Woken {
  workspace: WorkspaceOut;
  woke: boolean;
}

/** The states a machine is down in, which are the only ones a wake can lift it out of. A machine another client is
 * already waking, or one running but out of reach, was not taken off its nap by the caller that met it there, so
 * neither counts: the fact is the transition this call made, never the word the state happened to read. `pausing`
 * is here because the nap behind it is one somebody asked for, and a run that cuts that short owes it back. */
const MACHINE_DOWN: ReadonlySet<WorkspaceState> = new Set<WorkspaceState>(["paused", "pausing"]);

/** Every verb that needs the machine goes through here, so a paused or waking workspace is a wait and never the
 * provider's error. The runtime is asked even when the view says running: only its state read catches a provider-side
 * pause. The runtime refuses a gone workspace too; the refusal here exists to carry the verb's own action word. */
export async function awake(client: HostClient, workspace: WorkspaceView, action: string, tell: (line: string) => void): Promise<Woken> {
  const before = workspaceState({ phase: workspace.phase });
  if (before === "gone") throw new Error(goneRefusal(action, workspace.gone));
  if (before !== "running") tell(`waking ${workspace.name}`);
  const woken = (await client.request<{ workspace: WorkspaceOut }>("workspaces.wake", { workspaceId: workspace.id })).workspace;
  return { workspace: woken, woke: MACHINE_DOWN.has(before) && workspaceState({ phase: woken.phase }) === "running" };
}

/** The bring back over the wire, one road for the command line and the tool. */
async function broughtBack(client: HostClient, workspaceId: string, title?: string, body?: string): Promise<BringBackResult> {
  return BringBackResult.parse(
    await client.request("workspaces.bringBack", { workspaceId, ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) }),
  );
}

/** What a bring back reads as: where the branch went and how far it is over the base, git's own diffstat under it,
 * then the pull request or why there is none, and last what stayed behind in the workspace. The push's lines come
 * first whatever the pull request half said, since that half runs after the branch has landed on the remote. */
function broughtBackLine(name: string, back: BringBackResult): string {
  const commits = `${back.ahead} commit${back.ahead === 1 ? "" : "s"}`;
  const left = `${back.uncommitted} change${back.uncommitted === 1 ? "" : "s"}`;
  return [
    `${name}: ${back.branch} pushed, ${commits} over ${back.base}`,
    ...back.stat,
    back.pr === undefined ? (back.note ?? back.refused) : `${back.pr.url} (${back.pr.state})`,
    back.uncommitted === 0 ? undefined : `${left} left in the workspace; nothing uncommitted travels`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** What a launch owes the machine it woke when its thread never got going. Sleeping is automatic by window, and a
 * window is twenty minutes of the provider's rate for a turn that never reached the agent; the launch that took
 * the machine off its nap is the one that knows nothing else ran there. A machine the person already had running
 * is theirs and is neither touched nor spoken about here. Answers the line, which is the run's last, or nothing
 * where this launch changed nothing about the machine. */
export async function napAfterDeadLaunch(client: HostClient, woken: Woken, turn: Turn | undefined): Promise<string | undefined> {
  if (!woken.woke) return undefined;
  // An agent that named a refusal of its own is an agent that ran: the launch reached it, and the window the rule
  // gives a turn that ran is the right one.
  if (turn?.result?.refusal !== undefined) return undefined;
  try {
    const rows = await threads(client, woken.workspace.id);
    const mine = turn === undefined ? undefined : rows.find(t => threadIdOf(t) === turn.threadId);
    // A thread whose turn did work is not a launch that died: the machine holds what it did.
    if (mine?.ran === true) return undefined;
    if (rows.some(t => t !== mine && t.status === "running")) {
      const listed = (await workspaceStatuses(client)).find(w => w.id === woken.workspace.id);
      return workspaceStaysAwakeLine(woken.workspace.name, listed?.idleAt === undefined ? undefined : Math.max(0, listed.idleAt - Date.now()));
    }
    await client.request("workspaces.nap", { workspaceId: woken.workspace.id });
    return workspaceAsleepAgainLine(woken.workspace.name);
  } catch {
    // Whatever this road came to, the machine is awake as far as this run knows and the person is told that much.
    // The failure the run is answering with is what stands; none of it is worth losing to a second one.
    return workspaceStaysAwakeLine(woken.workspace.name);
  }
}

/** The same refusal with one more line under it. The class an exit code is read off is stamped on the error, so a
 * line added to what a person reads carries that stamp over rather than making a plain failure of a refusal. */
function withLine(e: unknown, line: string | undefined): unknown {
  if (line === undefined || !(e instanceof Error)) return e;
  const kind = (e as { kind?: unknown }).kind;
  return Object.assign(new Error(`${e.message}\n${line}`), typeof kind === "string" ? { kind } : {});
}

/** What a stop came to, as every director prints it: the runtime's three answers, none an error. */
export interface Stopped {
  threadId: string;
  outcome: SessionInterruptOutcome;
  /** The threads this thread's agents spawned that were running and stopped with it. */
  under?: readonly string[];
}

/** Stops the running turn of the thread a person names, through the runtime as the app's stop button does; the
 * machine is not touched. Parsed, not trusted: an outcome outside the enum must not read as stopped. */
export async function stop(client: HostClient, ref: string): Promise<Stopped> {
  const thread = await threadOf(client, ref);
  const { outcome, under } = SessionInterruptResult.parse(await client.request("sessions.interrupt", { sessionId: thread.sessionId }));
  return { threadId: thread.id, outcome, ...(under !== undefined && under.length > 0 ? { under } : {}) };
}

const STOP_WORDS: Record<SessionInterruptOutcome, string> = { accepted: "stopped", "not-running": "not running", "not-found": "not found by the host" };

export function stopLine(stopped: Stopped): string {
  const under = stopped.under ?? [];
  const tree = under.length === 0 ? "" : `, and with it ${under.length} ${under.length === 1 ? "thread" : "threads"} its agents spawned: ${under.map(threadWord).join(", ")}`;
  return `thread ${stopped.threadId} ${STOP_WORDS[stopped.outcome]}${tree}`;
}

/** Drops the thread from this computer through the runtime, the road the app's row action takes; the runtime
 * refuses one whose turn ran and nothing on the machine is touched either way. A row from before threads carries
 * no thread id, so it is refused here in its own words rather than dialled for and answered as a thread nobody has,
 * which is the guard the app's row action makes before it offers the action at all. */
export async function forgetThread(client: HostClient, thread: ThreadView): Promise<void> {
  if (thread.threadId === undefined) throw new Error(threadWithoutIdRefusal(thread.id));
  await client.request("sessions.forget", { threadId: thread.threadId });
}

/** The line every director prints for a forget, naming what nobody loses: no turn of the thread did any work. */
export function threadForgotLine(thread: ThreadView): string {
  return `forgot thread ${thread.id}: no turn ever ran on it, so nothing of its work is gone`;
}

/** What a rename came to, as every director prints it: the runtime's five answers, none an error. `error` is the
 * line the machine gave for a write it refused, and rides only that answer. */
export interface Renamed {
  threadId: string;
  title: string;
  harness: string;
  outcome: SessionRenameOutcome;
  error?: string;
}

/** Names the thread a person names, through the runtime, which writes the name into the agent's own store on the
 * machine. Parsed, not trusted: an outcome outside the enum must not read as renamed. */
export async function rename(client: HostClient, thread: ThreadView, title: string): Promise<Renamed> {
  const { outcome, error } = SessionRenameResult.parse(await client.request("sessions.rename", { sessionId: thread.sessionId, title }));
  return { threadId: thread.id, title, harness: thread.harness, outcome, ...(error !== undefined ? { error } : {}) };
}

/** Each answer in one phrase, the agent named where the answer is about the agent's own store, and the machine's own
 * line where the store refused the write: nothing here says which sessions a store has unless the store said it. */
export function renameLine(renamed: Renamed): string {
  const agent = agentName(renamed.harness);
  const words: Record<SessionRenameOutcome, string> = {
    renamed: `named ${renamed.title}, in ${agent} too`,
    unsupported: `not named: ${agent} keeps no name of a person's for a session`,
    "no-session": `not named: ${agent} on the machine has no such session`,
    failed: `not named: ${renamed.error ?? "the machine said nothing about the write"}`,
    "not-found": "not found by the host",
  };
  return `thread ${renamed.threadId} ${words[renamed.outcome]}`;
}

/** What a delete does to this workspace's machine, in its kind's own words: both lines about what a delete takes
 * read the one entry, so neither can say the other kind's sentence. */
const onDelete = (workspace: WorkspaceView): MachineOnDelete => onDeleteOf(workspaceKind(workspace), workspace.copy);

/** What dropping a workspace takes off this computer, counted before anyone is asked: its record and its threads. */
export interface Dropping {
  workspace: WorkspaceView;
  threads: number;
}

export async function dropping(client: HostClient, ref: string): Promise<Dropping> {
  const workspace = await workspaceOf(client, ref);
  return { workspace, threads: (await threads(client, workspace.id)).length };
}

/** The one confirmation a forget asks, naming what goes; the first line is the question, the second its hint. */
export function forgetQuestion(f: Dropping): string {
  return `Forget ${f.workspace.name}?\n${forgetNotice(f.threads)}`;
}

/** Drops the workspace from the host's store; the runtime refuses while its machine still exists. */
export async function forget(client: HostClient, f: Dropping): Promise<void> {
  await client.request("workspaces.forget", { workspaceId: f.workspace.id });
}

export function forgotLine(f: Dropping): string {
  return `forgot ${f.workspace.name} ${f.workspace.id}: its record and ${fmtThreads(f.threads)} are gone from this computer`;
}

/** The one confirmation a delete asks, in the words every client shows: what a forget takes, and the machine too. */
export function deleteQuestion(d: Dropping): string {
  return `Delete ${d.workspace.name}?\n${deleteNotice(d.threads, workspaceKind(d.workspace), d.workspace.copy)}`;
}

/** The one confirmation a project image's removal asks: the id, and what goes with it. */
export function imageRemoveQuestion(g: ProjectGolden): string {
  return `Remove project image ${g.snapshotId}?\n${projectImageRemoveNotice(g)}`;
}

/** Kills the workspace's machine at the provider, then drops its record here; a machine already gone is no error. */
export async function deleteWorkspace(client: HostClient, d: Dropping): Promise<void> {
  await client.request("workspaces.delete", { workspaceId: d.workspace.id });
}

export function deletedLine(d: Dropping): string {
  return `deleted ${d.workspace.name} ${d.workspace.id}: ${onDelete(d.workspace).done(d.workspace.machineId)}, and its record and ${fmtThreads(d.threads)} are gone from this computer`;
}

/** The most characters a folder cell holds before its front is cut: the end of a path is what a person recognises. */
const FOLDER_WIDTH = 40;

/** The most characters a title cell holds before its end is cut: the opening words are what a person recognises. */
const TITLE_WIDTH = 60;

/** The path within `width` cells, cut at the front behind an ellipsis when it is longer. */
export function shortenedFront(path: string, width: number): string {
  return path.length <= width ? path : `…${path.slice(path.length - width + 1)}`;
}

/** The text within `width` cells, cut at the end before an ellipsis when it is longer. */
export function shortenedEnd(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function threadLine(t: ThreadRow, indent = ""): string[] {
  return [t.projectName, t.workspaceName, `${indent}${t.id}`, t.harness, threadWordOf(t), t.startedBy, t.computerName, shortenedEnd(t.title, TITLE_WIDTH)];
}

/** The rows a --tree listing prints: every thread a person or the command line opened, each followed by the ones
 * its agents spawned, indented one step per level. A row whose parent is not in the listing stands at the top
 * rather than vanishing, so a workspace filter never hides a thread. */
export function threadTree(rows: readonly ThreadRow[]): { row: ThreadRow; depth: number }[] {
  const held = new Set(rows.map(r => r.id));
  const parentOf = (row: ThreadRow): string | undefined => (row.parentThreadId !== undefined && held.has(row.parentThreadId) ? row.parentThreadId : undefined);
  const out: { row: ThreadRow; depth: number }[] = [];
  const drawn = new Set<string>();
  const walk = (parent: string | undefined, depth: number): void => {
    for (const row of rows) {
      if (drawn.has(row.id) || parentOf(row) !== parent) continue;
      drawn.add(row.id);
      out.push({ row, depth });
      walk(row.id, depth + 1);
    }
  };
  walk(undefined, 0);
  // A row whose parents lead round in a circle is under no top row, and a listing prints every row it was given:
  // it stands at the top rather than vanishing, since a thread nobody can see is worse than one drawn flat.
  for (const row of rows) if (!drawn.has(row.id)) out.push({ row, depth: 0 });
  return out;
}

/** A workspace row: one kind of thing per column. WHERE is the computer or the provider it runs on in the words a
 * person uses for it, off the one reading every surface asks that question through; SIZE is the shape of the
 * machine in the kind's own word for a cpu, empty on a kind wsp holds no shape for. The id the provider minted for
 * the machine is on no row: it names nothing a person typed, and `wsp workspaces --json` carries it. STATE is one
 * word for every row, this computer's included, read off the status through the one predicate the sidebar reads,
 * so a machine the provider has paused and one whose daemon is dark say here what they say there. The projects
 * themselves are wsp projects' table. */
export function workspaceLine(w: WorkspaceListing, places: ReadonlyMap<string, string> = new Map(), capabilities?: Pick<Capabilities, "copies" | "ownNetwork" | "pauseMode">): string[] {
  const kind = kindWords(workspaceKind(w));
  const named = w.place === undefined ? undefined : places.get(w.place) ?? w.place;
  return [
    w.name,
    w.id,
    w.project.name,
    whereWord(w, named),
    // What this workspace's copy of the project is and what its ports are, in the words the app's own row says
    // them in. Both cells are empty on a fork, whose project arrives by the runtime's own road.
    w.copy === undefined ? "" : madeOfWord(w.copy.road),
    w.copy === undefined || capabilities === undefined ? "" : portsWord(capabilities, w.portBase, hostPlatform()),
    kind.rowReadsMachine ? fmtSize(w.size, kind.cpu) : "",
    workspaceWord(workspaceStateOf(w, w), capabilities?.pauseMode),
    agentsWord(w.agents),
  ];
}

/** What each place this host holds is called, by the id a record names it with: the rows carry the id, and a person
 * reads the name they gave the computer. Asked only when a row names one. */
export async function placeNames(client: HostClient): Promise<Map<string, string>> {
  const { places } = await client.request<{ places: PlaceView[] }>("places.list");
  return new Map(places.map(p => [p.id, p.name]));
}

/** Every project this host holds, as every director draws them. */
export async function projectsOf(client: HostClient): Promise<ProjectView[]> {
  return (await client.request<{ projects: ProjectView[] }>("projects.list")).projects;
}

/** The project a person names, by id or by name; a word naming none is refused with the ones there are. */
export async function projectOf(client: HostClient, ref: string): Promise<ProjectView> {
  return (await client.request<{ project: ProjectView }>("projects.resolve", { ref })).project;
}

/** One project's row: its name, its id, the computer it lives on by the name this wsp holds for it, where its code
 * comes from, where the checkout sits inside a workspace of it, the branch a workspace starts on, and how many
 * workspaces it has. */
function projectLine(p: ProjectView, workspaces: readonly WorkspaceView[], named: ReadonlyMap<string, string>): string[] {
  return [
    p.name,
    p.id,
    computerNamed(p.computer, named, hostPlatform()),
    sourceWord(p.source),
    shortenedFront(p.path, FOLDER_WIDTH),
    p.base ?? "",
    String(workspaces.filter(w => w.project.id === p.id).length),
  ];
}

/** What a road with no project to make a workspace of says, with the road that records one. Exported because the
 * host's own workspace road and the command line both end on it. */
export const NO_PROJECT_YET = "no projects yet; wsp add <folder> records one here, and wsp add <url> --on <computer> records one there";

/** A workspace of one project: the landing is read first, so a computer that forks nothing refuses in one sentence
 * before a stage is streamed, and the image is the computer's own head unless a project image is named. `size`
 * is the --size word; `engine` asks the computer for its container engine through the fenced socket. */
/** The two flags a computer declares about copies, read through the landing of a project standing on it: a row
 * that carries a copy is a row on the computer the host runs on, so its own project is what answers. Asked once
 * per table and only where a row holds a copy, since every other row's cells are empty either way. */
export async function hereCapabilities(client: HostClient, project: string): Promise<Pick<Capabilities, "copies" | "ownNetwork" | "pauseMode">> {
  return (await client.request<{ capabilities: Capabilities }>("workspaces.landing", { project })).capabilities;
}

/** What every row of a listing needs about the computer its project lands on, by the project's id: the two copy
 * flags its COPY and PORTS cells read and the pause mode its STATE word reads. One ask per project a row names,
 * and a project whose landing is refused holds none, so its row says what its record carries. */
export async function landingsFor(client: HostClient, projects: ReadonlyArray<string>): Promise<Map<string, Pick<Capabilities, "copies" | "ownNetwork" | "pauseMode">>> {
  const held = new Map<string, Pick<Capabilities, "copies" | "ownNetwork" | "pauseMode">>();
  for (const project of new Set(projects)) {
    try {
      held.set(project, await hereCapabilities(client, project));
    } catch {
      // A computer that forks nothing has no landing to give; the row reads its record alone.
    }
  }
  return held;
}

export async function createFor(
  client: HostClient,
  out: Out,
  project: Pick<ProjectView, "id" | "name" | "computer">,
  name: string,
  asked: { from?: string; size?: string; agents?: Partial<WorkspaceAgents>; engine?: boolean; parent?: string } = {},
): Promise<WorkspaceCreateResult> {
  // A workspace here is a copy of the project's folder and forks nothing, so the words a fork takes have nothing to
  // act on: they are refused here in the runtime's own sentence, before the landing is even read.
  const forkWords = [asked.from !== undefined ? "--from" : "", asked.size !== undefined ? "--size" : "", asked.engine === true ? "--engine" : ""].filter(w => w !== "");
  if (copiesFolder(kindForComputer(project.computer)) && forkWords.length > 0) throw usageRefusal(copyTakesNone(project.name, forkWords), "Drop them.");
  const capabilities = (await client.request<{ capabilities: Capabilities }>("workspaces.landing", { project: project.id })).capabilities;
  const chosen = asked.size === undefined ? undefined : sizeChosen(capabilities, asked.size);
  const golden = asked.from === undefined ? undefined : await projectGoldenFor(client, asked.from, project);
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "workspace.creating" && (f as unknown as WorkspaceCreatingEvent).name === name,
    f => {
      out.emit(f);
      out.stream(`${(f as unknown as WorkspaceCreatingEvent).message}\n`);
    },
  );
  try {
    const { workspace, notice } = await client.request<{ workspace: WorkspaceOut; notice?: string }>("workspaces.create", {
      project: project.id,
      name,
      ...(golden !== undefined ? { golden } : {}),
      ...chosen,
      ...(asked.agents !== undefined ? { agents: asked.agents } : {}),
      ...(asked.engine === true ? { engine: true } : {}),
      ...(asked.parent !== undefined ? { parent: asked.parent } : {}),
    });
    const created: WorkspaceCreateResult = { workspace, ...(notice !== undefined ? { notice } : {}) };
    // The folder this workspace holds the project in: the copy's on this computer, since a person who just had a
    // copy made needs the path it landed at, and the checkout's inside a fork.
    const at = workspace.folder ?? workspace.project.path;
    out.emit(created, `created ${workspace.name} ${workspace.id}, a copy of ${workspace.project.name} at ${at}${notice !== undefined ? `\n${notice}` : ""}`);
    return created;
  } finally {
    pushed.stop();
  }
}

/** The snapshot a --from names, checked against the project it is being forked for: a project image carries the
 * project it was taken of, and one of another project would put the wrong work in place. */
async function projectGoldenFor(client: HostClient, ref: string, project: Pick<ProjectView, "name">): Promise<string> {
  const golden = await projectGoldenOf(client, ref);
  const carried = goldenForkName(golden);
  if (carried !== project.name) throw usageRefusal(`${ref} is a project image of ${carried}, and this workspace is for ${project.name}.`, `Name a project image of ${project.name}, or run wsp add to record ${carried} as a project.`);
  return golden.snapshotId;
}

/** The two words wsp new takes, in either order of presence: with one word it is the work and the project is the
 * only one there is, and with two the first names the project. A missing project where there are several is
 * refused naming them, so nobody guesses which repo the work is on. */
export async function projectFirst(client: HostClient, args: readonly string[]): Promise<[Pick<ProjectView, "id" | "name" | "computer">, string]> {
  if (args.length === 2) return [await projectOf(client, args[0]!), args[1]!];
  return [await theProject(client, undefined), args[0]!];
}

/** The project a caller named, or the only one this host holds; refused naming them all when there are several and
 * the caller named none. */
export async function theProject(client: HostClient, ref: string | undefined): Promise<Pick<ProjectView, "id" | "name" | "computer">> {
  if (ref !== undefined) return projectOf(client, ref);
  const all = await projectsHere(client);
  if (all.length === 1) return all[0]!;
  if (all.length === 0) throw usageRefusal(NO_PROJECT_YET, "Run wsp add <folder> to record one.");
  throw usageRefusal(nameTheProjectLine(all.map(p => p.name)), "Run wsp projects to read them.");
}

/** The projects a caller may name, by the door it is allowed: the host's own list for a person's terminal, and for
 * a caller the host answers as a thread, which reads its own tree and not the person's records, the projects its
 * own workspaces hold. */
async function projectsHere(client: HostClient): Promise<Pick<ProjectView, "id" | "name" | "computer">[]> {
  const held = await projectsOf(client).catch(() => undefined);
  if (held !== undefined) return held;
  const byId = new Map<string, Pick<ProjectView, "id" | "name" | "computer">>();
  for (const w of await workspaces(client)) byId.set(w.project.id, { id: w.project.id, name: w.project.name, computer: w.project.computer });
  return [...byId.values()];
}

/** What a --spawn line asks for, the one reading of it: nothing when nobody named a switch, so a workspace made
 * without one is off, and a cap named without --spawn on is refused rather than quietly turning it on. */
export function agentsAsked(spawn: string | boolean | undefined, maxMachines?: string | number, maxDepth?: string | number): (Partial<WorkspaceAgents> & { spawn: boolean }) | undefined {
  const on = typeof spawn === "string" ? onOffWord(spawn) : spawn;
  const machines = maxMachines === undefined ? undefined : countAsked("--max-machines", maxMachines, 0);
  // One level is the least a switch that is on can mean; none of them is what --spawn off already says.
  const depth = maxDepth === undefined ? undefined : countAsked("--max-depth", maxDepth, 1);
  if (on === undefined) {
    if (machines === undefined && depth === undefined) return undefined;
    throw usageRefusal("--max-machines and --max-depth say how far agents may go, so they need --spawn on beside them.", "Add --spawn on, or drop them.");
  }
  return { spawn: on, ...(machines !== undefined ? { maxMachines: machines } : {}), ...(depth !== undefined ? { maxDepth: depth } : {}) };
}

function onOffWord(word: string): boolean {
  if (word === "on") return true;
  if (word === "off") return false;
  throw usageRefusal(`--spawn takes on or off, and got ${JSON.stringify(word)}.`, "Write --spawn on or --spawn off.");
}

function countAsked(flagName: string, word: string | number, least: number): number {
  const n = Number(word);
  if (!Number.isInteger(n) || n < least) throw usageRefusal(`${flagName} takes a whole number of ${least === 0 ? "zero" : "one"} or more, and got ${JSON.stringify(String(word))}.`, `Write it as ${flagName} <n>.`);
  return n;
}

/** The size a --size word names, read but not checked: on a joined computer what is on offer is that computer's to
 * say, and the host refuses a size it does not offer with the same sentence this one would have. */
/** The size a --size word names, checked against what the host's provider offers before anything is minted. */
function sizeChosen(capabilities: Capabilities, word: string): WorkspaceSize {
  const size = sizeFromWord(word);
  if (size === undefined || !offeredSize(capabilities.sizes, size)) throw usageRefusal(sizeRefusal(word, capabilities.sizes), "Name one of those with --size.");
  return size;
}

/** The project golden a person names: by snapshot id, else the newest whose project carries that name. The caller
 * has read the landing before asking, so a host that forks nothing refuses there and never reaches this. */
export async function projectGoldenOf(client: HostClient, ref: string): Promise<ProjectGolden> {
  const { projectGoldens } = await client.request<{ projectGoldens: ProjectGolden[] }>("projectGoldens.list");
  const byId = projectGoldens.find(g => g.snapshotId === ref);
  if (byId !== undefined) return byId;
  const byName = projectGoldens.filter(g => g.projects.some(p => p.name === ref)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (byName[0] !== undefined) return byName[0];
  throw new Error(`no project image named ${ref}; wsp snapshot <workspace> takes one`);
}

/** The project image a snapshot id names, and nothing else: a remove never picks one by a project's name. */
async function projectImageOf(client: HostClient, id: string): Promise<ProjectGolden> {
  const { projectGoldens } = await client.request<{ projectGoldens: ProjectGolden[] }>("projectGoldens.list");
  const golden = projectGoldens.find(g => g.snapshotId === id);
  if (golden === undefined) throw notFoundRefusal(noProjectImageLine(id));
  return golden;
}

async function removeProjectImage(client: HostClient, id: string): Promise<ProjectGoldenRemoved> {
  return ProjectGoldenRemoved.parse(await client.request("projectGoldens.remove", { snapshotId: id }));
}

/** Sets what the agents on the workspace a person names may ask of this host; the record, as every director shows it. */
export async function setAgents(client: HostClient, ref: string, agents: Partial<WorkspaceAgents>): Promise<WorkspaceOut> {
  const source = await workspaceOf(client, ref);
  return (await client.request<{ workspace: WorkspaceOut }>("workspaces.agents", { workspaceId: source.id, ...agents })).workspace;
}

/** Snapshots the workspace a person names as a project golden; the record, as every director shows it. */
export async function snapshot(client: HostClient, ref: string): Promise<ProjectGolden> {
  const source = await workspaceOf(client, ref);
  return (await client.request<{ projectGolden: ProjectGolden }>("workspaces.snapshot", { workspaceId: source.id })).projectGolden;
}

export function projectGoldenLine(g: ProjectGolden): string {
  const version = g.version !== undefined ? `image v${g.version}` : `image ${g.golden}`;
  const carried = g.projects.map(p => `${p.name} imported ${p.importedAt.slice(0, 10)}`).join(", ");
  return `project image ${g.snapshotId}: ${version} plus ${carried}, taken from ${g.workspaceName}\nfork it with: wsp new <name> --from ${goldenForkName(g)}`;
}

/** The place a word names, by the name or the id the list carries; a word nothing holds is refused with the names
 * there are. One reading, so the verb and the tool answer an unknown place alike. */
export async function placeNamed(client: HostClient, word: string): Promise<PlaceView> {
  const places = (await client.request<{ places: PlaceView[] }>("places.list")).places;
  const found = places.find(p => namesPlace(p, word));
  if (found === undefined) throw usageRefusal(noSuchPlaceRefusal(word, places.map(p => p.name)), "Run wsp places.");
  return found;
}

/** The words a person gave beside the address, read once for the command line and the tool alike: a port that is a
 * number, a key that is a path on this computer, and the name they chose for the workspace. */
export function sshAsked(name?: string, port?: string, keyPath?: string): SshAsked {
  const dialled = port === undefined ? undefined : Number(port);
  if (dialled !== undefined && (!Number.isInteger(dialled) || dialled < 1 || dialled > 65535)) throw usageRefusal(`--ssh-port takes a port, and got ${JSON.stringify(port)}.`, "A port is a whole number from 1 to 65535.");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(dialled !== undefined ? { port: dialled } : {}),
    ...(keyPath !== undefined ? { keyPath: absolutePath("--ssh-key is a path on this computer", keyPath) } : {}),
  };
}

/** The line every recorded machine is announced with: its kind's own word for what the machine is, and under it
 * anything the one dial that recorded it has to say (the key a machine over ssh answered with). */
function createdExisting(out: Out, workspace: WorkspaceView, notice?: string): WorkspaceCreateResult {
  const created: WorkspaceCreateResult = { workspace, ...(notice !== undefined ? { notice } : {}) };
  out.emit(created, `created ${workspace.name} ${workspace.id} (${machineWord(workspaceKind(workspace))})${notice !== undefined ? `\n${notice}` : ""}`);
  return created;
}

const sessionEvent = (f: Frame): f is Frame & SessionEvent => typeof f.type === "string" && f.type.startsWith("session.");

/** A turn as a director sees it: the thread it opened or resumed, how the start went (its own turn, or the thread's
 * running one that took the message, or one that waited behind it), the harness's result once it ended, and the
 * runtime's reason when the runtime ended it. */
export interface Turn {
  session: SessionView;
  threadId: string;
  outcome: SessionStartOutcome;
  result?: TurnResult;
  reason?: string;
  /** The thread's previous turn ended without a result, as the turn's session.start said. */
  afterCut?: true;
}

/** A path a caller named, refused unless absolute: whoever reads it has a working folder of its own that the caller
 * cannot see, so a relative path resolves somewhere neither of them meant. `named` opens the line. */
export function absolutePath(named: string, path: string): string {
  if (!path.startsWith("/")) throw usageRefusal(`${named}, absolute, and got ${JSON.stringify(path)}.`, "Give a path that opens with /, since whoever reads it works in a folder this line cannot see.");
  return path;
}

/** A folder named for a thread, refused unless absolute: the harness would run a relative one against its own home
 * and fail inside the guest, where the person reads it as a harness failure. */
export function absoluteFolder(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : absolutePath("--cwd is a path on the machine", cwd);
}

/** The model, effort and access mode a start names, as the composer's pickers name them; the runtime checks each
 * against the harness's catalog and refuses with the list. access is the wire's permissionMode. */
export type Picks = Partial<Record<(typeof PICK_FLAGS)[number], string>>;

/** The picks as sessions.start carries them: the fields the app's composer sends, absent ones left out. */
export function picksOf(picks: Picks): Record<string, string> {
  return { ...(picks.model !== undefined ? { model: picks.model } : {}), ...(picks.effort !== undefined ? { effort: picks.effort } : {}), ...(picks.access !== undefined ? { permissionMode: picks.access } : {}) };
}

/** The head every image type is told apart by; the longest of the four is twelve bytes. */
const IMAGE_HEAD_BYTES = 12;

/**
 * The images a `--image` flag or an MCP `images` list names, read off this computer's disk and carried as bytes, so
 * nothing on the machine ever reaches back for the person's filesystem. Each file's type comes off its own first
 * bytes, never off its name, and the caps are checked against what the files weigh before any of them is read whole,
 * so naming a video does not pull it into memory to refuse it.
 */
export function imagesFrom(paths: readonly string[], elsewhere = false): ImageAttachment[] {
  // Before a path is resolved, let alone opened: a caller on a machine would otherwise learn from the refusals
  // which paths exist on the person's disk, and a file that does exist would be read and sent.
  if (elsewhere && paths.length > 0) throw usageRefusal(guestNoFileLine, "Name a file on the machine the line runs on, or none.");
  const files = paths.map(given => {
    const path = resolve(given);
    // A path this computer has nothing at, or has something other than a file at, answers in a sentence; the reader's
    // own ENOENT is what a person fat-fingering a screenshot path would otherwise get.
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) throw usageRefusal(notAFileLine(given), "Name a file that is already here.");
    const head = Buffer.alloc(IMAGE_HEAD_BYTES);
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, IMAGE_HEAD_BYTES, 0);
    } finally {
      closeSync(fd);
    }
    const mediaType = imageTypeOf(head);
    if (mediaType === null) throw usageRefusal(notAnImageLine(given), "Name one of those instead.");
    return { path, mediaType, name: basename(path), bytes: stat.size };
  });
  const refusal = imagesRefusal(files);
  if (refusal !== null) throw usageRefusal(`${refusal}.`, "Drop that one and send the rest.");
  return files.map(f => ({ mediaType: f.mediaType, name: f.name, bytes: readFileSync(f.path).toString("base64") }));
}

/** The three pick flags as given on the command line. */
export function pickFlags(flags: Flags): Picks {
  return Object.fromEntries(PICK_FLAGS.map(name => [name, flag(flags, name)]));
}

/** What a refusal adds when the list it quotes is wsp's own table rather than the machine's own answer: a person
 * reading a model they know their agent takes has to be told the list is not that agent's. */
export const BUILT_IN_LIST_CLAUSE = "; that list is wsp's built-in one, since no agent on that workspace described itself, and the agent on its machine may take more";
/** The same for a refusal that quotes no list, a model the table says takes no effort: "that list" would point at nothing. */
export const BUILT_IN_TABLE_CLAUSE = "; wsp's built-in table says so, since no agent on that workspace described itself";

/** Refuses, in the runtime's own words and before a machine is minted or woken for it, what the runtime would refuse
 * once the machine was there: an empty task or message, an agent the host has no adapter for, a pick the agent's
 * catalog does not list. Named a workspace, this asks that workspace's own machine, the same lists the app's composer
 * shows and the start itself will check against, so a model only that machine's config knows (a provider the agent is
 * routed to) is not refused here for being absent from a table. Without one, or on a workspace that is not running,
 * the table answers, and the start on the machine checks the rest. */
export async function checkedStart(client: HostClient, task: string, harness: string | undefined, picks: Picks, workspaceId?: string): Promise<void> {
  if (task.trim() === "") throw usageRefusal(EMPTY_TASK_LINE, "Put it in quotes after the flags.");
  const { harnesses } = await client.request<{ harnesses: HarnessCatalog[] }>("harnesses.list", workspaceId === undefined ? undefined : { workspaceId });
  const table = harnesses.find(c => (harness === undefined ? c.isDefault === true : c.harness === harness));
  if (table === undefined && harness !== undefined) throw usageRefusal(noAdapterLine(harness, harnesses.map(c => c.harness)), "Name one of those with --agent.");
  try {
    startPicks(table, picksOf(picks), true);
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    const clause = (e as { offered?: number }).offered === 0 ? BUILT_IN_TABLE_CLAUSE : BUILT_IN_LIST_CLAUSE;
    throw usageRefusal(table?.source === "table" ? `${said}${clause}` : said, "Drop the flag, or give it a value the agent offers.");
  }
}

/** The person's view preferences as the host keeps them: the last project per workspace and the last target. */
async function preferencesOf(client: HostClient): Promise<Preferences> {
  return Preferences.parse((await client.request<{ preferences: unknown }>("preferences.get")).preferences);
}

/** Where a thread goes and what the first line says it did: the workspace named, else the one holding the project the
 * caller's folder is a repo of, in that project. `named` is the caller's word for naming a workspace, for the refusal
 * outside a repo; a repo no workspace holds is refused naming both roads. Nothing is woken by asking. */
export async function threadTarget(client: HostClient, ref: string | undefined, cwd: string | undefined, named: string, elsewhere = false): Promise<{ workspace: WorkspaceOut; opened?: (threadId: string, folder: string) => string }> {
  if (ref !== undefined) return { workspace: await workspaceOf(client, ref) };
  // The folder a caller on a machine was typed in is that machine's; walking it here would read the person's own
  // checkouts for a git root and then pick the workspace their preferences map it to.
  if (elsewhere) throw usageRefusal(guestNamesWorkspaceLine, "Name the workspace on the line.");
  const root = cwd === undefined ? undefined : gitRootOf(cwd);
  if (root === undefined) throw usageRefusal(noThreadTargetLine(named), "Run wsp workspaces to read the names.");
  const held = workspaceForFolder(await workspaces(client), await projectsOf(client), root);
  if (held === null) throw new Error(noWorkspaceForFolderLine(root, named));
  const { workspace } = held;
  return { workspace, opened: (threadId, folder) => threadOpenedLine(threadId, workspace.name, homeShortened(folder, workspace.home)) };
}

/** The first line for a thread whose workspace was inferred: the folder it starts in is the one named outright, else
 * the inferred project's; nothing where a workspace was named, which keeps the plain `thread <id>` line. */
function openedLine(target: Awaited<ReturnType<typeof threadTarget>>, workspace: WorkspaceView, cwd: string | undefined): ((threadId: string) => string) | undefined {
  if (target.opened === undefined) return undefined;
  const say = target.opened;
  const folder = cwd ?? workspace.project.path;
  return threadId => say(threadId, folder);
}

/** The start that opens a new thread in a workspace, under the named agent or the runtime's default, in the folder
 * or the project named; both go to the host as given, since the folder a thread starts in when neither is named is
 * the runtime's one rule, the same one the app's composer reads. notify names who every turn's end on it is told,
 * each a thread or NOTIFY_ME. The one place both doors, the command line and the MCP server, put the token of the
 * turn they are running inside on a start: it is what the host reads NOTIFY_ME against, and there is none when the
 * caller is not a turn; the environment it is read off is the caller's, handed in, never this process's. */
export function openingOf(env: VerbDeps["env"], workspace: WorkspaceView, prompt: string, opts: Picks & { harness?: string; cwd?: string; notify?: readonly string[]; title?: string; images?: readonly string[]; elsewhere?: boolean } = {}): Record<string, unknown> {
  const cwd = absoluteFolder(opts.cwd);
  const attachments = imagesFrom(opts.images ?? [], opts.elsewhere);
  const turnToken = turnTokenOf(env);
  return {
    workspaceId: workspace.id,
    prompt,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(opts.harness !== undefined ? { harness: opts.harness } : {}),
    ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
    ...(turnToken !== undefined ? { turnToken } : {}),
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...picksOf(opts),
  };
}

/** What the --notify flags name for the runtime: NOTIFY_ME as given, and every other reference as the thread it
 * picks, by its full id. Nothing when the caller named none, so the thread keeps whatever it already had. */
export async function notifyOf(client: HostClient, refs: readonly string[]): Promise<string[] | undefined> {
  if (refs.length === 0) return undefined;
  const named: string[] = [];
  for (const ref of refs) {
    if (ref === NOTIFY_ME) named.push(NOTIFY_ME);
    else {
      const thread = await threadOf(client, ref);
      named.push(thread.threadId ?? thread.id);
    }
  }
  return named;
}

/** The start a message to an existing thread makes: the thread named to the runtime, which resumes its latest turn
 * or, on a thread whose harness never announced a session, runs the message as its first turn; under the thread's own
 * agent, with any pick named for this turn. A row from before threads had ids resumes by its session, and one with
 * neither is refused: a start naming nothing would open a new thread in silence. */
export function messageTo(thread: ThreadView, prompt: string, picks: Picks = {}, images: readonly string[] = [], elsewhere = false): Record<string, unknown> {
  if (thread.threadId === undefined && thread.claudeSessionId === undefined) throw new Error(`thread ${thread.id} has no session to resume yet`);
  const target = thread.threadId !== undefined ? { thread: thread.threadId } : { resume: thread.claudeSessionId };
  const attachments = imagesFrom(images, elsewhere);
  return { workspaceId: thread.workspaceId, prompt, harness: thread.harness, ...target, ...(attachments.length > 0 ? { attachments } : {}), ...picksOf(picks) };
}

/** A reply the protocol schema refuses: the host process predates or postdates this command's build. */
const otherVersion = (op: string): string => `the host answered ${op} in a shape this wsp does not read; it runs another version of wsp, restart it with wsp up`;
const OTHER_VERSION = otherVersion("sessions.start");

/** What the runtime pushes about a start before it answers it: the wait behind the thread's running turn, and the
 * moment the harness took a message into that turn. Both are minted by this start's own request id, so a view with
 * the same text in flight cannot hand this one another start's news. */
interface StartNews {
  queued?(): void;
  /** Fires when the runtime records the steer, which is the moment the harness took the message; it carries what
   * that turn was doing then, which the start's own reply does not. */
  steered?(event: SessionSteerEvent): void;
}

/** Starts a turn as `startedBy` and answers with it the moment the runtime names it: what a detached start returns
 * and what a follow goes on from. The send carries its own request id so an app view with the same text in flight
 * cannot take this turn's start for its own, and so each notice is known to be this start's. */
async function begin(client: HostClient, start: Record<string, unknown>, startedBy: SessionOrigin, news: StartNews = {}): Promise<{ turn: Turn; turnId: string }> {
  await client.events();
  const requestId = randomUUID();
  const offNews = client.onFrame(f => {
    if (f["requestId"] !== requestId) return;
    if (f.type === "session.queued") news.queued?.();
    if (f.type === "session.steer") news.steered?.(f as unknown as SessionSteerEvent);
  });
  let answer: Record<string, unknown>;
  try {
    answer = await client.request("sessions.start", { ...start, startedBy, requestId });
  } finally {
    offNews();
  }
  const reply = SessionStartResult.safeParse(answer);
  if (!reply.success) throw new Error(OTHER_VERSION);
  const { session, outcome, turnId } = reply.data;
  const threadId = session.threadId;
  if (threadId === undefined) throw new Error("the runtime stamped no thread on the session");
  return { turn: { session, threadId, outcome }, turnId };
}

/** A start whose caller does not stay for the reply: the turn runs on, and a wait on the thread or its notify
 * carries the end. Answers once the turn is started, so a start queued behind the thread's running turn answers
 * when that turn has ended and this one began. */
export async function startDetached(client: HostClient, start: Record<string, unknown>, startedBy: SessionOrigin, onQueued?: () => void): Promise<Turn> {
  return (await begin(client, start, startedBy, onQueued === undefined ? {} : { queued: onQueued })).turn;
}

/** Starts a turn as `startedBy` and follows it to its reply: `on.queued` when the runtime says the start waits behind
 * the thread's running turn, `on.started` the thread as soon as the runtime names it, `on.event` every event of the
 * turn with the turn so far. Fails when the host goes away first. Events are picked by the turn's id: a start that
 * waited behind the thread's running turn must not read that turn's end as its own. The follow ends at
 * session.done, which carries the whole reply: session.end follows the runtime's exit read and reap, minutes later
 * when the machine is slow to answer. A turn the runtime ended itself has no done, so its end is the last event
 * instead. */
export async function follow(
  client: HostClient,
  start: Record<string, unknown>,
  startedBy: SessionOrigin,
  on: { queued?(): void; steered?(event: SessionSteerEvent): void; started?(turn: Turn): void; event(e: SessionEvent, turn: Turn): void },
): Promise<Turn> {
  const pushed = pushedFrames(client);
  try {
    const { turn, turnId } = await begin(client, start, startedBy, { ...(on.queued !== undefined ? { queued: on.queued } : {}), ...(on.steered !== undefined ? { steered: on.steered } : {}) });
    on.started?.(turn);
    const ended = new Promise<Turn>(done => {
      pushed.follow(
        f => sessionEvent(f) && f.turnId === turnId,
        f => {
          const e = f as unknown as SessionEvent;
          if (e.type === "session.start" && e.afterCut === true) turn.afterCut = true;
          if (e.type === "session.done") turn.result = e.result;
          if (e.type === "session.end" && e.reason !== undefined) turn.reason = e.reason;
          on.event(e, turn);
          if (e.type !== "session.done" && e.type !== "session.end") return;
          pushed.stop();
          done(turn);
        },
      );
    });
    return await untilSettled(client, ended);
  } finally {
    pushed.stop();
  }
}

/** A thread's turn as it ended, for whoever waited on it: the thread and the runtime's result for the turn. */
export interface Ended {
  threadId: string;
  result: TurnResult;
}

/** What a wait came to: the thread that left running, or the deadline that passed first. */
export type Waited = { ended: Ended } | { timedOutMs: number };

/** The thread's latest turn as its transcript ended it, by the protocol's one reading of a transcript; a thread the
 * transcript holds no turn of answers with `ended`, what the end that woke this wait carried. A turn the runtime
 * gave up before it opened is the case with no rows behind it: it never wrote any, since it never ran, and the
 * reason it did not is on that end and nowhere else. */
async function endedOf(client: HostClient, workspaceId: string, threadId: string, ended: TurnResult): Promise<Ended> {
  return { threadId, result: threadResult(await history(client, workspaceId), threadId) ?? ended };
}

/** The workspace's transcript as the host holds it, the rows every read and every wait folds. */
async function history(client: HostClient, workspaceId: string): Promise<SessionEvent[]> {
  return (await client.request<{ events: SessionEvent[] }>("sessions.history", { workspaceId })).events;
}

/** A thread's messages as the app lists them, or its final reply alone: the transcript is the host's, so nothing is
 * woken for a read and a napping machine reads the same as a running one. */
async function readThread(client: HostClient, thread: ThreadView, last: boolean): Promise<{ threadId: string; messages: ThreadMessage[] }> {
  const threadId = threadIdOf(thread);
  const events = await history(client, thread.workspaceId);
  return { threadId, messages: last ? threadReplyRows(events, threadId) : threadMessages(events, threadId) };
}

/** What a read prints when the transcript holds nothing to print: which of the two silences it is. */
const readLine = (read: { threadId: string; messages: readonly ThreadMessage[] }, last: boolean): string =>
  read.messages.length === 0 ? (last ? noReplyLine(read.threadId) : noMessagesLine(read.threadId)) : threadReadText(read.messages);

/** The runtime's thread id of a row, the one its events carry; a row from before threads had ids is its own. */
const threadIdOf = (t: ThreadView): string => t.threadId ?? t.id;

/** Blocks until one of the named threads leaves running and answers with that thread's end: at once for one already
 * over, else on the first done or end the host pushes for any of them; the deadline when `timeoutMs` passes first.
 * The rows are listed after the subscription, so an end between the two is a held frame and not a gap. A named
 * thread the listing no longer holds is over too: its only turn was given up before it opened, between the naming
 * and this call, and its end went out before the subscription, so it is answered failed off what the transcript
 * holds of it, which is nothing but the status. A done carries its result; an end without one in hand is read off
 * the transcript, since the reply may have landed before this call. Fails when the host goes away first. */
export async function firstEnded(client: HostClient, named: readonly ThreadView[], timeoutMs?: number): Promise<Waited> {
  const pushed = pushedFrames(client);
  let timer: NodeJS.Timeout | undefined;
  try {
    await client.events();
    const rows = await threads(client);
    const gone = named.find(t => rows.every(r => threadIdOf(r) !== threadIdOf(t)));
    if (gone !== undefined) return { ended: await endedOf(client, gone.workspaceId, threadIdOf(gone), { status: "failed" }) };
    const over = named.map(t => rows.find(r => r.id === t.id)).find((r): r is ThreadView & { status: TurnStatus } => r !== undefined && r.status !== "running");
    if (over !== undefined) return { ended: await endedOf(client, over.workspaceId, threadIdOf(over), { status: over.status }) };
    const ids = new Set(named.map(threadIdOf));
    const ended = new Promise<Waited>(done => {
      pushed.follow(
        f => sessionEvent(f) && (f.type === "session.done" || f.type === "session.end") && f.threadId !== undefined && ids.has(f.threadId),
        f => {
          const e = f as unknown as SessionEvent & { threadId: string };
          pushed.stop();
          if (e.type === "session.done") done({ ended: { threadId: e.threadId, result: e.result } });
          else done(endedOf(client, e.workspaceId, e.threadId, { status: "failed", ...(e.type === "session.end" && e.reason !== undefined ? { error: e.reason } : {}) }).then(ended => ({ ended })));
        },
      );
    });
    const deadline = new Promise<Waited>(settle => {
      if (timeoutMs !== undefined) timer = setTimeout(() => settle({ timedOutMs: timeoutMs }), timeoutMs);
    });
    return await untilSettled(client, Promise.race([ended, deadline]));
  } finally {
    clearTimeout(timer);
    pushed.stop();
  }
}

/** Why the turn did not complete, in one line; nothing when it did. */
export function turnFailure(turn: Turn): string | undefined {
  if (turn.result?.status === "completed") return undefined;
  return turn.result?.error ?? turn.reason ?? `turn ${turn.result?.status ?? "ended without a result"}`;
}

/** The refusal each cause an agent named is thrown as, so the exit code and the tool error say which class the
 * failure was: a turn refused for want of a sign-in is the auth class, which already means no key and no sign-in.
 * A cause with no row here takes the provider class every other turn failure takes. Adding a cause is a row. */
const REFUSAL_THROWS: Readonly<Record<TurnRefusal, (message: string) => Error>> = { "sign-in": authRefusal };

/** The turn's failure as the error every door throws for it, classed by what the agent refused it for; nothing when
 * it completed. The class is read off the cause the adapter stamped, never out of the agent's own words. */
export function turnRefusal(turn: Turn): Error | undefined {
  const failure = turnFailure(turn);
  if (failure === undefined) return undefined;
  const cause = turn.result?.refusal;
  const thrown = cause === undefined ? undefined : REFUSAL_THROWS[cause];
  return thrown === undefined ? new Error(failure) : thrown(failure);
}

/** What a send that met a running turn on its thread says on stderr: WAITING when the runtime announces the wait,
 * the rest once it answered. A steered message cannot change the running turn's picks, so the line names the flags
 * it dropped. */
const WAITING = "waiting behind the running turn";
const JOINED: Record<Exclude<SessionStartOutcome, "started">, (picks: Picks) => string> = {
  steered: picks => {
    const dropped = PICK_FLAGS.filter(name => picks[name] !== undefined).map(name => `--${name}`);
    return `joined the running turn${dropped.length === 0 ? "" : `; ${dropped.join(", ")} dropped, it keeps its own model, effort and access`}`;
  },
  queued: () => "queued behind the running turn; it has ended and this turn started",
};

/** What a message that joined a turn stopped on a prompt says under the join: the turn takes it up when the person
 * answers, and nothing before then, which is why the terminal goes quiet. The word is the thread table's own, so
 * the line sends the reader to the row that says the same thing. */
const WAITING_ON_A_PERSON = `the turn is waiting on a permission; wsp threads shows it as ${threadStateWord("waiting")}`;

/** A turn's stderr as a person watching it reads it: the reply's prose as it arrives, and a quiet line of its own
 * for each tool call, for what the call answered and for the turn's own end, so a turn that runs commands for
 * minutes shows work rather than silence. A line that lands mid-sentence breaks the sentence first; nothing is
 * redrawn, since the stream may be a file. The reply is one turn's text written once: `reply` hands the stdout
 * print the finished text only where the stream has not already put it in front of the same person, and closes
 * whatever the stream stopped mid-line on first, so the print under it never lands on the work's last line. */
function turnStream(ctx: VerbContext): { text(t: string, messageId?: string): void; line(l: string): void; says(l: string): void; reply(text: string | undefined): string | undefined } {
  let atLineStart = true;
  let streamedProse = false;
  /** The harness message the prose on the screen is a piece of, and whether prose is what was written last: another
   * message opens its own paragraph, the rule SessionDeltaEvent's messageId carries, and it is a paragraph only
   * where prose would run into prose. A line of the work between them has already parted them. */
  let said: string | undefined;
  let lastWasProse = false;
  const says = (l: string): void => {
    ctx.out.stream(`${atLineStart ? "" : "\n"}${l}\n`);
    atLineStart = true;
    lastWasProse = false;
  };
  return {
    text: (t, messageId) => {
      if (t === "") return;
      if (lastWasProse && said !== undefined && messageId !== undefined && messageId !== said) {
        ctx.out.stream(atLineStart ? "\n" : "\n\n");
        atLineStart = true;
      }
      said = messageId ?? said;
      streamedProse = true;
      lastWasProse = true;
      ctx.out.stream(t);
      atLineStart = t.endsWith("\n");
    },
    line: l => says(ctx.io.muted?.(l) ?? l),
    says,
    reply: text => {
      if (!atLineStart) ctx.out.stream("\n");
      atLineStart = true;
      return streamedProse && ctx.io.sameScreen === true ? undefined : text;
    },
  };
}

/** How a prompt a turn stopped on is answered from a terminal: the key a person types while the turn is watched, and
 * which of the prompt's own options that picks, by what picking it does to the call and never by the option's id,
 * which is the harness's. `does` is what the line under the prompt says typing the key does; a road without it takes
 * the option's own label, since which mode a harness offered is the harness's to say and its words ride the option.
 * `answer` is the road another terminal takes: the verb, its help row and the line printed after that pick; absent
 * where no verb carries the road. One row per answer, so an answer added later is a row here and reaches the keys,
 * the verbs and every line at once. */
interface AnswerRoad {
  key: string;
  effect: PermissionEffect;
  does?: string;
  answer?: { verb: string; about: string; said: string };
}

const ANSWER_ROADS: readonly AnswerRoad[] = [
  { key: "y", effect: "allow", does: "run it", answer: { verb: "allow", about: "answers the prompt the thread is stopped on and lets the call run", said: "allowed" } },
  { key: "n", effect: "deny", does: "refuse it", answer: { verb: "deny", about: "answers the prompt the thread is stopped on and refuses the call", said: "denied" } },
  { key: "a", effect: "mode" },
];

/** The roads this prompt's own options carry, each beside the option it picks. A call that asks the person something
 * rather than for consent carries its own answers and no road here, which is what leaves a terminal nothing to type. */
function answerRoads(options: readonly PermissionOption[]): { road: AnswerRoad; option: PermissionOption }[] {
  return ANSWER_ROADS.flatMap(road => {
    const option = options.find(o => o.effect === road.effect);
    return option === undefined ? [] : [{ road, option }];
  });
}

/** What the person at the keyboard types to answer the prompt above, printed under it: each key with what it does,
 * in the road's words or, where the road has none, in the words the option itself arrived with. */
export function answerKeysLine(options: readonly PermissionOption[]): string {
  const typed = answerRoads(options).map(({ road, option }) => `${road.key} to ${road.does ?? lowerFirst(option.label)}`);
  return `answer here: type ${typed.join(", ")}`;
}

/** A sentence's first letter in the case a sentence takes, for a label written to stand on a button. */
const lowerFirst = (words: string): string => `${words.slice(0, 1).toLowerCase()}${words.slice(1)}`;

/** The same answer for a caller with nobody at the keyboard: the lines another terminal runs, by the thread's id. */
export function answerVerbsLine(threadId: string): string {
  const verbs = ANSWER_ROADS.flatMap(road => (road.answer === undefined ? [] : [`wsp thread ${road.answer.verb} ${threadWord(threadId)}`]));
  return `answer from another terminal: ${verbs.join(", or ")}`;
}

/** What a prompt carrying none of the answers above is answered on: its options are the question's own, which no key
 * and no verb here stands for. */
export const ANSWER_IN_THE_APP = "answer it in the app: this prompt carries its own answers";

/** What a prompt answered from a terminal says once the pick landed: which answer it was and which call it closed,
 * so the line says what was allowed rather than only that something was. */
export function answeredLine(threadId: string, ask: { toolName: string; input: string; detail?: string }, said: string): string {
  return `${said} on thread ${threadWord(threadId)}: ${askingLine(ask)}`;
}

/** The one sentence a line that answers a prompt is refused with when the thread is stopped on none. */
export function noOpenAskLine(threadId: string): string {
  return `thread ${threadWord(threadId)} is waiting on no prompt; wsp threads says which threads need you`;
}

/** The one sentence it is refused with when the thread's prompt carries no option this answer stands for. */
export function noSuchAnswerLine(threadId: string, verb: string): string {
  return `the prompt thread ${threadWord(threadId)} is stopped on takes no ${verb}; wsp thread read shows what it asks`;
}

/** What a pick the host would not take came to, one line per outcome it can answer with; `answered` is the only one
 * that is not a failure and has no line here. */
const ANSWER_WORDS: Readonly<Record<Exclude<SessionAnswerOutcome, "answered">, string>> = {
  gone: "the prompt closed before the answer reached it",
  unsupported: "this thread's agent raises no prompt this host can answer",
  "not-found": "this host holds no turn of that thread",
  "no-option": "the prompt carries no option by that id",
};

/** Picks one option on a prompt the runtime holds open, the op the app's own buttons send; anything but a pick the
 * harness took is the caller's failure, in the words of the outcome. */
async function answerAsk(client: HostClient, sessionId: string, askId: string, optionId: string): Promise<void> {
  const { outcome } = SessionAnswerResult.parse(await client.request("sessions.answer", { sessionId, askId, optionId }));
  if (outcome !== "answered") throw new Error(ANSWER_WORDS[outcome]);
}

/** What a thread's open prompt answered by one of the roads above came to, for a terminal that is not watching the
 * turn: the prompt is read off the transcript the host holds, so a thread anybody opened is answerable from here. */
async function answerOpenAsk(client: HostClient, ref: string, road: AnswerRoad & { answer: NonNullable<AnswerRoad["answer"]> }): Promise<{ threadId: string; askId: string; optionId: string; line: string }> {
  const thread = await threadOf(client, ref);
  const threadId = threadIdOf(thread);
  const ask = openAsk(await history(client, thread.workspaceId), threadId);
  if (ask === undefined) throw new Error(noOpenAskLine(threadId));
  const option = ask.options.find((o: PermissionOption) => o.effect === road.effect);
  if (option === undefined) throw new Error(noSuchAnswerLine(threadId, road.answer.verb));
  await answerAsk(client, ask.sessionId, ask.askId, option.id);
  return { threadId, askId: ask.askId, optionId: option.id, line: answeredLine(threadId, ask, road.answer.said) };
}

/** The prompt road a watched turn takes: the ask said in the terminal that is blocked, the way to answer under it,
 * and, where somebody is at the keyboard, the answer they type sent back as the option it picks. A prompt closed by
 * anyone (this terminal, another one, the app, the turn ending) releases the read, so nothing sits on stdin after
 * the question it belonged to is gone. */
function answering(ctx: VerbContext, client: HostClient, say: (line: string) => void): { opened(ask: SessionPermissionEvent, threadId: string): void; closed(askId: string): void; stop(): void } {
  let open: { askId: string; release: () => void } | undefined;
  const release = (): void => {
    open?.release();
    open = undefined;
  };
  return {
    opened: (ask, threadId) => {
      const roads = answerRoads(ask.options);
      // Nobody is offered keys where no line printed which keys answer: --json writes the events and no stream, so
      // its caller answers by the verb, as a caller with no terminal does.
      const keyed = ctx.flags["json"] === true ? undefined : ctx.io.answerKey;
      say(needsYouLine(ask));
      // The way to answer, in the words of whoever is reading: the keys where somebody is at the keyboard, the
      // verbs where nobody is, and neither on a prompt whose options are the question's own.
      say(roads.length === 0 ? ANSWER_IN_THE_APP : keyed === undefined ? answerVerbsLine(threadId) : answerKeysLine(ask.options));
      if (keyed === undefined || roads.length === 0) return;
      release();
      let settle = (): void => {};
      const until = new Promise<void>(done => (settle = done));
      open = { askId: ask.askId, release: settle };
      void keyed(roads.map(({ road }) => road.key), until)
        .then(async typed => {
          const picked = roads.find(({ road }) => road.key === typed);
          if (picked !== undefined) await answerAsk(client, ask.sessionId, ask.askId, picked.option.id);
        })
        .catch((e: unknown) => ctx.io.error(e instanceof Error ? e.message : String(e)));
    },
    closed: askId => {
      if (open?.askId === askId) release();
    },
    stop: release,
  };
}

/** What the verbs take in place of the whole id, said beside the id the moment a person first meets one: the ids
 * are 36 characters and nobody retypes one, so the line that hands one over says the shorthand that already works
 * rather than leaving it to be found. It names the verb that reads a thread back as well, since a person holding a
 * thread id wants what the agent said and nothing else on the page they read said which word does that. */
export const THREAD_PREFIX_WORD = "wsp thread read, wsp send and wsp stop take its first characters";

/** The first line a thread's opening prints: its id, and where it went when no workspace was named. */
const openedThreadLine = (threadId: string, opened: ((threadId: string) => string) | undefined): string => (opened === undefined ? `thread ${threadId}` : opened(threadId));

/** The same line at a terminal, where a person has to retype the id to say anything else to the thread. The tool
 * door prints it without the clause: an agent holding the id passes it whole. */
const openedThreadSaid = (threadId: string, opened: ((threadId: string) => string) | undefined): string => `${openedThreadLine(threadId, opened)} · ${THREAD_PREFIX_WORD}`;


/** What a followed turn says about itself beyond the reply: the line that names the thread it opened where the
 * workspace was inferred, and the word the turn's own figure carries where this run knows what the figure is. */
interface SaidAbout {
  opened?: ((threadId: string) => string) | undefined;
  spend?: string | undefined;
}

/** The verbs' way through a turn: text, the tool calls behind it and what each answered stream to stderr as they
 * arrive, and the reply is read once. Where the stream is the person's own screen the streamed prose is that copy
 * and stdout adds only the lines around it; where stdout parts from the stream it carries the finished text whole,
 * with --json every event of the turn up to its done instead; a turn that did not complete is the verb's failure,
 * in the harness's words. */
async function followVerb(ctx: VerbContext, client: HostClient, start: Record<string, unknown>, announce: boolean, picks: Picks = {}, said: SaidAbout = {}, onTurn?: (turn: Turn) => void): Promise<Turn> {
  const { opened, spend } = said;
  const stream = turnStream(ctx);
  const asks = answering(ctx, client, line => stream.says(line));
  /** Each call this turn has open, by the id the harness named it, so its result is read against the call's own
   * input rather than against the harness's words for it. */
  const calls = new Map<string, { name: string; input: string }>();
  // What the runtime said about the turn this message joined, kept for the line under the join: the steer is
  // recorded as the harness takes the message, which is before the start this follow is waiting on is answered.
  let joinedWaiting = false;
  let turn: Turn;
  try {
    turn = await follow(client, start, "cli", {
      queued: () => ctx.io.error(WAITING),
      steered: event => {
        joinedWaiting = event.waiting === true;
      },
      started: (t: Turn) => {
        // The live turn, which follow fills in as its events land: whoever waited on it reads its end off this.
        onTurn?.(t);
        if (announce) ctx.out.emit({ type: "thread", id: t.threadId, workspaceId: t.session.workspaceId, harness: t.session.harness, startedBy: t.session.startedBy }, openedThreadSaid(t.threadId, opened));
        if (t.outcome !== "started") ctx.io.error(JOINED[t.outcome](picks));
        if (joinedWaiting) ctx.io.error(WAITING_ON_A_PERSON);
      },
      event: (e, t) => {
        ctx.out.emit(e, e.type === "session.done" ? stream.reply(e.result.text) : undefined);
        if (e.type === "session.start" && e.afterCut === true) ctx.io.error(AFTER_CUT_LINE);
        // The person's turn as the transcript keeps it: one bracket per image, since a terminal draws no pixels.
        if (e.type === "session.start") for (const image of e.attachments ?? []) stream.line(imageLine(image));
        if (e.type === "session.delta" && e.kind === "text") stream.text(e.text, e.messageId);
        // The harness's own note reads as the aside it is: the muted ink every line around the prose takes, and no
        // word of failure, which belongs to a call that failed and to the turn's own end.
        if (e.type === "session.delta" && e.kind === "note") stream.line(e.text);
        if (e.type === "session.delta" && e.kind === "tool_use") {
          stream.line(toolActivityLine(e.toolName, e.text));
          if (e.toolUseId !== undefined) {
            const open = calls.get(e.toolUseId);
            calls.set(e.toolUseId, { name: e.toolName ?? open?.name ?? "tool", input: (open?.input ?? "") + e.text });
          }
        }
        if (e.type === "session.delta" && e.kind === "tool_result") {
          const call = e.toolUseId === undefined ? undefined : calls.get(e.toolUseId);
          if (e.toolUseId !== undefined) calls.delete(e.toolUseId);
          const answer = toolAnsweredLine(call?.name, call?.input ?? "", { text: e.text, ...(e.isError !== undefined ? { isError: e.isError } : {}) });
          if (answer !== undefined) stream.line(answer);
        }
        if (e.type === "session.permission") asks.opened(e, t.threadId);
        if (e.type === "session.permission.closed") asks.closed(e.askId);
        if (e.type === "session.done") stream.line(turnSettledLine(e.result, spend));
        if (e.type === "session.notify" && e.notify === NOTIFY_ME) ctx.io.error(e.text);
      },
    });
  } finally {
    asks.stop();
  }
  const failure = turnRefusal(turn);
  if (failure !== undefined) throw failure;
  return turn;
}

/** The verbs' way through a detached start: the queued and joined lines on stderr as a follow prints them, then the
 * thread's id on stdout the moment the runtime names it, and nothing of the reply, which the thread's finished line
 * carries to whoever its start named. */
async function detachVerb(ctx: VerbContext, client: HostClient, start: Record<string, unknown>, picks: Picks = {}, opened?: (threadId: string) => string): Promise<void> {
  const turn = await startDetached(client, start, "cli", () => ctx.io.error(WAITING));
  if (turn.outcome !== "started") ctx.io.error(JOINED[turn.outcome](picks));
  ctx.out.emit(turnView(turn), openedThreadSaid(turn.threadId, opened));
}

export type ExecExit = Extract<ExecEvent, { type: "exec.exit" }>;

/** `ranIn` is the folder the host answered with, which every caller prints rather than the one it asked for; absent
 * only where the workspace's kind names no folder, which leaves the machine's own home. */
export interface ExecRun {
  exit: ExecExit;
  ranIn?: string;
}

/** Runs argv on the workspace's machine, in cwd when given, and follows it to its exit; `on` sees each output line
 * and the exit. Fails when the host goes away first. */
export async function execOn(client: HostClient, workspaceId: string, argv: readonly string[], cwd: string | undefined, on: (e: ExecEvent) => void): Promise<ExecRun> {
  const pushed = pushedFrames(client);
  const { execId, cwd: ranIn } = await client.request<{ execId: string; cwd?: string }>("workspaces.exec", { workspaceId, argv, ...(cwd !== undefined ? { cwd } : {}) });
  const exited = new Promise<ExecExit>(done => {
    pushed.follow(
      f => (f.type === "exec.output" || f.type === "exec.exit") && f["execId"] === execId,
      f => {
        const e = f as unknown as ExecEvent;
        on(e);
        if (e.type === "exec.exit") done(e);
      },
    );
  });
  try {
    return { exit: await untilSettled(client, exited), ...(ranIn !== undefined ? { ranIn } : {}) };
  } finally {
    pushed.stop();
  }
}

/** What an export asks for: the folder on the machine, where it lands here, whether to replace what is there, and
 * which agents' sessions come home (every one with sessions for the folder when absent). */
export interface ExportRequest {
  source: string;
  dest: string;
  replace?: boolean;
  agents?: readonly string[];
}

/** Brings a project folder and the agent sessions keyed to it home from the workspace's machine: `on` sees each
 * stage of the export as the runtime says it, and the result is what landed. Fails when the host goes away first. */
export async function exportProject(client: HostClient, workspaceId: string, req: ExportRequest, on: (e: ProjectExportEvent) => void): Promise<ProjectExportResult> {
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "project.export" && f["workspaceId"] === workspaceId && f["dest"] === req.dest,
    f => on(f as unknown as ProjectExportEvent),
  );
  try {
    const { exported } = await untilSettled(
      client,
      client.request<{ exported: ProjectExportResult }>("project.export", {
        workspaceId,
        source: req.source,
        dest: req.dest,
        ...(req.replace !== undefined ? { replace: req.replace } : {}),
        ...(req.agents !== undefined ? { agents: req.agents } : {}),
      }),
    );
    return exported;
  } finally {
    pushed.stop();
  }
}

/** The plan for a folder on this computer, as the app's dialog reads it: nothing is packed or uploaded. */
export async function planProject(client: HostClient, source: string): Promise<ProjectPlan> {
  return (await client.request<{ plan: ProjectPlan }>("project.plan", { source })).plan;
}

/** Lands a folder on this computer at dest on the workspace's machine, the way the app's dialog does: `on` sees each
 * stage of the import as the runtime says it, and the result is what landed. Fails when the host goes away first. */
export async function importProject(client: HostClient, workspaceId: string, req: ProjectImportRequest, on: (e: ProjectImportEvent) => void): Promise<ProjectImportResult> {
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "project.import" && f["workspaceId"] === workspaceId && f["source"] === req.source && f["dest"] === req.dest,
    f => on(f as unknown as ProjectImportEvent),
  );
  try {
    const { imported } = await untilSettled(client, client.request<{ imported: ProjectImportResult }>("project.import", { workspaceId, ...req }));
    return imported;
  } finally {
    pushed.stop();
  }
}

/** The rows a person changed from the plan's defaults: keep ticks a secret-shaped row, cut unticks it; a path the
 * plan does not list as secret-shaped is refused, since nothing would change for it. */
export function secretsChosen(plan: ProjectPlan, keep: readonly string[], cut: readonly string[]): ReadonlySet<string> {
  const listed = new Set(plan.secrets.map(s => s.path));
  for (const path of [...keep, ...cut]) {
    if (!listed.has(path)) throw usageRefusal(`${path} is not a secret-shaped file in the plan${listed.size === 0 ? ", which lists none" : `; the plan lists ${[...listed].join(", ")}`}.`, "Name one the plan lists, or drop the flag.");
  }
  const ticked = new Set(defaultConsent(plan.secrets));
  for (const path of keep) ticked.add(path);
  for (const path of cut) ticked.delete(path);
  return ticked;
}

/** The agents whose sessions travel: the ones named, each with sessions in the plan, else the plan's default. */
export function agentsChosen(plan: ProjectPlan, named: readonly string[] | undefined): ReadonlySet<string> {
  if (named === undefined) return defaultAgents(plan.agents);
  const travelling = plan.agents.filter(canTravel);
  for (const id of named) {
    if (!travelling.some(a => a.agent === id)) throw usageRefusal(`${id} has no sessions for this folder${travelling.length === 0 ? "" : `; the plan lists ${travelling.map(a => a.agent).join(", ")}`}.`, "Name one the plan lists, or drop the flag and let every agent with sessions come.");
  }
  return new Set(named);
}

/** The plan as the dialog shows it, one fact per line: the repository, the files and their size, the caches left
 * behind, the paths not carried, where it lands, then each secret-shaped row with its signals, size and what its tick
 * means, and each agent with its sessions and whether they travel. */
export function planLines(plan: ProjectPlan, ticked: ReadonlySet<string>, agents: ReadonlySet<string>, workspace?: Pick<WorkspaceView, "kind" | "home">): string[] {
  const rows: string[][] = [
    ["Repository", plan.repo ? "git, .git travels whole" : "none"],
    ["Files", `${plural(plan.files, "file")}, ${fmtBytes(plan.bytes)}`],
    ["Caches left behind", plan.excluded.length === 0 ? "none" : plan.excluded.join(", ")],
    ["Not carried", plan.skipped.length === 0 ? "none" : plural(plan.skipped.length, "path")],
    ...plan.skipped.map(s => [`  ${s.path}`, s.note]),
    ["Lands at", plan.source],
    ["Secret-shaped", plan.secrets.length === 0 ? "none" : plural(plan.secrets.length, "file")],
    ...plan.secrets.map(s => [`  ${s.path}`, secretSignalsLine(s), secretOffer(s, ticked.has(s.path)).full]),
    ["Agents", plan.agents.length === 0 ? "none with sessions for the folder" : `${plural(plan.agents.length, "agent")} with sessions for the folder`],
    ...plan.agents.map(a => [`  ${a.name}`, a.error ?? plural(a.sessions, "session"), agents.has(a.agent) ? "sessions travel" : "stays"]),
  ];
  return table(rows);
}

/** The line under a plan nobody has consented to yet, off a terminal: nothing moved, and the two ways to say yes. */
export const PLAN_ONLY = "nothing imported; run again with --yes to take these defaults, or --keep <path> and --cut <path> per secret-shaped row";

/** The one question a person at the terminal is asked under the plan; no is the default and moves nothing. */
export const IMPORT_NOW = "Import now? y/N";

/** A destination the runtime refused as already there, with the flag that overwrites it named; any other failure as it came. */
function withReplaceHint(e: unknown): unknown {
  if ((e as { kind?: unknown }).kind !== "exists") return e;
  return Object.assign(new Error(`${e instanceof Error ? e.message : String(e)}\nRun again with --replace to overwrite it.`), { kind: "exists" });
}

/** The agents a --agents flag names, comma-separated, each one the catalog knows; nothing when the flag is absent. */
export function agentsFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(",").map(s => s.trim()).filter(s => s !== "");
  if (ids.length === 0) throw usageRefusal("--agents was given no agent.", "Write it as --agents claude,codex, or drop the flag.");
  const known = CATALOG_AGENTS.map(a => a.id);
  const unknown = ids.find(id => !known.includes(id));
  if (unknown !== undefined) throw usageRefusal(unknownAgentLine(unknown, known), "Name one of those, or drop the flag.");
  return ids;
}

/** The one question a drop asks unless --yes, and the one line it prints when the answer is anything but yes. Off a
 * terminal nobody can answer, so the line without --yes is refused as written. */
async function confirmed(ctx: VerbContext, question: string, name: string): Promise<boolean> {
  if (ctx.flags["yes"] === true) return true;
  if (ctx.io.isTTY !== true) throw usageRefusal(`${question.split("\n")[0]} There is no terminal to answer on.`, "Pass --yes to say yes.");
  if ((await ctx.io.ask(question)) === "yes") return true;
  ctx.io.error(`${name} kept`);
  return false;
}

/** Nothing printed on the tool door: a tool answers with values, and the stages a create streams have no reader there. */
const QUIET: Out = { emit: () => {}, stream: () => {} };
/** The waking line has no reader on the tool door either: the result says which machine ran. */
const QUIET_LINE = (): void => {};
const QUIET_TURN = { event: () => {} };

const Created = z.object({ workspace: WorkspaceOut, notice: z.string().optional() });

/** What a send meets on its thread, in the runtime's own words: the outcome it answers with on a free or a running
 * turn, and the line it says when the last turn replied but its agent process has not exited. */
const { started, steered, queued } = SessionStartOutcome.enum;
const SEND_MEETS = `On a thread whose turn is not running the message starts a new turn (outcome \`${started}\`); when the turn is still running the message joins it (outcome \`${steered}\`) or waits for it and then runs (outcome \`${queued}\`), and the reply is that turn's. When the thread's turn has replied but its agent process is still running, the message waits for that process and runs as the thread's next turn (outcome \`${queued}\`), which the runtime says as \`${stillWorkingLine()}\`. A send is never refused for meeting a turn, and two sends keep the order they arrived in.`;

/** outcome says how the message landed: its own turn, steered into the thread's running one, or queued behind it;
 * afterCut is set when the thread's previous turn ended without a result, so the reply may be missing context. */
const TurnOut = z.object({
  threadId: z.string(),
  workspaceId: z.string(),
  harness: z.string(),
  text: z.string().optional().describe("the reply, complete; absent under detach, where the turn is still running and its end reaches whoever the start's notify named"),
  outcome: SessionStartOutcome,
  afterCut: z.literal(true).optional(),
});
/** What a wait answers with for the thread that left running: the turn's outcome and the facts the harness reported,
 * the reply cut to the notify line's tail. */
const ThreadEndOut = z.object({
  threadId: z.string(),
  status: TurnStatus,
  durationMs: z.number().optional(),
  costUsd: z.number().optional(),
  reply: z.string().optional().describe("the last non-empty line of the reply, or the error when there is no reply"),
});
const WaitOut = z.object({
  finished: ThreadEndOut.optional().describe("the thread that left running; absent when the timeout passed first"),
  timedOut: z.literal(true).optional().describe("set when the timeout passed with every named thread still running"),
});
const ThreadRowOut = ThreadView.extend({ projectName: z.string(), workspaceName: z.string(), computerName: z.string() });
const Argv = z.array(z.string()).min(1);

type Structured = Record<string, unknown>;

/** A result the agent reads as text and a client with a schema reads as the same value. */
const asJson = (structured: Structured): CallToolResult => ({ content: [{ type: "text", text: jsonLine(structured, 2) }], structuredContent: structured });
const asText = (text: string, structured: Structured): CallToolResult => ({ content: [{ type: "text", text }], structuredContent: structured });

const turnView = (turn: Turn): z.infer<typeof TurnOut> => ({
  threadId: turn.threadId,
  workspaceId: turn.session.workspaceId,
  harness: turn.session.harness,
  ...(turn.result !== undefined ? { text: turn.result.text ?? "" } : {}),
  outcome: turn.outcome,
  ...(turn.afterCut === true ? { afterCut: true as const } : {}),
});

/** The reply as the tool's text, with the cut line first when the thread's previous turn did not finish. */
const turnText = (out: z.infer<typeof TurnOut>): string => (out.afterCut === true ? `${AFTER_CUT_LINE}\n${out.text ?? ""}` : out.text ?? "");

/** A detached start's answer on the tool door: the thread's id, as the command line's first line prints it. */
const detachedOut = (turn: Turn, opened?: (threadId: string) => string): CallToolResult => asText(openedThreadLine(turn.threadId, opened), turnView(turn));

const endView = (ended: Ended): z.infer<typeof ThreadEndOut> => {
  const reply = notifyTail(ended.result);
  return {
    threadId: ended.threadId,
    status: ended.result.status,
    ...(ended.result.durationMs !== undefined ? { durationMs: ended.result.durationMs } : {}),
    ...(ended.result.costUsd !== undefined ? { costUsd: ended.result.costUsd } : {}),
    ...(reply !== undefined ? { reply } : {}),
  };
};

/** A wait's answer on both doors: the finished thread's end under the notify line, or timedOut under the line that
 * says who is still running. `length` is how much of the reply the line carries; the end's own reply field is the
 * tail whatever the line says, since that is the field a sidebar row and a notify read. */
function waitAnswer(named: readonly ThreadView[], waited: Waited, length: NotifyLength = "tail"): { value: z.infer<typeof WaitOut>; line: string } {
  if ("ended" in waited) return { value: { finished: endView(waited.ended) }, line: notifyLine(waited.ended.threadId, waited.ended.result, length) };
  return { value: { timedOut: true }, line: waitTimedOutLine(named.map(threadIdOf), waited.timedOutMs) };
}

/** The seconds a --timeout names, as milliseconds; a word that is not a number above zero is refused. */
function timeoutFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw usageRefusal(`--timeout takes seconds, a number above zero, and got ${JSON.stringify(value)}.`, "Write it as --timeout <seconds>.");
  return seconds * 1_000;
}

/** The turn's reply as the tool result; a turn that did not complete is a tool error with the harness's reason. */
function turnOut(turn: Turn): z.infer<typeof TurnOut> {
  const failure = turnRefusal(turn);
  if (failure !== undefined) throw failure;
  return turnView(turn);
}

/** The line under a plan the tool returned without importing: the call that says yes, and the two per-row answers. */
const PLAN_ONLY_TOOL = "nothing imported; call import again with yes true to take these defaults, or keep and cut per secret-shaped row";

const WorkspaceIn = z.string().describe("the workspace's name, or its id when two share a name");
const ThreadWorkspaceIn = z.string().optional().describe("the workspace's name, or its id when two share a name; absent, the thread goes to the workspace holding the project the client's own folder is a repo of, in that project, and the reply's first line says where it went");
const AgentIn = z.string().optional().describe(`the agent to run in the thread, one of ${THREAD_AGENTS.join(", ")}; absent means the host's default`);
const NotifyIn = z
  .array(z.string())
  .min(1)
  .optional()
  .describe(
    `who is told each time a turn of the new thread ends, each one a thread (by id, or a prefix of it) the line goes into as a message carrying that turn's whole reply, or me, which is the thread this call came out of when it came out of one and otherwise the person's app, where the line is its last reply line alone. Several targets each get the line once, which is how a builder's end reaches its orchestrator and a reviewer together; a target whose thread is gone by then falls back to the person, and the new thread's own id is refused. ${NOTIFY_CALLER}.`,
  );
const CwdIn = z.string().optional().describe("the folder on the machine the thread works in or the command runs in, absolute. Absent means the workspace's own project, which is where a thread there starts unless it says otherwise");
const DetachIn = z.boolean().optional().describe(`true answers with the thread id the moment the turn is started, without the reply, and the turn's end reaches whoever notify named; for a turn that runs for minutes or an hour, so this call does not block for it. ${NOTIFY_CALLER}.`);
const TitleIn = z.string().optional().describe("the thread's name, as a person's: it shows in the sidebar and in the agent's own list from the first second, and the title the host asks the agent for as the turn starts never replaces it; absent lets the thread be titled by its opening words until, seconds in, the agent names it");
const ImagesIn = z.array(z.string()).optional().describe(`paths on this computer, absolute or relative to the folder wsp runs in, of images to send with the message: ${IMAGE_TYPE_WORDS}, at most ${IMAGES_MAX} and ${IMAGE_MAX_WORDS} each. The host reads each file and sends its bytes, so the machine never reaches back for this computer\u2019s files; a message to an agent that reads no image is refused naming that agent.`);
const ConfirmIn = z.boolean().optional().describe("true deletes the machine; absent or false answers with what would go and deletes nothing, so a person can be asked first");
/** The same three words the app's composer uses; the runtime refuses a value the agent's catalog does not list, naming the list. */
const PICK_INPUTS = {
  model: z.string().optional().describe("the model the turn runs on, by the agent's own slug (claude-sonnet-5); absent on a new thread means the catalog's default, on send the thread's own"),
  effort: z.string().optional().describe("the reasoning effort, by the agent's own word (low, medium, high, xhigh, max); absent means the agent's default, high for claude"),
  access: z.string().optional().describe("the access mode, by the agent's own word (plan, acceptEdits, bypassPermissions); absent means what a thread on that workspace starts at, which on this computer and on a machine wsp forked is every action without asking, and on a computer you own is asking about each one"),
};
/** The same two on send, for the reason SEND_FLAGS gives. */
const SEND_INPUTS = { model: PICK_INPUTS.model, effort: PICK_INPUTS.effort };
/** The same word on new and fork; the refusal for a size the provider does not offer names the ones it does. */
const SizeIn = z.string().optional().describe("the machine size as <cpu>x<memGb>, like 2x4; absent takes the image's size. A size the provider does not offer is refused with the list it does, so read that list rather than guessing twice; a build wants the largest memory offered");
const SpawnIn = z.enum(["on", "off"]).optional().describe("whether the agents on this workspace may drive this host: open threads and fork machines under the thread they run in, capped. Absent is off, which is what every workspace made without it reads as");
const MaxMachinesIn = z.number().int().min(0).optional().describe("how many machines may stand at once under one root thread when spawn is on; needs spawn on beside it, and defaults to 3");
const MaxDepthIn = z.number().int().min(1).optional().describe("how many levels deep the tree under a root thread may go when spawn is on; 1 is the root's own children and no further, which is the default, and it needs spawn on beside it");

const PROJECT_FOLDERS = z.array(z.string()).optional().describe("folders on this computer, absolute, to weigh the histories by: only sessions that ran in one of them or under it count");
/** The same folders on the write verb, where naming them is also naming a rule input, so it re-decides the ticks. */
const WEIGH_BY_FOLDERS = z.array(z.string()).optional().describe("folders on this computer, absolute, to weigh the histories by: only sessions that ran in one of them or under it count. Naming one re-decides every tick from the rule, as tick does, so any flip an earlier call made goes");
/** Absolute, since the tool server's own folder is wherever the agent launched it and a prefix test on a relative
 * path silently matches nothing. */
const projectFolders = (folders: readonly string[]): string[] => folders.map(f => absolutePath("project is a folder on this computer", f));

/** The scheme a --scheme flag names; a word outside the pair is refused before anything is read. */
function schemeFlag(value: string | undefined): TerminalScheme | undefined {
  if (value === undefined) return undefined;
  const parsed = TerminalScheme.safeParse(value);
  if (!parsed.success) throw usageRefusal(`--scheme takes one of ${TerminalScheme.options.join(", ")}, and got ${JSON.stringify(value)}.`, "Name one of those.");
  return parsed.data;
}

/** The --project folders a recipe line names, resolved from where the person stands; nothing when it names none. */
const projectsFlag = (flags: Flags): { projects?: string[] } => (Array.isArray(flags["project"]) ? { projects: (flags["project"] as string[]).map(p => resolve(p)) } : {});

/** The reading is progress, not the answer: it goes to stderr so what is on stdout is the whole answer. */
const progress = (io: CliIO): { log(line: string): void; note(line: string): void } => ({ log: line => io.log(line), note: line => io.error(line) });

/** The recipe verbs' answer on the command line: one JSON object under --json, else the table's lines in the
 * terminal's colours and the line that says what to do next. */
function printTable(ctx: VerbContext, value: unknown, lines: (depth: number) => string[], next: string): void {
  ctx.out.emit(value);
  if (ctx.flags["json"] === true) return;
  for (const line of lines(colourDepth(isTTY(process.stdout)))) ctx.io.log(line);
  ctx.io.log(next);
}

/** One level of one computer's folders over the protocol, or every repo under its roots: the folder picker a browser
 * tab has, and the same answer here, so a line or an agent can look before it names a folder to import. `on` is a
 * computer by the name or id the places list carries, absent for this one; a folder on this computer is read by
 * `here`, and one on another computer is taken as given, absolute, since only that computer can resolve it. */
async function hostFolders(client: HostClient, asked: { folder?: string | undefined; hidden?: boolean | undefined; repos?: boolean | undefined; on?: string | undefined }, here: (folder: string) => string): Promise<HostFolderListing> {
  const { folder, hidden, repos, on } = asked;
  const place = on === undefined ? undefined : await placeNamed(client, on);
  const elsewhere = place !== undefined && place.id !== HERE_PLACE_ID ? place : undefined;
  const dir = folder === undefined ? undefined : elsewhere === undefined ? here(folder) : absolutePath(`folder is a path on ${elsewhere.name}`, folder);
  const { listing } = await client.request<{ listing: HostFolderListing }>("host.folders", {
    ...(dir !== undefined ? { dir } : {}),
    ...(hidden === true ? { hidden } : {}),
    ...(repos === true ? { repos } : {}),
    ...(elsewhere !== undefined ? { on: elsewhere.id } : {}),
  });
  return listing;
}

/** The cloud setup as the host serves it to the app, parsed and not trusted. */
async function initSetup(client: HostClient): Promise<InitSetup> {
  const { setup } = await client.request<{ setup: unknown }>("init.get", {});
  return InitSetup.parse(setup);
}

/** The level as a table, then the level in words with the folders that are browsable at all beside them, since a path
 * outside those is refused. The app's own browser draws the roots as crumbs instead. */
function folderLines(listing: HostFolderListing): string[] {
  return [
    ...table([["FOLDER", "GIT"], ...listing.folders.map(f => [f.path, f.repo ? (f.branch ?? "git") : ""])]),
    `${folderLevelLine(listing)} Browsable: ${listing.roots.join(", ")}.`,
  ];
}

/** The lines another terminal answers a thread's open prompt with, one per road that carries a verb: the same op the
 * app's buttons send, by thread id, so a person or an agent watching a thread from anywhere can unstick it. */
const ANSWER_VERBS: readonly CliVerb[] = ANSWER_ROADS.filter((road): road is AnswerRoad & { answer: NonNullable<AnswerRoad["answer"]> } => road.answer !== undefined).map(road => ({
  name: `thread ${road.answer.verb}`,
  usage: `wsp thread ${road.answer.verb} <thread>`,
  about: road.answer.about,
  page: "agent" as const,
  options: {},
  run: async (ctx: VerbContext) => {
    const [ref] = ctx.args;
    if (ref === undefined || ctx.args.length !== 1) throw usageRefusal(`wsp thread ${road.answer.verb} takes one thread.`, usageIs(ctx));
    const answered = await answerOpenAsk(await ctx.client(), ref, road);
    ctx.out.emit({ threadId: answered.threadId, askId: answered.askId, optionId: answered.optionId }, answered.line);
    return 0;
  },
  tool: tool({
    description: `${road.answer.about[0]!.toUpperCase()}${road.answer.about.slice(1)}, by thread id or a prefix of it. A thread stopped on a prompt reads Needs you in threads and runs nothing until somebody picks, so this is how a thread you did not open is unstuck; the prompt itself is on the thread's own rows, which thread_read prints. Refused in one line when the thread is waiting on no prompt and when the prompt it is stopped on carries no such answer, which is what a call that asks the person something rather than for consent does.`,
    input: { thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them") },
    output: { threadId: z.string(), askId: z.string(), optionId: z.string() },
    call: async ({ thread: ref }, deps: VerbDeps) => {
      const answered = await answerOpenAsk(await deps.client(), ref, road);
      return asText(answered.line, { threadId: answered.threadId, askId: answered.askId, optionId: answered.optionId });
    },
  }),
}));

/** A verb's rows, drawn once or redrawn where they stand until Ctrl-C. The rows come back from one call so a frame
 * is one reading of the host and never half of two, and the socket is handed to the frame rather than asked for
 * inside it, so a watch of any length is one dial however many frames it draws. The one road --watch takes, so the
 * lines that carry it cannot refresh by two different rules. The refusal is read before the dial, so a line with
 * nowhere to redraw never starts a host to say so. */
async function drawRows(ctx: VerbContext, words: string, frame: (client: HostClient) => Promise<{ value: object; rows: string[] }>): Promise<number> {
  if (ctx.flags["watch"] !== true) {
    const { value, rows } = await frame(await ctx.client());
    ctx.out.emit(value, rows.join("\n"));
    return 0;
  }
  const on = watchOn(words, { json: ctx.flags["json"] === true, redraw: ctx.io.redraw });
  if ("refusal" in on) throw on.refusal;
  const client = await ctx.client();
  await watchBlock(async () => (await frame(client)).rows, { ...on.redraw, ...(ctx.signals !== undefined ? { signals: ctx.signals } : {}) });
  return 0;
}

/** The computer or workspace a list of what stands there names: a workspace by its name, a computer by the name
 * wsp computers shows it under, and this computer where neither is given. Refused where both are, since a workspace
 * already names the computer it is on. */
async function agentsTarget(client: HostClient, workspace: string | undefined, on: string | undefined, usage: string, project?: string): Promise<AgentsTarget> {
  if (workspace !== undefined && on !== undefined) throw usageRefusal("A workspace already names its computer; give the workspace or --on <computer>, not both.", usage);
  if (workspace !== undefined) return { workspaceId: (await workspaceOf(client, workspace)).id };
  if (on !== undefined) return { placeId: (await placeNamed(client, on)).id, ...(project !== undefined ? { project } : {}) };
  return { placeId: HERE_PLACE_ID };
}

/** A line's --project, or a tool's project, as the act reads it: absent, not a project's; bare or true, the
 * workspace's own project; a name, with --on, that computer's project of the name. */
interface ProjectAsked {
  project: boolean;
  name?: string;
}

/** Reads --project against the target the line names: a name needs --on, since a workspace names its own project,
 * and --on needs a name, since a computer holds several. */
function projectAsked(value: string | boolean | undefined, workspace: string | undefined, on: string | undefined, usage: string): ProjectAsked {
  if (value === undefined || value === false) return { project: false };
  if (value === true || value === "") {
    if (on !== undefined) throw usageRefusal("--project with --on names the project: --project <name>, as wsp projects shows it.", usage);
    return { project: true };
  }
  if (on === undefined) throw usageRefusal(`--project ${value} names a project on a computer, which --on names; a workspace's own project is --project alone.`, usage);
  return { project: true, name: value };
}

/** The project a server's tools are asked in: only by name, with --on, since a workspace finds its own project's
 * servers by itself. */
function toolsProject(value: string | undefined, workspace: string | undefined, on: string | undefined, usage: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") throw usageRefusal("--project on wsp servers tools names a project on --on <computer>; a workspace finds its own project's servers.", usage);
  return projectAsked(value, workspace, on, usage).name;
}


/** One read of what stands on a computer or workspace, which each of the three lists prints its own part of. */
async function agentsReport(client: HostClient, workspace: string | undefined, on: string | undefined, usage: string): Promise<AgentsReport> {
  const target = await agentsTarget(client, workspace, on, usage);
  return AgentsReport.parse((await client.request<{ report: unknown }>("agents.read", { target })).report);
}

/** What every one of the three lists answers beside its own rows. */
const AGENTS_FRAME = AgentsReport.omit({ agents: true, skills: true, servers: true }).shape;

/** The report's own facts, beside the rows one list prints. */
function reportFacts(r: AgentsReport): Pick<AgentsReport, "target" | "home" | "user" | "readAt" | "stale" | "refused" | "projects"> {
  return { target: r.target, home: r.home, user: r.user, readAt: r.readAt, ...(r.stale !== undefined ? { stale: r.stale } : {}), refused: r.refused, ...(r.projects !== undefined ? { projects: r.projects } : {}) };
}

/** The lines under every list: a napping workspace's report is the one it last had, and each reader that could not
 * answer is named. */
function reportTail(r: AgentsReport): string[] {
  return [...(r.stale === "napping" ? ["napping: this is what stood there when it last ran"] : []), ...r.refused.map(line => `refused: ${cell(line)}`)];
}

function agentRowLines(r: AgentsReport): string[] {
  const word = (a: AgentRow): string => (!a.installed ? "not found" : a.signIn === "unknown" ? "sign-in unknown" : agentSignInWord(a.signIn));
  return [...table([["AGENT", "VERSION", "LATEST", "SIGN-IN", "WSP TOOLS", "PATH"], ...r.agents.map(a => [a.name, a.version ?? "-", a.latest ?? "-", word(a), a.wspTools ? "yes" : "no", a.path ?? "-"])]), ...reportTail(r)];
}

/** Where a skill or a server stands, as both tables print it: its scope, or the project it is a project's of by name. */
const scopeWord = (row: { scope: string; project?: { name: string } }): string => (row.project !== undefined ? `project ${cell(row.project.name)}` : row.scope);

export function skillRowLines(r: AgentsReport): string[] {
  const where = (s: SkillRow): string => s.paths.map(p => (p.linkTo === undefined ? cell(p.path) : `${cell(p.path)} -> ${cell(p.linkTo)}`)).join(", ");
  return [...(r.skills.length === 0 ? ["no skills"] : table([["SKILL", "KIND", "WHERE"], ...r.skills.map(s => [cell(s.name), scopeWord(s), where(s)])])), ...reportTail(r)];
}

function serverRowLines(r: AgentsReport): string[] {
  const reach = (s: McpRow): string => (s.transport.kind === "stdio" ? `stdio ${s.transport.line}` : `http ${s.transport.host}`);
  const state = (s: McpRow): string => [s.enabled ? s.auth : "disabled", ...(s.inRecipe === false ? ["not in recipe"] : [])].join(", ");
  return [...(r.servers.length === 0 ? ["no MCP servers"] : table([["SERVER", "AGENT", "SCOPE", "REACHED BY", "FILE", "STATE"], ...r.servers.map(s => [s.name, agentName(s.agent), scopeWord(s), reach(s), s.file, state(s)])])), ...reportTail(r)];
}

/** One server's tools as lines: its sign-in as the connect found it, then each tool, or why none came back. */
function toolLines(name: string, a: ServerToolsAnswer): string[] {
  const head = `${name}: ${a.auth}${a.holder !== undefined ? `, ${agentName(a.holder)} holds the sign-in` : ""}`;
  if (a.refused !== undefined) return [head, `refused: ${a.refused}`];
  if (a.tools === undefined) return [head];
  return [head, ...(a.tools.length === 0 ? ["no tools"] : table([["TOOL", "DESCRIPTION"], ...a.tools.map((t: McpTool) => [t.name, (t.description ?? "-").split("\n")[0]!])]))];
}

async function serverToolsOf(client: HostClient, name: string, agent: string, workspace: string | undefined, on: string | undefined, refresh: boolean, usage: string, project?: string): Promise<ServerToolsAnswer> {
  const target = await agentsTarget(client, workspace, on, usage, project);
  return ServerToolsAnswer.parse((await client.request<{ answer: unknown }>("servers.tools", { target, agent, name, ...(refresh ? { refresh } : {}) })).answer);
}

/** A server there added, removed or turned off or on; the answer names the file written. */
async function serverChanged(client: HostClient, op: "servers.add" | "servers.remove" | "servers.toggle", body: Record<string, unknown>, workspace: string | undefined, on: string | undefined, usage: string, project?: string): Promise<{ file: string }> {
  const target = await agentsTarget(client, workspace, on, usage, project);
  return z.object({ file: z.string() }).parse(await client.request(op, { target, ...body }));
}

/** The values an add names, off this process's own environment: `NAME` reads $NAME for a variable, and `Name=VAR`
 * reads $VAR as that header's value. A variable this environment does not hold is refused rather than sent empty. */
export function serverValues(env: Readonly<Record<string, string | undefined>>, names: readonly string[], headers: readonly string[], usage: string): { env?: Record<string, string>; headers?: Record<string, string> } {
  const read = (variable: string): string => {
    const value = env[variable];
    if (value === undefined) throw usageRefusal(`${variable} is not set in this environment, so there is no value to write.`, usage);
    return value;
  };
  const vars = Object.fromEntries(names.map(name => [name, read(name)]));
  const heads = Object.fromEntries(
    headers.map(pair => {
      const at = pair.indexOf("=");
      if (at <= 0 || at === pair.length - 1) throw usageRefusal(`${pair} is not <header>=<variable>.`, usage);
      return [pair.slice(0, at), read(pair.slice(at + 1))];
    }),
  );
  return { ...(names.length > 0 ? { env: vars } : {}), ...(headers.length > 0 ? { headers: heads } : {}) };
}

/** A server's command line as its program and arguments, split as a shell splits it; nothing without one. */
function serverCommand(line: string | undefined, usage: string): { command?: string; args?: string[] } {
  if (line === undefined) return {};
  const words = commandWords(line);
  if (words === undefined) throw usageRefusal(unclosedQuoteRefusal, usage);
  const [command = "", ...args] = words;
  return { command, args };
}

/** The scope a line names, which the wire checks too, and --project, which is the project scope; nothing without
 * either. */
function serverScope(word: string | undefined, usage: string, project: ProjectAsked = { project: false }): { scope?: McpScope } {
  if (word === undefined) return project.project ? { scope: "project" } : {};
  const scope = McpScope.safeParse(word);
  if (!scope.success) throw usageRefusal(`--scope is user, home or project, not ${word}.`, usage);
  if (project.project && scope.data !== "project") throw usageRefusal(`--project is the project scope, not ${word}; give one of the two.`, usage);
  return { scope: scope.data };
}

const ServerNameIn = z.string().describe("the server's name, as servers lists it");
const ServerAgentIn = z.string().describe("the catalog id of the agent whose config names it, as servers lists it");
const ServerScopeIn = McpScope.optional().describe("the scope servers lists it under: user, home or project; user without it");
const ServerProjectIn = z
  .union([z.boolean(), z.string()])
  .optional()
  .describe("the project's server of that name: true from a workspace, or the project's name, as projects lists it, with on");
const SERVER_CHANGE_WORDS =
  "Written as the login the computer was added with, into that agent's own file, which keeps its mode; a file that is a link out of the home, or out of the project for a project's file, is not written through, and a file the agent wrote meanwhile is left as it was. A napping workspace is not woken. The report there reads again at once.";

const SERVER_TOOLS_WORDS =
  "Starts that one server once on that computer or workspace, as the login it was added with and with the command and variables its agent's config gives it, or asks its address once from there, and stops it within 20 seconds; the answer is the server's state, the one the app shows, and stands three minutes unless refreshed or a sign-in there ends; an edited entry is asked again. A server behind a sign-in its agent holds brings no list, since no login file is read: Claude Code is asked for its word on it, and for any other agent it answers unknown, naming that agent as the one holding the sign-in. A napping workspace is not woken.";

/** The wsp tools into one agent's config on this computer. */
async function addTools(client: HostClient, agent: string): Promise<{ file: string }> {
  return z.object({ file: z.string() }).parse(await client.request("agents.addTools", { target: { placeId: HERE_PLACE_ID }, agent }));
}

/** Runs a sign-in the host plans for a target on that target's own terminal, shown in this one. */
async function signInHere(ctx: VerbContext, target: AgentsTarget, ask: { agent: string; name?: string }): Promise<BoxSignedIn> {
  const client = await ctx.client();
  const { line } = await client.request<{ line: unknown }>("agents.signInLine", { target, agent: ask.agent, ...(ask.name !== undefined ? { name: ask.name } : {}) });
  const road = await targetLink(client, target);
  try {
    return await relaySignIn({
      link: road.link,
      ...(ask.name === undefined ? { agent: ask.agent } : {}),
      line: SignInLine.parse(line),
      terminal: ctx.terminal ?? { input: process.stdin, output: process.stdout },
      open: ctx.open ?? (async () => false),
    });
  } finally {
    await road.close();
  }
}

/** The line a sign-in comes to: signed in where it was named, or not, with what the tool said. */
function signedInLine(what: string, where: string, answer: BoxSignedIn): string {
  if (answer.signedIn) return `${what} is signed in on ${where}${answer.detail === undefined ? "" : ` (${answer.detail})`}.`;
  return `${what} is not signed in on ${where}${answer.said === undefined ? "" : `: ${answer.said}`}.`;
}

/** skills.sh's search, asked by the host. */
async function searchSkillsSh(client: HostClient, q: string, limit: number | undefined): Promise<SkillHit[]> {
  return z.array(SkillHit).parse((await client.request<{ skills: unknown }>("skills.search", { q, ...(limit !== undefined ? { limit } : {}) })).skills);
}

/** Text off skills.sh as a terminal may print it: no control character but newline and tab, so no escape sequence. */
const printable = (s: string): string => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** A name a line prints: on one line, so a folder name cannot draw a row of its own, and with no control character. */
const cell = (s: string): string => withoutControlChars(s.replace(/[\n\t]/g, " "));

export function skillHitLines(hits: readonly SkillHit[]): string[] {
  return hits.length === 0 ? ["no skills on skills.sh match"] : table([["SKILL", "INSTALLS", "ADD WITH"], ...hits.map(h => [cell(h.name), String(h.installs), cell(h.id)])]);
}

/** A skill named `<owner>/<repo>/<skill>` is one on skills.sh; any other name is one already on the target. */
const onSkillsSh = (skill: string): boolean => skill.split("/").length === 3;

/** A skill's SKILL.md: off skills.sh by its id, else off the target by its name. */
async function skillShown(client: HostClient, skill: string, workspace: string | undefined, on: string | undefined, project: ProjectAsked, usage: string): Promise<SkillPreview> {
  if (onSkillsSh(skill)) {
    if (workspace !== undefined || on !== undefined || project.project) throw usageRefusal(`${skill} is read off skills.sh, which names no computer or project.`, usage);
    return SkillPreview.parse((await client.request<{ preview: unknown }>("skills.get", { skill })).preview);
  }
  const target = await agentsTarget(client, workspace, on, usage, project.name);
  return SkillPreview.parse((await client.request<{ preview: unknown }>("skills.preview", { target, name: skill, ...(project.project ? { project: true } : {}) })).preview);
}

export const shownText = (p: SkillPreview): string => {
  const text = printable(p.text);
  return p.size > SKILL_PREVIEW_BYTES ? `${text}\n\n(the first ${SKILL_PREVIEW_BYTES / 1024} KB of ${Math.ceil(p.size / 1024)} KB)` : text;
};

async function skillAdded(client: HostClient, skill: string, workspace: string | undefined, on: string | undefined, agents: readonly string[] | undefined, project: ProjectAsked, usage: string): Promise<SkillAdded> {
  const target = await agentsTarget(client, workspace, on, usage, project.name);
  return SkillAdded.parse((await client.request<{ added: unknown }>("skills.add", { target, skill, ...(agents !== undefined && agents.length > 0 ? { agents } : {}), ...(project.project ? { project: true } : {}) })).added);
}

export function addedLine(skill: string, a: SkillAdded): string {
  const name = cell(skill.split("/").at(-1) ?? skill);
  return a.agents.length === 0 ? `${name} is in ${cell(a.path)}.` : `${name} is in ${cell(a.path)}, and in ${a.agents.map(x => `${agentName(x.agent)}'s ${cell(x.path)}`).join(", ")}.`;
}

export const removedLine = (name: string, removed: readonly string[]): string => `${cell(name)} is gone from ${removed.map(cell).join(", ")}.`;

/** A skill there turned off, on, or removed, by its name. */
async function skillChanged(client: HostClient, op: "skills.remove" | "skills.toggle", name: string, workspace: string | undefined, on: string | undefined, project: ProjectAsked, turn: boolean | undefined, usage: string): Promise<string[]> {
  const target = await agentsTarget(client, workspace, on, usage, project.name);
  const said = await client.request<{ removed?: unknown; paths?: unknown }>(op, { target, name, ...(project.project ? { project: true } : {}), ...(turn !== undefined ? { on: turn } : {}) });
  return z.array(z.string()).parse(op === "skills.remove" ? said.removed : said.paths);
}

const SkillNameIn = z.string().describe("the skill's name, as skills lists it");
const SkillProjectIn = z
  .union([z.boolean(), z.string()])
  .optional()
  .describe("the project's skill of that name rather than the one that is not a project's: true from a workspace, or the project's name, as projects lists it, with on");
const SKILL_CHANGE_WORDS =
  "The skill wsp writes and a plugin's are always on and are refused; a napping workspace is not woken. The report there reads again at once.";

const AgentsWorkspaceIn = z.string().optional().describe("the workspace to read, by its name, or its id when two share a name; absent reads a computer");
const AgentsOnIn = z.string().optional().describe("the computer to read, by the name computers lists; absent with no workspace is the computer the app runs on");
const AGENTS_ON_WORDS = "the computer to read, by the name wsp computers shows; this computer without it, and a workspace names its own";
const AGENTS_READ_WORDS = "Read as the login the computer was added with, off each agent's config and whether its files are there: no MCP server is started and no login file is opened. A napping workspace answers what stood there when it last ran, marked stale, and is not woken.";

export const VERBS: readonly Verb[] = [
  {
    name: "computers",
    usage: "wsp computers",
    about: "your computers: this Mac, each box you added and each cloud account, with what each has, whether it is connected and how many workspaces it holds",
    page: "front",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp computers takes no positional arguments.", usageIs(ctx));
      const places = (await (await ctx.client()).request<{ places: PlaceView[] }>("places.list")).places;
      ctx.out.emit({ computers: places }, computerLines(places, hostPlatform()).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Every computer this host holds, which is the whole of where work can run: the computer the app runs on, each box joined to it and each cloud account. A row carries what that computer last reported (cores, memory, free disk, the engine it has for a project's own containers) and whether it is connected right now; a cloud row carries its hourly rate. A row whose copy of the image is building says which stage it is at, and one whose last build stopped says why. A computer is not a workspace: a project lives on a computer, and a workspace is a copy of that computer with the project inside, which wsp workspaces lists.",
      input: {},
      output: { computers: z.array(PlaceView) },
      call: async (_args, deps) => asJson({ computers: (await (await deps.client()).request<{ places: PlaceView[] }>("places.list")).places }),
    }),
  },
  {
    name: "agents",
    usage: "wsp agents [<workspace>] [--on <computer>]",
    about: "the coding agents on this computer, a box you added or a workspace: each one's version and the newest out, whether it is signed in there, and whether it carries the wsp tools",
    page: "agent",
    options: { on: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp agents takes one workspace at most.", usageIs(ctx));
      const report = await agentsReport(await ctx.client(), ctx.args[0], flag(ctx.flags, "on"), usageIs(ctx));
      ctx.out.emit({ ...reportFacts(report), agents: report.agents }, agentRowLines(report).join("\n"));
      return 0;
    },
    tool: tool({
      description: `The coding agents the catalog knows, as they stand on one computer or workspace: whether each is on that login's PATH and where, the version its command answers, the newest its vendor publishes as this host last read it (asked of npm, GitHub or the vendor from this host alone, kept a day, never with Newest agent versions off in Settings > Privacy or WSP_UPDATE_CHECK=0) and the version wsp's install pins, its sign-in there (signed in, your key from this host's vault, not signed in, or unknown), how a person signs it in, and whether one of its MCP config files names the wsp server. ${AGENTS_READ_WORDS}`,
      input: { workspace: AgentsWorkspaceIn, on: AgentsOnIn },
      output: { ...AGENTS_FRAME, agents: z.array(AgentRow) },
      call: async ({ workspace, on }, deps) => {
        const report = await agentsReport(await deps.client(), workspace, on, "agents takes a workspace or on, not both");
        return asText(agentRowLines(report).join("\n"), { ...reportFacts(report), agents: report.agents });
      },
    }),
  },
  {
    name: "skills",
    usage: "wsp skills [<workspace>] [--on <computer>]",
    about: "the skills on this computer, a box you added or a workspace, each by name with every folder it lives in and which agent loads it from there",
    page: "agent",
    options: { on: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp skills takes one workspace at most.", usageIs(ctx));
      const report = await agentsReport(await ctx.client(), ctx.args[0], flag(ctx.flags, "on"), usageIs(ctx));
      ctx.out.emit({ ...reportFacts(report), skills: report.skills }, skillRowLines(report).join("\n"));
      return 0;
    },
    tool: tool({
      description: `Every skill on one computer or workspace, one row per folder name: its description off its SKILL.md, every folder it lives in with the agent whose own folder that is (none for the shared ~/.agents/skills) and where a folder links to, and whether it is the person's own, a project's inside a workspace, or a plugin's. ${AGENTS_READ_WORDS}`,
      input: { workspace: AgentsWorkspaceIn, on: AgentsOnIn },
      output: { ...AGENTS_FRAME, skills: z.array(SkillRow) },
      call: async ({ workspace, on }, deps) => {
        const report = await agentsReport(await deps.client(), workspace, on, "skills takes a workspace or on, not both");
        return asText(skillRowLines(report).join("\n"), { ...reportFacts(report), skills: report.skills });
      },
    }),
  },
  {
    name: "skills search",
    usage: "wsp skills search <query> [--limit <n>]",
    about: "searches skills.sh for skills by their words, each with how often it was installed and the id wsp skills add takes",
    page: "agent",
    options: { limit: { type: "string" } },
    run: async ctx => {
      const q = ctx.args.join(" ");
      const raw = flag(ctx.flags, "limit");
      const limit = raw === undefined ? undefined : Number(raw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw usageRefusal("--limit takes a whole number from 1 to 50.", usageIs(ctx));
      const hits = await searchSkillsSh(await ctx.client(), q, limit);
      ctx.out.emit({ skills: hits }, skillHitLines(hits).join("\n"));
      return 0;
    },
    tool: tool({
      description: "Skills on skills.sh whose words match the query, most installed first as skills.sh ranks them: each one's name, the repo it comes from, how many times it was installed, and the id skills_add takes. The host asks skills.sh; an empty query is refused.",
      input: { query: z.string().describe("the words to search skills.sh for"), limit: z.number().int().min(1).max(50).optional().describe("how many to answer, 20 without it") },
      output: { skills: z.array(SkillHit) },
      call: async ({ query, limit }, deps) => {
        const hits = await searchSkillsSh(await deps.client(), query, limit);
        return asText(skillHitLines(hits).join("\n"), { skills: hits });
      },
    }),
  },
  {
    name: "skills show",
    usage: "wsp skills show <skill> [<workspace>] [--on <computer>] [--project [<name>]]",
    about: "prints a skill's SKILL.md: one on skills.sh by its <owner>/<repo>/<skill> before it is installed, or one already on this computer, a box you added or a workspace by its name",
    page: "agent",
    options: { on: { type: "string" }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [skill, workspace, ...rest] = ctx.args;
      if (skill === undefined || rest.length > 0) throw usageRefusal("wsp skills show takes one skill and one workspace at most.", usageIs(ctx));
      const shown = await skillShown(await ctx.client(), skill, workspace, flag(ctx.flags, "on"), projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx)), usageIs(ctx));
      ctx.out.emit(shown, shownText(shown));
      return 0;
    },
    tool: tool({
      description: `A skill's SKILL.md as text, its first ${SKILL_PREVIEW_BYTES / 1024} KB and the whole file's size: a skill on skills.sh by its <owner>/<repo>/<skill>, read by the host with nothing installed, or a skill already on one computer or workspace by its name. Nothing in it runs.`,
      input: { skill: z.string().describe("an <owner>/<repo>/<skill> off skills_search, or the name of a skill skills lists"), workspace: AgentsWorkspaceIn, on: AgentsOnIn, project: SkillProjectIn },
      output: SkillPreview.shape,
      call: async ({ skill, workspace, on, project }, deps) => {
        const shown = await skillShown(await deps.client(), skill, workspace, on, projectAsked(project, workspace, on, "skills_show"), "skills_show takes a workspace or on, not both");
        return asText(shownText(shown), shown);
      },
    }),
  },
  {
    name: "skills add",
    usage: "wsp skills add <skill> [<workspace>] [--on <computer>] [--agent <id>]... [--project [<name>]]",
    about: "installs a skill off skills.sh by its <owner>/<repo>/<skill> into the shared skills folder, with a link or a copy for each agent named that does not read that folder; every file is checked first and lands as a plain file that runs nothing",
    page: "agent",
    options: { on: { type: "string" }, agent: { type: "string", multiple: true }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [skill, workspace, ...rest] = ctx.args;
      if (skill === undefined || rest.length > 0) throw usageRefusal("wsp skills add takes one skill and one workspace at most.", usageIs(ctx));
      const agents = flagList(ctx.flags, "agent");
      const added = await skillAdded(await ctx.client(), skill, workspace, flag(ctx.flags, "on"), agents.length > 0 ? agents : undefined, projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx)), usageIs(ctx));
      ctx.out.emit(added, addedLine(skill, added));
      return 0;
    },
    tool: tool({
      description:
        "Installs one skill off skills.sh on one computer or workspace, as the login it was added with: its files land once in ~/.agents/skills/<name> (the project's .agents/skills with project, from a workspace), and each agent named that does not read that folder gets a link to it or a copy in its own skills folder; with no agent named, every agent whose own folder's home is there gets it. The download is checked whole before anything lands: every path plain and inside the skill, at most 200 files, 1 MB each and 5 MB in all, a SKILL.md at its root; every file lands 0644 and nothing in the skill runs. A skill already there is refused rather than written over.",
      input: {
        skill: z.string().describe("the skill's <owner>/<repo>/<skill>, as skills_search answers it"),
        workspace: AgentsWorkspaceIn,
        on: AgentsOnIn,
        agent: z.array(z.string()).optional().describe("the catalog ids of the agents to put it in; every agent whose folder is there without it"),
        project: z.union([z.boolean(), z.string()]).optional().describe("put it in a project rather than the home: true for the workspace's own, or the project's name, as projects lists it, with on"),
      },
      output: SkillAdded.shape,
      call: async ({ skill, workspace, on, agent, project }, deps) => {
        const added = await skillAdded(await deps.client(), skill, workspace, on, agent, projectAsked(project, workspace, on, "skills_add"), "skills_add takes a workspace or on, not both");
        return asText(addedLine(skill, added), added);
      },
    }),
  },
  {
    name: "skills remove",
    usage: "wsp skills remove <name> [<workspace>] [--on <computer>] [--project [<name>]]",
    about: "removes a skill by its name: every folder it lives in and every link to it, where a link's own folder elsewhere stays",
    page: "agent",
    options: { on: { type: "string" }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp skills remove takes one skill's name and one workspace at most.", usageIs(ctx));
      const removed = await skillChanged(await ctx.client(), "skills.remove", name, workspace, flag(ctx.flags, "on"), projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx)), undefined, usageIs(ctx));
      ctx.out.emit({ removed }, removedLine(name, removed));
      return 0;
    },
    tool: tool({
      description: `Removes one skill on one computer or workspace by its name, as the login it was added with: every folder skills lists for it and every link to it; a folder a link points to outside the skills folders stays. ${SKILL_CHANGE_WORDS}`,
      input: { name: SkillNameIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn, project: SkillProjectIn },
      output: { removed: z.array(z.string()) },
      call: async ({ name, workspace, on, project }, deps) => {
        const removed = await skillChanged(await deps.client(), "skills.remove", name, workspace, on, projectAsked(project, workspace, on, "skills_remove"), undefined, "skills_remove takes a workspace or on, not both");
        return asText(removedLine(name, removed), { removed });
      },
    }),
  },
  ...(["disable", "enable"] as const).map(
    (word): Verb => ({
      name: `skills ${word}`,
      usage: `wsp skills ${word} <name> [<workspace>] [--on <computer>]`,
      about: word === "disable" ? "turns a skill off by its name, its SKILL.md renamed SKILL.md.off where it lives, so no agent loads it until it is turned on" : "turns a skill that was turned off on again, its SKILL.md.off renamed back",
      page: "agent",
      options: { on: { type: "string" } },
      run: async ctx => {
        const [name, workspace, ...rest] = ctx.args;
        if (name === undefined || rest.length > 0) throw usageRefusal(`wsp skills ${word} takes one skill's name and one workspace at most.`, usageIs(ctx));
        const paths = await skillChanged(await ctx.client(), "skills.toggle", name, workspace, flag(ctx.flags, "on"), { project: false }, word === "enable", usageIs(ctx));
        ctx.out.emit({ paths }, `${name} is ${word === "enable" ? "on" : "off"}.`);
        return 0;
      },
      tool: tool({
        description: `Turns one skill ${word === "enable" ? "on again" : "off"} on one computer or workspace by its name, as the login it was added with: its SKILL.md is renamed ${word === "enable" ? "back from SKILL.md.off" : "SKILL.md.off"} in each folder it really lives in, which every link to it follows, and no agent config is edited. A project's skill lives in the repo and is refused. ${SKILL_CHANGE_WORDS}`,
        input: { name: SkillNameIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn },
        output: { paths: z.array(z.string()) },
        call: async ({ name, workspace, on }, deps) => {
          const paths = await skillChanged(await deps.client(), "skills.toggle", name, workspace, on, { project: false }, word === "enable", `skills_${word} takes a workspace or on, not both`);
          return asText(`${name} is ${word === "enable" ? "on" : "off"}.`, { paths });
        },
      }),
    }),
  ),
  {
    name: "servers",
    usage: "wsp servers [<workspace>] [--on <computer>]",
    about: "the MCP servers the agents on this computer, a box you added or a workspace are set up with: how each is reached, the file it is defined in and its sign-in as its config says it",
    page: "agent",
    options: { on: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp servers takes one workspace at most.", usageIs(ctx));
      const report = await agentsReport(await ctx.client(), ctx.args[0], flag(ctx.flags, "on"), usageIs(ctx));
      ctx.out.emit({ ...reportFacts(report), servers: report.servers }, serverRowLines(report).join("\n"));
      return 0;
    },
    tool: tool({
      description: `Every MCP server each agent's own config file defines on one computer or workspace, and a workspace's project files: the agent, the file, how it is reached (its command with every value hidden, or its url's host), the names of the variables it sets or reads and never their values, whether the file switches it off, whether wsp's recipe put it there on a box, and its sign-in as the config alone says it: open for a command or a fixed header, unknown for a remote server until something connects. ${AGENTS_READ_WORDS}`,
      input: { workspace: AgentsWorkspaceIn, on: AgentsOnIn },
      output: { ...AGENTS_FRAME, servers: z.array(McpRow) },
      call: async ({ workspace, on }, deps) => {
        const report = await agentsReport(await deps.client(), workspace, on, "servers takes a workspace or on, not both");
        return asText(serverRowLines(report).join("\n"), { ...reportFacts(report), servers: report.servers });
      },
    }),
  },
  {
    name: "agents signin",
    usage: "wsp agents signin <agent> [<workspace>]",
    about: "signs an agent in on this computer or in a workspace, its own sign-in run there and shown in this terminal; a box you added takes wsp add <computer> --sign-in <agent>",
    page: "agent",
    options: {},
    cliOnly: "runs the agent's own sign-in in a terminal a person types into, which is where the ones that ask them to pick a provider are answered",
    run: async ctx => {
      const [agent, workspace, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents signin takes one agent and one workspace at most.", usageIs(ctx));
      const target = await agentsTarget(await ctx.client(), workspace, undefined, usageIs(ctx));
      const answer = await signInHere(ctx, target, { agent });
      ctx.io.log(signedInLine(agentName(agent), workspace ?? THIS_COMPUTER, answer));
      return answer.signedIn ? 0 : 1;
    },
  },
  {
    name: "agents key",
    usage: "wsp agents key <agent>",
    about: "puts an agent's token or API key into this host's vault, typed where nothing echoes it; Claude Code's token is the one claude setup-token prints",
    page: "agent",
    options: {},
    cliOnly: "takes a token typed at the host's own terminal into its vault, which is the person's to hand over",
    hostSide: HOST_SIDE_VAULT,
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents key takes one agent.", usageIs(ctx));
      if (ctx.io.isTTY !== true) throw usageRefusal("nobody is at this terminal to paste a token.", "Run it in a terminal on the computer the host runs on.");
      const mint = catalogEntry(agent)?.signIn;
      const ask = mint !== undefined && "mint" in mint ? `Run ${mint.mint} in another terminal, then paste the token it prints` : `Paste ${agentName(agent)}'s API key`;
      const key = await ctx.io.askSecret(ask);
      await (await ctx.client()).request("agents.key", { agent, key });
      ctx.io.log(`${agentName(agent)}'s key is in this host's vault; every turn reads it from there.`);
      return 0;
    },
  },
  {
    name: "agents addtools",
    usage: "wsp agents addtools <agent>",
    about: "writes the wsp server into an agent's own config on this computer, the entry wsp mcp install writes, with the wsp skill beside it",
    page: "agent",
    options: {},
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents addtools takes one agent.", usageIs(ctx));
      const added = await addTools(await ctx.client(), agent);
      ctx.out.emit(added, `${agentName(agent)} now has the wsp tools: ${added.file}`);
      return 0;
    },
    tool: tool({
      description: `Writes the wsp server into one agent's own MCP config on the computer the app runs on, the same entry wsp mcp install writes, with the wsp skill beside it, and answers the file. ${addToolsHereRefusal}`,
      input: { agent: z.string().describe("the catalog id of the agent, as agents lists it") },
      output: { file: z.string() },
      call: async ({ agent }, deps) => {
        const added = await addTools(await deps.client(), agent);
        return asText(`${agentName(agent)} now has the wsp tools: ${added.file}`, added);
      },
    }),
  },
  {
    name: "servers signin",
    usage: "wsp servers signin <name> --agent <id> [<workspace>] [--on <computer>]",
    about: "signs one MCP server in by its agent's own command for it, run where the server is set up and shown in this terminal",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" } },
    cliOnly: "runs the harness's own sign-in for the server in a terminal a person types into, where the page's answer is pasted",
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers signin takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers signin needs --agent, the agent whose config names the server, as wsp servers shows it.", usageIs(ctx));
      const on = flag(ctx.flags, "on");
      const target = await agentsTarget(await ctx.client(), workspace, on, usageIs(ctx));
      const answer = await signInHere(ctx, target, { agent, name });
      ctx.io.log(signedInLine(name, workspace ?? on ?? THIS_COMPUTER, answer));
      return answer.signedIn ? 0 : 1;
    },
  },
  {
    name: "servers tools",
    usage: "wsp servers tools <name> --agent <id> [<workspace>] [--on <computer>] [--project <name>] [--refresh]",
    about: "starts one MCP server once where it is set up and lists its tools with their descriptions, and says whether it needs a sign-in",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" }, project: { type: "string", valueWith: "on" }, refresh: { type: "boolean" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers tools takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers tools needs --agent, the agent whose config names the server, as wsp servers shows it.", usageIs(ctx));
      const project = toolsProject(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      const answer = await serverToolsOf(await ctx.client(), name, agent, workspace, flag(ctx.flags, "on"), ctx.flags["refresh"] === true, usageIs(ctx), project);
      ctx.out.emit(answer, toolLines(name, answer).join("\n"));
      return 0;
    },
    tool: tool({
      description: `One MCP server's tools with their descriptions, and its sign-in as that one connect found it (open, signed in, needs a sign-in, failed, or unknown), with why nothing came back where nothing did. ${SERVER_TOOLS_WORDS}`,
      input: {
        name: z.string().describe("the server's name, as servers lists it"),
        agent: z.string().describe("the catalog id of the agent whose config names it, as servers lists it"),
        workspace: AgentsWorkspaceIn,
        on: AgentsOnIn,
        project: z.string().optional().describe("the project on that computer whose server it is, by the name projects lists, with on; a workspace finds its own project's servers"),
        refresh: z.boolean().optional().describe("start it again even where an answer from the last three minutes stands"),
      },
      output: ServerToolsAnswer.shape,
      call: async ({ name, agent, workspace, on, project, refresh }, deps) => {
        const usage = "servers_tools takes a workspace or on, not both";
        const answer = await serverToolsOf(await deps.client(), name, agent, workspace, on, refresh === true, usage, toolsProject(project, workspace, on, usage));
        return asText(toolLines(name, answer).join("\n"), answer);
      },
    }),
  },
  {
    name: "servers add",
    usage: "wsp servers add <name> [<workspace>] [--on <computer>] --agent <id> (--command \"<line>\" [--env <NAME>]... | --url <address> [--header <name>=<VARIABLE>]...) [--project [<name>]]",
    about: "writes one MCP server into an agent's own config: a command with its arguments and variables, or an address with its headers, each value read off this terminal's environment and written into that file on this computer; on any other the file names a variable and the value goes to the vault",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" }, command: { type: "string" }, env: { type: "string", multiple: true }, url: { type: "string" }, header: { type: "string", multiple: true }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers add takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers add needs --agent, the agent whose config takes the server.", usageIs(ctx));
      const command = flag(ctx.flags, "command");
      const url = flag(ctx.flags, "url");
      const values = serverValues(ctx.env, flagList(ctx.flags, "env"), flagList(ctx.flags, "header"), usageIs(ctx));
      const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      const body = { agent, name, ...serverCommand(command, usageIs(ctx)), ...(url !== undefined ? { url } : {}), ...values, ...(project.project ? { project: true } : {}) };
      const added = await serverChanged(await ctx.client(), "servers.add", body, workspace, flag(ctx.flags, "on"), usageIs(ctx), project.name);
      ctx.out.emit(added, `${name} is in ${added.file}.`);
      return 0;
    },
    tool: tool({
      description: `Writes one MCP server into one agent's own config on one computer or workspace, the project's file with project from a workspace: a command with its arguments and the variables it is given, or an address with its headers. Every value is read by name off the environment the wsp tools run with and never goes into an answer: on this computer it goes into that file, and on any other the file names a variable and the value goes to the vault, which hands it to every turn. A name already in the file is refused rather than written over. ${SERVER_CHANGE_WORDS}`,
      input: {
        name: z.string().describe("what to call the server in the agent's config"),
        agent: z.string().describe("the catalog id of the agent whose config takes it"),
        workspace: AgentsWorkspaceIn,
        on: AgentsOnIn,
        command: z.string().optional().describe("the line the server runs, the program and its arguments as a shell would split them, nothing expanded; or url"),
        env: z.array(z.string()).optional().describe("variables the server is given, each by its name, its value read off the same name in the environment the wsp tools run with"),
        url: z.string().optional().describe("the server's https address; or command"),
        header: z.array(z.string()).optional().describe("headers sent to the address, each <name>=<VARIABLE>, its value read off that variable in the environment the wsp tools run with"),
        project: z.union([z.boolean(), z.string()]).optional().describe("put it in a project's file rather than the agent's own: true for the workspace's own project, or the project's name, as projects lists it, with on"),
      },
      output: { file: z.string() },
      call: async ({ name, agent, workspace, on, command, env, url, header, project }, deps) => {
        const usage = "servers_add takes a workspace or on, not both";
        const values = serverValues(deps.env, env ?? [], header ?? [], usage);
        const asked = projectAsked(project, workspace, on, usage);
        const body = { agent, name, ...serverCommand(command, usage), ...(url !== undefined ? { url } : {}), ...values, ...(asked.project ? { project: true } : {}) };
        const added = await serverChanged(await deps.client(), "servers.add", body, workspace, on, usage, asked.name);
        return asText(`${name} is in ${added.file}.`, added);
      },
    }),
  },
  {
    name: "servers remove",
    usage: "wsp servers remove <name> [<workspace>] [--on <computer>] --agent <id> [--scope <user|home|project>] [--project [<name>]]",
    about: "takes one MCP server's entry out of an agent's own config, every other line of the file as it was",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" }, scope: { type: "string" }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers remove takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers remove needs --agent, the agent whose config names the server, as wsp servers shows it.", usageIs(ctx));
      const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      const scope = serverScope(flag(ctx.flags, "scope"), usageIs(ctx), project);
      const removed = await serverChanged(await ctx.client(), "servers.remove", { agent, name, ...scope }, workspace, flag(ctx.flags, "on"), usageIs(ctx), project.name);
      ctx.out.emit(removed, `${name} is gone from ${removed.file}.`);
      return 0;
    },
    tool: tool({
      description: `Takes one MCP server's entry out of one agent's own config on one computer or workspace, in the scope servers lists it under, every other server and line of the file as it was. ${SERVER_CHANGE_WORDS}`,
      input: { name: ServerNameIn, agent: ServerAgentIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn, scope: ServerScopeIn, project: ServerProjectIn },
      output: { file: z.string() },
      call: async ({ name, agent, workspace, on, scope, project }, deps) => {
        const usage = "servers_remove takes a workspace or on, not both";
        const asked = projectAsked(project, workspace, on, usage);
        const removed = await serverChanged(await deps.client(), "servers.remove", { agent, name, ...serverScope(scope, usage, asked) }, workspace, on, usage, asked.name);
        return asText(`${name} is gone from ${removed.file}.`, removed);
      },
    }),
  },
  ...(["disable", "enable"] as const).map(
    (word): Verb => ({
      name: `servers ${word}`,
      usage: `wsp servers ${word} <name> [<workspace>] [--on <computer>] --agent <id> [--scope <user|home|project>] [--project [<name>]]`,
      about: word === "disable" ? "turns one MCP server off by the switch its agent reads, so the agent leaves it out until it is turned on" : "turns an MCP server that was turned off on again",
      page: "agent",
      options: { agent: { type: "string" }, on: { type: "string" }, scope: { type: "string" }, project: { type: "string", valueWith: "on" } },
      run: async ctx => {
        const [name, workspace, ...rest] = ctx.args;
        const agent = flag(ctx.flags, "agent");
        if (name === undefined || rest.length > 0) throw usageRefusal(`wsp servers ${word} takes one server's name and one workspace at most.`, usageIs(ctx));
        if (agent === undefined) throw usageRefusal(`wsp servers ${word} needs --agent, the agent whose config names the server, as wsp servers shows it.`, usageIs(ctx));
        const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
        const scope = serverScope(flag(ctx.flags, "scope"), usageIs(ctx), project);
        const changed = await serverChanged(await ctx.client(), "servers.toggle", { agent, name, ...scope, on: word === "enable" }, workspace, flag(ctx.flags, "on"), usageIs(ctx), project.name);
        ctx.out.emit(changed, `${name} is ${word === "enable" ? "on" : "off"} in ${changed.file}.`);
        return 0;
      },
      tool: tool({
        description: `Turns one MCP server ${word === "enable" ? "on again" : "off"} in one agent's own config on one computer or workspace, by the switch that agent reads (Codex's enabled line, OpenCode's enabled field, Gemini CLI's mcp.excluded); Claude Code keeps no such switch per server and is refused. ${SERVER_CHANGE_WORDS}`,
        input: { name: ServerNameIn, agent: ServerAgentIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn, scope: ServerScopeIn, project: ServerProjectIn },
        output: { file: z.string() },
        call: async ({ name, agent, workspace, on, scope, project }, deps) => {
          const usage = `servers_${word} takes a workspace or on, not both`;
          const asked = projectAsked(project, workspace, on, usage);
          const changed = await serverChanged(await deps.client(), "servers.toggle", { agent, name, ...serverScope(scope, usage, asked), on: word === "enable" }, workspace, on, usage, asked.name);
          return asText(`${name} is ${word === "enable" ? "on" : "off"} in ${changed.file}.`, changed);
        },
      }),
    }),
  ),
  {
    name: "workspaces",
    usage: "wsp workspaces [--watch]",
    about: "what you have: each workspace with its project, the computer it runs on, the shape of its machine and its state as the sidebar shows it (running, paused, waking or unreachable, off the phase with the provider's word for the machine and the daemon reach beside it); --watch draws the same table again every second where it stands",
    page: "front",
    options: { watch: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp workspaces takes no positional arguments.", usageIs(ctx));
      return drawRows(ctx, "wsp workspaces", async client => {
        const rows = await workspaceStatuses(client);
        const places = rows.some(w => w.place !== undefined) ? await placeNames(client) : new Map<string, string>();
        // One landing per project a row names: the copy cells read its two flags and the state word reads its
        // pause mode, so a nap at a provider that keeps the machine's memory says paused here as it does in the app.
        const landings = await landingsFor(client, rows.map(w => w.project.id));
        return {
          value: { workspaces: rows },
          rows: table([["WORKSPACE", "ID", "PROJECT", "COMPUTER", "COPY", "PORTS", "SIZE", "STATE", "AGENTS"], ...rows.map(w => workspaceLine(w, places, landings.get(w.project.id)))]),
        };
      });
    },
    tool: tool({
      description:
        "Every workspace this host runs, as the app lists them: id, name, the project it holds, the computer it runs on and its state as the sidebar shows it (running, paused, waking or unreachable, off the phase with the provider's word for the machine and the daemon reach beside it) where the kind has one. A workspace is a copy of its project's computer with the project inside, made for one piece of work and named by it; on the computer the app runs on it is a copy of the project's folder beside it. The name is what run and every other verb take.",
      input: {},
      output: { workspaces: z.array(WorkspaceListing) },
      call: async (_args, deps) => asJson({ workspaces: await workspaceStatuses(await deps.client()) }),
    }),
  },
  {
    name: "projects",
    usage: "wsp projects",
    about: "your projects, each on its computer: where its code comes from, where the checkout sits inside a workspace of it, the branch a workspace starts on and how many workspaces it has",
    page: "front",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp projects takes no positional arguments.", usageIs(ctx));
      const client = await ctx.client();
      const projects = await projectsOf(client);
      const held = projects.length === 0 ? [] : await workspaces(client);
      // The computer's own name, off the one places reading every other table takes; a thread's token is refused
      // that list, and its rows then read the id, which is what it can name a computer by anyway.
      const named = projects.length === 0 ? new Map<string, string>() : await placeNames(client).catch(() => new Map<string, string>());
      ctx.out.emit({ projects }, projects.length === 0 ? NO_PROJECT_YET : table([["PROJECT", "ID", "COMPUTER", "SOURCE", "PATH", "BASE", "WORKSPACES"], ...projects.map(p => projectLine(p, held, named))]).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Every project this host holds: its name, the computer it lives on, where its code comes from (a folder on the computer the app runs on, or a repo a computer clones), where the checkout sits inside a workspace of it, the branch a workspace of it starts on, and how many workspaces stand on it. The name is what new takes. A project is recorded with add and is one source on one computer; a workspace is a copy of that computer with the project inside.",
      input: {},
      output: { projects: z.array(ProjectView) },
      call: async (_args, deps) => asJson({ projects: await projectsOf(await deps.client()) }),
    }),
  },
  {
    name: "projects add",
    toolOnly:
      "the command line records a project with wsp add, the same word that joins a computer and takes a provider's key; those two belong at the terminal the host runs at, so the tool door carries the project half alone",
    tool: tool({
      description:
        "Records a project: one source on one computer, which every workspace of it is a copy for. A folder on the computer the app runs on is copied beside itself for each workspace, and a repo is cloned by the computer named with on, which every workspace of it then holds a checkout of. A folder that is not a git repo, a repo without a computer to clone it, and a source already recorded on that computer are each refused in one line. The answer is the project, whose name is what new takes.",
      input: {
        source: z.string().describe("a folder on the computer the app runs on, or a repo's url"),
        on: z.string().optional().describe("the computer that clones the repo, by the name computers lists; a repo needs one and a folder takes none"),
        name: z.string().optional().describe("what to call the project here; the folder's or the repo's own last word without it"),
        base: z.string().optional().describe("the branch a workspace of the project starts on; the remote's own default branch at the clone without it"),
      },
      output: { project: ProjectView, notice: z.string().optional() },
      call: async (args, deps) => {
        const client = await deps.client();
        const { project, notice } = await client.request<{ project: ProjectView; notice?: string }>("projects.add", {
          source: args.source,
          ...(args.on !== undefined ? { on: args.on } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.base !== undefined ? { base: args.base } : {}),
        });
        const named = await placeNames(client).catch(() => new Map<string, string>());
        // What landed and is not what was asked for rides the answer: an add that stands with the commits left
        // behind reads as an add that stands, and the caller has to be told which.
        const said = addedProjectLine(project, named, hostPlatform());
        return asText(notice === undefined ? said : `${said}\n${notice}`, { project, ...(notice !== undefined ? { notice } : {}) });
      },
    }),
  },
  {
    name: "projects remove",
    usage: "wsp projects remove <project>",
    about: "takes a project out of this wsp, with the folder wsp itself made for it on the computer holding it; a folder of yours on this computer is left where it is, and a project with a workspace standing on it is refused naming them",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp projects remove takes one project.", usageIs(ctx));
      const client = await ctx.client();
      const project = await projectOf(client, ref);
      // The sentence comes off the wire: what a remove took is true differently on a computer of the person's, at
      // a provider and on this computer, and the runtime's own road for that computer is what says which.
      const { said } = await client.request<{ said: string }>("projects.remove", { projectId: project.id });
      ctx.out.emit({ project, said }, said);
      return 0;
    },
    tool: tool({
      description: `Takes a project's record out of this wsp, and with it the folder wsp itself made for the project on the computer holding it: its checkout there goes, and ${MEMORY_KEPT_CLAUSE}. A folder of yours on this computer stays exactly where it is, and no repo is ever asked for anything. Refused in one line while a workspace of it stands, naming the workspaces; delete those first.`,
      input: { project: z.string().describe("the project's name, or its id when two share a name") },
      output: { project: ProjectView, said: z.string() },
      call: async ({ project: ref }, deps) => {
        const client = await deps.client();
        const project = await projectOf(client, ref);
        const { said } = await client.request<{ said: string }>("projects.remove", { projectId: project.id });
        return asText(said, { project, said });
      },
    }),
  },
  {
    name: "threads",
    usage: "wsp threads [<workspace>] [--tree] [--watch]",
    about: "who is working, in which workspace and on which computer: every thread as the sidebar lists it, with its project, the agent, the state and who opened it; --tree indents the threads an agent spawned under the one that spawned them, and --watch draws the same table again every second where it stands",
    page: "front",
    options: { tree: { type: "boolean" }, watch: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp threads takes at most one workspace; wsp threads wait is its one subcommand, and wsp thread read <thread> prints what one said.", usageIs(ctx));
      return drawRows(ctx, "wsp threads", async client => {
        const rows = await threadRows(client, ctx.args[0]);
        const lines = ctx.flags["tree"] === true ? threadTree(rows).map(t => threadLine(t.row, "  ".repeat(t.depth))) : rows.map(t => threadLine(t));
        return { value: { threads: rows }, rows: table([["PROJECT", "WORKSPACE", "THREAD", "AGENT", "STATE", "BY", "COMPUTER", "TITLE"], ...lines]) };
      });
    },
    tool: tool({
      description: "Every thread as the sidebar lists it: its project, its workspace, the computer that workspace runs on, the agent inside, its state, who opened it (person, cli or agent) and its title. Optionally within one workspace. A thread an agent inside another thread opened carries parentThreadId and rootThreadId, which is the tree stop ends as one.",
      input: { workspace: WorkspaceIn.optional() },
      output: { threads: z.array(ThreadRowOut) },
      call: async ({ workspace: within }, deps) => asJson({ threads: await threadRows(await deps.client(), within) }),
    }),
  },
  {
    name: "threads wait",
    usage: "wsp threads wait <thread>... [--timeout <s>] [--tail]",
    about:
      "blocks until one of the threads leaves running and prints its finished line, with the reply whole under it; --tail prints the reply's last line alone, which is what a notify sends, and --timeout gives up after so many seconds and says so on stderr",
    page: "agent",
    options: { timeout: { type: "string" }, tail: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length === 0) throw usageRefusal("wsp threads wait takes one thread or more.", usageIs(ctx));
      const timeoutMs = timeoutFlag(flag(ctx.flags, "timeout"));
      const client = await ctx.client();
      const named = await threadsOf(client, ctx.args);
      // The whole reply unless the tail was asked for: a last line is a paragraph's end or a code fence, and a
      // person waiting on a thread is waiting for its answer, not for the shape of its final line.
      const { value, line } = waitAnswer(named, await firstEnded(client, named, timeoutMs), ctx.flags["tail"] === true ? "tail" : "whole");
      if (value.timedOut === true) {
        ctx.out.emit(value);
        ctx.io.error(line);
      } else ctx.out.emit(value, line);
      return 0;
    },
    tool: tool({
      description: `Blocks until one of the named threads leaves running and answers with that thread's end: its id, status (completed, interrupted or failed), how long it worked, what it cost and the last line of its reply, the text being the one line a notify sends. One thread per call: a caller that started three builders calls this three times, dropping each returned id from the list, since a thread already over comes back at once and would come back again. With timeout, the seconds to wait before answering with nothing and timedOut true, so other work fits between calls; keep it under your own tool call limit and call again. This blocks, so it is for a shell script and not for your own conversation. ${NOTIFY_CALLER}. ${COORDINATOR_HANDOFF}. Never poll threads for a state change.`,
      input: {
        threads: z.array(z.string()).min(1).describe("thread ids, or prefixes that each pick one"),
        timeout: z.number().positive().optional().describe("seconds to wait; absent waits until one of the threads finishes"),
      },
      output: WaitOut.shape,
      call: async ({ threads: refs, timeout }, deps) => {
        const client = await deps.client();
        const named = await threadsOf(client, refs);
        const { value, line } = waitAnswer(named, await firstEnded(client, named, timeout === undefined ? undefined : timeout * 1_000));
        return asText(line, value);
      },
    }),
  },
  {
    name: "recipe scan",
    readsHere: "the agents, package managers and history it reads are this computer's own",
    usage: "wsp recipe scan [--project <folder>]",
    about:
      "read this computer and print every option, writing nothing: the agents, the tools with why and size, what else a package manager here has that the image could take, the commands your agents ran, and the sign-ins, each with what to do about it and one line of why; --project weighs the histories by a folder and --json prints it as one object",
    page: "agent",
    options: { project: { type: "string", multiple: true } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipe scan takes no positional arguments.", usageIs(ctx));
      const host = nodeHost();
      const scan = await runScan(host, { ...projectsFlag(ctx.flags), cache: historyCache(ctx.statePath), ...(ctx.alsoHere !== undefined ? { alsoHere: ctx.alsoHere } : {}) }, progress(ctx.io));
      printTable(ctx, scan, depth => scanPrintout(scan, host.platform, depth), `Nothing was written. Take the do column with wsp recipe --set <id>=on and --signin <id>=machine, then run wsp init --recipe ${resolve(smallRecipePath(ctx.statePath))}.`);
      return 0;
    },
    tool: tool({
      description:
        "Every option this computer offers for a machine, read once and written nowhere: the person's agents and the catalog's tools with the tick their own use reaches and what each adds to the machine, what else a package manager on this computer has that the image could take (alsoHere, by manager, with the line that installs each on the machine, each row's id being the one to hand recipe's set, which ticks that package as a row of its own), whose scanned says whether anything looked, the commands their agents ran that the catalog does not carry, and the sign-in each ticked row brings. Every row carries a recommended value and a one-line reason, so apply those and put only the rows whose reason says worth a question. Run this before recipe, and before asking the person anything. Only names and counts are read.",
      input: { project: PROJECT_FOLDERS },
      output: RecipeScan.shape,
      call: async ({ project }, deps) => {
        const host = nodeHost();
        const scan = await runScan(host, {
          cache: historyCache(deps.statePath),
          ...(project !== undefined ? { projects: projectFolders(project) } : {}),
          ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
        });
        return asText(scanPrintout(scan, host.platform).join("\n"), scan);
      },
    }),
  },
  {
    name: "recipe",
    readsHere: "the agents, package managers and history it reads are this computer's own",
    usage: `wsp recipe [--tick ${RECIPE_TICKS.join("|")}] [--set <id>=on|off] [--signin <id>=${LOGIN_CHOICES.join("|")}] [--add <id>=<command>] [--add-check <id>=<command>] [--engine] [--project <folder>] [--out <path>]`,
    about:
      `write the recipe and print it as a table: every catalog agent and tool with its tick, why it has it and what it costs on the machine, then the commands your agents ran that no catalog row carries. --tick used|installed|default names the rule that decides every tick (used, the default, ticks what your agents actually ran here); --set <id>=on|off flips a row by its catalog id, or a package this computer's own package managers have by the id wsp recipe scan gives it, which the build installs by that package's own road; --signin <id>=${LOGIN_CHOICES.join("|")} answers a sign-in by catalog id, later leaving it to the first time the tool is needed on the workspace and key bringing the key files beside a login and nothing else of it; --add <id>=<command> carries a tool neither the catalog nor this computer has, installed by that command on the machine, with --add-check <id>=<command> saying it is there; --engine marks the recipe so every workspace from its image gets the place's Docker or podman through a socket of its own (a project whose compose file needs one), and stays in the file until you edit it out; --project reads a folder's own manifests for what it takes to build and weighs the histories by it, --out says where the file goes and --json prints the table as one object. Naming --tick or --project decides every tick again; without either, what the file says stands and the flags flip rows on top of it. A sign-in answer stands either way: no rule decides one. All of them repeat. Review it, then wsp init --recipe`,
    page: "agent",
    options: {
      out: { type: "string" },
      tick: { type: "string" },
      set: { type: "string", multiple: true },
      signin: { type: "string", multiple: true },
      add: { type: "string", multiple: true },
      "add-check": { type: "string", multiple: true },
      engine: { type: "boolean" },
      project: { type: "string", multiple: true },
    },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipe takes no positional arguments; wsp recipe scan is its one subcommand.", usageIs(ctx));
      const tick = flag(ctx.flags, "tick");
      if (tick !== undefined && !isRecipeTick(tick)) throw usageRefusal(`--tick takes one of ${RECIPE_TICKS.join(", ")}, and got ${JSON.stringify(tick)}.`, "Name one of those.");
      const out = resolve(flag(ctx.flags, "out") ?? smallRecipePath(ctx.statePath));
      const table = await runRecipe(
        nodeHost(),
        {
          out,
          cache: historyCache(ctx.statePath),
          ...(tick !== undefined ? { tick } : {}),
          ...(ctx.flags["engine"] === true ? { engine: true } : {}),
          set: flagList(ctx.flags, "set"),
          signin: flagList(ctx.flags, "signin"),
          add: flagList(ctx.flags, "add"),
          addCheck: flagList(ctx.flags, "add-check"),
          ...projectsFlag(ctx.flags),
          ...(ctx.alsoHere !== undefined ? { alsoHere: ctx.alsoHere } : {}),
        },
        progress(ctx.io),
      );
      printTable(ctx, table, depth => recipePrintout(table, depth), `Recipe written to ${out}. Review it, flip a row with wsp recipe --set <id>=on, then run wsp init --recipe ${out}.`);
      return 0;
    },
    tool: tool({
      description: `The recipe for a machine, read off this computer and written to a file: every catalog agent and tool with its tick, why it has that tick, and what it adds to the machine, plus the commands the person's agents ran that no catalog row carries. tick names the rule: used ticks what their agents actually ran here, installed ticks what is on this computer, default ticks what the catalog ships on; an agent wsp cannot open a thread on is off unless installed. The file is the state, so a second call is not a fresh start: naming tick or project lets the rule decide every tick again and throws away the flips a call before it made, and a call that names neither keeps what the file says and puts its own flips on top. Sign-in answers stand through every call whatever the rule, since nothing but the person decides one. Put the heavy rows to the person with their sizes before anything is built, then flip rows with set and run \`wsp init --recipe <out> --non-interactive --json\` from a shell, handing the person each sign-in line it prints, since the sign-ins finish in their browser. Only names and counts are read; nothing a session held is returned.`,
      input: {
        tick: RecipeTick.optional().describe(`which rule decides every tick: ${RECIPE_TICKS.join(", ")}. Naming it re-decides every row from the rule, so any flip an earlier call made goes; absent, the file's own rule and its ticks stand, and used decides a first call and any row the file does not carry`),
        set: z.array(z.string()).optional().describe('rows to flip, "<id>=on" or "<id>=off", applied over whatever decided the row: a catalog id, or the id recipe_scan gives a package one of this computer\'s own package managers has (alsoHere), which ticks that package as a row of its own and installs it by its own road. On a call that names tick or project they sit over the rule\'s fresh answer; on any other call they sit over the ticks already in the file'),
        signin: z.array(z.string()).optional().describe(`what happens to a row's sign-in, "<id>=${LOGIN_CHOICES.join("|")}"; key brings the key files beside its login and the login still runs on the machine. An answer already in the file stands until a later call names that row again, whatever tick or project do to the ticks`),
        add: z.array(z.string()).optional().describe('tools neither the catalog carries nor this computer has, "<id>=<install command>"; the line runs on the machine as given after every catalog install, and such a row is never offered a sign-in. A package recipe_scan already lists under alsoHere is refused here and ticked with set instead, since it is a row of its own. Rows an earlier call added stand, whatever tick or project do to the ticks'),
        add_check: z.array(z.string()).optional().describe('what proves an added tool landed, "<id>=<command that exits 0>"; without one the id on PATH is the check'),
        why: z.string().optional().describe("what the rows this call adds are for, in your own words; absent, they say an agent added them"),
        engine: z.boolean().optional().describe("mark the recipe so every workspace from its image gets the place's container engine (Docker or podman) through a socket of its own, for a project whose compose file needs one; it stays in the file until edited out"),
        project: WEIGH_BY_FOLDERS,
        out: z.string().optional().describe("where the recipe file goes, absolute; absent means the host's own recipe.json beside its state"),
      },
      output: RecipeAnswer.shape,
      call: async ({ tick, set, signin, add, add_check: addCheck, why, engine, project, out }, deps) => {
        const table = await runRecipe(nodeHost(), {
          out: out === undefined ? smallRecipePath(deps.statePath) : absolutePath("out is a path on this computer", out),
          cache: historyCache(deps.statePath),
          ...(tick !== undefined ? { tick } : {}),
          ...(set !== undefined ? { set } : {}),
          ...(signin !== undefined ? { signin } : {}),
          ...(add !== undefined ? { add } : {}),
          ...(addCheck !== undefined ? { addCheck } : {}),
          ...(why !== undefined ? { why } : {}),
          ...(engine === true ? { engine: true } : {}),
          ...(project !== undefined ? { projects: projectFolders(project) } : {}),
          ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
        });
        return asText(recipePrintout(table).join("\n"), table);
      },
    }),
  },
  {
    name: "new",
    usage: 'wsp new [<project>] "<what you are working on>" [--from <project image>] [--size <cpu>x<memGb>] [--engine] [--spawn on|off] [--max-machines <n>] [--max-depth <n>]',
    about: "a workspace: a copy of the project's computer with the project inside, named by the work; with one project the name of it is not needed, and --engine gives the copy the computer's Docker or podman through a socket that sees its own containers alone",
    page: "front",
    options: { from: { type: "string" }, size: { type: "string" }, engine: { type: "boolean" }, spawn: { type: "string" }, "max-machines": { type: "string" }, "max-depth": { type: "string" } },
    run: async ctx => {
      if (ctx.args.length === 0 || ctx.args.length > 2) throw usageRefusal("wsp new takes the work you are doing, and the project when you have more than one.", usageIs(ctx));
      const client = await ctx.client();
      const [project, name] = await projectFirst(client, ctx.args);
      const agents = agentsAsked(flag(ctx.flags, "spawn"), flag(ctx.flags, "max-machines"), flag(ctx.flags, "max-depth"));
      await createFor(client, ctx.out, project, name, { ...(flag(ctx.flags, "from") !== undefined ? { from: flag(ctx.flags, "from")! } : {}), ...(flag(ctx.flags, "size") !== undefined ? { size: flag(ctx.flags, "size")! } : {}), ...(agents !== undefined ? { agents } : {}), engine: ctx.flags["engine"] === true });
      return 0;
    },
    tool: tool({
      description:
        "A workspace for one piece of work: a copy of the project's computer with the project inside, named by the work. The project decides where it lands, so nothing else says where. On the computer the app runs on the workspace is a copy of the project's folder beside it, with a port of its own. With from, it forks a project image instead of the computer's own image head.",
      input: {
        project: z.string().optional().describe("the project this work is on, by the name or the id projects lists; needed once you have more than one project"),
        name: z.string().describe("what you are working on, which is the workspace's name and what run and every other verb take"),
        from: z.string().optional().describe("a project image: its project's name (the newest taken of it) or its snapshot id, as snapshot returns them"),
        size: SizeIn,
        engine: z.boolean().optional().describe("give the workspace the computer's container engine (Docker or podman) through a socket at the path a Docker client expects, which sees that workspace's containers alone; a computer with no engine refuses it, and absent takes what the image's recipe says"),
        spawn: SpawnIn,
        max_machines: MaxMachinesIn,
        max_depth: MaxDepthIn,
      },
      output: Created.shape,
      call: async ({ project: ref, name, from, size: word, engine, spawn, max_machines: maxMachines, max_depth: maxDepth }, deps) => {
        const client = await deps.client();
        const project = await theProject(client, ref);
        const agents = agentsAsked(spawn, maxMachines, maxDepth);
        return asJson(await createFor(client, QUIET, project, name, { ...(from !== undefined ? { from } : {}), ...(word !== undefined ? { size: word } : {}), ...(agents !== undefined ? { agents } : {}), engine: engine === true }));
      },
    }),
  },
  {
    name: "workspaces agents",
    usage: "wsp workspaces agents <workspace> --spawn on|off [--max-machines <n>] [--max-depth <n>]",
    about: "what the agents inside the workspace may ask of this host: off, or threads and machines under the thread they run in, capped",
    page: "agent",
    options: { spawn: { type: "string" }, "max-machines": { type: "string" }, "max-depth": { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp workspaces agents takes one workspace.", usageIs(ctx));
      const asked = agentsAsked(flag(ctx.flags, "spawn"), flag(ctx.flags, "max-machines"), flag(ctx.flags, "max-depth"));
      if (asked === undefined) throw usageRefusal("wsp workspaces agents takes --spawn on or --spawn off.", usageIs(ctx));
      const workspace = await setAgents(await ctx.client(), ref, asked);
      ctx.out.emit({ workspace }, `${workspace.name}: ${agentsLine(workspace.agents)}`);
      return 0;
    },
    tool: tool({
      description:
        "Turns the workspace's agents switch on or off and names its caps. With it on, a turn on this workspace is launched with a token into this host scoped to its own thread: that thread may open threads and fork machines under itself, up to maxMachines machines at once under one root thread and maxDepth levels deep, and may touch no other workspace, delete nothing, pause nothing and pair no computer. On this Mac the token is identity, not confinement: a thread there runs as the person and can read the host's own token file. Off, which is what every workspace reads as until this is called, its agents reach this host not at all. A caller that is itself a thread on a machine is refused: what agents may do is the person's to decide.",
      input: { workspace: WorkspaceIn, spawn: z.enum(["on", "off"]), max_machines: MaxMachinesIn, max_depth: MaxDepthIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref, spawn, max_machines: maxMachines, max_depth: maxDepth }, deps) => {
        const workspace = await setAgents(await deps.client(), ref, agentsAsked(spawn, maxMachines, maxDepth)!);
        return asText(`${workspace.name}: ${agentsLine(workspace.agents)}`, { workspace });
      },
    }),
  },
  {
    name: "rename",
    usage: 'wsp rename <workspace> "<name>"',
    about: "names the workspace on this computer; the name is unique here, so one another workspace holds is refused",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref, name] = ctx.args;
      if (ref === undefined || name === undefined || ctx.args.length !== 2) throw usageRefusal("wsp rename takes a workspace and one name.", usageIs(ctx));
      const renamed = await renameWorkspace(await ctx.client(), ref, name);
      ctx.out.emit(renamed, renamedWorkspaceLine(renamed));
      return 0;
    },
    tool: tool({
      description:
        "Names the workspace on this computer, the name the sidebar and every listing show and the one workspace takes. A name is unique here, since that is how a workspace is addressed, so a name another workspace holds and a blank one are refused in one line and nothing is renamed. Threads on the machine are addressed by id and run on through it, and the machine at the provider keeps the metadata name it was forked under until it is next forked or rebuilt.",
      input: { workspace: WorkspaceIn, name: z.string() },
      output: { was: z.string(), workspace: WorkspaceOut },
      call: async ({ workspace: ref, name }, deps) => {
        const renamed = await renameWorkspace(await deps.client(), ref, name);
        return asText(renamedWorkspaceLine(renamed), { ...renamed });
      },
    }),
  },
  {
    name: "snapshot",
    usage: "wsp snapshot <workspace>",
    about: "a project image of the workspace: your image plus the project as it is now, ready to fork",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp snapshot takes one workspace.", usageIs(ctx));
      const projectGolden = await snapshot(await ctx.client(), ref);
      ctx.out.emit({ projectGolden }, projectGoldenLine(projectGolden));
      return 0;
    },
    tool: tool({
      description: "A project image of the workspace: its image version plus the project loaded on it as its disk stands now, synced first so a file written just before is whole on the image, ready for new with from. Only a running machine with a project imported, on a provider that copies a machine's disk, can be snapshotted, and which life the copy may come from is that provider's rule: a machine that was never resumed on the cloud, any life on a container fork. Anything else, and a disk whose sync fails, is refused in one line and nothing is taken.",
      input: { workspace: WorkspaceIn },
      output: { projectGolden: ProjectGolden },
      call: async ({ workspace: ref }, deps) => asJson({ projectGolden: await snapshot(await deps.client(), ref) }),
    }),
  },
  {
    name: "fork",
    usage: 'wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>] [--send "<task>" [run\'s flags]]',
    about: "a new machine from the source's image version, not a copy of its live disk; --size as new's",
    page: "agent",
    options: { name: { type: "string" }, size: { type: "string" }, send: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS, cwd: { type: "string" }, notify: { type: "string", multiple: true }, spawn: { type: "string" }, "max-machines": { type: "string" }, "max-depth": { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp fork takes one workspace.", usageIs(ctx));
      const task = flag(ctx.flags, "send");
      for (const dependent of ["agent", ...PICK_FLAGS, "cwd", "notify"]) if (task === undefined && flag(ctx.flags, dependent) !== undefined) throw usageRefusal(`--${dependent} says how a thread opens, and this line opens none.`, `Add --send "<task>", or drop --${dependent}.`);
      const client = await ctx.client();
      const source = await workspaceOf(client, ref);
      if (workspaceState({ phase: source.phase }) === "gone") throw new Error(goneRefusal("fork", source.gone));
      // Resolved and checked before the machine is minted, so a bad reference or pick costs nothing. The picks are
      // checked against the source's machine, since the fork's own comes from the golden that machine runs.
      const notify = await notifyOf(client, flagList(ctx.flags, "notify"));
      const harness = flag(ctx.flags, "agent");
      const picks = pickFlags(ctx.flags);
      if (task !== undefined) await checkedStart(client, task, harness, picks, source.id);
      const asked = agentsAsked(flag(ctx.flags, "spawn"), flag(ctx.flags, "max-machines"), flag(ctx.flags, "max-depth"));
      const created = await createFor(client, ctx.out, await projectOf(client, source.project.id), flag(ctx.flags, "name") ?? `${source.name}-fork`, { parent: source.id, ...(flag(ctx.flags, "size") !== undefined ? { size: flag(ctx.flags, "size")! } : {}), ...(asked !== undefined ? { agents: asked } : {}) });
      if (task === undefined) return 0;
      ctx.out.emit({ turn: turnView(await followVerb(ctx, client, openingOf(ctx.env, created.workspace, task, { harness, ...picks, cwd: flag(ctx.flags, "cwd"), notify, elsewhere: ctx.elsewhere }), true, {}, { spend: turnSpendWord(created.workspace) })) });
      return 0;
    },
    tool: tool({
      description: "A sibling workspace from the source's image version (a new machine, not a copy of its live disk); with a task, its first thread is opened and the reply returned. When that first turn fails, the error still names the workspace, which exists: continue with run on it rather than forking again.",
      input: { workspace: WorkspaceIn, name: z.string().optional().describe("defaults to <source>-fork"), size: SizeIn, task: z.string().optional(), agent: AgentIn, ...PICK_INPUTS, cwd: CwdIn, notify: NotifyIn, spawn: SpawnIn, max_machines: MaxMachinesIn, max_depth: MaxDepthIn },
      output: Created.extend({ turn: TurnOut.optional(), failure: z.string().optional() }).shape,
      stream: ["workspace", "notice"],
      call: async ({ workspace: ref, name, size: word, task, agent: harness, cwd: folder, notify: tell, spawn, max_machines: maxMachines, max_depth: maxDepth, ...input }, deps) => {
        absoluteFolder(folder);
        const client = await deps.client();
        const source = await workspaceOf(client, ref);
        if (task !== undefined) await checkedStart(client, task, harness, input, source.id);
        const asked = agentsAsked(spawn, maxMachines, maxDepth);
        const created = await createFor(client, QUIET, await projectOf(client, source.project.id), name ?? `${source.name}-fork`, { parent: source.id, ...(word !== undefined ? { size: word } : {}), ...(asked !== undefined ? { agents: asked } : {}) });
        if (task === undefined) return asJson(created);
        let failure: string;
        try {
          const turn = await follow(client, openingOf(deps.env, created.workspace, task, { harness, ...input, cwd: folder, notify: await notifyOf(client, tell ?? []), elsewhere: deps.elsewhere }), "agent", QUIET_TURN);
          const ended = turnFailure(turn);
          if (ended === undefined) return asJson({ ...created, turn: turnView(turn) });
          failure = ended;
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
        // The machine was minted before the turn failed; an error that hid it would have the agent fork a second one.
        return { ...asText(`created ${created.workspace.name} ${created.workspace.id}; first turn failed: ${failure}`, { ...created, failure }), isError: true };
      },
    }),
  },
  {
    name: "bring back",
    usage: 'wsp bring back <workspace> [--title "<title>"] [--body "<body>"]',
    about: "pushes the workspace's branch and opens its pull request; the branch the work started from is refused",
    page: "agent",
    options: { title: { type: "string" }, body: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp bring back takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const { workspace: awoken } = await awake(client, workspace, "bring back", line => ctx.io.error(line));
      const back = await broughtBack(client, awoken.id, flag(ctx.flags, "title"), flag(ctx.flags, "body"));
      ctx.out.emit({ ...back }, broughtBackLine(awoken.name, back));
      // The push is reported either way; the exit is the pull request half's, which refused where this is set.
      return back.refused === undefined ? 0 : 1;
    },
    tool: tool({
      description:
        "Pushes the branch the workspace's copy is on to the project's remote and opens its pull request against the base, or answers with the one already open. The base is the branch its parent was on at the fork for a workspace forked out of another, whatever that parent does after, and the project's own base otherwise. Refused in one line on the base branch itself, since work leaves a workspace as a branch of its own, and on a branch with nothing the base lacks. The two halves are answered apart: the branch, the count over the base and the diffstat are there whenever the push landed, then either the pull request, the note saying why it waits where the machine has no signed-in command line for the git host, or the pull request half's own refusal.",
      input: {
        workspace: WorkspaceIn,
        title: z.string().optional().describe("the pull request's title; without one the host fills the title and the body from the commits"),
        body: z.string().optional().describe("the pull request's body, which needs a title beside it"),
      },
      output: BringBackResult.shape,
      call: async ({ workspace: ref, title, body }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const { workspace: awoken } = await awake(client, workspace, "bring back", QUIET_LINE);
        const back = await broughtBack(client, awoken.id, title, body);
        const said = asText(broughtBackLine(awoken.name, back), { ...back });
        return back.refused === undefined ? said : { ...said, isError: true };
      },
    }),
  },
  {
    name: "pause",
    usage: "wsp pause <workspace>",
    about: "naps the workspace's machine",
    page: "front",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp pause takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await nap(client, ref);
      ctx.out.emit({ workspace }, stateLine(workspace, await pauseModeOf(client, workspace.project.id)));
      return 0;
    },
    tool: tool({
      description: "Naps the workspace's machine; it wakes on the next thread or command.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref }, deps) => asJson({ workspace: await nap(await deps.client(), ref) }),
    }),
  },
  {
    name: "wake",
    usage: "wsp wake <workspace>",
    about: "wakes the workspace's machine and prints the state the next wsp workspaces will show for it",
    page: "front",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp wake takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const { workspace } = await awake(client, await workspaceOf(client, ref), "wake", line => ctx.io.error(line));
      ctx.out.emit({ workspace }, await wokeLine(client, workspace));
      return 0;
    },
    tool: tool({
      description: "Wakes the workspace's machine and returns its view once the runtime has answered; one already running comes back unchanged. run, send and exec do this themselves, so it is only needed to wake a machine ahead of them.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        return asJson({ workspace: (await awake(client, await workspaceOf(client, ref), "wake", QUIET_LINE)).workspace });
      },
    }),
  },
  {
    name: "rebuild",
    usage: "wsp rebuild <workspace>",
    about: "replaces a gone workspace's machine from its image and prints the state of the new one",
    page: "app",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp rebuild takes one workspace.", usageIs(ctx));
      const workspace = await rebuild(await ctx.client(), ref);
      ctx.out.emit({ workspace }, rebuiltLine(workspace));
      return 0;
    },
    tool: tool({
      description:
        "Replaces the machine of a workspace the provider no longer has, forking it afresh from the image the workspace was made on and importing the vault its last nap left; the workspace keeps its id, its name and its threads, and the new machine's id and state come back once the runtime has them. Anything written on the old machine's disk since that nap is not there. This is the road out of the refusal every other verb gives a gone workspace, and it is refused in one line on a machine that still answers.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref }, deps) => {
        const workspace = await rebuild(await deps.client(), ref);
        return asText(rebuiltLine(workspace), { workspace });
      },
    }),
  },
  {
    name: "image",
    usage: "wsp image",
    about: "the image this host owns: its version, its hash, whether it holds your sign-ins, and the copy each place has built of it",
    page: "agent",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp image takes no positional arguments.", usageIs(ctx));
      const view = await imageView(await ctx.client());
      ctx.out.emit(view, imageLines(view).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The image this host owns and the copy each place has built of it. The record is the recipe the seal was planned from, the sign-ins it holds and a hash over both; a copy built at that hash is current and any other is stale, whatever version the place's own manifest gave it. A record with no vault was read back off its own copy rather than written at a seal, so it judges none of them and every copy of it asks for the sign-ins again: cutting the next version holds them. The project images taken off workspaces are listed under it, each with its snapshot id, the workspace it was taken off, its size where the provider lists one and its date.",
      input: {},
      output: { image: SealedImage.nullable(), copies: z.array(SealedImageCopy), projects: z.array(SealedProjectImage) },
      call: async (_args, deps) => {
        const view = await imageView(await deps.client());
        return asText(imageLines(view).join("\n"), view);
      },
    }),
  },
  {
    name: "image build",
    usage: "wsp image build <place> [--force]",
    about: "builds this host's image at a place from the record, its sign-ins coming from the vault and no sign-in run again",
    page: "agent",
    options: { force: { type: "boolean" } },
    run: async ctx => {
      const [place] = ctx.args;
      if (place === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image build takes one place.", usageIs(ctx));
      const { image, built } = await buildImageAt(await ctx.client(), ctx.out, place, ctx.flags["force"] === true);
      ctx.out.emit(built, sealedBuiltLine(image, built));
      return 0;
    },
    tool: tool({
      description:
        "Builds this host's image at a place from the record alone: a builder is forked there with the recipe the image was sealed from and every sign-in set to skip, the sign-ins the seal held are landed on it out of the vault, and the copy is sealed and recorded under that place at the record's hash. Nothing signs in again and no Keychain is read. A place that already holds a copy built from this record is answered with that copy and `built` false, so asking twice costs nothing; a place whose copy is building is answered with that build, never a second one. A joined computer builds its copy at the end of its setup; every other copy, and every copy a newer version left behind, is built only when this line asks or when a fork there finds no current copy, and that fork says so before the build starts, since a build bills where it runs. Refused in one line for a place this host does not hold, for a place that takes no copy at all, and for a record sealed without the recipe it was built from. A record holding no sign-ins is refused too, since every copy of it would ask for them again; `force` builds it anyway.",
      input: { place: z.string().describe("the place to build the copy at, by the name wsp places lists"), force: z.boolean().optional().describe("build even where the record holds no sign-ins, so the copy asks for every one of them again") },
      output: { copy: SealedImageCopy, built: z.boolean() },
      call: async ({ place, force }, deps) => {
        const { image, built } = await buildImageAt(await deps.client(), QUIET, place, force);
        return asText(sealedBuiltLine(image, built), built);
      },
    }),
  },
  {
    name: "image export",
    usage: "wsp image export <file>",
    about: "writes the image record and your sign-ins to one encrypted file, sealed to a passphrase you type",
    page: "agent",
    options: {},
    cliOnly: "the vault leaves the host only at a person's hand, with a passphrase they type",
    hostSide: HOST_SIDE_VAULT,
    run: async ctx => {
      const [dest] = ctx.args;
      if (dest === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image export takes one file on this computer.", usageIs(ctx));
      const passphrase = await imagePassphrase(ctx);
      const { exported } = await (await ctx.client()).request<{ exported: SealedImageExport }>("image.export", { dest: resolve(dest), passphrase });
      ctx.out.emit({ exported }, sealedExportLine(exported));
      return 0;
    },
  },
  {
    name: "image move",
    usage: "wsp image move <workspace>",
    about: "moves the workspace onto the newest version of its image and prints what of the image's own files it kept",
    page: "app",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image move takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const source = await workspaceOf(client, ref);
      ctx.io.error(IMAGE_MOVE_CONFIRM);
      const moved = await moveImage(client, source.id);
      ctx.out.emit(moved, imageMovedLine(moved));
      return 0;
    },
    tool: tool({
      description:
        "Moves the workspace onto the newest version of the image it was forked from: a fresh machine of that image replaces the old one and the workspace's home folder comes across, less the files the image itself wrote and nobody changed here, whose newer copies come with the image. `kept` names the files of the image's own this workspace had changed, which travelled instead. An archive carries no deletion, so a file taken out of a folder the image writes into comes back with the new image. Anything installed outside the home folder comes from the new image, and everything running on the old machine stops with it. Refused in one line on a workspace that is not running, one forked from a project image, and one whose image this host no longer holds; one already on the newest version comes back untouched and says so.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut, moved: z.boolean(), kept: z.array(z.string()), fallback: z.boolean().optional() },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        const source = await workspaceOf(client, ref);
        const moved = await moveImage(client, source.id);
        return asText(imageMovedLine(moved), moved);
      },
    }),
  },
  {
    name: "image remove",
    usage: "wsp image remove <snapshot id> [--yes]",
    about: "deletes a project image's snapshot at the provider and drops its record; refused while a workspace stands on it",
    page: "app",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [id] = ctx.args;
      if (id === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image remove takes one project image, by the id wsp image lists it under.", usageIs(ctx));
      const client = await ctx.client();
      const golden = await projectImageOf(client, id);
      if (!(await confirmed(ctx, imageRemoveQuestion(golden), id))) return 1;
      const removed = await removeProjectImage(client, id);
      ctx.out.emit(removed, projectImageRemovedLine(id, removed.alreadyGone));
      return 0;
    },
    tool: tool({
      description:
        "Deletes a project image's snapshot at the provider its place names and then drops its record, so no later fork starts from it; the id is the one the image tool lists each project image under, never a project's name. The provider's listing is read back until the id has left it: a snapshot the provider had already lost drops its record and answers `alreadyGone` true, a listing that still holds the id after the wait keeps the record and says to ask again, and any other refusal of the provider's keeps the record and carries the provider's own words. Refused in one line while any workspace stands on the image, whatever its state, naming them: delete those first, or forget one whose machine is gone. Called without confirm it removes nothing and answers with what would go, which is the line to put to the person.",
      input: {
        image: z.string().describe("the project image's snapshot id, as the image tool lists it"),
        confirm: z.boolean().optional().describe("true deletes the snapshot; absent or false answers with what would go and deletes nothing, so a person can be asked first"),
      },
      output: ProjectGoldenRemoved.shape,
      call: async ({ image: id, confirm }, deps) => {
        const client = await deps.client();
        const golden = await projectImageOf(client, id);
        if (confirm !== true) {
          return { ...asText(`${id} kept. ${projectImageRemoveNotice(golden)} Ask the person, then call image_remove again with confirm true.`, { projectGolden: golden, alreadyGone: false }), isError: true };
        }
        const removed = await removeProjectImage(client, id);
        return asText(projectImageRemovedLine(id, removed.alreadyGone), removed);
      },
    }),
  },
  {
    name: "forget",
    usage: "wsp forget <workspace> [--yes]",
    about: "drops a gone workspace and its threads from this computer; refused while its machine exists",
    page: "agent",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp forget takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const f = await dropping(client, ref);
      if (!(await confirmed(ctx, forgetQuestion(f), f.workspace.name))) return 1;
      await forget(client, f);
      ctx.out.emit({ workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads }, forgotLine(f));
      return 0;
    },
    tool: tool({
      description:
        "Drops a workspace whose machine the provider no longer has: its record and its threads leave this computer and the person's sidebar. The provider is read until twelve reads in a row agree the machine is gone, and nothing is asked of the machine. Refused in one line while the machine still exists (pause it, or delete it at the provider, first).",
      input: { workspace: WorkspaceIn },
      output: { workspaceId: z.string(), name: z.string(), threads: z.number().int() },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        const f = await dropping(client, ref);
        await forget(client, f);
        return asText(forgotLine(f), { workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads });
      },
    }),
  },
  {
    name: "delete",
    usage: "wsp delete <workspace> [--yes]",
    about: "deletes the machine at the provider, then drops the record and threads from this computer",
    page: "front",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp delete takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const d = await dropping(client, ref);
      if (!(await confirmed(ctx, deleteQuestion(d), d.workspace.name))) return 1;
      await deleteWorkspace(client, d);
      ctx.out.emit({ workspaceId: d.workspace.id, name: d.workspace.name, machineId: d.workspace.machineId, threads: d.threads }, deletedLine(d));
      return 0;
    },
    tool: tool({
      description:
        "Deletes the workspace's machine at the provider and drops its record and its threads from this computer and the person's sidebar. Everything on that machine's disk that was not exported or pushed goes with it and no wake brings it back; a workspace whose machine is already gone takes forget instead. Called without confirm it deletes nothing and answers with what would go, which is the line to put to the person.",
      input: { workspace: WorkspaceIn, confirm: ConfirmIn },
      output: { workspaceId: z.string(), name: z.string(), machineId: z.string(), threads: z.number().int() },
      call: async ({ workspace: ref, confirm }, deps) => {
        const client = await deps.client();
        const d = await dropping(client, ref);
        const going = { workspaceId: d.workspace.id, name: d.workspace.name, machineId: d.workspace.machineId, threads: d.threads };
        // The command line asks a person before this and the app will; over MCP the second call is that step, so a
        // machine is never killed by one tool call the caller made on its own.
        if (confirm !== true) {
          return { ...asText(`${d.workspace.name} kept. ${deleteNotice(d.threads, workspaceKind(d.workspace), d.workspace.copy)} Ask the person, then call delete again with confirm true.`, going), isError: true };
        }
        await deleteWorkspace(client, d);
        return asText(deletedLine(d), going);
      },
    }),
  },
  {
    name: "run",
    usage: 'wsp run [<workspace>] [--agent <id>] [--model, --effort, --access <word>] [--cwd <path>] [--notify <thread|me>] [--title <title>] [--image <path>] [--detach] "<task>"',
    about: "an agent works in the workspace and you read its reply: a thread with the agent, model, effort and access the app offers, in the workspace's project; with no workspace, run from inside one of your project folders, on that project's workspace; follows its first turn, or with --detach prints the id and returns",
    page: "front",
    options: { agent: { type: "string" }, ...PICK_OPTIONS, cwd: { type: "string" }, notify: { type: "string", multiple: true }, title: { type: "string" }, image: { type: "string", multiple: true }, detach: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length === 0) throw usageRefusal("wsp run takes a task and got none.", 'Put the task in quotes: wsp run <workspace> "say hi".');
      if (ctx.args.length > 2) throw usageRefusal(`wsp run takes a workspace and a task; ${ctx.args[2]!} reads as a third word.`, usageIs(ctx));
      const client = await ctx.client();
      const [ref, task] = await workspaceFirst(client, "run", ctx.args, "the task");
      const target = await threadTarget(client, ref, ctx.cwd, "<workspace>", ctx.elsewhere);
      const found = target.workspace;
      const harness = flag(ctx.flags, "agent");
      const picks = pickFlags(ctx.flags);
      await checkedStart(client, task, harness, picks, found.id);
      const cwd = flag(ctx.flags, "cwd");
      const opened = openedLine(target, found, cwd);
      const woken = await awake(client, found, "send", line => ctx.io.error(line));
      const opening = openingOf(ctx.env, woken.workspace, task, { harness, ...picks, cwd, notify: await notifyOf(client, flagList(ctx.flags, "notify")), title: flag(ctx.flags, "title"), images: flagList(ctx.flags, "image"), elsewhere: ctx.elsewhere });
      let started: Turn | undefined;
      try {
        if (ctx.flags["detach"] === true) await detachVerb(ctx, client, opening, {}, opened);
        else ctx.out.emit(turnView(await followVerb(ctx, client, opening, true, {}, { opened, spend: turnSpendWord(woken.workspace) }, t => (started = t))));
      } catch (e) {
        throw withLine(e, await napAfterDeadLaunch(client, woken, started));
      }
      return 0;
    },
    tool: tool({
      description: `Opens a thread in the workspace under the named agent, on the model, effort and access mode named or the catalog's defaults (a cheaper model for a review, say), in the folder cwd names, else the workspace's own project, and follows its first turn; returns the reply text as soon as it is complete, with the thread id for send. With detach true it returns the thread id the moment the turn is started, without the reply: the road for a turn that runs for minutes or an hour. ${TURN_END_WORDS}. With notify, each turn of the thread sends one line (outcome, duration, cost, and the reply whole into a thread or its last line to the person) to every target named, so a caller need not wait here or poll. ${NOTIFY_WORDS}. ${NOTIFY_CALLER}.`,
      input: { workspace: ThreadWorkspaceIn, task: z.string(), agent: AgentIn, ...PICK_INPUTS, cwd: CwdIn, notify: NotifyIn, title: TitleIn, images: ImagesIn, detach: DetachIn },
      output: TurnOut.shape,
      call: async ({ workspace: ref, task, agent: harness, cwd: folder, notify: tell, title, images, detach, ...input }, deps) => {
        const client = await deps.client();
        const target = await threadTarget(client, ref, deps.cwd, "workspace", deps.elsewhere);
        const found = target.workspace;
        await checkedStart(client, task, harness, input, found.id);
        const opened = openedLine(target, found, folder);
        const woken = await awake(client, found, "send", QUIET_LINE);
        const opening = openingOf(deps.env, woken.workspace, task, { harness, ...input, cwd: folder, notify: await notifyOf(client, tell ?? []), title, images, elsewhere: deps.elsewhere });
        let started: Turn | undefined;
        try {
          if (detach === true) return detachedOut(await startDetached(client, opening, "agent"), opened);
          const out = turnOut(await follow(client, opening, "agent", { ...QUIET_TURN, started: t => (started = t) }));
          return asText(opened === undefined ? turnText(out) : `${opened(out.threadId)}\n${turnText(out)}`, out);
        } catch (e) {
          throw withLine(e, await napAfterDeadLaunch(client, woken, started));
        }
      },
    }),
  },
  {
    name: "thread read",
    usage: "wsp thread read <thread> [--last]",
    about:
      "the thread's messages as the app lists them, oldest first: who each one is, when the runtime recorded it and the text, with every tool call folded to the one line the app's row reads; --last prints the final reply alone, the whole message its finished line carries. A tool's output and the agent's reasoning are no rows of it",
    page: "agent",
    options: { last: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp thread read takes one thread.", usageIs(ctx));
      const last = ctx.flags["last"] === true;
      const client = await ctx.client();
      const read = await readThread(client, await threadOf(client, ref), last);
      ctx.out.emit(read, readLine(read, last));
      return 0;
    },
    tool: tool({
      description:
        "The thread's messages as the app lists them, oldest first: each one's who (person for the message that opened or steered a turn, agent for the agent's own words, tool for one call of its folded to a line, turn for the outcome, duration and cost the turn ended with), at, the ms epoch the runtime recorded it, and its text. With last true, the final reply alone, the whole message the thread's finished line carries, and a row under it saying so when the thread has started another turn since, so a report is never read as the one being written. This is how you read a thread you did not open, and how you read the report behind a line that reached you; the transcript is the host's, so nothing on a machine is touched and a paused workspace reads the same as a running one. A thread of many turns answers with all of them, so read one with last true when the report is what you are after. A call's output and the agent's reasoning are no rows of it. A thread whose rows the transcript's cap has dropped answers with none, which is an answer and not an error.",
      input: {
        thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them"),
        last: z.boolean().optional().describe("true answers with the final reply alone, the whole message the thread's finished line carries, with a row under it where the thread has started another turn since; absent answers with every message"),
      },
      output: { threadId: z.string(), messages: z.array(ThreadMessage) },
      call: async ({ thread: ref, last }, deps) => {
        const client = await deps.client();
        const read = await readThread(client, await threadOf(client, ref), last === true);
        return asText(readLine(read, last === true), read);
      },
    }),
  },
  {
    name: "thread rename",
    usage: 'wsp thread rename <thread> "<title>"',
    about: "names the thread inside the agent's own store, so the agent shows the same name",
    page: "app",
    options: {},
    run: async ctx => {
      const [ref, title] = ctx.args;
      if (ref === undefined || title === undefined || ctx.args.length !== 2) throw usageRefusal("wsp thread rename takes a thread and one name.", usageIs(ctx));
      const client = await ctx.client();
      const thread = await threadOf(client, ref);
      await awake(client, await workspaceOf(client, thread.workspaceId), "rename", line => ctx.io.error(line));
      const renamed = await rename(client, thread, title);
      ctx.out.emit(renamed, renameLine(renamed));
      return 0;
    },
    tool: tool({
      description:
        "Names the thread (by id, or a prefix of it) in the agent's own store on the machine, the field the agent writes when a person renames the session inside it, so the thread reads by that name in wsp and in the agent. outcome renamed means the store took it; unsupported means the thread's agent keeps no name of a person's, which is an answer, not an error; no-session means the agent's store on the machine has no such session; failed means the store refused the write and error carries the machine's own line for it. Whether an agent keeps a name is on its row in harnesses.list, from the adapter on the machine.",
      input: { thread: z.string(), title: z.string() },
      output: { threadId: z.string(), title: z.string(), harness: z.string(), outcome: SessionRenameOutcome, error: z.string().optional() },
      call: async ({ thread: ref, title }, deps) => {
        const client = await deps.client();
        const thread = await threadOf(client, ref);
        await awake(client, await workspaceOf(client, thread.workspaceId), "rename", QUIET_LINE);
        const renamed = await rename(client, thread, title);
        return asText(renameLine(renamed), { ...renamed });
      },
    }),
  },
  {
    name: "thread forget",
    usage: "wsp thread forget <thread>",
    about: "drops a thread no turn ever ran on, the row a launch that never got going leaves behind; refused once a turn of it did work",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp thread forget takes one thread.", usageIs(ctx));
      const client = await ctx.client();
      const thread = await threadOf(client, ref);
      await forgetThread(client, thread);
      ctx.out.emit({ threadId: thread.id, workspaceId: thread.workspaceId }, threadForgotLine(thread));
      return 0;
    },
    tool: tool({
      description:
        "Drops a thread (by id, or a prefix of it) no turn ever ran on: the row a launch that never got going leaves in threads and in the person's sidebar goes, and nothing is asked of the machine. A launch the agent refused outright, for want of a sign-in, counts as one that ran nothing and goes the same way. Refused in one line once a turn of the thread did work, since that work is written down on it and nowhere else; a whole workspace's threads go with forget or delete on the workspace.",
      input: { thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them") },
      output: { threadId: z.string(), workspaceId: z.string() },
      call: async ({ thread: ref }, deps) => {
        const client = await deps.client();
        const thread = await threadOf(client, ref);
        await forgetThread(client, thread);
        return asText(threadForgotLine(thread), { threadId: thread.id, workspaceId: thread.workspaceId });
      },
    }),
  },
  ...ANSWER_VERBS,
  {
    name: "send",
    usage: 'wsp send <thread> [--model, --effort <value>] [--image <path>] [--detach] "<message>"',
    about: "a message to the thread, on a named model or effort, with images; the thread keeps its own access and a running turn its own picks; --detach prints the id and returns",
    page: "front",
    options: { ...SEND_OPTIONS, image: { type: "string", multiple: true }, detach: { type: "boolean" } },
    run: async ctx => {
      const [ref, message] = ctx.args;
      if (ref === undefined || message === undefined || ctx.args.length !== 2) throw usageRefusal("wsp send takes a thread and one message.", usageIs(ctx));
      const client = await ctx.client();
      const picks = pickFlags(ctx.flags);
      const thread = await threadOf(client, ref);
      await checkedStart(client, message, thread.harness, picks, thread.workspaceId);
      const { workspace } = await awake(client, await workspaceOf(client, thread.workspaceId), "send", line => ctx.io.error(line));
      const images = flagList(ctx.flags, "image");
      if (ctx.flags["detach"] === true) await detachVerb(ctx, client, messageTo(thread, message, picks, images, ctx.elsewhere), picks);
      else ctx.out.emit(turnView(await followVerb(ctx, client, messageTo(thread, message, picks, images, ctx.elsewhere), false, picks, { spend: turnSpendWord(workspace) })));
      return 0;
    },
    tool: tool({
      description: `Sends a message to an existing thread (by id, or a prefix of it) and returns the reply when it is complete; a person's message on the same thread lands in order with yours. With detach true it returns the thread id the moment the turn is started, without the reply, and the turn's end reaches whoever the thread's start named. A model or effort named here is the turn's; the thread runs on the agent and at the access its own turns ran at, which a message does not change; a turn that joins a running one keeps that one's. ${SEND_MEETS}`,
      input: { thread: z.string(), message: z.string(), ...SEND_INPUTS, images: ImagesIn, detach: DetachIn },
      output: TurnOut.shape,
      call: async ({ thread: ref, message, images, detach, ...input }, deps) => {
        const client = await deps.client();
        const thread = await threadOf(client, ref);
        await checkedStart(client, message, thread.harness, input, thread.workspaceId);
        await awake(client, await workspaceOf(client, thread.workspaceId), "send", QUIET_LINE);
        if (detach === true) return detachedOut(await startDetached(client, messageTo(thread, message, input, images, deps.elsewhere), "agent"));
        const out = turnOut(await follow(client, messageTo(thread, message, input, images, deps.elsewhere), "agent", QUIET_TURN));
        return asText(turnText(out), out);
      },
    }),
  },
  {
    name: "stop",
    usage: "wsp stop <thread>",
    about: "stops the thread's running turn, as the app's stop does; the machine stays up",
    page: "front",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp stop takes one thread.", usageIs(ctx));
      const stopped = await stop(await ctx.client(), ref);
      ctx.out.emit(stopped, stopLine(stopped));
      return 0;
    },
    tool: tool({
      description: "Stops the thread's running turn (by id, or a prefix of it), as the app's stop button does; the machine stays up and the thread takes the next send. outcome accepted means the turn ended interrupted; not-running means it had already ended, which is an answer, not an error. A thread whose agents spawned threads of their own stops as one: under names each of those that was running and was stopped with it.",
      input: { thread: z.string() },
      output: { threadId: z.string(), outcome: SessionInterruptOutcome, under: z.array(z.string()).optional() },
      call: async ({ thread: ref }, deps) => {
        const stopped = await stop(await deps.client(), ref);
        return asText(stopLine(stopped), { ...stopped });
      },
    }),
  },
  {
    name: "exec",
    usage: "wsp exec <workspace> [--cwd <dir>] -- <command...>",
    about: "runs the command on the machine, each word as given, in --cwd or the folder a thread would start in",
    page: "agent",
    options: { cwd: { type: "string" } },
    run: async ctx => {
      const [ref, ...words] = ctx.args;
      if (ref === undefined || words.length === 0) throw usageRefusal("wsp exec takes a workspace, then -- and the command.", usageIs(ctx));
      const client = await ctx.client();
      const { workspace } = await awake(client, await workspaceOf(client, ref), "exec", line => ctx.io.error(line));
      const folder = absoluteFolder(flag(ctx.flags, "cwd"));
      const { exit, ranIn } = await execOn(client, workspace.id, words, folder, e => {
        if (e.type === "exec.output") ctx.out.emit(e, e.text);
      });
      if (exit.error !== undefined) throw new Error(exit.error);
      ctx.out.emit({ exitCode: exit.exitCode, ...(ranIn !== undefined ? { cwd: ranIn } : {}) });
      if (exit.exitCode !== null && exit.exitCode !== 0) ctx.io.error(execFolderLine(ranIn));
      return exit.exitCode ?? EXIT_CODES.provider;
    },
    tool: tool({
      description: "Runs a command on the workspace's machine as argv (each word as given; use sh -c for a shell line), in the folder cwd names or the one a thread would start in (the workspace's last used or only project, else its own folder), and returns its output lines, exit code and the folder it ran in. A non-zero exit is a result; the machine going away is an error.",
      input: { workspace: WorkspaceIn, argv: Argv, cwd: CwdIn },
      output: { exitCode: z.number().int().nullable(), output: z.array(z.string()), cwd: z.string().optional().describe("the folder the command ran in, as the host resolved it; absent only on a machine whose kind names no folder, where its own home is where the command ran") },
      stream: ["output"],
      call: async ({ workspace: ref, argv, cwd: folder }, deps) => {
        const asked = absoluteFolder(folder);
        const client = await deps.client();
        const { workspace: target } = await awake(client, await workspaceOf(client, ref), "exec", QUIET_LINE);
        const output: string[] = [];
        const { exit, ranIn } = await execOn(client, target.id, argv, asked, e => {
          if (e.type === "exec.output") output.push(e.text);
        });
        if (exit.error !== undefined) throw new Error(exit.error);
        return asText(output.join("\n"), { exitCode: exit.exitCode, output, ...(ranIn !== undefined ? { cwd: ranIn } : {}) });
      },
    }),
  },
  {
    name: "folders",
    usage: "wsp folders [<folder>] [--hidden] [--repos] [--on <computer>]",
    about: "the folders inside one folder on this computer or on a box you added with --on, or with --repos every git repo under the home folder, most recently used first, for naming one to record",
    page: "app",
    options: { hidden: { type: "boolean" }, repos: { type: "boolean" }, on: { type: "string" } },
    run: async ctx => {
      const [folder] = ctx.args;
      if (ctx.args.length > 1) throw usageRefusal("wsp folders takes one folder on this computer at most.", usageIs(ctx));
      const on = typeof ctx.flags["on"] === "string" ? ctx.flags["on"] : undefined;
      const listing = await hostFolders(await ctx.client(), { folder, hidden: ctx.flags["hidden"] === true, repos: ctx.flags["repos"] === true, on }, f => resolve(f));
      ctx.out.emit(listing, folderLines(listing).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The folders directly inside one folder on the person's own computer, or on a box they added, one level at a time, as the app's import dialog browses them: each folder's absolute path, whether git tracks it, and how many hidden ones the level holds. Browse this to name a folder for import instead of guessing a path. The roots are that computer's home folder and the folder of every project on it; a path outside those is refused, and folder absent lists the home folder. A cloud account keeps no computer to browse and is refused. Folders only: no file is named and nothing is read.",
      input: {
        folder: z.string().optional().describe("the folder to list, absolute and inside the roots; absent lists the home folder"),
        hidden: z.boolean().optional().describe("true lists the hidden folders too, which are otherwise only counted"),
        repos: z.boolean().optional().describe("true answers every git repo under the home folder and the recorded projects instead of one level, each with its branch and when git last wrote to it, most recent first; folder is ignored"),
        on: z.string().optional().describe("the computer whose folders to list, by the name computers lists; absent is the computer the app runs on"),
      },
      output: HostFolderListing.shape,
      call: async ({ folder, hidden, repos, on }, deps) => {
        const listing = await hostFolders(await deps.client(), { folder, hidden, repos, on }, f => absolutePath("folder is a path on this computer", f));
        return asText(folderLines(listing).join("\n"), listing);
      },
    }),
  },
  {
    name: "setup",
    usage: "wsp setup",
    about: "the cloud setup on this host as the app's Set up cloud machines modal reads it: which keys are held (never their values), the agents here, what a machine costs, and the init job's phase, rows and progress when one runs or ran",
    page: "app",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp setup takes no positional arguments.", usageIs(ctx));
      const setup = await initSetup(await ctx.client());
      ctx.out.emit({ setup }, initSetupLines(setup).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The cloud setup on this host, as the app's Set up cloud machines modal reads it: which keys the host holds (their presence, never a value), the agents on this computer and whether each carries the wsp tools, what a machine costs, and the init job when one runs or ran: its road, phase, screens, rows and progress. The rows are the image's stages, each sign-in with the page the person opens on this computer and the code it asks for while it waits, then its state, and the first workspace once forked. Read it to tell the person where the build is and which sign-in waits for them; the build is started from the app's sidebar row, and wsp init --recipe from a shell is the same run.",
      input: {},
      output: { setup: InitSetup },
      call: async (_args, deps) => asJson({ setup: await initSetup(await deps.client()) }),
    }),
  },
  {
    name: "terminal config",
    readsHere: "the Ghostty config it reads is the person's own, in their home on this computer",
    usage: `wsp terminal config [--scheme ${TerminalScheme.options.join("|")}]`,
    about:
      "the Ghostty config on this computer as the app's terminal pane applies it, read from ~/.config/ghostty and Application Support with its includes and theme resolved: the font and its fallbacks, the size, the colors, the cursor, the padding, the background opacity, and the blur, which is read but not applied; --scheme picks the side of a light:...,dark:... theme",
    page: "app",
    options: { scheme: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp terminal config takes no positional arguments.", usageIs(ctx));
      const config = await readGhosttyConfig(nodeHost(), schemeFlag(flag(ctx.flags, "scheme")));
      ctx.out.emit(config, terminalConfigLines(config).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The person's Ghostty config on this computer as the app's terminal pane applies it: every config file Ghostty would load and the theme it names, read now, with only the keys the pane honours. files is empty when they have no Ghostty config, and each other key is absent when no file sets it, so the pane keeps its default there. backgroundBlur is read and not applied: the desktop window's own material is the blur, and a browser tab has none. Read this to say how their terminal looks or to check what a config change did; nothing is written.",
      input: { scheme: TerminalScheme.optional().describe("which side of a light:...,dark:... theme to resolve; dark when absent") },
      output: TerminalConfig.shape,
      call: async ({ scheme }, _deps) => {
        const config = await readGhosttyConfig(nodeHost(), scheme);
        return asText(terminalConfigLines(config).join("\n"), config);
      },
    }),
  },
  {
    name: "export",
    usage: "wsp export <workspace> <folder> [--from <path on the machine>] [--replace] [--agents <ids>]",
    about: "brings a project folder and the agent sessions keyed to it home from the machine",
    page: "agent",
    options: { from: { type: "string" }, replace: { type: "boolean" }, agents: { type: "string" } },
    run: async ctx => {
      const [ref, folder] = ctx.args;
      if (ref === undefined || folder === undefined || ctx.args.length !== 2) throw usageRefusal("wsp export takes a workspace and a folder on this computer.", usageIs(ctx));
      const dest = resolve(folder);
      const agents = agentsFlag(flag(ctx.flags, "agents"));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const req: ExportRequest = { source: flag(ctx.flags, "from") ?? dest, dest, ...(ctx.flags["replace"] === true ? { replace: true } : {}), ...(agents !== undefined ? { agents } : {}) };
      let done = "";
      try {
        const exported = await exportProject(client, workspace.id, req, e => {
          if (e.stage === "done") done = e.message;
          else if (e.stage !== "failed") ctx.out.stream(`${e.message}\n`);
        });
        ctx.out.emit(exported, done);
        return 0;
      } catch (e) {
        throw withReplaceHint(e);
      }
    },
    tool: tool({
      description:
        "Brings a project folder and the agent sessions keyed to it home from the workspace's machine to this computer: the folder lands at `folder` (absolute, must not exist unless replace), the sessions in the agents' homes here keyed to it. `from` is the folder's path on the machine, the same path as `folder` when absent. The result says per agent what moved, what landed as transcripts only, and how many indexed rollouts were skipped.",
      input: {
        workspace: WorkspaceIn,
        folder: z.string().describe("where the folder lands on this computer, absolute"),
        from: z.string().optional().describe("the folder's path on the machine; defaults to folder"),
        replace: z.boolean().optional().describe("remove what is at folder first; without it an existing folder is refused"),
        agents: z.array(z.string()).optional().describe("catalog ids of the agents whose sessions come home; absent means every agent with sessions for the folder"),
      },
      output: ProjectExportResult.shape,
      call: async ({ workspace: ref, folder, from, replace, agents }, deps) => {
        const client = await deps.client();
        const target = await workspaceOf(client, ref);
        const req: ExportRequest = { source: from ?? folder, dest: folder, ...(replace !== undefined ? { replace } : {}), ...(agents !== undefined ? { agents } : {}) };
        let done = "";
        const exported = await exportProject(client, target.id, req, e => {
          if (e.stage === "done") done = e.message;
        });
        return asText(done, exported);
      },
    }),
  },
];

/** The entries the command line answers, in the help's order. */
export const CLI_VERBS: readonly (CliVerb | CliOnlyVerb)[] = VERBS.filter((v): v is CliVerb | CliOnlyVerb => "run" in v);

/** The verb whose words open argv, the longest first, so `thread read` wins over a verb named `thread`. */
export function findVerb(argv: ReadonlyArray<string>): CliVerb | CliOnlyVerb | undefined {
  return [...CLI_VERBS].sort((a, b) => b.name.length - a.name.length).find(v => {
    const words = v.name.split(" ");
    return words.every((w, i) => argv[i] === w);
  });
}

/** Every line of help fits this many columns. */
export const HELP_WIDTH = 80;

/** What each flag a verb reads says in that verb's own help, one short line each: a reminder, not a lesson. A word
 * that means the same thing wherever it is read is keyed by the word alone; one that means two things is keyed by
 * the verb and the word, since a sentence covering both meanings is the paragraph this table was split out of. The
 * parity test holds every flag of every verb to a row here, so a flag added to a verb is documented or named.
 *
 * The tool inputs' own descriptions are not these: an agent reading a tool needs the whole rule before it calls,
 * and a person at a terminal needs the line that reminds them which word to type.
 *
 * The words after model, effort and access are examples a person reads before they type, not the list the run is
 * held to: the agent's own catalog is that, it is fetched per agent at the turn, and a line printed before any
 * agent is named cannot await it. A word outside the catalog is refused by the runtime naming the list it does
 * hold, which is where the truth is said. */
export const FLAG_WORDS: Readonly<Record<string, string>> = {
  agent: "which agent runs the thread, by its catalog id (claude, codex); the workspace's own default without it",
  agents: "the agents whose sessions for that folder travel with it, by catalog id, comma separated; every one that has them without it",
  "add-check": "<id>=<command> proving that added tool is on the machine; repeats",
  add: "<id>=<command> carrying a tool neither the catalog nor this computer has, installed by that command on the machine; repeats",
  access: "how far the agent may go without asking, by the agent's own word (plan, acceptEdits, bypassPermissions); without it, what a thread on that workspace starts at: every action without asking on this computer and on a machine wsp forked, asking about each one on a computer you own",
  cwd: "the folder on the machine to work in; the project's folder without it",
  detach: "print the thread's id and return, leaving the reply to the thread's finished line",
  effort: "how hard the agent thinks, by its own word (low, medium, high, xhigh, max); its default without it",
  engine: "give it the place's Docker or podman through a socket that sees its own containers alone",
  "recipe engine": "mark the recipe so every workspace from its image gets the place's Docker or podman; it stays in the file until you edit it out",
  "export from": "the folder on the machine to bring home; the project registered for the folder you named without it",
  force: "build again even where the place already holds this version",
  hidden: "list the folders whose names start with a dot too",
  "folders on": "the computer whose folders to list, by the name wsp computers shows; a box you added answers from its own disk, and this computer is listed without it",
  "agents on": AGENTS_ON_WORDS,
  "skills on": AGENTS_ON_WORDS,
  "skills show on": AGENTS_ON_WORDS,
  "skills add on": AGENTS_ON_WORDS,
  "skills remove on": AGENTS_ON_WORDS,
  "skills disable on": AGENTS_ON_WORDS,
  "skills enable on": AGENTS_ON_WORDS,
  "skills search limit": "how many skills to answer, from 1 to 50; 20 without it",
  "skills show project": "the project's skill of that name rather than the one that is not a project's: alone from a workspace, or the project's name with --on",
  "skills remove project": "the project's skill of that name rather than the one that is not a project's: alone from a workspace, or the project's name with --on",
  "skills add agent": "an agent to put the skill in, by its catalog id; repeats, and every agent whose folder is there without it",
  "skills add project": "put it in a project rather than the home: alone for the workspace's own, or the project's name with --on",
  "servers on": AGENTS_ON_WORDS,
  "servers tools on": AGENTS_ON_WORDS,
  "servers signin on": AGENTS_ON_WORDS,
  "servers signin agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers tools agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers tools refresh": "start the server again even where an answer from the last three minutes stands",
  "servers tools project": "the project on the computer --on names whose server it is, by name; a workspace finds its own project's servers",
  "servers add on": AGENTS_ON_WORDS,
  "servers add agent": "the agent whose config takes the server, by its catalog id",
  "servers add command": "the line the server runs, its program and arguments in one quoted value, split as a shell splits it and nothing expanded; or --url",
  "servers add env": "a variable the server is given, by its name, its value read off the same name in this terminal's environment; repeats",
  "servers add url": "the server's https address; or --command",
  "servers add header": "<name>=<VARIABLE>, a header sent to the address with its value read off that variable in this terminal's environment; repeats",
  "servers add project": "put it in a project's file rather than the agent's own: alone for the workspace's own project, or the project's name with --on",
  "servers remove on": AGENTS_ON_WORDS,
  "servers remove agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers remove scope": "user, home or project, as wsp servers shows it; user without it",
  "servers remove project": "the project scope: alone for the workspace's own project, or the project's name with --on",
  "servers disable on": AGENTS_ON_WORDS,
  "servers disable agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers disable scope": "user, home or project, as wsp servers shows it; user without it",
  "servers disable project": "the project scope: alone for the workspace's own project, or the project's name with --on",
  "servers enable on": AGENTS_ON_WORDS,
  "servers enable agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers enable scope": "user, home or project, as wsp servers shows it; user without it",
  "servers enable project": "the project scope: alone for the workspace's own project, or the project's name with --on",
  repos: "every git repo under the home folder instead of one level, most recently used first",
  image: "an image file on this computer to send with the message; repeats",
  last: "the final reply alone, the whole message the thread's finished line carries",
  "max-depth": "how many levels of threads may stand under the root thread; needs --spawn on, and defaults to 1",
  "max-machines": "how many machines may stand at once under one root thread; needs --spawn on, and defaults to 3",
  model: "the model the turn runs on, by the agent's own slug (claude-sonnet-5); the thread's own without it",
  name: "what to call the new workspace; <source>-fork without it",
  "new from": "a project image to start from, by its project's name or its snapshot id, as wsp snapshot returns them",
  notify: "where each turn's end is sent, a thread's id or me; repeats",
  out: "where the recipe file is written",
  "recipe project": "a folder on this computer to weigh the histories by; repeats",
  "recipe scan project": "a folder on this computer to weigh the histories by; repeats",
  replace: "overwrite what is already at the destination",
  scheme: `which side of a light:...,dark:... theme to read; ${TerminalScheme.options.join(" or ")}`,
  send: "a task for the new workspace's first thread, with run's own flags after it",
  set: "<id>=on|off flipping one row of the recipe by its id; repeats",
  signin: `<id>=${LOGIN_CHOICES.join("|")} answering one sign-in by catalog id; repeats`,
  size: "the machine size as <cpu>x<memGb>, like 2x4; a size the provider does not offer is refused naming the ones it does",
  spawn: "on lets the agents there open threads and fork machines of their own, capped; off is what a workspace made without it is",
  "threads wait tail": "print the reply's last line alone, the line a notify sends, rather than the whole reply",
  tick: `the rule that decides every tick: ${RECIPE_TICKS.join(", ")}`,
  timeout: "how long to wait before answering that they are still running",
  title: "what to call the thread; the agent names it from the task without one",
  "bring back title": "what to call the pull request; the host fills its title and its body from the commits without one",
  "bring back body": "the pull request's body, which needs a title beside it",
  tree: "indent the threads an agent opened under the one that opened them",
  watch: "draw the table again every second where it stands, until Ctrl-C; it needs a terminal to redraw on",
  yes: "go ahead without being asked",
};

/** The line one flag gets in one verb's own help: the verb's own row where the word means two things, else the
 * word's own. Nothing where no row carries it, which the parity test refuses. */
export const flagSays = (verb: string, name: string): string | undefined => FLAG_WORDS[`${verb} ${name}`] ?? FLAG_WORDS[name];

/** The verb's about behind the indent, wrapped to the help's width. */
const aboutLines = (verb: CliVerb | CliOnlyVerb, indent: string): string[] => wrap(`${indent}${verb.about}`, HELP_WIDTH, indent);

/** The usage wrapped at the gaps between its groups and never inside a bracket, so a flag stays on the line with its
 * value. `lead` is what the first line opens with, so a page that opens it with `usage: ` is wrapped to the columns
 * it will actually stand in rather than to two spaces and then widened by five. */
export function usageLines(usage: string, indent: string, lead = "  "): string[] {
  let depth = 0;
  const grouped = [...usage]
    .map(c => {
      if (c === "[") depth++;
      if (c === "]") depth--;
      return c === " " && depth > 0 ? "\u00a0" : c;
    })
    .join("");
  return wrap(`${lead}${grouped}`, HELP_WIDTH, indent).map(line => line.replaceAll("\u00a0", " "));
}

/** The lines of one page: each usage, then what it does indented under it, so no line runs wide. */
export function verbHelp(page?: Page): string {
  return CLI_VERBS.filter(v => page === undefined || v.page === page)
    .map(v => [...usageLines(v.usage, "    "), ...aboutLines(v, "      ")].join("\n"))
    .join("\n");
}

/** Every flag a verb reads beside the ones every verb takes, in the order the verb declares them. */
export const ownFlagsOf = (verb: CliVerb | CliOnlyVerb): string[] => Object.keys(verb.options).filter(name => !Object.hasOwn(COMMON, name));

/** What the flags every line takes say, wherever a page prints them. One home, so a verb's own help, a command's
 * own help and the agent page cannot word the same flag three ways, which they did. `hostSide` is what --host means
 * to a line that runs at its own host's terminal and dials nobody else. */
export const COMMON_FLAG_WORDS = {
  json: "print the raw protocol values, one JSON object per line, with everything else on stderr",
  state: "the state file the host serves",
  host: "run the line against a host on your account, by the name wsp hosts lists it under; WSP_HOST names one for a whole shell",
  hostSide: "read to say this line runs at its own host's terminal; it dials no other",
} as const;

/** One page of help: the usage wrapped as every page wraps it, what the line does, then a line per flag. The one
 * renderer, so a verb's page, a command's page and the tool server's own read alike. */
export function helpPage(usage: string, about: readonly string[], rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([word]) => word.length), 0) + 4;
  return [
    ...usageLines(usage, "       ", "usage: "),
    ...about,
    ...(rows.length === 0 ? [] : ["", ...rows.flatMap(([word, says]) => wrap(`  ${word.padEnd(width)}${says}`, HELP_WIDTH, " ".repeat(width + 2)))]),
  ].join("\n");
}

/** What one verb's own `--help` prints: its usage, what it does, its own flags one line each, then the three every
 * verb takes. A page that named ten flags on the usage line and then documented three of them left the person to
 * guess what the other seven took. */
export function verbPage(verb: CliVerb | CliOnlyVerb, host: string): string {
  return helpPage(verb.usage, aboutLines(verb, "  "), [
    ...ownFlagsOf(verb).map((name): [string, string] => [`--${name}`, flagSays(verb.name, name) ?? ""]),
    ["--json", COMMON_FLAG_WORDS.json],
    ["--state", COMMON_FLAG_WORDS.state],
    ["--host", host],
  ]);
}

/** The usage of every verb that opens with this word, for a command that stopped short of one; none when no verb does. */
export function verbUsage(word: string): string | undefined {
  const usages = CLI_VERBS.filter(v => v.name.split(" ")[0] === word).map(v => `usage: ${v.usage}`);
  return usages.length > 0 ? usages.join("\n") : undefined;
}

/** The refusal a verb's own parse leaves: the line naming the verbs that read a flag this one does not, or the
 * parser's own words behind the verb's usage. */
function parseRefusal(verb: CliVerb | CliOnlyVerb, e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const usage = `usage: ${verb.usage}`;
  const named = (e as { code?: unknown }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /^Unknown option '--([^']+)'/.exec(message)?.[1] : undefined;
  if (named === undefined) return usageRefusal(message, usage);
  const readers = CLI_VERBS.filter(v => v !== verb && Object.hasOwn(v.options, named)).map(v => `wsp ${v.name}`);
  return readers.length === 0 ? usageRefusal(message, usage) : usageRefusal(foreignFlagLine(`--${named}`, readers, `wsp ${verb.name}`), usage);
}

/** The one line a refusal or a failure leaves on stderr, the failure object under --json and the prose behind its
 * prefix otherwise, and the exit code the failure's class owns. The prefix is where the command's name is printed,
 * so a sentence that names itself is printed alone rather than behind a second copy of its own name. */
export function failed(io: CliIO, json: boolean, e: unknown, prefix = ""): number {
  const failure = verbFailure(e);
  io.error(json ? jsonLine(failure) : sayOnce(prefix, failure.error));
  return failure.exit;
}

/** A tool call's failure: the text the agent reads, and the object a --json run prints, marked as an error. A
 * refusal the host's own validator wrote reads here as it reads at a terminal, with the tool's own line under it:
 * an agent given the wire's issue list learns this host's every op and nothing about its call. */
export function toolFailure(e: unknown, usage?: string): CallToolResult {
  const failure = verbFailure(usage === undefined ? e : hostSchemaRefusal(e, usage) ?? e);
  return { content: [{ type: "text", text: failure.error }], structuredContent: failure, isError: true };
}

/** Whether a line asked for JSON, read off the words before any `--`, for the refusal of a line the parser would not read. */
export function jsonAsked(argv: ReadonlyArray<string>): boolean {
  const cut = argv.indexOf("--");
  return argv.slice(0, cut === -1 ? argv.length : cut).includes("--json");
}

export async function runVerb(verb: CliVerb | CliOnlyVerb, argv: ReadonlyArray<string>, io: CliIO, statePathOf: (flag?: string) => string, deps: Pick<VerbDeps, "alsoHere" | "cwd" | "env" | "start" | "signals" | "dial" | "elsewhere" | "terminal" | "open">): Promise<number> {
  let flags: Flags;
  let args: string[];
  try {
    const parsed = parseArgs({ args: optionalValues(argv.slice(verb.name.split(" ").length), verb.options), options: { ...COMMON, ...verb.options }, allowPositionals: true });
    flags = parsed.values as Flags;
    args = parsed.positionals;
    absoluteFolder(flag(flags, "cwd"));
  } catch (e) {
    return failed(io, jsonAsked(argv), parseRefusal(verb, e));
  }
  const hostSide = "hostSide" in verb ? verb.hostSide : undefined;
  if (flags["help"] === true) {
    // A line that runs at its own host's terminal takes the flag only to say so, which is what its own line says.
    const host = hostSide === undefined ? COMMON_FLAG_WORDS.host : COMMON_FLAG_WORDS.hostSide;
    io.log(verbPage(verb, host));
    return 0;
  }
  const statePath = statePathOf(flag(flags, "state"));
  // Which host this line runs against is read once: the dial takes the same reading, so a hosts file that changed
  // mid-line cannot send the note one way and the socket another.
  let aim: HostAim;
  try {
    aim = aimedHost(statePath, { ...(flag(flags, "host") !== undefined ? { host: flag(flags, "host")! } : {}), env: deps.env });
  } catch (e) {
    return failed(io, flags["json"] === true, e, `wsp ${verb.name}: `);
  }
  // A line whose work happens at the host's own terminal is answered here however it was aimed, as wsp host pair and
  // wsp host devices are: it never dials, so nothing of this computer's crosses to the other one.
  if (hostSide !== undefined && aim.kind !== "here") {
    return failed(io, flags["json"] === true, usageRefusal(hostSideOnlyLine(verb.name, aimName(aim)), hostSideOnlyFix(hostSide)));
  }
  // The note rides with the dial, not with the line: the recipe verbs write beside the state file whatever host
  // the line names, so saying it is not read before they run would be untrue.
  const stateNote = aim.kind !== "here" && flag(flags, "state") !== undefined ? stateIgnoredLine(aimName(aim)) : undefined;
  let noted = false;
  let client: HostClient | undefined;
  const ctx: VerbContext = {
    args,
    flags,
    usage: verb.usage,
    io,
    out: formatter(io, flags["json"] === true),
    statePath,
    aim,
    env: deps.env,
    ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
    ...(deps.start !== undefined ? { start: deps.start } : {}),
    ...(deps.signals !== undefined ? { signals: deps.signals } : {}),
    ...(deps.elsewhere === true ? { elsewhere: true } : {}),
    ...(deps.terminal !== undefined ? { terminal: deps.terminal } : {}),
    ...(deps.open !== undefined ? { open: deps.open } : {}),
    client: async () => {
      if (stateNote !== undefined && !noted) {
        noted = true;
        io.error(stateNote);
      }
      return (client ??= await (deps.dial ?? dialHost)(statePath, { aim, say: line => io.error(line), ...(deps.start !== undefined ? { start: deps.start } : {}) }));
    },
  };
  try {
    return await verb.run(ctx);
  } catch (e) {
    return failed(io, flags["json"] === true, hostSchemaRefusal(e, verb.usage) ?? e, `wsp ${verb.name}: `);
  } finally {
    client?.close();
  }
}

/** A refusal the host's own validator wrote, turned into the one line a person can act on: what it would not read,
 * and the form the verb takes. The issue list it arrives as carries the wire's field names and every op the host
 * serves, and none of that is a person's to read. Nothing for every other failure, which is already a sentence. */
function hostSchemaRefusal(e: unknown, usage: string): Error | undefined {
  const said = e instanceof Error ? validatorRefusal(e.message) : undefined;
  return said === undefined ? undefined : usageRefusal(said, `usage: ${usage}`);
}
