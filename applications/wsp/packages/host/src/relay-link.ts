// SPDX-License-Identifier: AGPL-3.0-only
// The box's side of the relay, and the person's side of it. A box is put on an
// account from a computer already signed in, or by a device code flow the
// person approves in a browser, and at every start it asks the relay for a
// tunnel, runs the connector against its own loopback port and says where it
// landed. The reply to that heartbeat is the account's own computers and the
// admissions signed for them, which this host verifies with keys it holds and
// the relay does not: no key, no pairing code and no device token is ever sent
// there, and every admission is bytes the relay stores and cannot make.
import { hostname as thisComputer } from "node:os";
import { dirname, join } from "node:path";
import {
  AccountDevices,
  DEFAULT_RELAY,
  HOST_BEAT_MS,
  LOGIN_NO_KEY_REFUSAL,
  NO_HOSTS_LINE,
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  deviceAdmissionTranscript,
  fmtDuration,
  hostDroppedLine,
  hostKeyMovedLine,
  hostsTable,
  isUrl,
  pairToken,
  readJoinToken,
  relayQuietLine,
  relayUrlOf,
  runForTheList,
  unknownWordLine,
  usageRefusal,
  type AccountDevice,
  type AccountView,
  type Admission,
  type DeviceView,
  type HostsTableRow,
} from "@wsp/protocol";
import { keyFingerprint, signPlaceBytes, type PlaceKeyPair } from "@wsp/keys";
import {
  clientRecordPath,
  deviceKeyHere,
  deviceKeyOf,
  readDeviceKeyPair,
  readRelayClient,
  readRelayRecord,
  removeRelayClient,
  removeRelayRecord,
  writeRelayClient,
  writeRelayRecord,
  type DeviceKey,
  type RelayClientRecord,
  type RelayRecord,
} from "./account.js";
import type { CliIO } from "./cli.js";
import { CLOUDFLARED, connectorRunning, ensureCloudflared, startConnector, stopRecordedConnector, type Connector } from "./connector.js";
import { publicAddressLine, stateLine } from "./host-lock.js";
import { accountRecords, aimedAlias, aliasFrom, readHost, removeHost, writeHost, type HostRecord } from "./hosts.js";
import { hostKeyHere } from "./places.js";
import { servingElsewhere } from "./serving-home.js";
import { table } from "./verbs.js";

// The records themselves live beside the rule that reads them, which may not load this file; every caller that had
// them from here still does.
export {
  clientRecordPath,
  deviceKeyHere,
  deviceKeyPath,
  readDeviceKeyPair,
  readRelayClient,
  readRelayRecord,
  relayRecordPath,
  writeRelayRecord,
  type DeviceKey,
  type RelayClientRecord,
  type RelayRecord,
} from "./account.js";

/** A code stands a quarter of an hour on the relay, so nothing here waits longer than that for the approval. */
const LINK_WAIT_MS = 15 * 60_000;
const POLL_MS = 3_000;
/** The relay's page a person types a code and signs computers out on, spelled here because no code is shared with it. */
const VERIFY_PAGE_PATH = "/link/verify";

export interface RelayDeps {
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** What this computer calls itself on the approval page. */
  deviceName(): string;
  cloudflared(dir: string): Promise<string>;
  connector: typeof startConnector;
  heartbeatMs: number;
}

export const systemRelayDeps: RelayDeps = {
  fetch: (input, init) => fetch(input as string, init),
  now: Date.now,
  sleep: ms => new Promise(done => setTimeout(done, ms)),
  deviceName: thisComputer,
  cloudflared: dir => ensureCloudflared(join(dir, "bin")),
  connector: startConnector,
  heartbeatMs: HOST_BEAT_MS,
};

/** Who this wsp is signed in to, read off the two records on this computer and nothing else: the relay is never
 * called for it, so the app's row draws at once and says the same while the relay is down. Either record is a
 * sign-in, since a person signing this computer in and a person putting this computer on their account from its
 * own terminal are both on the account; the name is the one the relay gave on approval, which a relay that names
 * none leaves absent and then signed in is the whole answer. */
export function accountHere(statePath: string | undefined, home: string): AccountView {
  const client = readRelayClient(home);
  // A host serving no state file keeps no record of its own; reading one from a bare path would read whatever
  // relay.json the working folder happens to hold.
  const host = statePath === undefined || statePath === "" ? undefined : readRelayRecord(statePath);
  const login = client?.login ?? host?.login;
  return { signedIn: client !== undefined || host !== undefined, ...(login === undefined ? {} : { login }) };
}

