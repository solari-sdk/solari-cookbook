// SPDX-License-Identifier: AGPL-3.0-only
// The tools stage on the builder: every ticked install as one guarded run in
// plan order, the disk read before each against the floor kept for the agents,
// and the cleanup (Homebrew's housekeeping, then the cache sweep) at the first
// reading under the floor and again once the loop is over. The guard runs the
// install in its own session and, at the timeout, kills that session and every
// process descended from it before returning, so a slow brew never holds a
// cellar lock into the next tool's turn.
import { BREW_PREFIX, HOMEBREW, MIB, ROAD_MODULES, ROAD_STEPS, type RoadName } from "@wsp/catalog";
import { fmtBytes, listedName, nameList, pinsReadLine, shellQuote, stepRetryLine, timedOutLine, type DiskUse, type GoldenStage, type GoldenStep, type RecipeDigest, type ToolPin } from "@wsp/protocol";
import { INLINE_EXEC_MS, markersOf, pagedReads } from "./exec-detached.js";
import { TOOLS_PATH, brewHousekeeping as brewHousekeepingCmds, pathLine, type ToolInstall } from "./golden-import.js";
import type { ExecResult, Machine } from "./machine.js";

export interface ToolResult {
  id: string;
  label: string;
  outcome: "installed" | "failed" | "skipped";
  note?: string;
  ms?: number;
  /** What df moved across the install, when it could be read on both sides; zero for a package already there. */
  bytes?: number;
  /** The road a source install took, as its script reported: the release asset, or the module go installed. */
  road?: ToolRoad;
  /** What the row installed, read back once it landed: the tag and sum a release printed, or the version its road's
   * line printed, marked latest when the road installs the current one wherever it runs. */
  pin?: ToolPin;
}

export interface ToolRoad {
  kind: Extract<RoadName, "release" | "go">;
  from: string;
  /** The release asset's sha256 as the guest read it, and the tag it came from; the recipe records both on the first install of a tag. */
  sha256?: string;
  tag?: string;
}

export interface ToolsOutcome {
  tools: ToolResult[];
  /** The Homebrew checkout the formulae installed under, when the stage put one on the machine. */
  homebrew?: { tag: string; commit: string };
}

type Stage = (stage: GoldenStage, detail?: string, step?: GoldenStep) => void;

/** Where each figure sits on df's line. */
const DF_COLUMN = { size: 2, used: 3, free: 4 } as const;
/** df on a disk in kilobytes, the columns asked for on one line in that order, /root's unless a path is named: used is
 * what a snapshot comes to, free is what an install has left, size is the disk those two are read against; the one
 * place the df line is spelled. */
export const dfKbCmd = (columns: readonly (keyof typeof DF_COLUMN)[], path = "/root"): string => `df -Pk ${path} | awk 'NR==2{print ${columns.map(c => `$${DF_COLUMN[c]}`).join(", ")}}'`;
export const FREE_KB_CMD = dfKbCmd(["free"]);
export const USED_KB_CMD = dfKbCmd(["used"]);
/** How a df that did not answer reads, for dfRead and for the rejected exec diskUse catches. */
const dfFailed = (res: ExecResult): string => `df failed: ${reasonOf(res, INLINE_EXEC_MS / 1000)}`;
/** The columns asked for off one df, in bytes; a full disk is free 0 and an empty one used 0, so only a size of zero
 * is a reading no disk has; a rejected exec throws. */
