// SPDX-License-Identifier: AGPL-3.0-only
// The image's vault: what the sign-in and secrets stages left on the builder,
// archived off it before the snapshot so every other place builds its copy of
// the image from the record and never runs a sign-in again. Separate from the
// nap-time vault of a workspace's home (vault.ts's own callers): that one
// carries a machine's work, this one carries the person's logins.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { shellQuote, vaultMemberRefusal, type SealedPin, type VaultRoad } from "@wsp/protocol";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import type { Machine } from "./machine.js";
import { exportPaths, importInto, type VaultOptions } from "./vault.js";

export interface ImageVault {
  tar: Buffer;
  sha256: string;
  /** How many of the paths asked for were on the machine and went into the archive. */
  paths: number;
  /** The paths that went in, absolute, as the record keeps them: what every member of the archive is judged against. */
  held: string[];
}

/** tar refuses an operand that is not there and the whole export fails with it, so the paths are read first and
 * only the ones that exist are archived: a machine whose person never signed a tool in still seals. The loop ends
 * on an exit of its own, since a missing last path would otherwise leave `[ -e ]`'s 1 as the whole command's and
 * read as a machine that would not answer. Any other exit is exactly that, and the seal stops on it rather than
 * sealing an image whose sign-ins nobody could read. */
export async function presentPaths(machine: Machine, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const probe = `for p in ${paths.map(shellQuote).join(" ")}; do [ -e "$p" ] && echo "$p"; done; exit 0`;
  const read = await machine.exec(probe, { timeoutMs: INLINE_EXEC_MS });
  if (read.exitCode !== 0) {
    throw new Error(`the machine would not say which of the image's sign-in paths it holds (exit ${read.exitCode}): ${read.stderr.slice(-200)}`);
  }
  const found = new Set(read.stdout.split("\n").map(l => l.trim()).filter(l => l !== ""));
  return paths.filter(p => found.has(p));
}

/** The tar of the paths that are on the machine, from `/`, and its sha256. Every member is read here, against the
 * paths that were asked for, so a builder that hands back more than it was asked for fails the seal on the person's
 * own place with the member named, rather than at a copy somewhere else. */
export async function exportImageVault(machine: Machine, paths: readonly string[], opts: VaultOptions = {}): Promise<ImageVault> {
  const present = await presentPaths(machine, paths);
  const tar = await exportPaths(machine, present, opts);
  refuseForeignMembers("seal", tar, present);
  return { tar, sha256: createHash("sha256").update(tar).digest("hex"), paths: present.length, held: present };
}

/** Lands a vault over `/` on a fresh builder; the paths it carries are the ones the sign-in stages would have
 * written. An overlay, since the pack has already written the config beside the login under the same folders and a
 * wholesale replace of those folders would take it with it. */
export async function importImageVault(machine: Machine, tar: Buffer, opts: VaultOptions = {}): Promise<void> {
  await importInto(machine, tar, "/", { ...opts, overlay: true });
}

/** One member of a vault archive as the guest's tar would extract it under `-C /`: the name it lands at, what it
 * is, and the target it points at when it is a link. */
export interface VaultMember {
  /** The name as the header carries it, before any rooting; the refusal names it as the archive wrote it. */
  name: string;
  kind: "file" | "dir" | "symlink" | "hardlink";
  /** A symbolic link's target as written, a hard link's target as the archive names it. */
  target?: string;
}

const TAR_BLOCK = 512;
/** The pax keys this reader knows. A record carrying any other changes what tar extracts in a way nothing here
 * reads, and the whole point of this reading is that it sees what tar sees. */
const PAX_READ = new Set(["path", "linkpath", "size"]);

const refusal = (road: VaultRoad, where: string, why: string): Error => new Error(vaultMemberRefusal(road, where, why));

/** A NUL-ended string field. */
const fieldText = (block: Buffer, at: number, length: number): string => {
  const raw = block.subarray(at, at + length);
  const end = raw.indexOf(0);
  return (end === -1 ? raw : raw.subarray(0, end)).toString("utf8");
};

/** A ustar numeric field as tar reads it: octal digits ended by a NUL or a space. A field whose first byte carries
 * the high bit is base-256, a form this reader does not read, and a header it cannot read is refused rather than
 * guessed at. */
const fieldNumber = (road: VaultRoad, block: Buffer, at: number, length: number, where: string, what: string): number => {
  const raw = block.subarray(at, at + length);
  if ((raw[0]! & 0x80) !== 0) throw refusal(road, where, `its ${what} is written base-256, a form this reading does not read`);
  const text = raw.toString("latin1").replace(/\0/g, " ").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw refusal(road, where, `its ${what} is not an octal number`);
  return Number.parseInt(text, 8);
};

