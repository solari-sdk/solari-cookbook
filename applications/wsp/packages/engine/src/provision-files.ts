// SPDX-License-Identifier: AGPL-3.0-only
// The person's own agent files on a computer they own: the skills, the
// standing instructions, the commands and the configuration their agents read,
// landed in the agents' homes on that computer. A computer somebody lives on
// is not an image: a file already there with other content is never written
// over, its row says so, and a run after they remove it lands it. What wsp
// itself put there it may replace, which is what the list beside the job
// records; nothing outside an agent's own paths travels at all. The file an
// agent writes for itself is the one thing that lands once and then stands:
// what wsp owns in it is the server keys the servers step wrote, not its bytes,
// and a leave takes those keys back out of it one by one.
import { createHash } from "node:crypto";
import {
  EXEC_DEADLINE_EXIT,
  MCP_ID_PREFIX,
  agentOfRow,
  placeProvisionPaths,
  provisionLandedLine,
  provisionListReadLine,
  provisionPackedLine,
  provisionShippedLine,
  shellQuote,
  type PlaceProvisionRow,
} from "@wsp/protocol";
import { CATALOG_AGENTS, MCP_AGENTS, skillsDirOf } from "@wsp/catalog";
import { INLINE_EXEC_MS, OLD_APPEND_MARKS } from "./exec-detached.js";
import type { SkippedPath } from "./golden-import.js";
import type { PackFiles } from "./golden.js";
import { READ_MS, landConfigs, parseConfigs, parseMcpId, readConfigsCmd, type ScopeFile } from "./golden-mcp.js";
import type { Machine } from "./machine.js";
import { importInto } from "./vault.js";

/** Where each stage of this round says what it came to: the round is minutes long on a computer somebody owns,
 * and a line of its own per stage is what says which of them the minutes went to, since the job's own log on that
 * computer carries the time of every line. Every step here takes one; `provisionFiles` is where a caller that
 * wants none is answered, once. */
export type FilesSay = (line: string) => void;

/** One planned file of the person's, as the run needs it: the recipe row it came from and where it lands under the
 * home on that computer. */
export interface ProvisionLanding {
  id: string;
  label: string;
  /** Home-relative on the computer; a directory covers every file under it. */
  dest: string;
  /** A file an agent writes for itself, or one the recipe marks volatile: it lands where it is missing and stands
   * where it is there, whoever wrote what is in it, and it never enters the list as a file. What wsp owns in such a
   * file is the keys the servers step wrote, which are recorded one by one. */
  once?: true;
}

/** What one path came to there. `kept` is a file the person already had with other content, which is never
 * written over. */
export type LandOutcome = "installed" | "present" | "kept" | "failed";

/** Whether one planned destination covers a path: the destination itself, or anything under it where the
 * destination is a folder. One rule for every reader on this side, as `wsp_once` is the one rule on that computer. */
const covers = (dest: string, rel: string): boolean => rel === dest || rel.startsWith(`${dest}/`);

/** The `~/`-relative paths one agent keeps what it reads in, off the catalog alone: the home its own state sits
 * under, the folder it loads skills from, every config path the catalog names for it and the file it keeps its
 * MCP servers in. */
function agentPaths(a: (typeof CATALOG_AGENTS)[number]): string[] {
  // Under the home and nowhere else: a path the catalog writes some other way names no file this may land.
  return [`~/${a.stateHome}`, skillsDirOf(a), ...a.configPaths, ...(a.mcp?.files ?? [])].filter(p => p.startsWith("~/")).map(p => p.replace(/\/+$/, ""));
}

/** Whether one planned file may land in an agent's home on a computer somebody owns: its row is that agent's own
 * or one of that agent's MCP servers, and its path on this computer is one the catalog names for it. Nothing else
 * goes: a dotfile, a login's store and a shell's rc belong to the computer the person sits at, not to the agents
 * they run there, and an agent the catalog does not carry has no home of its own to write into. */
export function agentStateFile(f: { id: string; source: string }, home: string): boolean {
  const agent = agentOfRow(f) ?? parseMcpId(f.id)?.agent;
  const entry = CATALOG_AGENTS.find(a => a.id === agent);
  if (entry === undefined) return false;
  return agentPaths(entry).some(p => covers(`${home}/${p.slice(2)}`, f.source));
}

/** What each line of the landing prints, so no path of the person's can be read as the run's own words. */
export const LAND_MARK = "wsp-land";