/** One call to a relay, with its own sentence when it refuses: the relay's words are the person's words. */
async function relayCall<T>(deps: RelayDeps, url: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (e) {
    throw new Error(`the relay at ${new URL(url).origin} did not answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  const answer = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!res.ok) throw new Error(typeof answer?.error === "string" ? answer.error : `the relay at ${new URL(url).origin} answered ${res.status}`);
  return answer as T;
}

const trimUrl = (url: string): string => url.replace(/\/+$/, "");

interface LinkStarted {
  code: string;
  verifyUrl: string;
  pollToken: string;
  pollAfterMs?: number;
}

interface LinkApproved {
  state: string;
  token: string;
  name: string;
  hostId?: string;
  /** Who approved it, as the relay spells them. Older relays send none. */
  login?: string;
}

/** The waiting half of the device code flow, for a box and for a person's own computer alike: the code is already
 * up, and this is the poll that collects the token once somebody approved it. */
async function waitApproved(deps: RelayDeps, relayUrl: string, started: LinkStarted): Promise<LinkApproved> {
  const deadline = deps.now() + LINK_WAIT_MS;
  // The relay says how long to sleep between polls, held between half a second and half a minute: a relay that
  // says zero would have this line spinning for a quarter of an hour.
  const between = Math.min(Math.max(started.pollAfterMs ?? POLL_MS, 500), 30_000);
  while (deps.now() < deadline) {
    await deps.sleep(between);
    const answer = await relayCall<LinkApproved>(deps, `${relayUrl}/link/poll`, { method: "POST", body: { pollToken: started.pollToken } });
    if (answer.state === "approved") return answer;
    if (answer.state === "expired") throw new Error(`the code ${started.code} ran out before it was approved; run the line again for a fresh one`);
  }
  throw new Error(`nobody approved ${started.code} while this line waited; run it again for a fresh code`);
}

const startLink = (deps: RelayDeps, relayUrl: string, body: Record<string, unknown>): Promise<LinkStarted> =>
  relayCall<LinkStarted>(deps, `${relayUrl}/link/start`, { method: "POST", body });

/** What this computer is signed in as, or the refusal naming the line that signs it in. Every account line but the
 * sign-in itself comes through here, so a computer holding no token reads one sentence whichever it ran. */
function signedInHere(home: string): RelayClientRecord {
  const held = readRelayClient(home);
  if (held === undefined) throw usageRefusal("this computer is signed in to no account.", "Run wsp login, which prints a word to approve on a computer already in.");
  return held;
}

/** What one computer already in signs for another: the key admitted, its own key and the moment, over the bytes
 * both ends build from one function. The private half never leaves this computer, and the relay carries what comes
 * out of here without being able to make it. */
export function signAdmission(pair: PlaceKeyPair, device: string, at: number): Admission {
  const by = keyFingerprint(pair.publicKey);
  const issuedAt = new Date(at).toISOString();
  return { device, by, issuedAt, signature: signPlaceBytes(pair.privateKeyPem, deviceAdmissionTranscript(device, by, issuedAt)) };
}

/** A word that is a code and nothing else: the alphabet's characters and the dash the screens group them with, at
 * the length a code is. What tells a code somebody cut the key off from the id of a computer on the account. */
function isCodeAlone(word: string): boolean {
  const letters = word.replace(/-/g, "").toUpperCase();
  return letters.length === PAIR_CODE_LENGTH && [...letters].every(letter => PAIR_CODE_ALPHABET.includes(letter));
}

interface RelayHostView {
  id: string;
  name: string;
  hostname: string | null;
  connectorVersion?: string | null;
  lastSeen?: string | null;
  hostKey?: string | null;
}

interface RelayClientView {
  id: string;
  name: string;
  signedInAt?: string;
  lastSeen?: string | null;
  thisOne?: boolean;
  fingerprint?: string | null;
  admissions?: { by: string; issuedAt: string; byName?: string }[];
}

const relayHosts = async (record: RelayClientRecord, deps: RelayDeps): Promise<RelayHostView[]> =>
  (await relayCall<{ hosts: RelayHostView[] }>(deps, `${record.relayUrl}/hosts`, { token: record.token })).hosts;

const relayClients = async (record: RelayClientRecord, deps: RelayDeps): Promise<RelayClientView[]> =>
  (await relayCall<{ clients: RelayClientView[] }>(deps, `${record.relayUrl}/clients`, { token: record.token })).clients;

/** The rows wsp login prints when it is asked nothing: which computers hold a token for this account, which key
 * each signed in under and who admitted it, so the person reads the id wsp login <id> and wsp logout <id> take. */
export function clientLines(clients: readonly RelayClientView[]): string[] {
  if (clients.length === 0) return ["No computer is signed in to that account. Run wsp login on the one you are at."];
  return table([
    ["COMPUTER", "ID", "KEY", "ADMITTED BY", "SIGNED IN", "LAST SEEN", ""],
    ...clients.map(c => [
      c.name,
      c.id,
      c.fingerprint ?? "",
      (c.admissions ?? []).map(a => `${a.byName ?? a.by} ${a.issuedAt}`).join(", "),
      c.signedInAt ?? "",
      c.lastSeen ?? "",
      c.thisOne === true ? "this one" : "",
    ]),
  ]);
}

export interface RelayCommandOpts {
  statePath: string;
  home: string;
}

/** wsp login, in its four readings: an address signs this computer in there, a word off another computer's own
 * wsp login admits that computer, an id admits one already on the account, and nothing at all signs this computer
 * in to the default relay or, when it is already in, lists the account's computers. */
export async function loginCommand(io: CliIO, opts: RelayCommandOpts, word: string | undefined, deps: RelayDeps = systemRelayDeps): Promise<number> {
  const held = readRelayClient(opts.home);
  if (word === undefined) {
    if (held === undefined) return signIn(io, opts, DEFAULT_RELAY, deps);
    for (const line of clientLines(await relayClients(held, deps))) io.log(line);
    return 0;
  }
  if (isUrl(word)) {
    if (held !== undefined && trimUrl(word) !== held.relayUrl) {
      throw usageRefusal(`this computer is signed in to the account at ${held.relayUrl}, and one at a time is the rule.`, `Run wsp logout before signing in to ${trimUrl(word)}.`);
    }
    if (held !== undefined) throw usageRefusal(`this computer is already signed in to ${held.relayUrl} as ${held.name}.`, "Run wsp logout to sign it out first.");
    return signIn(io, opts, trimUrl(word), deps);
  }
  const typed = readJoinToken(word);
  // A word with no key names no computer to admit: nothing here could say which key it would be signing for, and
  // nothing is posted. Read before the word is taken for an id, since a code is what a person is likely to paste.
  if (typed.hostKey === undefined && isCodeAlone(word)) throw new Error(LOGIN_NO_KEY_REFUSAL);
  const client = signedInHere(opts.home);
  const pair = deviceKeyHere(opts.home);
  if (typed.hostKey !== undefined) {
    const admission = signAdmission(pair, typed.hostKey, deps.now());
    const { name } = await relayCall<{ name: string }>(deps, `${client.relayUrl}/link/approve`, { method: "POST", token: client.token, body: { code: typed.code, admission } });
    io.log(`${name} is signed in to ${client.relayUrl} and admitted to every host that trusts this computer's key`);
    io.log("It reaches them once wsp hosts there lists them; nothing of this computer's was sent to the relay but the signature above.");
    return 0;
  }
  // An id names a computer already on the account, approved on the page and admitted by nobody: its key is read
  // off the account's own listing, since an admission for a key the row does not hold is refused there.
  const row = (await relayClients(client, deps)).find(c => c.id === word);
  if (row === undefined) throw usageRefusal(`no computer with the id ${word} is signed in to ${client.relayUrl}.`, "Run wsp login on its own to read the ids on this account.");
  if (row.fingerprint === null || row.fingerprint === undefined) {
    throw usageRefusal(`${row.name} signed in with no device key, so no host can admit it.`, `Sign it out with wsp logout ${row.id}, or from ${client.relayUrl}${VERIFY_PAGE_PATH} in your browser, and run wsp login there again.`);
  }
  await relayCall(deps, `${client.relayUrl}/clients/${encodeURIComponent(row.id)}/admissions`, { method: "POST", token: client.token, body: signAdmission(pair, row.fingerprint, deps.now()) });
  io.log(`${row.name} is admitted to every host that trusts this computer's key; each one reads it on its next beat, within ${fmtDuration(HOST_BEAT_MS)}`);
  return 0;
}

/** Signs this computer in: the key it will prove to the hosts goes up with the name, and the word it prints is
 * what one line on a computer already in turns into an admission. The page is the other road, for the first
 * computer on an account, and it grants the sign-in alone. */
async function signIn(io: CliIO, opts: RelayCommandOpts, relayUrl: string, deps: RelayDeps): Promise<number> {
  const key = deviceKeyOf(deviceKeyHere(opts.home));
  const name = deps.deviceName();
  const started = await startLink(deps, relayUrl, { kind: "client", name, fingerprint: key.fingerprint });
  io.log(`word        ${pairToken(started.code, key.fingerprint)}`);
  io.log(`code        ${started.code}`);
  io.log(`open        ${started.verifyUrl}`);
  io.log(`On a computer already signed in: wsp login ${pairToken(started.code, key.fingerprint)}, which signs this computer's key for the hosts it can reach.`);
  io.log(`Or open that page, sign in with GitHub and type ${started.code} there, which signs this computer in to read the account and admits it to no host until a computer already in runs wsp login <id> for it.`);
  io.log(`The code stands for ${fmtDuration(LINK_WAIT_MS)} and is spent by the approval.`);
  const approved = await waitApproved(deps, relayUrl, started);
  writeRelayClient(opts.home, {
    relayUrl,
    token: approved.token,
    name,
    ...(approved.login === undefined ? {} : { login: approved.login }),
    fingerprint: key.fingerprint,
    linkedAt: new Date(deps.now()).toISOString(),
  });
  io.log(`signed in to ${relayUrl}${approved.login === undefined ? "" : ` as ${approved.login}`}; wsp hosts lists the hosts on this account`);
  return 0;
}

/** wsp logout: this computer, or another of the person's by its id. Signing this one out takes its client row with
 * its admissions, its own record and every host record it holds through the account; the device key stays, since
 * it opens nothing by itself and is the key the hosts already trust. */
export async function logoutCommand(io: CliIO, opts: RelayCommandOpts, id: string | undefined, deps: RelayDeps = systemRelayDeps): Promise<number> {
  const client = signedInHere(opts.home);
  if (id !== undefined) {
    await relayCall(deps, `${client.relayUrl}/clients/${encodeURIComponent(id)}`, { method: "DELETE", token: client.token });
    io.log(`${id} is signed out of ${client.relayUrl}; the token it held opens nothing, its admissions are gone, and every host on the account drops what it admitted on them within ${fmtDuration(HOST_BEAT_MS)}`);
    return 0;
  }
  // What is left to do over there when this computer's own row could not be taken off: the one line says so
  // whether the reading or the delete is what failed, and where the reading never got an id, wsp login on a
  // computer still signed in is what prints it.
  const mayStillHold = (id: string | undefined): string =>
    `the account may still hold this computer as ${client.name}; sign it out from another computer with ${id === undefined ? "wsp logout <id>, reading the id off wsp login there" : `wsp logout ${id}`}.`;
  // The relay first, while the token is still here: the records go whatever it says, since a relay that is down
  // must not leave this computer holding a token it cannot use.
  const own = await Promise.resolve()
    .then(async () => (await relayClients(client, deps)).find(c => c.thisOne === true))
    .catch((e: unknown) => {
      io.error(e instanceof Error ? e.message : String(e));
      io.error(mayStillHold(undefined));
      return undefined;
    });
  if (own !== undefined) {
    await relayCall(deps, `${client.relayUrl}/clients/${encodeURIComponent(own.id)}`, { method: "DELETE", token: client.token }).catch((e: unknown) => {
      io.error(e instanceof Error ? e.message : String(e));
      io.error(mayStillHold(own.id));
    });
  }
  removeRelayClient(opts.home);
  const dropped = accountRecords(opts.home).filter(held => removeHost(opts.home, held.alias));
  io.log(`signed out of ${client.relayUrl}; this computer holds no token for it${dropped.length === 0 ? "" : ` and no record for ${dropped.map(held => held.alias).join(", ")}`}`);
  io.log("The key this computer signs with stays, since it opens nothing on its own.");
  return 0;
}

/** wsp hosts: every host on the account this computer can reach, in one table. The rows are written into the hosts
 * folder as they are read, so the rule that decides where a line goes, the Hosts menu and every verb read them off
 * the same files, offline and without asking the relay again. */
export async function hostsCommand(io: CliIO, opts: RelayCommandOpts, deps: RelayDeps = systemRelayDeps): Promise<number> {
  const client = readRelayClient(opts.home);
  if (client === undefined) {
    io.log(NO_HOSTS_LINE);
    return 0;
  }
  const listed = await relayHosts(client, deps).catch((e: unknown) => {
    io.error(relayQuietLine(e instanceof Error ? e.message : String(e)));
    return undefined;
  });
  const rows = listed === undefined ? heldRows(opts.home) : accountRows(io, opts, listed, deps);
  if (rows.length === 0) {
    io.log(NO_HOSTS_LINE);
    return 0;
  }
  // Which host a line with no name on it takes, read through the one rule every verb comes by and after the
  // folder is settled, so the mark cannot say one host and a verb go to another.
  const marked = aimedAlias(opts.statePath, opts.home);
  for (const line of table(hostsTable(rows.map(row => (row.host === marked ? { ...row, default: true } : row))))) io.log(line);
  return 0;
}

/** The rows this computer holds on its own, for a relay that did not answer: whatever the hosts folder says, which
 * is what every verb would dial. */
function heldRows(home: string): HostsTableRow[] {
  return accountRecords(home).map(({ alias, record }) => ({
    host: alias,
    address: record.url,
    ...(record.deviceId === "" ? {} : { deviceId: record.deviceId }),
    ...(record.hostKey === undefined ? {} : { hostKey: record.hostKey }),
  }));
}

/** The listing folded into the hosts folder, and the rows that come out of it: one record per account host that has
 * an address, the alias folded from its name, the key pinned at first sight and held to after it, and every record
 * the account no longer names taken away. */
function accountRows(io: CliIO, opts: RelayCommandOpts, listed: readonly RelayHostView[], deps: RelayDeps): HostsTableRow[] {
  const home = opts.home;
  const now = deps.now();
  const rows: HostsTableRow[] = [];
  const kept = new Set<string>();
  for (const host of listed) {
    const alias = aliasFrom(host.name);
    const held = readHost(home, alias);
    const address = host.hostname === null || host.hostname === "" ? undefined : relayUrlOf(host.hostname);
    const listedKey = host.hostKey === null || host.hostKey === undefined ? undefined : host.hostKey;
    // The key is pinned the first time this computer sees it and held to on every dial after: a listing naming
    // another key for a host already pinned is another host, or a relay steering this computer at one.
    const pinned = held?.hostKey;
    let moved = false;
    if (pinned !== undefined && listedKey !== undefined && pinned !== listedKey) {
      moved = true;
      io.error(hostKeyMovedLine(alias, pinned, listedKey));
    }
    const hostKey = pinned ?? listedKey;
    // A host that has not said which key it proves cannot be dialled: no record is written for it, so a line
    // aimed at that name is refused with the sentence that names wsp hosts, and the row below reads as not up yet
    // until a beat carries the key.
    if (!moved && address !== undefined && hostKey !== undefined) {
      const record: HostRecord = {
        url: address,
        deviceId: held?.deviceId ?? "",
        deviceToken: held?.deviceToken ?? "",
        ...(hostKey === undefined ? {} : { hostKey }),
        pairedAt: held?.pairedAt ?? new Date(now).toISOString(),
        via: { kind: "account", hostId: host.id },
      };
      writeHost(home, alias, record);
      kept.add(alias);
    } else if (held !== undefined) kept.add(alias);
    const beat = host.lastSeen === null || host.lastSeen === undefined ? null : Date.parse(host.lastSeen);
    // What a line aimed at this name would dial: the record's own address where it stands, since a listing naming
    // another key changes nothing about the host this computer pinned, and nothing at all where no key is held.
    const shown = moved && held !== undefined ? held.url : hostKey === undefined ? undefined : address;
    rows.push({
      host: alias,
      ...(shown === undefined ? {} : { address: shown }),
      awayMs: beat === null || Number.isNaN(beat) ? null : Math.max(0, now - beat),
      ...(held?.deviceId === undefined || held.deviceId === "" ? {} : { deviceId: held.deviceId }),
      ...(host.connectorVersion === null || host.connectorVersion === undefined ? {} : { connector: host.connectorVersion }),
      ...(hostKey === undefined ? {} : { hostKey }),
    });
  }
  // A record this computer wrote off an earlier listing whose host the account no longer names: it goes, since a
  // name aimed at it would dial a host nobody on the account holds.
  for (const held of accountRecords(home)) {
    if (kept.has(held.alias)) continue;
    if (removeHost(home, held.alias)) io.error(hostDroppedLine(held.alias));
  }
  return rows;
}

const RELAY_USAGE = ["usage: wsp host link [<url>] [--name <name>]", "       wsp host unlink"].join("\n");

export async function relayCommand(io: CliIO, opts: RelayCommandOpts, args: readonly string[], values: { name?: string }, deps: RelayDeps = systemRelayDeps): Promise<number> {
  const [word, second, third, ...rest] = args;
  if (word === undefined || rest.length > 0) throw usageRefusal("wsp host takes one of its account lines.", RELAY_USAGE);
  if (word === "link") {
    if (third !== undefined) throw usageRefusal(`wsp host link takes no word beside ${third}.`, RELAY_USAGE);
    return relayLink(io, opts, second, values, deps);
  }
  if (word === "unlink") {
    if (second !== undefined) throw usageRefusal("wsp host unlink takes the account this computer is already on, so it needs no address.", RELAY_USAGE);
    return relayUnlink(io, opts, deps);
  }
  // The words reaching here come from the command table, so this is the line a road added there without a branch
  // below would take; the pointer names the page that lists them.
  throw usageRefusal(unknownWordLine(`host ${word}`), runForTheList("wsp host --help"));
}

/** The link writes beside one state file, and the state a line works on is not always the one this computer's host
 * serves: a terminal opened in a folder with a `.wsp` of its own links that folder's state and leaves the serving
 * host on no relay. Said before the code goes up, so nobody approves a link they have not read. */
function otherStateServedLine(statePath: string, served: string, relayUrl: string): string {
  return `this link writes beside ${statePath}, and the host serving on this computer is on ${served}; wsp host link ${relayUrl} --state ${served} is the line that puts that one on the account.`;
}

async function relayLink(io: CliIO, opts: RelayCommandOpts, address: string | undefined, values: { name?: string }, deps: RelayDeps): Promise<number> {
  const held = readRelayRecord(opts.statePath);
  if (held !== undefined) throw usageRefusal(`this computer is already on the account at ${held.relayUrl} as ${held.name}.`, "Run wsp host unlink to take it off first.");
  const signedIn = readRelayClient(opts.home);
  if (address !== undefined && !isUrl(address)) throw usageRefusal("wsp host link takes the address of the relay, starting http:// or https://.", RELAY_USAGE);
  if (address !== undefined && signedIn !== undefined && trimUrl(address) !== signedIn.relayUrl) {
    throw usageRefusal(`this computer is signed in to the account at ${signedIn.relayUrl}, and a host goes on the account this computer is signed in to.`, `Run wsp logout first to put it on ${trimUrl(address)} instead.`);
  }
  if (address === undefined && signedIn === undefined) throw usageRefusal("wsp host link takes the address of the relay on a computer that is signed in to none.", `Run wsp login first, or give the address: wsp host link <url>.\n\n${RELAY_USAGE}`);
  const relayUrl = signedIn?.relayUrl ?? trimUrl(address!);
  const served = servingElsewhere(opts.statePath);
  if (served !== undefined) io.error(otherStateServedLine(opts.statePath, served, relayUrl));
  const name = values.name ?? deps.deviceName();
  // The key of the computer running this line is the one key this host will trust to sign an admission, so it is
  // recorded here whichever road the link took, and minted now when this home holds none.
  const deviceKey = deviceKeyOf(deviceKeyHere(opts.home));
  // The key this host proves, which the account records once: read only on the road that names it at the link,
  // since reading it mints the host's own pair when this state file has none.
  const hostKey = signedIn === undefined ? undefined : hostKeyHere(opts.statePath);
  const approved =
    signedIn === undefined
      ? await codeLink(io, deps, relayUrl, name)
      : await relayCall<LinkApproved>(deps, `${relayUrl}/hosts`, { method: "POST", token: signedIn.token, body: { name, ...(hostKey === undefined ? {} : { hostKey }) } });
  if (approved.hostId === undefined) throw new Error(`the relay at ${relayUrl} approved this computer without naming a host; it runs another version of the relay`);
  const record: RelayRecord = {
    relayUrl,
    hostId: approved.hostId,
    token: approved.token,
    name,
    ...(approved.login === undefined ? {} : { login: approved.login }),
    deviceKey,
    linkedAt: new Date(deps.now()).toISOString(),
  };
  writeRelayRecord(opts.statePath, record);
  io.log(`relay       ${relayUrl}`);
  io.log(`host        ${name}`);
  // The folder this landed in is the whole of what the owner could not read off the summary, in the one spelling
  // wsp status prints it.
  io.log(stateLine(opts.statePath));
  io.log(`This computer asks that relay for a tunnel every time wsp up runs, and says where it answers. It admits a computer on the account on an admission signed by ${deviceKey.fingerprint}, the key of the computer that ran this line. wsp host unlink takes it back off.`);
  return 0;
}

/** The device code flow, for a box on a computer signed in to nothing: a code shown here and a page the person
 * opens and approves as themselves. A signed-in computer needs none of it and posts the box straight onto its
 * own account. */
async function codeLink(io: CliIO, deps: RelayDeps, relayUrl: string, name: string): Promise<LinkApproved> {
  const started = await startLink(deps, relayUrl, { kind: "host", name });
  io.log(`code        ${started.code}`);
  io.log(`open        ${started.verifyUrl}`);
  io.log(`type        ${started.code} on that page`);
  io.log(`Open that page and sign in to approve ${name}. The code stands for ${fmtDuration(LINK_WAIT_MS)} and is spent by the approval.`);
  return waitApproved(deps, relayUrl, started);
}

async function relayUnlink(io: CliIO, opts: RelayCommandOpts, deps: RelayDeps): Promise<number> {
  const record = readRelayRecord(opts.statePath);
  if (record === undefined) throw usageRefusal("this computer is on no account.", "Run wsp host link <url> to put it on one.");
  // The record goes first of all, so the host that is serving starts no connector in place of the one stopped next,
  // and the connector goes before the relay is told: a tunnel with connections still registered cannot be deleted.
  removeRelayRecord(opts.statePath);
  await stopRecordedConnector(dirname(opts.statePath));
  // The record is gone whatever the relay says: a relay that is down must not leave this computer holding a token
  // it cannot use, and the line below says what is left to do over there.
  try {
    await relayCall(deps, `${record.relayUrl}/hosts/${record.hostId}`, { method: "DELETE", token: record.token });
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e));
    io.error(`the relay may still hold this computer as ${record.name}; take it off there with wsp hosts on your own computer.`);
  }
  io.log(`unlinked from ${record.relayUrl}; the tunnel is stopped and this computer holds no token for it`);
  return 0;
}

