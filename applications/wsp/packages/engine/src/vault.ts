import { createHash } from "node:crypto";
import { hasByteRoad, landBytes } from "./land-bytes.js";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { relative } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { shellQuote, vaultOverCapLine } from "@wsp/protocol";
import { backoffMs, classify, shouldRetry } from "./errors.js";
import { GUEST_TMP, INLINE_EXEC_MS } from "./exec-detached.js";
import { plural } from "./golden-tools.js";
import type { Machine } from "./machine.js";

type Fetch = typeof globalThis.fetch;

export interface VaultOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  /** Export only: an archive over this many bytes is removed and refused with kind vaultTooLarge. */
  maxBytes?: number;
  /** exportPaths only: what the archive leaves behind under each path, judged before the size is read. */
  exclude?: CacheRule;
  /** exportPaths only: absolute guest paths the archive leaves behind whatever the rule says, so what stands at each
   * on the destination is left alone. A directory holding one of them travels as its contents and not as itself:
   * --recursive-unlink replaces a directory it extracts wholesale, and would take the copy left behind with it. */
  drop?: readonly string[];
  /** Import only: merge into what the destination already holds instead of replacing its directories. */
  overlay?: boolean;
  /** The folder on the machine the trip's own parts are written in; the machine's shared temporary one unless the
   * caller names wsp's own folder there, which a machine somebody owns needs. */
  tmpDir?: string;
  /** Import only: called as each part lands, with the bytes sent so far. */
  onPart?: (progress: UploadProgress) => void;
  /** Export only: called as the archive comes down, with the bytes received so far of its total. */
  onProgress?: (progress: DownloadProgress) => void;
  /** Export only: how the archive comes off the machine. The provider's signed URL by default, which is every
   * caller that has one. `exec` reads it back as base64 through the one call every backend has, for a machine
   * whose provider mints no URL (a container, one reached over ssh, this computer); it holds the whole archive in
   * memory twice on the way, so it is refused over EXEC_READ_CAP and is only for archives known to be small. */
  readRoad?: "signed-url" | "exec";
}

/** The most an archive read back through exec may weigh. Measured nothing: it is the bound that keeps a road with
 * no streaming from being handed a disk image, and the refusal above it names the size. */
export const EXEC_READ_CAP = 16 * 1024 * 1024;

export interface DownloadProgress {
  bytes: number;
  total: number;
}

export interface UploadProgress {
  part: number;
  parts: number;
  bytes: number;
  total: number;
  /** The pieces the part was cut into where the road it took cuts them, one call each; absent on a road that
   * takes the part whole. */
  pieces?: number;
}

const feed = async (sink: Writable, chunk: Buffer): Promise<void> => {
  if (!sink.write(chunk)) await once(sink, "drain");
};

/** The archive at path on the guest, brought down over its signed URL into `sink` as it arrives; total is the size
 * read on the guest when the caller has it, else the bytes seen so far. */