/** The field the list beside the job is split on and the end of one of its lines, as the text of these runs
 * spells them: a printf escape, never the character itself, so a script reads back on one line wherever it is
 * printed. One spelling for the landing, the reads of the list and the close. */
const TAB = "\\t";
const NL = "\\n";

/** What a line's digest fields read where the round no longer owns that name: a key line with this in place of a
 * digest is a tombstone, which the close takes out along with every earlier line for the same id. */
export const NO_DIGEST = "-";

/** The shell test for a line of the list that names a key in an agent's own file rather than a path under the
 * home: its row id carries the servers' own prefix. One spelling for every reader written here. The twin the
 * daemon carries of the ownership read tells the two apart by whether a file stands at the path, which is the
 * same answer for a line whose id names no path. */
function keyTest(): string[] {
  return ["wsp_key() {", `  case "$1" in (${shellQuote(MCP_ID_PREFIX)}*) return 0 ;; esac`, "  return 1", "}"];
}

/** The shell test for a path that lands once: a case of the destinations themselves, each quoted so a path holding
 * a glob character or a backslash is read as the path it is, and a folder covering what is under it. One spelling
 * for the landing and for the close, which drops the lines a path of this kind left in the list before. */
function onceTest(once: readonly string[]): string[] {
  const patterns = once.flatMap(dest => [shellQuote(dest), `${shellQuote(dest)}/*`]);
  return ["wsp_once() {", ...(patterns.length === 0 ? [] : [`  case "$1" in (${patterns.join("|")}) return 0 ;; esac`]), "  return 1", "}"];
}

/** Which of a plan's landings land once, as the scripts take them. */
export const oncePathsOf = (lands: readonly ProvisionLanding[]): string[] => lands.filter(l => l.once === true).map(l => l.dest);

/** One line the landing printed: what became of one path under the home on that computer. */
interface Landed {
  rel: string;
  outcome: LandOutcome;
}

/** Whether one path lands once, judged here because it has to be judged before anything travels. */
export const landsOnce = (rel: string, once: readonly string[]): boolean => once.some(dest => covers(dest, rel));

/** What the read of what already stands there prints for one path: the digest of the bytes at that path, and the
 * digest the list beside the job records for it. Each record ends in a NUL rather than a newline, since a path of
 * the person's may hold a newline and a record ending in one would read as two. */
export const STAND_MARK = "wsp-stand";
export const LEDGER_MARK = "wsp-ledger";

/** The end of one record of that read, as the text of the run spells it: a printf escape, never the byte itself. */
const NUL = "\\0";

/** How long the read of what stands there may take. It hashes the files the round would land, the same bytes the
 * landing's own walk reads at the other end; past it nothing stands and every file travels, which is the round as
 * it was before this read existed. */
const STAND_MS = 120_000;

/** The run that reads what already stands where this round's files would land: the paths come over on the run's
 * own input, since there are more of them than a command line may carry and none of them belongs in a command a
 * log would keep. One `sha256sum` process reads them all, so the answer costs one pass over those files rather
 * than a process each, and one `awk` beside it prints what the list beside the job records for the same paths.
 * A path that is not there prints nothing of its own and takes that read's exit non-zero with it, which is why
 * the answer is the marks and no reader of it looks at an exit. */
export function standingScript(home: string): string {
  const at = placeProvisionPaths(home);
  const q = (s: string): string => shellQuote(s);
  return [
    "set -u",
    `home=${q(home)}; ledger=${q(at.landed)}; list=${q(at.asked)}`,
    'mkdir -p "$(dirname "$list")" || exit 1',
    'cat > "$list" || exit 1',
    '[ -s "$list" ] || exit 0',
    'cd "$home" || exit 1',
    // The digest of the bytes standing at each path, in one process over the whole list. The record sha256sum
    // prints is the digest, one space, the character saying how it read the file, then the path as it was given.
    'xargs -0 sha256sum -z -- < "$list" 2>/dev/null | while IFS= read -r -d "" rec; do',
    '  p=${rec#* }',
    `  printf '${STAND_MARK}${TAB}%s${TAB}%s${NUL}' "\${rec%% *}" "\${p#[ *]}"`,
    "done",
    '[ -f "$ledger" ] || ledger=/dev/null',
    // The list beside the job, keyed by the same paths, and the first line a path has there, which is the line the
    // landing and the close read too. A path holding a newline keys nothing here and no line of that list can name
    // one either, since the landing writes a line per path on a line of its own.
    `xargs -0 printf '%s${NL}' < "$list" | awk -F"${TAB}" 'NR==FNR { want[$0]=1; next } want[$1] && !seen[$1]++ { printf "${LEDGER_MARK}${TAB}%s${TAB}%s${NL}", $1, $3 }' - "$ledger" | tr '${NL}' '${NUL}'`,
    'rm -f "$list"',
    "exit 0",
  ].join("\n");
}