export interface RelayUp {
  /** The name the start line printed, which is the first one this host's tunnel had, and nothing when the connector
   * never got one. A quick tunnel is given another every time its child runs, so publicHostname is the live name. */
  hostname(): Promise<string | undefined>;
  close(): Promise<void>;
}

/** What the door reads of the account this host is on, and what the beat fills in. The runtime holds the rule that
 * admits a computer; this holds what it reads and nothing else. */
export interface AdmittedLink {
  signer(): DeviceKey | undefined;
  list(): readonly AccountDevice[] | undefined;
  refresh(): Promise<void>;
  /** What a beat learned: an explicit listing, or nothing for a reply carrying no devices field and for a beat
   * that was refused, which admits nobody new and revokes nobody. */
  took(devices: readonly AccountDevice[] | undefined): void;
  /** The beat a miss asks for, installed once this host is serving and linked; a host on no account keeps none and
   * a refresh there does nothing at all. */
  beatsThrough(beat: () => Promise<void>): void;
}

/** How long one miss buys before another may ask the relay again: a device approved a moment ago is admitted at
 * once, and a stranger on the tunnel cannot make this host call its relay once per attempt. */
export const BEAT_FLOOR_MS = 10_000;

/** The account's own computers as this host knows them, for the door that admits one. The signer is read off the
 * record at every ask rather than copied at the start: a host linked while it serves trusts that computer's key
 * from the link on, and one unlinked while it serves trusts nobody. */
