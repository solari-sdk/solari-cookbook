// SPDX-License-Identifier: AGPL-3.0-only
// The hosts on the person's account this computer can reach, and the one rule
// that decides which host a line runs against. A record is one file per alias
// under the wsp home, mode 0600, written by wsp hosts off the account's listing
// and holding the address, the pinned key and the device token the first dial
// bought. Every reader of "which host" comes through aimedHost, so the command
// line and the tool server cannot disagree about where a verb goes.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { authRefusal, hostNoKeyLine, LAUNCHED_WITH, WS_PATH, hostFromEnv, isLoopback, isUrl, runForTheList, servedHostname, usageRefusal } from "@wsp/protocol";
import { writeOwn } from "@wsp/own-file";
import { readRelayRecord } from "./account.js";
import { servingHost } from "./host-lock.js";
import { defaultHomeIn, homeNamed } from "./serving-home.js";

/** The address predicate has one home in the protocol; the command line's callers read it from here. */
export { isUrl };

/** What this computer keeps about a host on its account: the address the account names, the device the host minted
 * for this computer and the token that names it. The token opens the host, so the file is the person's own. */
export interface HostRecord {
  url: string;
  deviceId: string;
  deviceToken: string;
  pairedAt: string;
  /** The fingerprint of the key the account listed for that host when this computer first saw it, which every
   * later dial holds it to before it sends the token. */
  hostKey?: string;
  /** The account the record came off, with the host's own id there, which is what says whether a record names the
   * host on this computer. A file without it was written by a road that is gone and is read as no record. */
  via: { kind: "account"; hostId: string };
}

/** One host this computer holds, as a listing reads it: never the token, which no listing has any use for. */
export interface HostEntry {
  alias: string;
  url: string;
  deviceId: string;
}

/** The home wsp keeps everything of a person's in when nobody names another. */
export const DEFAULT_HOME = defaultHomeIn(homedir());

/** The folder wsp keeps its state, its keys and its hosts in. One reading, since the command line, the verbs and the
 * tool server all have to name the same folder, and the variable itself is read where every other road reads it,
 * so `WSP_HOME=` with nothing after it is a home nobody named rather than the folder the run happens to sit in. */
export function wspHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return homeNamed(env["WSP_HOME"]) ?? DEFAULT_HOME;
}

export function hostsDir(home: string): string {
  return join(home, "hosts");
}

/** An alias is one name, never a path: it becomes a file name under the hosts folder, so a word with a separator or
 * a dot-dot in it is refused before anything is written or read. The characters, the one an alias may open with
 * and the length live here alone, since the name a person types and the name an address is folded into are held to
 * the same rule. */
const ALIAS_CHARS = "A-Za-z0-9._-";
const ALIAS_FIRST = "A-Za-z0-9";
const ALIAS_MAX = 64;
const ALIAS = new RegExp(`^[${ALIAS_FIRST}][${ALIAS_CHARS}]{0,${ALIAS_MAX - 1}}$`);

const aliasOk = (alias: string): boolean => ALIAS.test(alias) && !alias.includes("..");

/** The alias itself, or the refusal for a word that could never be one: every road that names a file reads it here. */
function checkedAlias(alias: string): string {
  if (!aliasOk(alias)) throw usageRefusal(`${JSON.stringify(alias)} is not a host alias.`, `A name is letters, digits, dots, dashes and underscores, opens with a letter or a digit, and is at most ${ALIAS_MAX} characters.`);
  return alias;
}

/** The alias a name becomes when nobody typed one: what the rule above will not take folded to a dash, a run of
 * dots collapsed to one, the characters it cannot open with dropped, cut to the length it allows. Dots are in the
 * alias class while the checker refuses a dot-dot, so the collapse is what keeps the one contract this fold has:
 * whatever goes in, the name that comes out is one the checker takes, and the last line holds that even for an
 * input the rules above have not thought of. */
export function aliasFrom(name: string): string {
  const folded = name
    .replace(new RegExp(`[^${ALIAS_CHARS}]`, "g"), "-")
    .replace(/\.{2,}/g, ".")
    .replace(new RegExp(`^[^${ALIAS_FIRST}]+`), "")
    .slice(0, ALIAS_MAX);
  return aliasOk(folded) ? folded : "host";
}

const isRecord = (v: unknown): v is HostRecord =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as HostRecord).url === "string" &&
  typeof (v as HostRecord).deviceId === "string" &&
  typeof (v as HostRecord).deviceToken === "string" &&
  (v as HostRecord).via?.kind === "account" &&
  typeof (v as HostRecord).via.hostId === "string";