/** What that read answered, by home-relative path: the digest of the bytes standing at it, and the digest the list
 * beside the job records for it. A path is in neither where nothing stands there and the list names it not. */
export interface Standing {
  at: Map<string, string>;
  listed: Map<string, string>;
}

/** What the read printed, record by record: a record that is not a mark's is not an answer, and a path of the
 * person's that holds a tab keeps every byte of itself, since the path is the last field of its record. */
export function parseStanding(stdout: string): Standing {
  const standing: Standing = { at: new Map(), listed: new Map() };
  for (const record of stdout.split("\0")) {
    const words = record.split("\t");
    if (words.length < 3) continue;
    if (words[0] === STAND_MARK) standing.at.set(words.slice(2).join("\t"), words[1]!);
    if (words[0] === LEDGER_MARK) standing.listed.set(words[1]!, words[2]!);
  }
  return standing;
}

/** The exit a command gets where no shell ran it at all, which is the one answer that says the read itself did not
 * happen rather than what it found. */
const NO_SHELL_EXIT = 127;

/** What stands at the paths this round would land on, read off that computer in one frame. Nothing at all where
 * the read itself did not happen: the link threw, the daemon's own timer cut the command, no shell ran it, or
 * nothing of the read came back. Everything then travels, which is the round as it was. */
export async function standingDigests(machine: Machine, home: string, paths: readonly string[]): Promise<Standing | undefined> {
  if (paths.length === 0) return undefined;
  const res = await machine.exec(standingScript(home), { timeoutMs: STAND_MS, stdin: Buffer.from(paths.map(p => `${p}\0`).join("")) }).catch(() => undefined);
  if (res === undefined || res.exitCode === EXEC_DEADLINE_EXIT || res.exitCode === NO_SHELL_EXIT) return undefined;
  const standing = parseStanding(res.stdout);
  return standing.at.size === 0 && standing.listed.size === 0 ? undefined : standing;
}

/** The run on the computer itself, over the tree already extracted beside the job: every file the person's copy
 * holds, landed where it is missing, left alone where the same bytes are already there, and kept as it is where
 * the person's own file differs, unless that file is the one wsp landed last time and has not been touched since.
 * Each path prints its outcome; the ones wsp owns are written down with what travelled for them, and the run that
 * closes the job turns that list into what it left there. */
export function landFilesScript(home: string, once: readonly string[] = []): string {
  const at = placeProvisionPaths(home);
  const q = (s: string): string => shellQuote(s);
  return [
    "set -u",
    ...onceTest(once),
    `home=${q(home)}; stage=${q(at.staging)}; ledger=${q(at.landed)}; landing=${q(at.landing)}`,
    'mkdir -p "$(dirname "$landing")" || exit 1',
    ': > "$landing" || exit 1',
    'cd "$stage" || exit 1',
    'find . -type f -print | while IFS= read -r p; do',
    '  rel=${p#./}',
    '  src="$stage/$rel"; dest="$home/$rel"',
    '  s=$(sha256sum "$src" | cut -d" " -f1)',
    '  if [ ! -e "$dest" ]; then act=installed',
    // A file its agent writes for itself stands as it is from its first landing on: the agent rewrites it at every
    // launch, so its bytes are never wsp's to replace, and what the recipe has to say about it is its server keys.
    '  elif wsp_once "$rel"; then act=present',
    "  else",
    '    d=$(sha256sum "$dest" 2>/dev/null | cut -d" " -f1)',
    // The path goes to awk through the environment: an assigned variable would have every backslash in it read
    // as an escape, and a path holding one would match no line of the list.
    `    known=$(wsp_rel="$rel" awk -F"${TAB}" '$1==ENVIRON["wsp_rel"] { print $2" "$3; exit }' "$ledger" 2>/dev/null)`,
    '    if [ "$d" = "$s" ]; then act=present',
    // The person's own file stands unless the bytes there are the ones wsp left: then the copy is wsp's to
    // replace, and it is replaced only where their computer's copy has itself changed since.
    '    elif [ -n "$known" ] && [ "$d" = "${known##* }" ]; then',
    '      if [ "$s" = "${known%% *}" ]; then act=present; else act=installed; fi',
    "    else act=kept; fi",
    "  fi",
    '  if [ "$act" = installed ]; then',
    '    mkdir -p "$(dirname "$dest")" && cp -p "$src" "$dest" || act=failed',
    "  fi",
    `  printf '${LAND_MARK}${TAB}%s${TAB}%s${TAB}%s${NL}' "$act" "$s" "$rel"`,
    `  if [ "$act" != kept ] && [ "$act" != failed ] && ! wsp_once "$rel"; then printf "%s${TAB}%s${NL}" "$rel" "$s" >> "$landing"; fi`,
    "done",
    "exit 0",
  ].join("\n");
}