async function dfRead(machine: Machine, columns: readonly (keyof typeof DF_COLUMN)[]): Promise<{ bytes: number[] } | { reason: string }> {
  const res = await machine.exec(dfKbCmd(columns), { timeoutMs: INLINE_EXEC_MS });
  const printed = res.stdout.trim();
  const kb = printed.split(/\s+/).map(Number);
  const size = columns.indexOf("size");
  // The pipe exits as awk does, so a df that failed exits 0 having printed nothing.
  const answered = res.exitCode === 0 && printed !== "";
  if (answered && kb.length === columns.length && kb.every(n => Number.isFinite(n) && n >= 0) && (size === -1 || kb[size]! > 0)) return { bytes: kb.map(n => n * 1024) };
  return { reason: answered ? `df answered ${printed.slice(0, 160)}` : dfFailed(res) };
}
export { MIB };
/** One unpack peak filled the disk from 1.6 GB free (measured 2026-09-05), so the loop stops above that. */
export const TOOLS_DISK_FLOOR = 2048 * MIB;
/** How long the guard gives the TERM, then the KILL, to land. */
const KILL_GRACE_S = 10;
/** The run's deadline sits past the timeout, both graces and the one-second polls between them. */
export const GUARD_SLACK_S = 2 * KILL_GRACE_S + 40;
/** How long a guarded run has before the engine kills what the guard did not. */
export const guardDeadlineMs = (timeoutS: number): number => (timeoutS + GUARD_SLACK_S) * 1000;
/** A failed export or upload leaves its archive in /tmp, on the root disk the tools share. */
const SWEEP_TMP_CMD = "rm -f /tmp/wsp-vault-*.tgz";
/** Homebrew's message when another brew holds the cellar it wants. */
const CELLAR_LOCKED = /has already locked/;
/** Every lock Homebrew holds, taken and released in turn: returns once no brew is mid-install. */
const BREW_LOCK_WAIT_S = 600;
const BREW_LOCK_WAIT_CMD = `for l in ${BREW_PREFIX}/var/homebrew/locks/*.lock; do [ -e "$l" ] && flock -w ${BREW_LOCK_WAIT_S} "$l" true; done; true`;

/** Re-exported so the engine's callers keep one import; the rule itself lives beside fmtBytes in the protocol. */
export { plural } from "@wsp/protocol";

/** The line that names the failure, for a warning: the last `Error:` line on stderr (Homebrew
 * follows its error with advice), else the last stderr line, else stdout's; 124 is the guest-side timeout. */
export function reasonOf(res: ExecResult, timeoutS: number): string {
  if (res.exitCode === 124) return timedOutLine(timeoutS);
  const lines = (text: string): string[] => text.split("\n").map(l => l.trim()).filter(l => l !== "");
  const err = lines(res.stderr);
  return (err.filter(l => l.startsWith("Error:")).at(-1) ?? err.at(-1) ?? lines(res.stdout).at(-1) ?? `exit ${res.exitCode}`).slice(0, 160);
}

/** What a row nothing had to be done for reads as: the tool answers already, whether the provider's image shipped
 * it, an earlier run installed it or the caller found it on a computer somebody owns, and either way no bytes move
 * for it now. It sits with the loop that writes it; the floor re-exports it, since that is where it was first said. */
export const ALREADY_ON_MACHINE = "already on the machine";

/** A result that read its pin back: what a tools or a harness stage says about one row once it is on the machine. */
export interface Pinned {
  id: string;
  outcome: "installed" | "failed" | "skipped";
  pin?: ToolPin;
}

/** The pin an install recorded, when it landed and read one back: what the digest tick the seal writes and the
 * record's pins are made of. */
export function recordedPin(t: Pinned): ToolPin | undefined {
  return t.outcome === "installed" ? t.pin : undefined;
}

/** The pins a stage recorded, by the row's id. */
export function recordedPins(rows: readonly Pinned[]): Map<string, ToolPin> {
  return new Map(rows.flatMap((t): [string, ToolPin][] => { const pin = recordedPin(t); return pin === undefined ? [] : [[t.id, pin]]; }));
}

/** The digest with the pins a stage recorded written on its ticks, so the sealed version says what each row installed
 * and the record built from it carries the same. */
export function withRecordedPins(digest: RecipeDigest, rows: readonly Pinned[]): RecipeDigest {
  const pins = recordedPins(rows);
  return pins.size === 0 ? digest : { ...digest, ticks: digest.ticks.map(t => (pins.has(t.id) ? { ...t, pin: pins.get(t.id)! } : t)) };
}

/** The pin a row's read came to: the version its line printed, marked latest when the road installs the current
 * one wherever it runs; nothing when the line printed nothing. */
export function pinRead(version: string, fixed: boolean): ToolPin | undefined {
  const tag = version.trim().split("\n")[0]?.trim() ?? "";
  return tag === "" ? undefined : { tag, ...(fixed ? {} : { latest: true as const }) };
}

