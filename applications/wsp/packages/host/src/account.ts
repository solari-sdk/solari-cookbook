// SPDX-License-Identifier: AGPL-3.0-only
// The three files this computer keeps about an account: the record a linked
// host holds beside its state, the record a person's own computer holds in the
// wsp home, and the device key that computer signs with. Written apart from
// the relay's own lines because the rule that decides which host a line runs
// against reads the first of them and may not load the command line's listings
// to do it.
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeOwn } from "@wsp/own-file";
import { keyFingerprint, newPlaceKeyPair, type PlaceKeyPair } from "@wsp/keys";

/** The key of the computer this wsp runs on, as a host records it and as an admission names it. The private half
 * never leaves the file it is written in; the fingerprint is what a host holds a signer to. */
export interface DeviceKey {
  fingerprint: string;
  publicKey: string;
}

/** What a linked box keeps: which relay it is on, which host it is there, and the token that names it. The token
 * opens the relay's own routes for this host and nothing else. */
export interface RelayRecord {
  relayUrl: string;
  hostId: string;
  token: string;
  name: string;
  /** The account the approval was signed in under, where the relay named it; a relay that names none leaves it out
   * and the account is known only as signed in. */
  login?: string;
  /** Where this box answers from anywhere, once it has a tunnel; a quick tunnel's name changes at every start. */
  hostname?: string;
  /** The device key of the computer that put this host on the account, which is the one key this host trusts to
   * sign another computer's admission until a device admitted here signs the next. Recorded at the link, and at
   * the first start of a host that was linked before this wsp wrote it. */
  deviceKey?: DeviceKey;
  linkedAt: string;
}

/** What a person's own computer keeps: the relay it signed in to and the token that lists the hosts on its account. */
export interface RelayClientRecord {
  relayUrl: string;
  token: string;
  name: string;
  /** As on a host's record: the account the approval named, where the relay named one. */
  login?: string;
  /** The fingerprint this computer signed in under, so a listing can mark its own row and a word it prints names
   * the key a host will be asked to admit. */
  fingerprint?: string;
  linkedAt: string;
}

const isRecord = (v: unknown): v is RelayRecord =>
  typeof v === "object" && v !== null && typeof (v as RelayRecord).relayUrl === "string" && typeof (v as RelayRecord).hostId === "string" && typeof (v as RelayRecord).token === "string";

const isClientRecord = (v: unknown): v is RelayClientRecord =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as RelayClientRecord).relayUrl === "string" &&
  typeof (v as RelayClientRecord).token === "string" &&
  (v as RelayRecord).hostId === undefined;

const isKeyPair = (v: unknown): v is PlaceKeyPair =>
  typeof v === "object" && v !== null && typeof (v as PlaceKeyPair).publicKey === "string" && typeof (v as PlaceKeyPair).privateKeyPem === "string";

function readJsonFile<T>(path: string, holds: (v: unknown) => v is T): T | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return holds(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The token and the key in these files open a relay and sign for a computer, so they go through the one writer of
 * the owner's files. */
export function writeJsonFile(path: string, value: unknown): void {
  writeOwn(dirname(path), basename(path), `${JSON.stringify(value, null, 2)}\n`);
}

export function relayRecordPath(statePath: string): string {
  return join(dirname(statePath), "relay.json");
}

export function readRelayRecord(statePath: string): RelayRecord | undefined {
  return readJsonFile(relayRecordPath(statePath), isRecord);
}

export function writeRelayRecord(statePath: string, record: RelayRecord): void {
  writeJsonFile(relayRecordPath(statePath), record);
}

export function removeRelayRecord(statePath: string): void {
  rmSync(relayRecordPath(statePath), { force: true });
}

/** The person's own token, not the box's: the two live on one computer whenever a person drives their own host,
 * and the state folder is the wsp home by default, so they cannot share a name. */
export function clientRecordPath(home: string): string {
  return join(home, "relay-client.json");
}

export function readRelayClient(home: string): RelayClientRecord | undefined {
  return readJsonFile(clientRecordPath(home), isClientRecord);
}

export function writeRelayClient(home: string, record: RelayClientRecord): void {
  writeJsonFile(clientRecordPath(home), record);
}

export function removeRelayClient(home: string): void {
  rmSync(clientRecordPath(home), { force: true });
}

export function deviceKeyPath(home: string): string {
  return join(home, "device-key.json");
}

export function readDeviceKeyPair(home: string): PlaceKeyPair | undefined {
  return readJsonFile(deviceKeyPath(home), isKeyPair);
}

/** The key this computer signs an admission with, minted the first time a line needs one and kept from then on.
 * One key per wsp home, made and written the way a host's own place key is: it opens nothing by itself, so it
 * stays when a sign-out takes the token away, and a computer admitted to a host keeps the key that host trusts. */
export function deviceKeyHere(home: string): PlaceKeyPair {
  const held = readDeviceKeyPair(home);
  if (held !== undefined) return held;
  const made = newPlaceKeyPair();
  writeJsonFile(deviceKeyPath(home), made);
  return made;
}

/** The public half of this computer's key, as a host records it and as a listing names it. */
export const deviceKeyOf = (pair: PlaceKeyPair): DeviceKey => ({ fingerprint: keyFingerprint(pair.publicKey), publicKey: pair.publicKey });