/** What the read of the list's server lines prints, so no name of the person's reads as the run's own words. */
export const SERVER_MARK = "wsp-server";

/** The run that reads which servers in the agents' own files on that computer are wsp's own: every line the list
 * beside the job holds for a key, with the digest of the entry wsp left under that name. No file's bytes are read
 * here, since the file a key sits in is the agent's own; what the digest is compared with is that entry as it
 * stands in the file now. */
export function landedServersScript(home: string): string {
  const at = placeProvisionPaths(home);
  return [
    "set -u",
    ...keyTest(),
    `ledger=${shellQuote(at.landed)}`,
    '[ -f "$ledger" ] || exit 0',
    `tab=$(printf "${TAB}")`,
    'while IFS="$tab" read -r id from at; do',
    `  wsp_key "$id" && printf '${SERVER_MARK}${TAB}%s${TAB}%s${NL}' "$at" "$id"`,
    'done < "$ledger"',
    "exit 0",
  ].join("\n");
}

/** What the ownership read prints for one path of the list, so no path of the person's reads as the run's own words. */
export const OWN_MARK = "wsp-own";

/** The run that reads which files in the agents' homes on that computer are wsp's own: every path the list beside
 * the job names whose bytes there are still the ones wsp left. It reads the computer and the list and nothing of
 * any run, so a leave tells wsp's own copies from the person's whatever has happened since the round that landed
 * them. A line the servers step wrote names a key in an agent's own file and no path, so nothing under the home
 * stands at one and this passes over it; those lines are landedServers' to read. The leave is the one caller, on
 * both roads it runs: the daemon over the link runs this same text through sh. */
export function landedFilesScript(home: string): string {
  const at = placeProvisionPaths(home);
  return [
    "set -u",
    `home=${shellQuote(home)}; ledger=${shellQuote(at.landed)}`,
    '[ -f "$ledger" ] || exit 0',
    `tab=$(printf "${TAB}")`,
    'while IFS="$tab" read -r rel from at; do',
    '  dest="$home/$rel"',
    '  [ -f "$dest" ] || continue',
    '  d=$(sha256sum "$dest" | cut -d" " -f1)',
    `  [ "$d" = "$at" ] && printf '${OWN_MARK}${TAB}%s${NL}' "$rel"`,
    'done < "$ledger"',
    "exit 0",
  ].join("\n");
}

/** The run that closes the job on that computer: the markers the job's own log is appended behind, then every path
 * this round landed, with the bytes that travelled for it and the bytes standing there now, then every key the
 * servers step wrote as it wrote it, then the lines from before for what this round did not touch, since what wsp
 * left at those is still what it left. A round that landed nothing writes no landing, and this run then leaves the
 * list exactly as it was rather than emptying it. The tree that travelled goes with it, so nothing of the person's
 * is left lying in wsp's folder. */