/** The checksum as tar checks it: the header summed with its own checksum field read as spaces, matched against the
 * field as the unsigned sum and as the signed sum, since tars have written both. A header that fails is refused
 * here and never skipped: skipping one is how a reader and tar come to disagree about where the next header is. */
const checksumOk = (road: VaultRoad, block: Buffer, where: string): boolean => {
  const want = fieldNumber(road, block, 148, 8, where, "checksum");
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i]!;
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return want === unsigned || want === signed;
};

/** The pax records of an `x` block's data: `<len> <key>=<value>\n`, each read whole. */
const paxOf = (road: VaultRoad, data: Buffer, where: string): { path?: string; linkpath?: string; size?: number } => {
  const held: { path?: string; linkpath?: string; size?: number } = {};
  let at = 0;
  while (at < data.length) {
    if (data[at] === 0) break;
    const space = data.indexOf(0x20, at);
    if (space === -1) throw refusal(road, where, "its pax record has no length");
    const length = Number(data.subarray(at, space).toString("latin1"));
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) throw refusal(road, where, "its pax record runs past the block it is written in");
    const record = data.subarray(space + 1, at + length).toString("utf8").replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq === -1) throw refusal(road, where, "its pax record carries no key");
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1);
    if (!PAX_READ.has(key)) throw refusal(road, where, `its pax record carries ${key}, which this reading does not read`);
    if (key === "size") {
      const size = Number(value);
      if (!Number.isInteger(size) || size < 0) throw refusal(road, where, "its pax size is not a whole number of bytes");
      held.size = size;
    } else if (key === "path") held.path = value;
    else held.linkpath = value;
    at += length;
  }
  return held;
};

/** Every member of a gzipped tar, read on this computer as the guest's tar would extract it. Every divergence from
 * that reading is a refusal of the whole archive rather than a skip: a member this side passes over and tar lands
 * is the hole the member rule stands in front of. */
export function vaultMembers(road: VaultRoad, tar: Buffer): VaultMember[] {
  let raw: Buffer;
  try {
    raw = gunzipSync(tar);
  } catch (e) {
    throw refusal(road, "its first bytes", `they do not decompress as tar's gzip reads them (${e instanceof Error ? e.message : String(e)})`);
  }
  if (raw.length % TAR_BLOCK !== 0) throw refusal(road, "its last bytes", `the archive is ${raw.length} bytes, which is not a whole number of tar blocks`);
  const members: VaultMember[] = [];
  let pax: { path?: string; linkpath?: string; size?: number } | undefined;
  let longName: string | undefined;
  let longLink: string | undefined;
  for (let at = 0; at < raw.length; at += TAR_BLOCK) {
    const where = `block ${at / TAR_BLOCK}`;
    const block = raw.subarray(at, at + TAR_BLOCK);
    if (block.every(b => b === 0)) {
      // Two zero blocks end tar's read and everything behind them is nothing tar extracts; one on its own is a
      // stream that stopped mid-archive.
      if (at + 2 * TAR_BLOCK <= raw.length && raw.subarray(at + TAR_BLOCK, at + 2 * TAR_BLOCK).every(b => b === 0)) return members;
      throw refusal(road, where, "a zero block stands where tar reads two to end the archive");
    }
    const ustar = raw.subarray(at + 257, at + 263).toString("latin1") === "ustar\0";
    const gnu = raw.subarray(at + 257, at + 265).toString("latin1") === "ustar  \0";
    if (!ustar && !gnu) throw refusal(road, where, "its header is neither a ustar nor a GNU header");
    if (!checksumOk(road, block, where)) throw refusal(road, where, "its header fails its own checksum");
    const type = block[156] === 0 ? "0" : String.fromCharCode(block[156]!);
    const size = pax?.size ?? fieldNumber(road, block, 124, 12, where, "size");
    const dataBlocks = Math.ceil(size / TAR_BLOCK);
    const dataAt = at + TAR_BLOCK;
    if (dataAt + dataBlocks * TAR_BLOCK > raw.length) throw refusal(road, where, "its data runs past the end of the archive");
    const data = raw.subarray(dataAt, dataAt + size);
    at += dataBlocks * TAR_BLOCK;
    if (type === "x" || type === "L" || type === "K") {
      // A member named twice over is a member two readers name differently. GNU writes a long name and a long link
      // target for one member, which is one description in two entries and is read as one.
      if (pax !== undefined || (type === "x" && (longName !== undefined || longLink !== undefined))) throw refusal(road, where, "one member carries both a pax record and a long name entry");
      if (type === "L" ? longName !== undefined : type === "K" && longLink !== undefined) throw refusal(road, where, "one member carries two long name entries of the same kind");
      if (type === "x") pax = paxOf(road, data, where);
      else if (type === "L") longName = fieldText(data, 0, data.length);
      else longLink = fieldText(data, 0, data.length);
      continue;
    }
    if (type !== "0" && type !== "1" && type !== "2" && type !== "5") throw refusal(road, where, `its type flag is ${type}, which is not a file, a folder or a link`);
    if (type !== "0" && size !== 0) throw refusal(road, where, "a folder or a link carries data, so where its next header stands cannot be read");
    const prefix = ustar ? fieldText(block, 345, 155) : "";
    const named = fieldText(block, 0, 100);
    const name = pax?.path ?? longName ?? (prefix === "" ? named : `${prefix}/${named}`);
    const target = pax?.linkpath ?? longLink ?? fieldText(block, 157, 100);
    pax = undefined;
    longName = undefined;
    longLink = undefined;
    const kind = type === "5" ? "dir" : type === "2" ? "symlink" : type === "1" ? "hardlink" : "file";
    members.push({ name, kind, ...(kind === "symlink" || kind === "hardlink" ? { target } : {}) });
  }
  throw refusal(road, "its last bytes", "the archive ends without the two zero blocks tar reads to end it");
}