/** What a batched read prints ahead of each row's version: the marker, the row's place in the run, the version. */
const VERSION_READ = "wsp-version";

/** One run reads every installed row's version back on the tools PATH: a release's own line already said its tag
 * and sum, so that stands; every other row with a read gets what its line printed, or nothing when it printed
 * nothing or the run could not be made, which the stage says. Then one line names what was pinned and, once, the
 * rows whose road installs latest on every place. */
async function readPins(machine: Machine, tools: readonly ToolInstall[], results: readonly ToolResult[], stage: (detail: string) => void, path: string, prefix?: string): Promise<void> {
  const rows = results.flatMap(r => {
    const tool = r.outcome === "installed" ? tools.find(t => t.id === r.id) : undefined;
    return tool?.pin === undefined ? [] : [{ result: r, tool, pin: tool.pin }];
  });
  for (const row of rows) {
    if (row.result.road?.tag !== undefined) row.result.pin = { tag: row.result.road.tag, ...(row.result.road.sha256 !== undefined ? { sha256: row.result.road.sha256 } : {}), ...(row.pin.fixed ? {} : { latest: true as const }) };
  }
  const reads = rows.filter(row => row.result.pin === undefined && row.pin.read !== undefined);
  // Paged as the checks are: a version line on a manager's own store is as slow as any other read, and a page that
  // could not be made costs its own rows their pin rather than every row's.
  for (const { rows: page, res } of await pagedReads(machine, reads, (row, at) => `printf '${VERSION_READ} %s %s\\n' ${at} "$( ( ${row.pin.read} ) 2>/dev/null | head -n 1 )"`, pathLine(path, prefix))) {
    if (res.exitCode !== 0) {
      stage(`the versions could not be read back (${reasonOf(res, INLINE_EXEC_MS / 1000)}): ${nameList(page.map(r => r.result.label))} record no pin`);
      continue;
    }
    const printed = markersOf(res.stdout, VERSION_READ);
    for (const [at, row] of page.entries()) {
      const pin = pinRead(printed.get(String(at)) ?? "", row.pin.fixed);
      if (pin !== undefined) row.result.pin = pin;
    }
  }
  const pinned = rows.filter(row => row.result.pin !== undefined);
  const line = pinsReadLine(
    pinned.filter(row => row.result.pin!.latest !== true).map(row => ({ name: row.result.label, tag: row.result.pin!.tag })),
    pinned.filter(row => row.result.pin!.latest === true).map(row => ({ name: row.result.label, tag: row.result.pin!.tag, words: row.pin.words })),
  );
  if (line !== undefined) stage(line);
}

/** The last WSP_ROAD line a road install printed, when it printed one. */
export function roadOf(stdout: string): ToolRoad | undefined {
  const m = [...stdout.matchAll(/^WSP_ROAD (release|go) (\S+)(?: ([0-9a-f]{64})(?: (\S+))?)?/gm)].at(-1);
  return m === undefined ? undefined : { kind: m[1] as ToolRoad["kind"], from: m[2]!, ...(m[3] !== undefined ? { sha256: m[3] } : {}), ...(m[4] !== undefined ? { tag: m[4] } : {}) };
}

export type FreeDisk = { kind: "free"; bytes: number } | { kind: "unknown"; reason: string };

/** One df column read off the machine, in bytes; a df that fails or prints no number is reported, never assumed. */
async function dfRootBytes(machine: Machine, column: "used" | "free"): Promise<{ bytes: number } | { reason: string }> {
  const read = await dfRead(machine, [column]);
  return "bytes" in read ? { bytes: read.bytes[0]! } : read;
}

/** What df says is free under /root. */
export async function freeBytes(machine: Machine): Promise<FreeDisk> {
  const read = await dfRootBytes(machine, "free");
  return "bytes" in read ? { kind: "free", bytes: read.bytes } : { kind: "unknown", reason: read.reason };
}

/** What df says is used under /root and the size of the disk it sits on, off one exec; a df that fails or prints
 * no pair of numbers is reported, never assumed. */