export function closeFilesScript(home: string, once: readonly string[] = []): string {
  const at = placeProvisionPaths(home);
  const q = (s: string): string => shellQuote(s);
  return [
    "set -u",
    ...onceTest(once),
    ...keyTest(),
    `home=${q(home)}; stage=${q(at.staging)}; ledger=${q(at.landed)}; landing=${q(at.landing)}; log=${q(at.log)}`,
    // A path an older road appended to carries one marker per append and nothing swept them: a hundred and
    // seventeen stood beside one job's log on a box after two updates. The sweep is the first thing here, so a
    // round that landed nothing still leaves the folder as it should be.
    `rm -f "$log"${OLD_APPEND_MARKS}`,
    // No landing at all is a round that never reached the computer: the list stands, so the copies wsp left
    // there before are still read as its own.
    '[ -f "$landing" ] || exit 0',
    `tab=$(printf "${TAB}")`,
    ': > "$ledger.new" || exit 1',
    'while IFS="$tab" read -r rel from at; do',
    // A line the servers step wrote names a key in an agent's own file and carries the digest of what wsp left
    // under that name: it goes through as it is, since no file on that computer holds those bytes alone. A
    // tombstone rides the same road and is taken out below, once it has shadowed the lines before it.
    `  if wsp_key "$rel"; then printf "%s${TAB}%s${TAB}%s${NL}" "$rel" "$from" "$at" >> "$ledger.new"; continue; fi`,
    '  dest="$home/$rel"',
    '  [ -f "$dest" ] || continue',
    `  printf "%s${TAB}%s${TAB}%s${NL}" "$rel" "$from" "$(sha256sum "$dest" | cut -d" " -f1)" >> "$ledger.new"`,
    'done < "$landing"',
    // The lines from before, but for a path that lands once: from its first landing on the bytes there are its
    // agent's, so a line saying wsp left those bytes would be a line saying it owns what it does not.
    '[ ! -f "$ledger" ] || while IFS="$tab" read -r rel from at; do',
    `  wsp_once "$rel" || printf "%s${TAB}%s${TAB}%s${NL}" "$rel" "$from" "$at" >> "$ledger.new"`,
    'done < "$ledger"',
    // One line per path, this round's first: both readers of the list take the first line a path has, so a path
    // this round wrote again keeps one line and a path it did not touch keeps the line it had. A tombstone is
    // read first and kept out, which is how a name this round no longer owns leaves the list with its old line.
    `awk -F"${TAB}" '!seen[$1]++ && $3 != "${NO_DIGEST}"' "$ledger.new" > "$ledger.keep" || exit 1`,
    'mv "$ledger.keep" "$ledger"',
    'rm -f "$ledger.new"',
    'rm -rf "$stage" "$landing"',
    "exit 0",
  ].join("\n");
}

/** What the landing printed, in the order it printed it; a line that is not the mark's is not an answer. */
export function parseLanded(stdout: string): Landed[] {
  return stdout.split("\n").flatMap(line => {
    const words = line.split("\t");
    const outcome = words[1];
    if (words[0] !== LAND_MARK || words.length < 4 || outcome === undefined || !["installed", "present", "kept", "failed"].includes(outcome)) return [];
    return [{ outcome: outcome as LandOutcome, rel: words.slice(3).join("\t") }];
  });
}

/** Which planned entry a landed path belongs to: the longest destination that holds it, since one row may name a
 * folder and another a file inside it. Nothing for a path no entry names, which gets a row of its own. */
function ownerOf(rel: string, lands: readonly ProvisionLanding[]): ProvisionLanding | undefined {
  let best: ProvisionLanding | undefined;
  for (const l of lands) {
    if (!covers(l.dest, rel)) continue;
    if (best === undefined || l.dest.length > best.dest.length) best = l;
  }
  return best;
}

/** How many paths of a row's are named in its note before it says how many more there are. */
const NAMED = 3;

const listOf = (paths: readonly string[]): string => (paths.length <= NAMED ? paths.join(", ") : `${paths.slice(0, NAMED).join(", ")} and ${paths.length - NAMED} more`);

/** How a file's row reads: the name of the recipe row that carries it, where one does, and the path it lands at on
 * that computer. The rows the landing answers with and the rows a round that never landed answers with read the
 * same way. */
const fileLabel = (label: string | undefined, home: string, dest: string): string => (label === undefined ? `${home}/${dest}` : `${label} ${home}/${dest}`);

/** One row per planned entry, in plan order, with what became of the paths under it: installed where anything
 * landed, present where every path was already the same, kept in the person's own words where their files stand
 * and nothing of theirs was touched, failed where a path could not be written. */