/** Where a name lands under `-C /`, as tar roots it: leading slashes and `.` segments gone. Nothing where a `..`
 * segment walks out, which tar refuses to extract at all. */
const landsAt = (name: string): string | undefined => {
  const parts = name.split("/").filter(p => p !== "" && p !== ".");
  return parts.includes("..") ? undefined : `/${parts.join("/")}`;
};

/** Where a symbolic link's target points: a path on the guest, absolute as written or read from the folder the
 * link itself lands in. */
const pointsAt = (target: string, from: string): string | undefined => {
  const parts = (target.startsWith("/") ? target : `${from.slice(0, from.lastIndexOf("/"))}/${target}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (out.pop() === undefined) return undefined;
  }
  return `/${out.join("/")}`;
};

const underHeld = (path: string, held: readonly string[]): boolean =>
  held.some(h => {
    const root = landsAt(h);
    return root !== undefined && (path === root || path.startsWith(`${root}/`));
  });

/** Why a member may not land, or nothing when it may: the one rule the seal and the copy both read. A name that
 * walks out with `..`, a name outside the paths the seal asked for, and a link pointing out of them are the three
 * ways an archive reaches somewhere nobody asked it to. A hard link's target is an archive name and is rooted
 * where tar extracts, never against the link's own folder, since tar links the new name to that file itself. */
export function refusedMember(member: VaultMember, held: readonly string[]): string | undefined {
  const lands = landsAt(member.name);
  if (lands === undefined) return "its name walks out of where it lands with ..";
  if (!underHeld(lands, held)) return `it lands at ${lands}, which is not one of the paths the seal asked for or under one`;
  if (member.target === undefined || member.target === "") return undefined;
  const points = member.kind === "hardlink" ? landsAt(member.target) : pointsAt(member.target, lands);
  if (points === undefined || !underHeld(points, held)) return `it points at ${member.target}, which is not under the paths the seal asked for`;
  return undefined;
}

/** The archive against the paths the seal asked for, read whole before any of it is handed to a machine: one member
 * outside them refuses all of it, since a builder that wrote that member wrote every other one too. */
export function refuseForeignMembers(road: VaultRoad, tar: Buffer, held: readonly string[]): void {
  for (const member of vaultMembers(road, tar)) {
    const why = refusedMember(member, held);
    if (why !== undefined) throw new Error(vaultMemberRefusal(road, member.name, why));
  }
}

/** The header the image hash is taken under, so a hash can never be read as one of another rule's. */
const IMAGE_HASH_RULE = "wsp-image-2";
/** What an image with no vault hashes as: its own word, never the empty string, so a record with no vault and one
 * whose vault hashed to nothing are different images. */
const NO_VAULT = "none";
/** What a row that installs latest hashes as in place of its version: the version is what one seal got, not what
 * a copy is fixed to, so two records that differ only there are the same image. */
const LATEST = "latest";

/** One rule for the image hash: the recipe the copy is built from, the vault it imports and the pins it installs
 * at, in id order, and nothing else. */
export function imageHash(recipeHash: string, vaultSha256: string | undefined, pins: readonly SealedPin[]): string {
  const fixed = [...pins].sort((a, b) => a.id.localeCompare(b.id)).map(p => [p.id, p.latest === true ? LATEST : p.tag, p.sha256 ?? ""]);
  return createHash("sha256").update(`${IMAGE_HASH_RULE}\n${recipeHash}\n${vaultSha256 ?? NO_VAULT}\n${JSON.stringify(fixed)}`).digest("hex");
}