export async function diskUse(machine: Machine): Promise<DiskUse> {
  const read = await dfRead(machine, ["used", "size"]).catch((e: unknown) => ({ reason: dfFailed({ exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }) }));
  return "bytes" in read ? { kind: "use", usedBytes: read.bytes[0]!, sizeBytes: read.bytes[1]! } : { kind: "unknown", reason: read.reason };
}

/** What a snapshot of the disk comes to: what the backend says the machine has written since it booted, where it
 * can read that off the disk itself, else what df says is used under /root. On a container df reads the box's
 * whole disk, so a backend that knows the machine's own bytes is asked first. Unknown when neither answers, and
 * the line that wanted it says less. */
export async function usedBytes(machine: Machine): Promise<number | undefined> {
  const shape = await machine.describe?.().catch(() => undefined);
  if (shape?.usedBytes !== undefined) return shape.usedBytes;
  const read = await dfRootBytes(machine, "used").catch(() => undefined);
  return read !== undefined && "bytes" in read ? read.bytes : undefined;
}

/** The df reading that closes a stage's last line, so the run's log says what each stage left on the disk. */
export async function freeNote(machine: Machine): Promise<string | undefined> {
  const free = await freeBytes(machine);
  return free.kind === "free" ? `${fmtBytes(free.bytes)} free` : undefined;
}

/** A stage's closing line: its parts in order, the empty ones left out. */
export const closing = (...parts: (string | undefined)[]): string => parts.filter(p => p !== undefined && p !== "").join("; ");

const SWEEP_TIMEOUT_S = 300;
/** The caches the installs leave on the root disk: npm's tarballs, uv's wheels, go's module and build caches,
 * apt's debs, node-gyp's headers from the daemon's native build. Each is rebuilt on use; together they held about
 * 2 GB of the 20 GB builder after one recipe. */
const sweepCachesCmd = (path: string): string => [
  "set -euo pipefail",
  `export PATH=${path}`,
  "if command -v go >/dev/null 2>&1; then go clean -cache -modcache; fi",
  "rm -rf /root/.npm /root/.cache/uv /root/.cache/go-build /root/.cache/node-gyp",
  "if command -v apt-get >/dev/null 2>&1; then apt-get clean; fi",
].join("\n");

/** After an install stage the caches go, under the guard; the phrase says what came back, or why nothing did. */
export async function sweepCaches(machine: Machine, path: string = TOOLS_PATH): Promise<string> {
  const before = await freeBytes(machine);
  const res = await machine.run(guarded(sweepCachesCmd(path), SWEEP_TIMEOUT_S), { deadlineMs: guardDeadlineMs(SWEEP_TIMEOUT_S) });
  if (res.exitCode !== 0) return `cache sweep failed (${reasonOf(res, SWEEP_TIMEOUT_S)})`;
  const after = await freeBytes(machine);
  return before.kind === "free" && after.kind === "free" && after.bytes > before.bytes ? `caches swept, ${fmtBytes(after.bytes - before.bytes)} back` : "caches swept";
}

// Descendants of $1 by parent pid from /proc, widened until no new pid turns up: su -c
// starts its command in a fresh session, so the session's process group alone misses it.
const TREE_FN = [
  "tree() {",
  '  local want="$1" found="" f s pid ppid more=1',
  '  while [ -n "$more" ]; do',
  "    more=",
  "    for f in /proc/[0-9]*/stat; do",
  '      [ -r "$f" ] && read -r s < "$f" || continue',
  '      pid=${f#/proc/}; pid=${pid%/stat}; s=${s##*) }; ppid=${s#* }; ppid=${ppid%% *}',
  '      case " $want $found " in *" $pid "*) continue;; esac',
  '      case " $want $found " in *" $ppid "*) found="$found $pid"; more=1;; esac',
  "    done",
  "  done",
  "  echo $found",
  "}",
].join("\n");

/** The script in its own session, watched from outside it: at the timeout the session's process
 * group and everything descended from it get TERM, then KILL, and the guard returns 124 only once
 * they are gone (disowned first, or bash reports the kill on stderr). The exit code and output are
 * the script's own otherwise. */