async function download(machine: Machine, path: string, sink: Writable, opts: VaultOptions, total?: number): Promise<void> {
  if (opts.readRoad === "exec") return execRead(machine, path, sink, opts, total);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = await machine.downloadUrl(path);
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`vault export download failed: HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length"));
  const known = total ?? (Number.isFinite(length) && length > 0 ? length : undefined);
  // A 200 off the wire always carries a body, empty archive or not, so a missing one is a download that gave nothing.
  if (res.body === null) throw new Error(`vault export download failed: HTTP ${res.status} with no body`);
  opts.onProgress?.({ bytes: 0, total: known ?? 0 });
  let bytes = 0;
  const reader = res.body.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    await feed(sink, Buffer.from(next.value));
    bytes += next.value.length;
    opts.onProgress?.({ bytes, total: known ?? bytes });
  }
}

/** The archive read back through the one call every backend has, base64 on stdout. Its size is read on the guest
 * first, so an archive too big for a road with no streaming is refused before any of it is in memory. */
async function execRead(machine: Machine, path: string, sink: Writable, opts: VaultOptions, total?: number): Promise<void> {
  const bytes = total ?? (await guestFileSize(machine, path));
  if (bytes > EXEC_READ_CAP) {
    throw Object.assign(new Error(`the archive on the machine is ${bytes} bytes and this provider mints no download URL, so it comes back through one command, which is capped at ${EXEC_READ_CAP}`), { kind: "vaultTooLarge", bytes });
  }
  opts.onProgress?.({ bytes: 0, total: bytes });
  const read = await machine.exec(`base64 < ${shellQuote(path)}`, { timeoutMs: opts.timeoutMs ?? 120_000 });
  if (read.exitCode !== 0) throw new Error(`vault export read failed (exit ${read.exitCode}): ${read.stderr.slice(-500)}`);
  const body = Buffer.from(read.stdout.replace(/\s+/g, ""), "base64");
  if (body.length !== bytes) throw new Error(`vault export read failed: the machine held ${bytes} bytes and ${body.length} came back`);
  await feed(sink, body);
  opts.onProgress?.({ bytes: body.length, total: bytes });
}

/** A download held in memory: the road for an archive a caller keeps as bytes, like the vault a wake stores. */
async function downloadBuffer(machine: Machine, path: string, opts: VaultOptions, total?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await download(machine, path, new Writable({ write: (chunk: Buffer, _enc, done) => { chunks.push(chunk); done(); } }), opts, total);
  return Buffer.concat(chunks);
}

/** A download streamed into a file on this computer, so an archive of a whole project never sits in memory; a
 * download that fails leaves no file behind. Returns the bytes written. */
async function downloadFile(machine: Machine, path: string, into: string, opts: VaultOptions, total?: number): Promise<number> {
  const out = createWriteStream(into);
  try {
    await download(machine, path, out, opts, total);
    out.end();
    await finished(out);
  } catch (e) {
    // The open runs on the thread pool: a removal before it lands leaves the file the open then creates.
    out.destroy();
    await finished(out).catch(() => {});
    await rm(into, { force: true });
    throw e;
  }
  return (await stat(into)).size;
}

/** What a folder's archive leaves behind: a directory whose whole name is in dirs, a file whose whole name is in
 * files, and a directory holding one of the marker files, whatever its name. Names, never substrings, so a source
 * file or a folder that only holds the word cache stays. */
export interface CacheRule {
  dirs: readonly string[];
  files: readonly string[];
  markers: readonly string[];
}

/** The script that archives `targets`, paths relative to `cwd`, into `out` with the rule's caches left behind. One
 * find names every cache root under the rule on stdout, one per line as find spelled them minus a leading ./ ; a
 * second lists every entry kept, NUL separated, and tar takes that list with recursion off: both tars' exclude
 * patterns match a name at any depth, so a file called dist would otherwise go with the dist directory. Nothing under
 * a .git directory is judged, so a repository travels whole. `drop` names exact paths the archive leaves behind
 * whatever the rule says. Only find and tar features both GNU and BSD have. */
function excludingArchiveScript(cwd: string, targets: readonly string[], rule: CacheRule, out: string, drop: readonly string[] = []): string {
  const names = (list: readonly string[]): string => list.map(n => `-name ${shellQuote(n)}`).join(" -o ");
  const paths = (list: readonly string[]): string => `\\( ${list.map(p => `-path ${shellQuote(asPattern(p))}`).join(" -o ")} \\)`;
  const named = [
    ...(rule.dirs.length === 0 ? [] : [`\\( -type d \\( ${names(rule.dirs)} \\) \\)`]),
    ...(rule.files.length === 0 ? [] : [`\\( -type f \\( ${names(rule.files)} \\) \\)`]),
    ...rule.markers.map(m => `\\( -type d -exec test -f ${shellQuote(`{}/${m}`)} \\; \\)`),
  ];
  const cache = `\\( ${named.length === 0 ? "-false" : named.join(" -o ")} \\)`;
  const skip = drop.length === 0 ? cache : `\\( ${cache} -o ${paths(drop)} \\)`;
  // Every directory the archive would carry that holds a dropped path: it stays out of the archive while everything
  // under it travels, which is how a dropped file's neighbours land without --recursive-unlink taking the copy the
  // destination keeps. One that is a starting point leaves by not being on the list tar is handed; only one below a
  // starting point needs a predicate, since -mindepth 1 means find never tests a starting point at all.
  const held = ancestorsOf(drop).filter(h => targets.some(t => t === h || h.startsWith(`${t}/`)));
  const walked = held.filter(h => targets.some(t => h.startsWith(`${t}/`)));
  const flat = walked.length === 0 ? "" : `${paths(walked)} -o `;
  const gone = new Set([...drop, ...held]);
  const where = targets.map(shellQuote).join(" ");
  const carried = targets.filter(t => !gone.has(t));
  const list = `${out}.list`;
  const keep = `${out}.keep`;
  return [
    "set -eo pipefail",
    `cd ${shellQuote(cwd)}`,
    `find ${where} -mindepth 1 -path '*/.git' -prune -o ${skip} -prune -print > ${shellQuote(list)}`,
    carried.length === 0 ? `: > ${shellQuote(keep)}` : `printf '%s\\0' ${carried.map(shellQuote).join(" ")} > ${shellQuote(keep)}`,
    `find ${where} -mindepth 1 \\( -path '*/.git' -o -path '*/.git/*' \\) -print0 -o ${skip} -prune -o ${flat}-print0 >> ${shellQuote(keep)}`,
    `tar czf ${shellQuote(out)} --no-recursion --null -T ${shellQuote(keep)}`,
    `sed 's|^\\./||' ${shellQuote(list)}`,
    `rm -f ${shellQuote(list)} ${shellQuote(keep)}`,
  ].join("\n");
}

/** A path as find's -path takes it: that is an fnmatch pattern, so a folder a person named with a bracket or a star
 * in it would otherwise match some other path and drop that one instead. */
const asPattern = (path: string): string => path.replace(/[\\*?[]/g, m => `\\${m}`);

/** Every directory above the dropped paths, as the archive spells them; the caller keeps the ones the archive holds. */
function ancestorsOf(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) for (let cut = p.lastIndexOf("/"); cut > 0; cut = p.lastIndexOf("/", cut - 1)) out.add(p.slice(0, cut));
  return [...out];
}

/** The script that archives a folder on the guest from its own root into `out`, its caches left behind under the rule. */
export function folderExportScript(dir: string, rule: CacheRule, out: string): string {
  return excludingArchiveScript(dir, ["."], rule, out);
}

/** A path on the machine for one trip's own file or directory, named so two trips never write the same one. The
 * folder it sits in is the caller's to name: /tmp on a machine wsp made, whose whole disk is wsp's, and wsp's own
 * folder under the login's home on a machine somebody else owns, where a folder every account on it shares is a
 * folder another account can sit in first. */
export const guestTmpPath = (what: string, dir: string = GUEST_TMP): string => `${dir.replace(/\/+$/, "")}/${what}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Paths to archive from one root on the guest: the directory tar runs in and absolute paths under it, which travel
 * at their path relative to it. A filtered copy written under a scratch root that mirrors the homes travels at the
 * path it mirrors, so the archive holds it where the store it replaces would have been. */
export interface ArchiveGroup {
  root: string;
  paths: readonly string[];
}

/** A path as tar names it from its group's root; the root group keeps its own spelling, since exportPaths is handed
 * paths relative to it as well as absolute ones and relative() would resolve those against this computer's cwd. */
const tarPath = (root: string, path: string): string => (root === "/" ? path.replace(/^\//, "") : relative(root, path));

/** The one tar that archives every group into `out`, each group from its own root. */
const groupArchiveScript = (groups: readonly ArchiveGroup[], out: string): string =>
  `tar czf ${shellQuote(out)} ${groups.map(g => `-C ${shellQuote(g.root)} ${g.paths.map(p => shellQuote(tarPath(g.root, p))).join(" ")}`).join(" ")}`;

/** The byte size of a file on the guest, read the one way both GNU and BSD spell it. */
async function guestFileSize(machine: Machine, path: string): Promise<number> {
  const size = await machine.exec(`wc -c < ${shellQuote(path)}`, { timeoutMs: INLINE_EXEC_MS });
  const bytes = Number(size.stdout.trim());
  if (size.exitCode !== 0 || !Number.isFinite(bytes)) throw new Error(`the archive's size on the machine is unknown: ${size.stderr.slice(-200)}`);
  return bytes;
}

/** Archives what `script` names into a temp file on the guest, refuses one over the cap, hands the archive's guest
 * path to `bring`, and removes it from the guest whatever happens. */
async function archiveOf<T>(machine: Machine, script: (out: string) => string, opts: VaultOptions, bring: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = `${guestTmpPath("wsp-vault")}.tgz`;
  const tar = await machine.run(script(tmp), { deadlineMs: opts.timeoutMs ?? 120_000 });
  if (tar.exitCode !== 0) {
    throw new Error(`vault export tar failed (exit ${tar.exitCode}): ${tar.stderr.slice(-500)}`);
  }
  try {
    if (opts.maxBytes !== undefined) {
      const bytes = await guestFileSize(machine, tmp);
      if (bytes > opts.maxBytes) throw Object.assign(new Error(vaultOverCapLine(bytes, opts.maxBytes)), { kind: "vaultTooLarge", bytes });
    }
    return await bring(tmp);
  } finally {
    await machine.exec(`rm -f ${shellQuote(tmp)} ${shellQuote(`${tmp}.list`)} ${shellQuote(`${tmp}.keep`)}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
  }
}

/** An absolute guest path as the archive spells it from the root. */
const rooted = (p: string): string => p.replace(/^\//, "");

/** No cache is left behind: the rule a drop list alone travels under. */
const NO_CACHES: CacheRule = { dirs: [], files: [], markers: [] };

/** The paths the rule keeps, judged by name: find judges nothing at a path it is handed (a folder export's own root
 * would prune the whole folder), so a caller that hands over whole paths has them judged here. A machine used for
 * builds carries the install its worktrees share at the top of the home, and that is a path, not something under
 * one. By name alone, since a caller hands paths and not what they are: find's own predicate also asks the type,
 * so a file named as a cache directory goes with it here. Refuses an export whose every named path is a cache,
 * which would otherwise run find with no starting point; a caller that named none is answered above. */
function keptPaths(paths: readonly string[], rule: CacheRule): string[] {
  const kept = paths.filter(p => {
    const name = p.replace(/\/+$/, "").split("/").pop() ?? p;
    return !rule.dirs.includes(name) && !rule.files.includes(name);
  });
  if (kept.length === 0) throw new Error(`vault export: every path named is a cache under the rule (${paths.join(", ")}), so there is nothing to archive`);
  return kept;
}

/** Nothing named, nothing archived. An empty archive rather than a tar with no operand, which refuses, or a find
 * with no starting point, which reads the directory it runs in: from the root the export runs in, that is the whole
 * filesystem. The enumeration behind both real roads always names a path, so this is what a caller with nothing to
 * say gets. */
const emptyArchiveScript = (out: string): string => `tar czf ${shellQuote(out)} --no-recursion --null -T /dev/null`;

// Signed-URL transport on both directions: exec stdout could carry base64 for small exports but hits response-size limits.
export const exportPaths = (machine: Machine, paths: string[], opts: VaultOptions = {}): Promise<Buffer> =>
  archiveOf(
    machine,
    out => {
      if (paths.length === 0) return emptyArchiveScript(out);
      if (opts.exclude === undefined && (opts.drop === undefined || opts.drop.length === 0)) return groupArchiveScript([{ root: "/", paths }], out);
      const rule = opts.exclude ?? NO_CACHES;
      return excludingArchiveScript("/", keptPaths(paths, rule).map(rooted), rule, out, (opts.drop ?? []).map(rooted));
    },
    opts,
    tmp => downloadBuffer(machine, tmp, opts),
  );

/** The groups into a file on this computer instead of into memory, for a caller that hands the archive on as a path:
 * the export road, where the agents' state can be a whole history. Returns the bytes written. */
export const exportPathsInto = (machine: Machine, groups: readonly ArchiveGroup[], into: string, opts: VaultOptions = {}): Promise<number> =>
  archiveOf(machine, out => groupArchiveScript(groups, out), opts, tmp => downloadFile(machine, tmp, into, opts));

/** The refusal an export gives for a destination on this computer that already holds something; kind "exists" is
 * what a caller reads to offer replace. */
export const destExists = (dest: string, files: number): Error => Object.assign(new Error(`${dest} already exists on this computer with ${plural(files, "file")}; export with replace to overwrite it`), { kind: "exists" });

/** A folder on the guest streamed into a file on this computer, rooted at the folder, its caches left behind under
 * the rule and named; the folder is checked first so a wrong path costs one command, and the guest keeps nothing
 * afterwards. */
export async function exportFolder(machine: Machine, dir: string, rule: CacheRule, into: string, opts: VaultOptions = {}): Promise<{ bytes: number; excluded: string[] }> {
  const probe = await machine.exec(`test -d ${shellQuote(dir)} && echo yes || echo no`, { timeoutMs: INLINE_EXEC_MS });
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "yes") throw new Error(`${dir} is not a folder on the machine`);
  const tmp = `${guestTmpPath("wsp-out")}.tgz`;
  try {
    const packed = await machine.run(folderExportScript(dir, rule, tmp), { deadlineMs: opts.timeoutMs ?? 600_000 });
    if (packed.exitCode !== 0) throw new Error(`packing ${dir} on the machine failed (exit ${packed.exitCode}): ${packed.stderr.slice(-500)}`);
    const excluded = packed.stdout.split("\n").filter(l => l !== "").sort();
    return { bytes: await downloadFile(machine, tmp, into, opts, await guestFileSize(machine, tmp)), excluded };
  } finally {
    await machine.exec(`rm -f ${shellQuote(tmp)} ${shellQuote(`${tmp}.list`)} ${shellQuote(`${tmp}.keep`)}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
  }
}

/** The signed upload URL takes one PUT of at most this many bytes (measured 2026-09-04: 200 at 32 MiB,
 * 413 from 33 MiB, the body naming the limit); a larger archive travels in parts of this size. */
export const UPLOAD_PART_BYTES = 32 * 1024 * 1024;

type UploadBody = { error?: unknown; limit?: unknown };

function parseBody(body: string): UploadBody | undefined {
  try {
    return JSON.parse(body) as UploadBody;
  } catch {
    return undefined;
  }
}

/** The provider answers a refused upload with `{error, limit}`; the limit is the one figure worth repeating. */
function uploadFailure(status: number, body: string, part: number, parts: number, attempts: number): string {
  const where = parts === 1 ? "" : ` on part ${part} of ${parts}`;
  const parsed = parseBody(body);
  const reason = typeof parsed?.error === "string" ? parsed.error : body.trim().slice(0, 300);
  const limit = typeof parsed?.limit === "number" ? `; the upload takes at most ${parsed.limit} bytes per PUT` : "";
  const tries = attempts > 1 ? ` after ${attempts} attempts` : "";
  return `vault import upload failed${where}: HTTP ${status}${reason === "" ? "" : ` ${reason}`}${tries}${limit}`;
}

/** One part, PUT until it lands. The signed URL truncates the path on every PUT, so a retry after a lost
 * response or a 502 to 504 is safe; the bound and backoff are the backend's own. A 413 or any 4xx is final. */
async function putPart(doFetch: Fetch, url: string, bytes: Uint8Array<ArrayBuffer>, part: number, parts: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { method: "PUT", body: bytes });
    } catch (e) {
      if (attempt >= 3) throw new Error(`vault import upload failed${parts === 1 ? "" : ` on part ${part} of ${parts}`}: ${e instanceof Error ? e.message : String(e)} after ${attempt} attempts`);
      await new Promise(r => setTimeout(r, backoffMs(attempt)));
      continue;
    }
    if (res.ok) return;
    const body = await res.text().catch(() => "");
    const parsed = parseBody(body);
    const kind = classify(res.status, typeof parsed?.error === "string" ? { error: parsed.error } : {});
    if (!shouldRetry(kind, attempt)) throw new Error(uploadFailure(res.status, body, part, parts, attempt));
    await new Promise(r => setTimeout(r, backoffMs(attempt)));
  }
}

/** A file for the upload road: its path on the guest, its mode and its bytes. */
export interface TarFile {
  path: string;
  mode: number;
  content: string | Uint8Array;
}
/** A directory of its own, so an empty one and its mode survive the trip. */
export interface TarDir {
  path: string;
  mode: number;
  dir: true;
}
/** A symbolic link, carried as one: the target is written as it is, never followed. */
export interface TarLink {
  path: string;
  target: string;
}
export type TarEntry = TarFile | TarDir | TarLink;

const TAR_BLOCK = 512;
/** The ustar size field is eleven octal digits. */
export const TAR_MAX_FILE_BYTES = 0o77777777777;
const TAR_LINK_MAX = 100;

function tarField(header: Buffer, at: number, length: number, value: string): void {
  header.write(value, at, length, "utf8");
}

/** A ustar name of at most 100 bytes with a prefix of at most 155, split at a slash; undefined when neither field holds the path. */
function splitName(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return undefined;
}

function tarName(path: string): { name: string; prefix: string } {
  const split = splitName(path);
  if (split === undefined) throw new Error(`${path} does not fit a ustar header`);
  return split;
}

/** Whether tarOf can hold an entry at this path, with this link target when it is a link. */
export function fitsTar(path: string, target?: string): boolean {
  return splitName(path.replace(/^\/+/, "")) !== undefined && (target === undefined || Buffer.byteLength(target) <= TAR_LINK_MAX);
}

/** A gzipped ustar archive of the entries, each at its path with its mode and owned by root, for importInto to land
 * at the root of the guest: paths lose their leading slash, as tar wants them. */
export function tarOf(entries: readonly TarEntry[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const link = "target" in e;
    const body = "content" in e ? (typeof e.content === "string" ? Buffer.from(e.content, "utf8") : Buffer.from(e.content.buffer, e.content.byteOffset, e.content.byteLength)) : Buffer.alloc(0);
    if (body.length > TAR_MAX_FILE_BYTES) throw new Error(`${e.path} is ${body.length} bytes, over what a ustar header holds`);
    if (link && Buffer.byteLength(e.target) > TAR_LINK_MAX) throw new Error(`${e.path} links to a target too long for a ustar header`);
    const { name, prefix } = tarName(e.path.replace(/^\/+/, ""));
    const header = Buffer.alloc(TAR_BLOCK);
    tarField(header, 0, 100, name);
    tarField(header, 100, 8, `${(link ? 0o777 : e.mode).toString(8).padStart(7, "0")}\0`);
    tarField(header, 108, 8, "0000000\0");
    tarField(header, 116, 8, "0000000\0");
    tarField(header, 124, 12, `${body.length.toString(8).padStart(11, "0")}\0`);
    tarField(header, 136, 12, `${mtime.toString(8).padStart(11, "0")}\0`);
    tarField(header, 148, 8, "        ");
    tarField(header, 156, 1, link ? "2" : "dir" in e ? "5" : "0");
    if (link) tarField(header, 157, TAR_LINK_MAX, e.target);
    tarField(header, 257, 6, "ustar\0");
    tarField(header, 263, 2, "00");
    tarField(header, 265, 32, "root");
    tarField(header, 297, 32, "root");
    tarField(header, 345, 155, prefix);
    let sum = 0;
    for (const b of header) sum += b;
    tarField(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body);
    const pad = (TAR_BLOCK - (body.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK * 2));
  return gzipSync(Buffer.concat(blocks));
}

// A hash mismatch exits with its own code so the caller can tell it from a failed extraction.
const HASH_MISMATCH_EXIT = 65;

export async function importInto(machine: Machine, tar: Buffer, destDir: string, opts: VaultOptions = {}): Promise<{ parts: number }> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (tar.length === 0) throw new Error("vault import: empty archive, nothing to import");
  const tmp = `${guestTmpPath("wsp-vault-in", opts.tmpDir)}.tgz`;
  const parts = Math.ceil(tar.length / UPLOAD_PART_BYTES);
  const partPaths = parts === 1 ? [tmp] : Array.from({ length: parts }, (_, i) => `${tmp}.part${i}`);
  try {
    for (const [i, path] of partPaths.entries()) {
      const end = Math.min((i + 1) * UPLOAD_PART_BYTES, tar.length);
      const part = tar.subarray(i * UPLOAD_PART_BYTES, end);
      // The backend's own road where it has one; the signed URL keeps the retries below, which are this road's own
      // answer to a part lost between here and the provider's storage.
      let pieces: number | undefined;
      if (hasByteRoad(machine)) pieces = (await landBytes(machine, path, part))?.pieces;
      else await putPart(doFetch, await machine.uploadUrl(path), new Uint8Array(part), i + 1, parts);
      opts.onPart?.({ part: i + 1, parts, bytes: end, total: tar.length, ...(pieces !== undefined ? { pieces } : {}) });
    }
  } catch (e) {
    // Every part path, not only those that answered ok: a body can land before the response fails.
    await machine.exec(`rm -f ${partPaths.map(shellQuote).join(" ")}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
    throw e;
  }
  const digest = createHash("sha256").update(tar).digest("hex");
  // --recursive-unlink: imported dirs replace existing ones wholesale, so a
  // stale config dir on the target can't shadow the vaulted one. An overlay
  // (laptop files onto a fresh guest) merges instead, and --no-same-owner
  // keeps root from inheriting the laptop's uid off the archive.
  const flags = opts.overlay ? "--no-same-owner" : "--recursive-unlink";
  // The parts are streamed into tar in order, never joined on disk, so the guest holds the archive once.
  // pipefail: a part cat cannot read fails the hash line with cat's message instead of hashing what flowed.
  const joined = `cat ${partPaths.map(shellQuote).join(" ")}`;
  const script = [
    "set -eo pipefail",
    `trap "rm -f ${partPaths.map(shellQuote).join(" ")}" EXIT`,
    `sum=$(${joined} | sha256sum | cut -d' ' -f1)`,
    `test "$sum" = ${digest} || exit ${HASH_MISMATCH_EXIT}`,
    `mkdir -p ${shellQuote(destDir)}`,
    `${joined} | tar xzf - -C ${shellQuote(destDir)} ${flags}`,
  ].join("\n");
  const untar = await machine.run(script, { deadlineMs: opts.timeoutMs ?? 120_000 });
  if (untar.exitCode === HASH_MISMATCH_EXIT) {
    throw new Error(`vault import: the uploaded archive (${tar.length} bytes in ${parts} part${parts === 1 ? "" : "s"}) did not match its hash on the machine`);
  }
  if (untar.exitCode !== 0) {
    throw new Error(`vault import untar failed (exit ${untar.exitCode}): ${untar.stderr.slice(-500)}`);
  }
  return { parts };
}

export interface LandOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  /** Where the archive's parts are written on the machine while they travel; the machine's shared temporary
   * folder unless the caller names wsp's own there. */
  tmpDir?: string;
  /** Remove what is at the destination first; without it an existing path is refused with kind "exists". */
  replace?: boolean;
  onPart?: (progress: UploadProgress) => void;
  /** Called once the archive is extracted, right before it is moved into place. */
  onLanding?: () => void;
}

// The landing refuses with its own code so an existing path can be told from a failed move.
const EXISTS_EXIT = 66;

const exists = (path: string): Error => Object.assign(new Error(`${path} already exists on the machine; import with replace to overwrite it`), { kind: "exists" });

/** Lands an archive of a folder at an absolute path on the guest: extracted beside it into a staging directory,
 * then moved into place in one rename, so a failed upload or extraction leaves nothing at the destination. An
 * existing destination is refused before any byte goes up, and again at the move, unless `replace` removes it. */
export async function landBundle(machine: Machine, tar: Buffer, dest: string, opts: LandOptions = {}): Promise<{ parts: number }> {
  const target = dest.replace(/\/+$/, "");
  if (!dest.startsWith("/") || target === "") throw new Error(`destination must be an absolute path below /, got ${dest}`);
  const probe = await machine.exec(`test -e ${shellQuote(target)} && echo yes || echo no`, { timeoutMs: INLINE_EXEC_MS });
  if (probe.exitCode !== 0) throw new Error(`could not look at ${target} on the machine: ${probe.stderr.slice(-200)}`);
  if (probe.stdout.trim() === "yes" && opts.replace !== true) throw exists(target);
  const staging = `${target}.wsp-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { parts } = await importInto(machine, tar, staging, {
    overlay: true,
    ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onPart !== undefined ? { onPart: opts.onPart } : {}),
  }).catch(async (e: unknown) => {
    await machine.exec(`rm -rf ${shellQuote(staging)}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
    throw e;
  });
  opts.onLanding?.();
  const script = [
    "set -e",
    `trap "rm -rf ${shellQuote(staging)}" EXIT`,
    `mkdir -p ${shellQuote(target.slice(0, target.lastIndexOf("/")) || "/")}`,
    opts.replace === true ? `rm -rf ${shellQuote(target)}` : `test ! -e ${shellQuote(target)} || exit ${EXISTS_EXIT}`,
    `mv ${shellQuote(staging)} ${shellQuote(target)}`,
  ].join("\n");
  const moved = await machine.run(script, { deadlineMs: opts.timeoutMs ?? 120_000 });
  if (moved.exitCode === EXISTS_EXIT) throw exists(target);
  if (moved.exitCode !== 0) throw new Error(`landing at ${target} failed (exit ${moved.exitCode}): ${moved.stderr.slice(-500)}`);
  return { parts };
}