export function admittedDevices(statePath: string, deps: Pick<RelayDeps, "now"> = systemRelayDeps): AdmittedLink {
  let listed: readonly AccountDevice[] | undefined;
  let beat: (() => Promise<void>) | undefined;
  let askedAt = -Infinity;
  let asking: Promise<void> | undefined;
  return {
    signer: () => readRelayRecord(statePath)?.deviceKey,
    list: () => listed,
    took: devices => {
      if (devices !== undefined) listed = devices;
    },
    beatsThrough: fn => {
      beat = fn;
    },
    refresh: async () => {
      if (beat === undefined) return;
      if (asking !== undefined) return asking;
      const at = deps.now();
      if (at - askedAt < BEAT_FLOOR_MS) return;
      askedAt = at;
      asking = beat()
        .catch(() => undefined)
        .finally(() => {
          asking = undefined;
        });
      return asking;
    },
  };
}

/** The devices of this host as the reconcile reads and cuts them: the store's own listing and the one revoke road
 * the op takes. */
export interface RelayDeviceDoor {
  list(): Promise<DeviceView[]>;
  revoke(id: string): Promise<boolean>;
}

/** What a beat's listing does to the devices standing here: every device admitted through the account whose key
 * the account no longer names is taken away and its sockets cut. A device that redeemed a code is never touched:
 * the account has nothing to say about it. Nothing here forgets a key this host revoked: a revocation made at the
 * host is not the account's to undo, so a listing that stops naming a computer and names it again leaves it
 * refused, and a code from wsp host pair is the road back in. */