export function filesRows(lands: readonly ProvisionLanding[], landed: readonly Landed[], home: string): PlaceProvisionRow[] {
  const byOwner = new Map<string, Landed[]>();
  const loose: Landed[] = [];
  for (const l of landed) {
    const owner = ownerOf(l.rel, lands);
    if (owner === undefined) loose.push(l);
    else (byOwner.get(owner.dest) ?? byOwner.set(owner.dest, []).get(owner.dest)!).push(l);
  }
  const rowOf = (id: string, label: string | undefined, dest: string, rows: readonly Landed[]): PlaceProvisionRow => {
    const under = (outcome: LandOutcome): string[] => rows.filter(r => r.outcome === outcome).map(r => r.rel);
    const failed = under("failed");
    const installed = under("installed");
    const kept = under("kept");
    const notes = [
      ...(rows.length > 1 && installed.length > 0 ? [`${installed.length} of ${rows.length} files`] : []),
      ...(kept.length > 0 ? [`${kept.length === rows.length ? "already there with other content" : `${kept.length} already there with other content`}: ${listOf(kept)}`] : []),
    ];
    const outcome: PlaceProvisionRow["outcome"] =
      failed.length > 0 ? "failed" : installed.length > 0 ? "installed" : rows.length === 0 || kept.length === rows.length ? "skipped" : "present";
    const note = failed.length > 0 ? `could not be written: ${listOf(failed)}` : rows.length === 0 ? "nothing of it travelled" : notes.join("; ");
    return { id, label: fileLabel(label, home, dest), outcome, kind: "file", ...(note !== "" ? { note } : {}) };
  };
  return [
    ...lands.map(l => rowOf(`files/${l.dest}`, l.label, l.dest, byOwner.get(l.dest) ?? [])),
    // A path no planned row names is read by its path alone: the hook script a copied setting names travels
    // beside it, and no recipe row is its own.
    ...loose.map(l => rowOf(`files/${l.rel}`, undefined, l.rel, [l])),
  ];
}

/** The paths under the home on a computer that hold what wsp landed there, each with whether this run put it there
 * or found the same bytes already. The servers step reads it for one thing: a server already in a file this run
 * landed whole arrived with this run, whatever the merge then had to do to that file. */
export type OwnedPaths = ReadonlyMap<string, "installed" | "present">;

export interface LandFilesResult {
  rows: PlaceProvisionRow[];
  owned: OwnedPaths;
  /** What the person keeps there, for the document the job leaves on the computer. */
  skipped: SkippedPath[];
}

/** How long the files may take to reach that computer and be walked into place. */
const LAND_MS = 300_000;

/** Lands the person's agent files on the computer itself: the archive extracted into wsp's own folder there, then
 * one run that puts each file in its agent's home under the rules above, then the rows. The staging tree stays
 * until the job closes, since the servers step reads the configs that travelled out of it. */
export async function landAgentFiles(machine: Machine, o: { home: string; tar: Buffer; lands: readonly ProvisionLanding[]; stood?: readonly string[]; say: FilesSay }): Promise<LandFilesResult> {
  const at = placeProvisionPaths(o.home);
  await machine.exec(`rm -rf ${shellQuote(at.staging)}`, { timeoutMs: INLINE_EXEC_MS });
  // Under wsp's own folder there, never the shared temporary one: on a computer somebody owns, another account
  // could be sitting in /tmp first, and what travels is the person's own configuration.
  await importInto(machine, o.tar, at.staging, { overlay: true, timeoutMs: LAND_MS, tmpDir: at.dir, onPart: p => o.say(provisionShippedLine(p)) });
  const res = await machine.run(landFilesScript(o.home, oncePathsOf(o.lands)), { deadlineMs: LAND_MS });
  if (res.exitCode !== 0) throw new Error(`the agents' files did not land on ${machine.id} (exit ${res.exitCode}): ${res.stderr.slice(-300)}`);
  const walked = parseLanded(res.stdout);
  o.say(provisionLandedLine(walked.length));
  // A file the pack left home because the same bytes stand there is read as present: the landing never walked it,
  // the list beside the job already holds the line saying wsp left those bytes, and the servers round has to know
  // that the copy there is wsp's own.
  const landed = [...walked, ...(o.stood ?? []).map(rel => ({ rel, outcome: "present" as const }))];
  return {
    rows: filesRows(o.lands, landed, o.home),
    owned: new Map(landed.flatMap(l => (l.outcome === "installed" || l.outcome === "present" ? [[`${o.home}/${l.rel}`, l.outcome] as const] : []))),
    skipped: landed.filter(l => l.outcome === "kept").map(l => ({ id: ownerOf(l.rel, o.lands)?.id ?? `files/${l.rel}`, path: `${o.home}/${l.rel}`, note: "already there with other content; wsp did not write over it" })),
  };
}

/** The digest one key in the list is owned by: the entry standing under that name, in the shape its format keeps
 * when the agent writes the file again. Nothing for a name the text does not define. One rule for the round that
 * writes a key line and for the leave that reads one back. */