export function guarded(script: string, timeoutS: number): string {
  return [
    TREE_FN,
    `setsid bash -c ${shellQuote(script)} &`,
    "p=$!",
    "t=0",
    `while [ $t -lt ${timeoutS} ] && kill -0 $p 2>/dev/null; do sleep 1; t=$((t+1)); done`,
    "if kill -0 $p 2>/dev/null; then",
    "  disown $p 2>/dev/null",
    '  v="$p $(tree $p)"',
    "  kill -TERM -- -$p $v 2>/dev/null",
    `  t=0; while [ $t -lt ${KILL_GRACE_S} ] && kill -0 $v 2>/dev/null; do sleep 1; t=$((t+1)); done`,
    '  v="$p $(tree $p)"',
    "  kill -KILL -- -$p $v 2>/dev/null",
    `  t=0; while [ $t -lt ${KILL_GRACE_S} ] && kill -0 $v 2>/dev/null; do sleep 1; t=$((t+1)); done`,
    "  exit 124",
    "fi",
    "wait $p",
  ].join("\n");
}

/** Seconds a road's step may run: the guard ends it after that many. */
export const roadLimitS = (road: RoadName): number => ROAD_STEPS[road].limitS;

/** A road's script under the guard: the road's network clock ahead of the command, the road's limit on the run. */
export function guardedRoad(road: RoadName, cmd: string): string {
  return guarded([...ROAD_STEPS[road].env, cmd].join("\n"), roadLimitS(road));
}

/** Every skipped tool by name, those sharing a reason together: the reason is one line, the names are what the person ticked. */
function skippedByReason(skipped: readonly ToolResult[]): string {
  const byNote = new Map<string, string[]>();
  for (const t of skipped) byNote.set(t.note ?? "no reason given", [...(byNote.get(t.note ?? "no reason given") ?? []), t.label]);
  return [...byNote].map(([note, names]) => `${nameList(names)} (${note})`).join("; ");
}

type Run = (cmd: string, label: string, road: RoadName, step?: GoldenStep) => Promise<ExecResult>;

/** Homebrew's autoremove then cleanup, each under the guard; the phrase says what came back or what failed, nothing when neither. */
async function brewHousekeeping(machine: Machine, run: Run, path: string): Promise<string | undefined> {
  const before = await freeBytes(machine);
  const failed: string[] = [];
  for (const cmd of brewHousekeepingCmds(path)) {
    const res = await run(cmd, "Homebrew cleanup", "brew");
    if (res.exitCode !== 0) failed.push(reasonOf(res, roadLimitS("brew")));
  }
  const after = await freeBytes(machine);
  if (failed.length > 0) return `Homebrew cleanup failed (${failed.join("; ")})`;
  if (before.kind === "free" && after.kind === "free" && after.bytes > before.bytes) return `Homebrew cleanup freed ${fmtBytes(after.bytes - before.bytes)}`;
  return undefined;
}

function summarize(tools: ToolResult[], housekeeping: string | undefined): string {
  const parts: string[] = [];
  const n = (o: ToolResult["outcome"]) => tools.filter(t => t.outcome === o);
  // An install is named when it says something more than that it landed: the road it took, a note its plan carried.
  // The note is bracketed and the label quoted when it carries this list's own separator, so neither reads as another tool.
  const named = n("installed").flatMap(t => {
    const road = t.road !== undefined ? ` ${ROAD_MODULES[t.road.kind].words}` : "";
    const note = t.note !== undefined ? ` (${t.note})` : "";
    return road === "" && note === "" ? [] : [`${listedName(t.label)}${road}${note}`];
  });
  parts.push(`${n("installed").length} installed${named.length > 0 ? ` (${named.join(", ")})` : ""}`);
  const failed = n("failed");
  if (failed.length > 0) parts.push(`${failed.length} failed: ${failed.map(t => `${listedName(t.label)} (${t.note})`).join(", ")}`);
  const skipped = n("skipped");
  if (skipped.length > 0) parts.push(`${skipped.length} skipped: ${skippedByReason(skipped)}`);
  return housekeeping !== undefined ? `${parts.join(", ")}; ${housekeeping}` : parts.join(", ");
}