function hostFile(home: string, alias: string): string {
  return join(hostsDir(home), `${checkedAlias(alias)}.json`);
}

/** The record under this alias, or nothing when this computer holds none: a name that could not be a file, a file
 * that is not there and a file somebody hand-edited into nonsense all read the same. */
export function readHost(home: string, alias: string): HostRecord | undefined {
  if (!aliasOk(alias)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(hostFile(home, alias), "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeHost(home: string, alias: string, record: HostRecord): void {
  // The token in here opens the host, so the record is the owner's: writeOwn says what that means.
  writeOwn(home, relative(home, hostFile(home, alias)), `${JSON.stringify(record, null, 2)}\n`);
}

export function listHosts(home: string): HostEntry[] {
  const dir = hostsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(".json"))
    .map(name => ({ alias: name.slice(0, -".json".length), record: readHost(home, name.slice(0, -".json".length)) }))
    .filter((h): h is { alias: string; record: HostRecord } => h.record !== undefined)
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map(h => ({ alias: h.alias, url: h.record.url, deviceId: h.record.deviceId }));
}

/** Takes the record away. True when there was one to take. */
export function removeHost(home: string, alias: string): boolean {
  if (readHost(home, alias) === undefined) return false;
  rmSync(hostFile(home, alias), { force: true });
  return true;
}

// The rule now lives beside WS_PATH in the protocol, which a place's own agent reads too; the name stays here for
// every caller that already had it from this module.
export { wsUrlOf } from "@wsp/protocol";

/** Which host a line runs against: the host on this computer, an alias for a host on the account, or an address with
 * the token a turn's launch carried for it. */
export type HostAim = { kind: "here" } | { kind: "alias"; alias: string; record: HostRecord } | { kind: "url"; url: string; token?: string; hostKey?: string };

/** An aim at a host on another computer: what a reading that takes the name a line gave hands back, since only the
 * fallbacks under that name can land on this one. */
export type AimElsewhere = Exclude<HostAim, { kind: "here" }>;

/** What a caller names when it asks where to dial: the word a --host flag carried, the environment the caller runs
 * in, and the wsp home holding the hosts folder, which that environment names when the caller does not. */
export interface HostPick {
  host?: string;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

/** What the person reads when a line names a host this computer holds no record for. */
export function noSuchHostLine(alias: string, home: string): string {
  const known = listHosts(home).map(h => h.alias);
  const has = known.length === 0 ? "this computer holds none" : `this computer holds ${known.join(", ")}`;
  return `no host named ${alias} is connected; ${has}, and wsp login puts the hosts on your account here.`;
}

/** Where a person reads which hosts this computer can reach: the one listing. Written once, since every refusal
 * that names a host nobody holds points at it. */
export const READ_THE_HOSTS = runForTheList("wsp hosts");

/** Every record under the hosts folder, with the alias it is under: what wsp hosts rewrites, what a sign-out drops,
 * and what the rule below falls to. */
export function accountRecords(home: string): { alias: string; record: HostRecord }[] {
  return listHosts(home).flatMap(entry => {
    const record = readHost(home, entry.alias);
    return record === undefined ? [] : [{ alias: entry.alias, record }];
  });
}

/** The same, less the host on this computer: a record whose road names the host id in this computer's own relay
 * record is that host, and a line with nothing named goes here as it always did rather than out through the relay
 * and back. Read off the hosts folder and that one record, so every reader of the rule below stays synchronous
 * and offline. */
export function accountHosts(statePath: string, home: string): { alias: string; record: HostRecord }[] {
  const ownId = readRelayRecord(statePath)?.hostId;
  return accountRecords(home).filter(held => held.record.via.hostId !== ownId);
}

/** Which account host a line falls to when nothing else named one: the single one this computer can reach, the
 * several it cannot choose between, or none at all. One reading, so the mark wsp hosts prints and the host a verb
 * dials cannot disagree. */
export type AccountAim = { kind: "one"; alias: string; record: HostRecord } | { kind: "several"; aliases: string[] } | { kind: "none" };

export function accountAim(statePath: string, home: string): AccountAim {
  const held = accountHosts(statePath, home);
  const first = held[0];
  if (held.length === 1 && first !== undefined) return { kind: "one", alias: first.alias, record: first.record };
  return held.length === 0 ? { kind: "none" } : { kind: "several", aliases: held.map(h => h.alias) };
}

/** What the person reads when this computer can reach several hosts on the account: which one a line takes is
 * theirs to say, and naming them once is the whole of it. */
export const severalAccountHostsLine = (aliases: readonly string[]): string =>
  `this computer can reach ${aliases.length} hosts on your account (${aliases.join(", ")}) and none of them is the one every line takes.`;

/** The alias a line with nothing named on it takes: the single account host that is not this computer. Nothing where
 * the rule names none, which is a line that stays on this computer. */
export function aimedAlias(statePath: string, home: string): string | undefined {
  const account = accountAim(statePath, home);
  return account.kind === "one" ? account.alias : undefined;
}

/** What the person reads when a line names an address where an alias goes. An address carries no token, and only an
 * account's admission can make one, so a verb wants the name it holds the host under. */
export function addressNotPairedLine(url: string): string {
  return `--host takes the name of a host on your account; ${url} is an address, and wsp hosts lists the names.`;
}

/** What the person reads when a host answered the socket, refused the token this computer holds, and this computer
 * had no key of its own to prove in its place. */
export function deviceRefusedLine(alias: string): string {
  return `the host ${alias} refused this computer's token, which it has taken away; run wsp logout, wsp login and wsp hosts to sign this computer in again.`;
}

/** What the person reads when a host did not answer at all. Private on purpose: the stamped refusal below is the
 * only way to build this sentence, so no road can raise it as an error a caller cannot tell from a host's own. */
function noAnswerLine(where: string, why: string): string {
  return `the host at ${where} did not answer: ${why}`;
}

/** A host that did not answer at all: the road or the host, never the token this computer holds. A caller whose act
 * cannot be redone once it has moved on tries again on this kind and on no other. */
export function noAnswerRefusal(where: string, why: string): Error {
  return Object.assign(new Error(noAnswerLine(where, why)), { kind: "unreachable" });
}

/** A road that carried nothing before its window was out. The dial waits on one and the hand back's reply waits on
 * another, so the words for that wait are written here once rather than at each of them. */
export function noAnswerWithin(where: string, windowMs: number): Error {
  return noAnswerRefusal(where, `nothing came back within ${windowMs} ms`);
}

/** The window for a host that answers over loopback, where an answer that is late is a host that is gone. */
const NEAR_WINDOW_MS = 5_000;
/** The window for a host at an address off this computer, which is reached through whatever sits between: for a box
 * behind a relay that is DNS, a content delivery edge and the tunnel's connector. Measured on that road, a warm
 * tunnel opens the socket and answers the first frame in 0.3 s, while an edge whose tunnel has just come up holds a
 * request for 5.8 s before it answers anything at all, and a busy box answers later still. */
const FAR_WINDOW_MS = 15_000;

/** How long a dial waits for its socket and for the answer to its first frame, by the road the host is on. Read
 * here by every dial, since a loopback's window on a relayed road calls a host that is answering dead. */
export function dialWindowMs(aim: HostAim): number {
  if (aim.kind === "here") return NEAR_WINDOW_MS;
  // A record a hand edited holds any word at all, and the window a dial gets is no place to throw over one: a word
  // the protocol's own reading of an address cannot read is not loopback either, so it takes the longer window.
  const where = servedHostname(aimAddress(aim));
  return where !== undefined && isLoopback(where) ? NEAR_WINDOW_MS : FAR_WINDOW_MS;
}

/** Why a line that runs at the host's own terminal cannot be aimed anywhere else. Its own sentence per line, since
 * what a person may not do from here differs: hand out access, or carry a vault off. */
export const HOST_SIDE_ACCESS = "Handing out access is the one thing a paired computer cannot do from here.";

/** What the person reads when a line that runs at the host's own terminal is aimed at one on another computer: the
 * thing it does happens over there and nowhere else, so there is no road from here to there. Every way a line is
 * aimed reads the same, whether a --host flag, WSP_HOST or the account's one host did the aiming. */
export function hostSideOnlyLine(word: string, where: string): string {
  return `wsp ${word} runs on the computer the host runs on, and this line is aimed at ${where}.`;
}

/** What to do about it: the same line, typed over there. `why` says what a paired computer may not do from here. */
export function hostSideOnlyFix(why: string = HOST_SIDE_ACCESS): string {
  return `Run it in a terminal over there. ${why}`;
}

/** The note a line naming both --state and a host somewhere else gets: the state file is this computer's, and a
 * host elsewhere serves its own. */
export function stateIgnoredLine(where: string): string {
  return `--state names a file on this computer and this line runs against ${where}, which serves its own, so it is not read.`;
}

/** The host a line names outright: the --host word, then WSP_HOST, and nothing when neither names one. Read apart
 * from the fallbacks below it because a line that answers about this computer (wsp status) moves only when a
 * person named a host, while a verb, which has a host to speak to either way, follows the fallbacks too. */
export function namedHost(pick: HostPick = {}): AimElsewhere | undefined {
  const env = pick.env ?? process.env;
  const named = [pick.host, env["WSP_HOST"]].map(w => w?.trim()).find(w => w !== undefined && w !== "");
  return named === undefined ? undefined : aimAt(named, pick.home ?? wspHome(env), env);
}

/** The one reading of which host a line runs against: the name it was given, then the pair a turn's launch left
 * in the environment, then the host on this computer serving the state file, then the account's one host. The command
 * line and the tool server both come here, so a verb and a tool started the same way go to the same host. */
export function aimedHost(statePath: string, pick: HostPick = {}): HostAim {
  const env = pick.env ?? process.env;
  const home = pick.home ?? wspHome(env);
  const named = namedHost(pick);
  if (named !== undefined) return named;
  // The pair is the identity the launch handed this turn, and it goes ahead of anything this computer holds: a
  // guest's default state file is a path nothing serves, and a turn on this computer under a host that does serve
  // it was still given its own token and not the host's. What a person types on the line still wins above.
  const carried = hostFromEnv(env);
  if (carried !== undefined) return keyed({ kind: "url", url: carried.url, token: carried.token, ...(carried.hostKey === undefined ? {} : { hostKey: carried.hostKey }) }, LAUNCHED_WITH);
  if (servingHost(statePath) !== undefined) return { kind: "here" };
  // Nothing serves here and this computer is signed in: the one host on the account it can reach is where the line
  // goes, which is what signing in was for, and no host is started here. Several of them is the person's to settle;
  // none at all, or no sign-in, and a host starts here exactly as it did before.
  const account = accountAim(statePath, home);
  if (account.kind === "one") return keyed({ kind: "alias", alias: account.alias, record: account.record }, account.alias);
  if (account.kind === "several") throw usageRefusal(severalAccountHostsLine(account.aliases), `Name one on the line with --host <name>.\n\n${READ_THE_HOSTS}`);
  return { kind: "here" };
}

function aimAt(named: string, home: string, env: Readonly<Record<string, string | undefined>>): AimElsewhere {
  // An address with a token beside it in this environment is a host this line may drive; one without is refused at
  // the dial, since nothing on this computer holds a token for it.
  if (isUrl(named)) {
    const carried = hostFromEnv(env);
    const here = carried?.url === named ? carried : undefined;
    return keyed({ kind: "url", url: named, ...(here === undefined ? {} : { token: here.token, ...(here.hostKey === undefined ? {} : { hostKey: here.hostKey }) }) }, named);
  }
  const record = readHost(home, named);
  if (record === undefined) throw usageRefusal(noSuchHostLine(named, home), READ_THE_HOSTS);
  return keyed({ kind: "alias", alias: named, record }, named);
}

/** The one rule for an aim that carries a token: this computer holds the fingerprint of the key that host proves
 * before it sends the token anywhere, so a relay that named the address, or anyone else on the road, is answered
 * by the host itself or by nobody. Every road an aim comes by is read here, the record a person named and the
 * launch a turn started with alike, and `where` names which so the person knows which one to look at. An address on
 * this computer's own loopback is what a line aimed at the host here is, and dials as one: there is no road
 * between two ports of one computer for anybody to stand on. */
function keyed(aim: AimElsewhere, where: string): AimElsewhere {
  const held = aimHolds(aim);
  if (held.token === undefined || held.hostKey !== undefined) return aim;
  const at = servedHostname(aimAddress(aim));
  if (at !== undefined && isLoopback(at)) return aim;
  throw authRefusal(hostNoKeyLine(where));
}

/** What an aim at a host elsewhere holds for it: the token it would present, and the fingerprint of the key it
 * holds that host to. One reading, so the rule above that refuses an aim with no key and the dial that pins the
 * key before it sends the token cannot disagree about what a record or a launch carried. */
export function aimHolds(aim: AimElsewhere): { token: string | undefined; hostKey: string | undefined } {
  return aim.kind === "alias" ? { token: aim.record.deviceToken, hostKey: aim.record.hostKey } : { token: aim.token, hostKey: aim.hostKey };
}

/** How a host is named in a line the person reads: the alias where there is one, the address otherwise. */
export function aimName(aim: HostAim): string {
  return aim.kind === "alias" ? aim.alias : aim.kind === "url" ? aim.url : "this computer";
}

/** Where a host on another computer answers, for the lines that print the address beside the name. The aim for
 * this computer carries none: its address is the one its own lock records, which those lines read there. */
export function aimAddress(aim: AimElsewhere): string {
  return aim.kind === "alias" ? aim.record.url : aim.url;
}