export const serverDigest = (entry: string | undefined): string | undefined => (entry === undefined ? undefined : createHash("sha256").update(entry).digest("hex"));

/** What the read of the list's key lines printed: the digest of the entry wsp left, by row id. A line that is not
 * the mark's is not an answer. */
export function parseLandedServers(stdout: string): Map<string, string> {
  return new Map(
    stdout.split("\n").flatMap(line => {
      const words = line.split("\t");
      return words[0] === SERVER_MARK && words.length > 2 ? [[words.slice(2).join("\t"), words[1]!] as const] : [];
    }),
  );
}

/** What wsp owns in the agents' own files on that computer, off the list beside the job: one entry per server it
 * wrote there, with the digest of that entry as it left it. Empty where the computer has no list yet or would not
 * answer, which reads every server in those files as the agent's own and leaves them. */
export async function landedServers(machine: Machine, home: string, say: FilesSay): Promise<Map<string, string>> {
  const res = await machine.run(landedServersScript(home), { deadlineMs: LAND_MS }).catch(() => undefined);
  if (res === undefined || res.exitCode !== 0) return new Map();
  const keys = parseLandedServers(res.stdout);
  say(provisionListReadLine(keys.size));
  return keys;
}

/** The three things taking wsp's servers back out needs of the computer they are on. The host has them over the
 * link that computer's daemon holds; the wsp on that computer has them in its own hands. */
export interface ServerPort {
  /** Runs a script there and answers what it printed; nothing where it would not run. */
  run(script: string): Promise<string>;
  /** The first of an agent's files that is there, with its text; nothing where none of them is. */
  read(files: readonly string[]): Promise<ScopeFile | undefined>;
  /** That file, as it was read, with this text by the one config write inside `home`. */
  write(file: ScopeFile, text: string, home: string): Promise<void>;
}

/** The port over a machine: the same read of a config off it and the same landing and write the servers round puts
 * one back with. */
export function machineServerPort(machine: Machine): ServerPort {
  return {
    run: async script => {
      const res = await machine.run(script, { deadlineMs: LAND_MS }).catch(() => undefined);
      return res === undefined || res.exitCode !== 0 ? "" : res.stdout;
    },
    read: async files => {
      // The answer is that file whole, the servers' env and headers with it, so it goes by the road that says its
      // output is not a log's.
      const asked = [{ files }];
      const res = await machine.run(readConfigsCmd(asked), { deadlineMs: READ_MS, unlogged: true }).catch(() => undefined);
      return res === undefined || res.exitCode !== 0 ? undefined : parseConfigs(res.stdout, asked)?.[0];
    },
    write: async (file, text, home) => {
      const failure = await landConfigs(machine, home, [file], new Map([[file.path, text]]));
      if (failure !== undefined) throw new Error(failure);
    },
  };
}

/** One agent's own file on that computer with wsp's servers taken back out of it. */
export interface ServersOut {
  path: string;
  names: string[];
}

/** What a leave says it took out of one agent's own file: the names and the file they came out of. */
export const serversOutLines = (out: ServersOut): string[] => [`${out.names.join(", ")} (out of ${out.path})`];

/** Takes the servers wsp merged into the agents' own files on a computer back out of them, which is what a leave
 * cannot do by taking a path: those files are the agents' own and only the keys in them are wsp's. The list
 * beside the job says which keys those are and what wsp left under each, and a key whose entry there still reads
 * as that is wsp's to take; one the agent or the person has written since reads differently and stays, the same
 * rule by which the merge never writes over one. Nothing else in the file moves. A file that will not parse or
 * will not be written keeps its servers and the agents beside it still lose theirs. */
export async function unmergeServers(port: ServerPort, home: string): Promise<ServersOut[]> {
  const keys = parseLandedServers(await port.run(landedServersScript(home)));
  const out: ServersOut[] = [];
  for (const agent of MCP_AGENTS) {
    const mine = [...keys].flatMap(([id, digest]) => {
      const key = parseMcpId(id);
      return key?.agent === agent.id ? [{ ...key, digest }] : [];
    });
    if (mine.length === 0) continue;
    try {
      const file = await port.read(agent.mcp.files.map(f => `${home}/${f.slice(2)}`));
      if (file === undefined) continue;
      let text = file.text;
      const took: string[] = [];
      // The user scope and, for a format that keeps servers per folder, the machine's own home folder: the same
      // two scopes the merge wrote them under.
      for (const scoped of [false, true]) {
        const project = scoped ? home : undefined;
        const names = mine.filter(k => k.home === scoped && serverDigest(agent.mcp.format.entryOf(text, k.name, project)) === k.digest).map(k => k.name);
        if (names.length === 0) continue;
        text = agent.mcp.format.remove(text, names, project).text;
        took.push(...names);
      }
      if (took.length === 0 || text === file.text) continue;
      await port.write(file, text, home);
      out.push({ path: file.path, names: took });
    } catch {
      continue;
    }
  }
  return out;
}