/** Which of the commands are not on the machine's tools PATH; `failed` says why the check itself could not run. */
export async function missingCommands(machine: Machine, bins: readonly string[], path: string = TOOLS_PATH, prefix?: string): Promise<{ missing: Set<string>; failed?: string }> {
  const cmd = `${pathLine(path, prefix)}\nfor b in ${bins.map(shellQuote).join(" ")}; do command -v "$b" >/dev/null 2>&1 || echo "missing $b"; done`;
  const res = await machine.exec(cmd, { timeoutMs: INLINE_EXEC_MS });
  const failed = res.exitCode === 0 ? undefined : reasonOf(res, INLINE_EXEC_MS / 1000);
  const missing = new Set(res.stdout.split("\n").flatMap(l => (l.startsWith("missing ") ? [l.slice("missing ".length).trim()] : [])));
  return failed === undefined ? { missing } : { missing, failed };
}

/** The installs that name their command, checked by name on the tools PATH: an install that exited 0 without
 * putting the command there is a failure, not an install, and so is one the check could not reach. */
async function verifyCommands(machine: Machine, tools: readonly ToolInstall[], results: ToolResult[], stage: (detail: string) => void, path: string, prefix?: string): Promise<void> {
  const named = results.filter(r => r.outcome === "installed").map(r => ({ result: r, bin: tools.find(t => t.id === r.id)?.bin })).filter((x): x is { result: ToolResult; bin: string } => x.bin !== undefined);
  if (named.length === 0) return;
  const { missing, failed } = await missingCommands(machine, named.map(x => x.bin), path, prefix);
  if (failed !== undefined) stage(`the PATH check failed (${failed}): ${named.map(x => x.bin).join(", ")} count as failed`);
  for (const x of named) {
    if (failed === undefined && !missing.has(x.bin)) continue;
    x.result.outcome = "failed";
    x.result.note = failed === undefined ? `${x.bin} is not on PATH after the install` : `${x.bin} could not be checked on PATH: ${failed}`;
    delete x.result.road;
  }
}

/** What a batched check prints for a row that is not there: the marker, the row's place in the run, then the last
 * line its check printed. The place and not the id, because an id is a custom row's own free text and can carry the
 * space this line is read back on. Like the command check above, one run answers for every row rather than one round
 * trip each. */
const CHECK_FAILED = "wsp-check";

/** The installs that carry a check of their own, read on the tools PATH after the stage, a page of reads to an
 * exec: a row whose install exited 0 without leaving its tool on the machine is a failure, not an install, and so
 * is every row of a page that could not be run at all, which is said in the stage detail rather than passing
 * quietly. Paged because a check can be a `brew list` of about a second and a recipe can carry a dozen: one read
 * of all of them reaches the inline bound and would fail every row on the machine, agents included. */
async function verifyChecks(machine: Machine, tools: readonly ToolInstall[], results: readonly ToolResult[], stage: (detail: string) => void, path: string, prefix?: string): Promise<void> {
  const checked = results.flatMap(r => {
    const check = r.outcome === "installed" ? tools.find(t => t.id === r.id)?.check : undefined;
    return check === undefined ? [] : [{ result: r, check }];
  });
  if (checked.length === 0) return;
  const pages = await pagedReads(
    machine,
    checked,
    (c, at) => `if ! out="$( ( ${c.check} ) 2>&1 )"; then printf '${CHECK_FAILED} %s %s\\n' ${at} "$(printf '%s' "$out" | tail -1)"; fi`,
    pathLine(path, prefix),
  );
  for (const { rows, res } of pages) {
    if (res.exitCode !== 0) {
      const why = reasonOf(res, INLINE_EXEC_MS / 1000);
      stage(`the checks could not be run (${why}): ${nameList(rows.map(c => c.result.label))} count as failed`);
      for (const c of rows) {
        c.result.outcome = "failed";
        c.result.note = `the check could not be run (${c.check}): ${why}`;
      }
      continue;
    }
    const failed = markersOf(res.stdout, CHECK_FAILED);
    for (const [at, c] of rows.entries()) {
      const why = failed.get(String(at));
      if (why === undefined) continue;
      c.result.outcome = "failed";
      c.result.note = `the check did not pass (${c.check})${why === "" ? "" : `: ${why}`}`;
    }
  }
}