export async function reconcileAccountDevices(door: RelayDeviceDoor, listed: readonly AccountDevice[], log: (line: string) => void): Promise<void> {
  const keys = new Set(listed.map(device => device.fingerprint));
  for (const device of await door.list()) {
    if (device.via?.kind !== "account" || keys.has(device.via.fingerprint)) continue;
    if (await door.revoke(device.id)) log(`relay: ${device.name} is no longer on this account, so its token here is taken away`);
  }
}

export interface RelayStartOpts {
  statePath: string;
  /** The loopback port the tunnel carries to: the app's own port, so the host may stay on loopback. */
  port: number;
  log(line: string): void;
  /** Where a beat's reply lands, which is the door a computer on the account comes in by. */
  admitted?: AdmittedLink;
  /** The devices standing on this host, for the reconcile of what the account listed. */
  devices?: RelayDeviceDoor;
  /** The wsp home whose device key this host trusts to sign an admission: the home of the computer it runs on. */
  home: string;
}

/** What a linked host does at every start: ask for a tunnel, run the connector, and keep saying it is there and
 * reading back the account's computers. Nothing here can take the host down: a relay that is off or a connector
 * that will not run is one line and a host that goes on serving the computer it is on. */
export async function startRelay(opts: RelayStartOpts, deps: RelayDeps = systemRelayDeps): Promise<RelayUp | undefined> {
  const record = readRelayRecord(opts.statePath);
  if (record === undefined) return undefined;
  const stateDir = dirname(opts.statePath);
  // A host linked before this wsp recorded a device key has one recorded at its first start after: the key of the
  // computer it is on, minted when this home holds none, which is the key it will trust to sign an admission.
  // A home this cannot be written in is one line and a host that goes on serving, as everything else here is: it
  // admits no computer through the account until the key lands, and the code road is untouched.
  if (record.deviceKey === undefined) {
    try {
      const deviceKey = deviceKeyOf(deviceKeyHere(opts.home));
      writeRelayRecord(opts.statePath, { ...record, deviceKey });
      opts.log(`relay: this host admits a computer on the account on an admission signed by ${deviceKey.fingerprint}, the key of the computer it runs on`);
    } catch (e) {
      opts.log(`relay: this host could not record the key it trusts to admit a computer on the account (${e instanceof Error ? e.message : String(e)}); a code from wsp host pair is the road in until it can`);
    }
  }
  // A connector an earlier run left behind would hold the same tunnel open; its pid is the one that run wrote down.
  await stopRecordedConnector(stateDir);
  let asked: { tunnelToken: string | null; hostname: string | null; why?: string };
  let bin: string;
  try {
    asked = await relayCall(deps, `${record.relayUrl}/hosts/${record.hostId}/tunnel`, { method: "POST", token: record.token, body: { port: opts.port } });
    bin = await deps.cloudflared(stateDir);
  } catch (e) {
    opts.log(`relay: no tunnel this time (${e instanceof Error ? e.message : String(e)}); this host is still served on the addresses above`);
    return undefined;
  }
  if (asked.hostname === null && asked.why !== undefined) opts.log(`relay: ${asked.why}`);

  // A heartbeat carries a hostname only for a quick tunnel, which is the one name the box learns and the relay does
  // not: a managed name is the relay's own, and a box that reported one back would be refused and never read as up.
  const ownName = asked.hostname === null;
  // The fingerprint of the key this host proves, read once here: a host whose place key cannot be read says where
  // it is all the same, and the account lists no key for it until it can.
  let proves: string | undefined;
  try {
    proves = hostKeyHere(opts.statePath);
  } catch (e) {
    opts.log(`relay: this host could not read the key it proves (${e instanceof Error ? e.message : String(e)}); the account lists none for it until it can`);
  }
  const say = async (hostname: string | undefined): Promise<void> => {
    const name = ownName ? (hostname ?? readRelayRecord(opts.statePath)?.hostname) : undefined;
    const reply = await relayCall<unknown>(deps, `${record.relayUrl}/hosts/${record.hostId}/heartbeat`, {
      method: "POST",
      token: record.token,
      body: {
        ...(name !== undefined && name !== "" ? { hostname: name } : {}),
        version: CLOUDFLARED.version,
        // The key this host proves, written on the account at the first beat that names it and held to after: every
        // computer on the account pins it off the listing before it dials. Read once at the start, since a beat is
        // no place to read a file that may not read.
        ...(proves === undefined ? {} : { hostKey: proves }),
      },
    });
    // A reply with no devices field is an older relay, or one before its migration: absent is unknown, so it
    // admits nobody new and revokes nobody. Only an explicit listing moves anything here.
    const read = AccountDevices.safeParse(reply);
    if (!read.success) return;
    opts.admitted?.took(read.data.devices);
    if (opts.devices !== undefined) await reconcileAccountDevices(opts.devices, read.data.devices, opts.log);
  };
  opts.admitted?.beatsThrough(() => say(undefined));

  /** Where this host answers, as it becomes known: the name lands in the record first, since the beats and every
   * line that says where this host is read it there, and is said to the relay straight after. Nothing here can take
   * the host down, so a relay that refuses the name is one line and a host that goes on serving. */
  const learn = async (hostname: string): Promise<void> => {
    try {
      // wsp host unlink takes the record away while this host serves; without this, a name learned after that
      // would put a relay.json back holding a hostname and nothing else, where the unlink had left none.
      const held = readRelayRecord(opts.statePath);
      if (held === undefined) return;
      writeRelayRecord(opts.statePath, { ...held, hostname });
      opts.log(publicAddressLine(hostname));
      await say(hostname);
    } catch (e) {
      opts.log(`relay: could not say where this host is (${e instanceof Error ? e.message : String(e)})`);
    }
  };

  let connector: Connector;
  try {
    connector = deps.connector({
      bin,
      stateDir,
      port: opts.port,
      ...(asked.tunnelToken !== null ? { token: asked.tunnelToken } : {}),
      log: opts.log,
      // wsp host unlink stops the child and takes the record away; this host is what would otherwise start another.
      keepRunning: () => readRelayRecord(opts.statePath) !== undefined,
      // Only a quick tunnel is handed a new name when its child is restarted; a managed name is the relay's own and
      // is not this box's to report, so nothing on that road listens for one.
      ...(ownName ? { onHostname: (hostname: string): void => void learn(hostname) } : {}),
    });
  } catch (e) {
    opts.log(`relay: the connector would not start (${e instanceof Error ? e.message : String(e)}); this host is still served on the addresses above`);
    return undefined;
  }

  const reported = (async (): Promise<string | undefined> => {
    if (asked.hostname !== null) {
      await learn(asked.hostname);
      return asked.hostname;
    }
    // Every quick tunnel name, this first one and each one a restart is given, arrives at learn through onHostname.
    return connector.hostname();
  })();

  const beat = setInterval(() => {
    void say(undefined).catch((e: unknown) => opts.log(`relay: could not say where this host is (${e instanceof Error ? e.message : String(e)})`));
  }, deps.heartbeatMs);
  // A heartbeat must not hold this process up when everything else is done.
  beat.unref?.();

  return {
    hostname: () => reported,
    close: async () => {
      clearInterval(beat);
      await connector.stop();
    },
  };
}

/** What a box behind a relay says at start: it binds this computer alone and is still reachable from anywhere, so
 * a request that came in through the relay gets no token in the page and pairs for one, while this computer's own
 * app opens as it did before the link. */
export function relayOnLoopbackLine(): string {
  return "this host is on a relay, so it can be reached from anywhere it can dial out: a request that arrives through the relay carries no token in the page and pairing is the gate, while the app on this computer opens as before. Run wsp host pair for a code, and wsp host devices to see who took one.";
}

/** Where this host answers from anywhere: the name the record holds, and only while a connector this computer
 * started is carrying it. A name with nothing behind it is worse than no name, since every line that prints one
 * is telling somebody where to reach this host. */
export function publicHostname(statePath: string): string | undefined {
  const record = readRelayRecord(statePath);
  if (record?.hostname === undefined || !connectorRunning(dirname(statePath))) return undefined;
  return record.hostname;
}