/** The paths the ownership read answered with, home-relative and in the order the list named them. A line that is
 * not the mark's is not an answer: a path of the person's holding a newline prints lines this never reads as its
 * own, and a path that is not plainly under the home is no path of wsp's, whatever a list says. */
export function ownMarks(stdout: string): string[] {
  return stdout.split("\n").flatMap(line => {
    const words = line.split("\t");
    const rel = words.slice(1).join("\t");
    if (words[0] !== OWN_MARK || rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) return [];
    return [rel];
  });
}

/** Writes what the servers step put in the agents' own files into the list this round is building, one line per
 * key. Nothing here fails the job: a computer that would not keep a line is one whose servers landed all the same,
 * and the next run reads that key as its agent's own and leaves it. A line that lands twice is no matter, since the
 * close keeps the first line each name has. */
export async function appendLanding(machine: Machine, home: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  const at = placeProvisionPaths(home);
  await machine
    .exec([`mkdir -p ${shellQuote(at.dir)} || exit 1`, `printf '%s\\n' ${lines.map(shellQuote).join(" ")} >> ${shellQuote(at.landing)}`].join("\n"), { timeoutMs: INLINE_EXEC_MS })
    .catch(() => undefined);
}

/** The files round of the job: the archive read off this computer and landed on that one, with a row per planned
 * path and what this run itself put there. A pack or a landing that throws is one failed row per planned path
 * with the reason, since the archive is the person's whole set of agent files and one row of it cannot fail
 * alone, and the round then says it put nothing there rather than anything about whose the files are. */
export async function provisionFiles(machine: Machine, o: { home: string; lands: readonly ProvisionLanding[]; pack: PackFiles; say?: FilesSay }): Promise<LandFilesResult> {
  // The one place the stages may go unsaid, so every step below takes a say and none of them asks whether it has one.
  const say = o.say ?? ((): void => {});
  const once = oncePathsOf(o.lands);
  try {
    const packed = await o.pack(async staged => {
      const standing = await standingDigests(machine, o.home, staged.map(f => f.dest));
      if (standing === undefined) return [];
      // Three digests have to agree before a file stays home: the bytes staged here, the bytes standing there, and
      // the line the list beside the job holds for that path. A line older than the bytes, or none at all, sends
      // the file, so the close writes that line exactly as it does today. A path that lands once always travels,
      // since the servers round reads the copy that travelled out of the tree beside the job.
      return staged.filter(f => !landsOnce(f.dest, once) && standing.at.get(f.dest) === f.digest && standing.listed.get(f.dest) === f.digest).map(f => f.dest);
    });
    say(provisionPackedLine(o.lands.length, { bytes: packed.bytes, ...(packed.files !== undefined ? { files: packed.files } : {}), ...(packed.stood !== undefined ? { stood: packed.stood.length } : {}) }));
    const landed = await landAgentFiles(machine, { home: o.home, tar: packed.tar, lands: o.lands, ...(packed.stood !== undefined ? { stood: packed.stood } : {}), say });
    return { ...landed, skipped: [...packed.skipped, ...landed.skipped] };
  } catch (e) {
    const note = (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
    return {
      rows: o.lands.map(l => ({ id: `files/${l.dest}`, label: fileLabel(l.label, o.home, l.dest), outcome: "failed" as const, kind: "file" as const, note })),
      owned: new Map(),
      skipped: [],
    };
  }
}

/** Writes down what wsp owns on that computer and takes the tree that travelled away again. Nothing here fails
 * the job: a computer that would not keep the list is one whose files landed all the same, and the next run reads
 * its own copies as the person's, which keeps them rather than writing over them. */
export async function closeAgentFiles(machine: Machine, home: string, once: readonly string[] = []): Promise<void> {
  await machine.run(closeFilesScript(home, once), { deadlineMs: LAND_MS }).catch(() => undefined);
}