/** What a caller that is not a fresh builder tells the loop about the machine under it. */
export interface InstallToolsOptions {
  /** Steps the machine already satisfies, by step id: each is pushed as installed with ALREADY_ON_MACHINE, runs
   * no command, and counts as landed for the steps waiting on it. */
  present?: ReadonlySet<string>;
  /** Whether the caches the installs leave are swept. A builder becomes an image, so its are swept; a computer
   * somebody owns keeps its own, which are theirs and not this run's to throw away. */
  caches?: "sweep" | "keep";
  /** Each row the moment its outcome exists, for a caller that reports as it goes rather than at the end. */
  onTool?: (result: ToolResult) => void;
  /** The PATH every script of this job exports. The tools PATH on a machine wsp forked, and the probe list on a
   * computer somebody owns, whose home every workspace there writes. */
  path?: string;
  /** The folder of wsp's own the managers install under on a computer somebody owns, whose knobs ride the line
   * beside that PATH; absent on a machine wsp forked, where each manager keeps its own folder under the home. */
  prefix?: string;
}

/** Runs the plan's installs one at a time. Each tool fails alone and is named in the stage detail;
 * one that waits on an install that failed is skipped with that install's name. At the first reading
 * under the floor the cleanup runs once and df is read again, since the bottle cache alone held 2.4 GB
 * at that point on one run; the loop stops only if the disk is still under the floor, and the tools
 * left are skipped with the reading. */
export async function installTools(machine: Machine, tools: readonly ToolInstall[], onStage: Stage, at: GoldenStage = "installing-tools", opts: InstallToolsOptions = {}): Promise<ToolsOutcome> {
  const stage = (detail: string, step?: GoldenStep): void => onStage(at, detail, step);
  const present = opts.present ?? new Set<string>();
  const path = opts.path ?? TOOLS_PATH;
  /** Nothing on a machine whose caches are the person's own; the phrase where they are this run's to sweep. */
  const sweep = async (): Promise<string | undefined> => (opts.caches === "keep" ? undefined : await sweepCaches(machine, path));
  await machine.exec(SWEEP_TMP_CMD, { timeoutMs: INLINE_EXEC_MS });
  const out: ToolsOutcome = { tools: [] };
  /** One row's outcome: kept for the answer and handed to the caller watching, in the order the loop reaches them. */
  const landed = (result: ToolResult): void => {
    out.tools.push(result);
    opts.onTool?.(result);
  };
  const installed = new Set<string>();
  const labelOf = (id: string): string => tools.find(t => t.id === id)?.label ?? id;
  const run: Run = (cmd, label, road, step) => machine.run(guardedRoad(road, cmd), { deadlineMs: guardDeadlineMs(roadLimitS(road)), onLine: line => stage(`${label}: ${line}`, step) });
  let floor: string | undefined;
  let dfWarned = false;
  let cleanedAtFloor = false;
  /** Nothing touches the disk between the read after an install and the next tool's turn, so that read serves both. */
  let reading: FreeDisk | undefined;
  const floorNote = (reading: string): string => `${reading}, keeping ${fmtBytes(TOOLS_DISK_FLOOR)} free`;
  const cleanupAtFloor = async (low: number): Promise<FreeDisk | undefined> => {
    if (cleanedAtFloor) return undefined;
    cleanedAtFloor = true;
    stage(`${fmtBytes(low)} free, under the ${fmtBytes(TOOLS_DISK_FLOOR)} floor; cleaning up before skipping`);
    const brew = installed.has("tools/homebrew") ? await brewHousekeeping(machine, run, path) : undefined;
    const swept = await sweep();
    const after = await freeBytes(machine);
    stage(closing(brew, swept, after.kind === "free" ? `${fmtBytes(after.bytes)} free` : after.reason));
    return after;
  };
  for (const [i, tool] of tools.entries()) {
    // Read before anything else about this step: a step the machine already satisfies at the version asked runs
    // nothing, so neither the disk nor what it waits on has any bearing on it, and what waits on it waits on
    // something that is already there.
    if (present.has(tool.id)) {
      installed.add(tool.id);
      landed({ id: tool.id, label: tool.label, outcome: "installed", note: ALREADY_ON_MACHINE });
      continue;
    }
    if (tool.after !== undefined && !installed.has(tool.after)) {
      landed({ id: tool.id, label: tool.label, outcome: "skipped", note: `${labelOf(tool.after)} did not install` });
      continue;
    }
    if (floor !== undefined) {
      landed({ id: tool.id, label: tool.label, outcome: "skipped", note: floor });
      continue;
    }
    let free = reading ?? (await freeBytes(machine));
    reading = undefined;
    if (free.kind === "unknown" && !dfWarned) {
      dfWarned = true;
      stage(`free disk unknown (${free.reason}); installing without the ${fmtBytes(TOOLS_DISK_FLOOR)} floor`);
    } else if (free.kind === "free" && free.bytes < TOOLS_DISK_FLOOR) {
      const after = await cleanupAtFloor(free.bytes);
      if (after === undefined || after.kind === "unknown" || after.bytes < TOOLS_DISK_FLOOR) {
        const words = after === undefined ? `${fmtBytes(free.bytes)} free` : after.kind === "free" ? `${fmtBytes(after.bytes)} free after cleanup` : `${fmtBytes(free.bytes)} free before cleanup and unknown after (${after.reason})`;
        floor = floorNote(words);
        landed({ id: tool.id, label: tool.label, outcome: "skipped", note: floor });
        continue;
      }
      free = after;
    }
    const step: GoldenStep = { label: tool.label, command: tool.shown ?? tool.cmd };
    const limit = roadLimitS(tool.manager);
    stage(`${tool.label} (${i + 1}/${tools.length})`, step);
    const t0 = Date.now();
    let res = await run(tool.cmd, tool.label, tool.manager, step);
    if (res.exitCode !== 0 && CELLAR_LOCKED.test(res.stderr)) {
      stage(`${tool.label}: another brew holds its cellar; waiting for it, then once more`, step);
      await machine.run(BREW_LOCK_WAIT_CMD, { deadlineMs: (BREW_LOCK_WAIT_S + 60) * 1000 });
      res = await run(tool.cmd, tool.label, tool.manager, step);
    }
    let timeouts = res.exitCode === 124 ? 1 : 0;
    if (timeouts === 1 && ROAD_STEPS[tool.manager].retry) {
      stage(`${tool.label}: ${stepRetryLine(limit)}`, step);
      res = await run(tool.cmd, tool.label, tool.manager, step);
      if (res.exitCode === 124) timeouts = 2;
    }
    const ms = Date.now() - t0;
    if (res.exitCode === 0) {
      installed.add(tool.id);
      if (tool.id === "tools/homebrew") out.homebrew = { ...HOMEBREW };
      const road = roadOf(res.stdout);
      const left = await freeBytes(machine);
      reading = left;
      const bytes = free.kind === "free" && left.kind === "free" ? Math.max(0, free.bytes - left.bytes) : undefined;
      landed({ id: tool.id, label: tool.label, outcome: "installed", ...(tool.note !== undefined ? { note: tool.note } : {}), ms, ...(bytes !== undefined ? { bytes } : {}), ...(road !== undefined ? { road } : {}) });
    } else {
      landed({ id: tool.id, label: tool.label, outcome: "failed", note: timeouts === 2 ? timedOutLine(limit, 2) : reasonOf(res, limit), ms });
    }
  }
  await verifyCommands(machine, tools, out.tools, stage, path, opts.prefix);
  await verifyChecks(machine, tools, out.tools, stage, path, opts.prefix);
  await readPins(machine, tools, out.tools, stage, path, opts.prefix);
  const housekeeping = installed.has("tools/homebrew") ? await brewHousekeeping(machine, run, path) : undefined;
  stage(closing(summarize(out.tools, housekeeping), await sweep(), await freeNote(machine)));
  return out;
}
