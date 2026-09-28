// SPDX-License-Identifier: AGPL-3.0-only
// One guest command that may outlive a single exec: the script goes to a file
// and starts in its own session with its streams and exit code on disk, then
// short execs read the files from where the last read stopped until the exit
// code is there or the deadline kills the session. A poll that fails (the
// machine napping) is retried after a pause; the deadline bounds that too,
// and a guest the backend calls unusable or a machine the provider no longer
// has ends the run at once.

import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { EXEC_BODY_MAX, EXEC_CHUNK_BYTES, EXEC_DEADLINE_EXIT, shellQuote } from "@wsp/protocol";
import { GuestUnusableError, isMissing } from "./errors.js";
import type { ExecResult, Machine, RunOptions } from "./machine.js";

/** The longest one plain exec may take. The provider cuts any exec still running at about 29 s with a 502
 * (measured 2026-09-05), whatever its timeoutMs says; anything that can run longer goes through run(). */
export const INLINE_EXEC_MS = 20_000;
/** What a run past its deadline exits with, the same code the guest-side guard uses for its own timeout, and the
 * one the exec op on a place answers with, read off the protocol so the two roads cannot say different numbers. */
export const DEADLINE_EXIT = EXEC_DEADLINE_EXIT;

/** The folder a machine wsp made keeps wsp's own working files in. The whole disk there is wsp's, so the shared
 * temporary folder is wsp's too; a machine somebody else owns names its own, since a folder every account on it
 * shares is one another account could sit in first. */
export const GUEST_TMP = "/tmp";
/** Where a run's script, its streams and its exit code live on a machine wsp made. A machine somebody else owns
 * names its own under their home, since a folder every account on it shares is one another account could sit in
 * first; both roads read one rule rather than each spelling a path. */
export const RUN_DIR = `${GUEST_TMP}/wsp-run`;

/** What a guest prints back to say a step landed, and the only proof any of them gives: the exec that carried the
 * step exits 0 whether or not the step happened, so the code on its own says nothing. One home for the words, read
 * by the launch road here and by the streaming one above it. */
export const HANDSHAKE = { piece: "WSP_PIECE", launched: "WSP_LAUNCHED", written: "WSP_OK", gone: "WSP_GONE", run: "WSP_RUN" } as const;

/** What the machine said, for a sentence that would otherwise end in a colon with nothing behind it: its output if
 * it printed any, else the plain fact that it printed none, with the code it exited beside it either way. A bare
 * exit 0 reads as success on every other road a person knows. */
export function machineAnswer(res: ExecResult): string {
  const said = [res.stdout, res.stderr].map(text => text.trim()).filter(text => text !== "").join(" ");
  return said === "" ? `it printed nothing and exited ${res.exitCode}` : `it exited ${res.exitCode} and said: ${said}`;
}

/** Where a backend that cannot hand a machine its environment at create writes it for the daemon's unit alone to
 * read, one KEY="value" line each, under /etc so it travels with the disk. The daemon's unit names it as an
 * EnvironmentFile it may lack; nothing else on the machine reads it. */
export const DAEMON_ENV_FILE = "/etc/wsp/daemon.env";
/** Room left under the cap for what a backend wraps around the command on the wire: its JSON keys, its exec env line,
 * one escape byte per newline. */
const EXEC_ENVELOPE_BYTES = 512;
const POLL_MS = 2_000;
const FIRST_POLL_MS = 250;
const NO_EXIT_NOTE = "wsp: the command ended without reporting an exit code";

/** Whether one command fits an exec body, the backend's wrapper counted: the one place the measured cap is read, so
 * every road that builds a command out of a list pages it against the same rule. A body over the cap is refused with
 * 413 by the provider, which reads as the road failing rather than as the command being too long. */
export function execFits(command: string): boolean {
  return Buffer.byteLength(command) + EXEC_ENVELOPE_BYTES <= EXEC_BODY_MAX;
}

/** How many reads one exec carries. A read is a version line, a `command -v` or a `brew list`, about a second each
 * on a computer somebody owns, and one exec has the inline bound above to answer inside; the body cap pages a long
 * read as well. */
export const READS_PER_EXEC = 8;

/** One page of reads and what the exec that carried it answered. */
export interface ReadPage<T> {
  rows: readonly T[];
  res: ExecResult;
}

/** Many short reads on a machine in as few execs as they fit in: `READS_PER_EXEC` to a page, and a page that would
 * not fit one exec body is split again. `line` is handed the row's place inside its own page, since each page's
 * output is read back on its own, and `head` opens every page (the PATH the reads run on).
 *
 * The pages are what a caller reads a failure off: an exec that could not be made fails the rows it carried and no
 * others, where one unpaged read of everything would have failed every row on the machine. */
export async function pagedReads<T>(machine: Machine, rows: readonly T[], line: (row: T, at: number) => string, head: string): Promise<ReadPage<T>[]> {
  const out: ReadPage<T>[] = [];
  let page: { row: T; line: string }[] = [];
  const cmdOf = (lines: readonly string[]): string => [head, ...lines].join("\n");
  const send = async (): Promise<void> => {
    if (page.length === 0) return;
    const sending = page;
    page = [];
    out.push({ rows: sending.map(p => p.row), res: await machine.exec(cmdOf(sending.map(p => p.line)), { timeoutMs: INLINE_EXEC_MS }) });
  };
  for (const row of rows) {
    const next = line(row, page.length);
    if (page.length > 0 && (page.length >= READS_PER_EXEC || !execFits(cmdOf([...page.map(p => p.line), next])))) {
      await send();
      page.push({ row, line: line(row, 0) });
    } else page.push({ row, line: next });
  }
  await send();
  return out;
}

/** What one page printed, by the place in that page the marker names: the one rule for reading a batched read back,
 * so a reader of `pagedReads` never spells it again. A line that is not the marker's is not an answer. */
export function markersOf(stdout: string, marker: string): Map<string, string> {
  return new Map(
    stdout.split("\n").flatMap(line => {
      const words = line.trim().split(" ");
      return words[0] === marker && words[1] !== undefined ? [[words[1], words.slice(2).join(" ")] as const] : [];
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export interface GuestWrite {
  /** Where on the guest; its directory is made if missing. */
  path: string;
  text: string;
  /** Add to the file's end instead of replacing it. */
  append?: boolean;
}

export interface PutFilesOptions {
  /** Lines the last exec runs before any file lands. */
  before?: string[];
  /** Lines the last exec runs once every file is on disk. */
  after?: string[];
  timeoutMs?: number;
}

/** The file beside an appended path that says which append landed last, holding that append's own key: exec honours
 * no idempotency key and a lost answer is retried, so an append runs only where the marker does not already hold its
 * key. One marker per path, whatever a path is appended to over a machine's life, since a name of its own per append
 * fills the folder it sits in with a file nothing comes back for. */
export const appendMarker = (path: string): string => `${path}.appended`;

/** The markers a path carries from a road that named each append at random, which are dead the moment a job that
 * appends by the marker above runs: a sweep of them is `"$path"` with this glob after it, which the name above
 * cannot be matched by. */
export const OLD_APPEND_MARKS = ".a[0-9a-f]*";

/** The execs that put the files on the guest, every body under the cap. The last exec runs `before`, lands each file,
 * then runs `after`, so a caller's launch shares it. A file whose base64 fits that exec goes in it as one printf; a
 * larger one goes up first in numbered pieces, each written whole to its own file so a retried exec lands it once, and
 * the last exec joins them under pipefail so a missing piece fails the write instead of landing a spliced file. An
 * append lands once behind the marker above, which its key is written into after it; the marker, and the pieces of an
 * append that `before` turned away, stay beside the file until the run's cleanup removes them. */
function uploadSequence(files: GuestWrite[], before: string[], after: string[], upload: string): string[] {
  const head = `mkdir -p ${[...new Set(files.map(f => posix.dirname(f.path)))].map(shellQuote).join(" ")}`;
  // A key per file of the upload, so two appends to one path in one call each land rather than the second reading
  // the first's marker as its own.
  const plan = files.map((f, at) => ({ ...f, b64: Buffer.from(f.text, "utf8").toString("base64"), pieces: 0, mark: appendMarker(f.path), key: `${upload}.${at}` }));
  type Planned = (typeof plan)[number];
  const land = (f: Planned): string[] => {
    const names = `${shellQuote(f.path)}.{0..${f.pieces - 1}}`;
    const decode = `${f.pieces === 0 ? `printf %s ${shellQuote(f.b64)}` : `cat ${names}`} | base64 -d ${f.append ? ">>" : ">"} ${shellQuote(f.path)}`;
    const write = f.append
      ? `[ "$(cat ${shellQuote(f.mark)} 2>/dev/null)" = ${shellQuote(f.key)} ] || { ${decode} && printf %s ${shellQuote(f.key)} > ${shellQuote(f.mark)}; } || exit 1`
      : `${decode} || exit 1`;
    return f.pieces === 0 ? [write] : [write, `rm -f ${names}`];
  };
  const last = (): string => [head, ...before, "set -o pipefail", ...plan.flatMap(land), ...after].join("\n");
  // A piece waits on disk for the last exec to join and remove it, so it is the writer's alone while it waits: a
  // script cut into pieces carries the same bytes as one that fits, the caller's environment among them.
  const piece = (path: string, i: number, part: string): string => [head, "umask 077", `printf %s ${shellQuote(part)} > ${shellQuote(path)}.${i} || exit 1`, `echo ${HANDSHAKE.piece}`].join("\n");
  const execs: string[] = [];
  while (!execFits(last())) {
    const f = plan.filter(f => f.pieces === 0).sort((a, b) => b.b64.length - a.b64.length)[0];
    if (f === undefined) throw new Error("the lines around the upload do not fit one exec body");
    // Base64 decodes in groups of four, so a piece boundary on a multiple of four keeps the joined text decodable.
    const size = Math.floor((EXEC_BODY_MAX - EXEC_ENVELOPE_BYTES - Buffer.byteLength(piece(f.path, f.b64.length, ""))) / 4) * 4;
    f.pieces = Math.max(1, Math.ceil(f.b64.length / size));
    for (let i = 0; i < f.pieces; i++) execs.push(piece(f.path, i, f.b64.slice(i * size, (i + 1) * size)));
  }
  return [...execs, last()];
}

/** What one upload took, beside what its last exec answered: the numbered pieces the files were cut into to fit
 * an exec body, one exec of its own each. Zero where everything fit the one exec that lands them. */
export interface UploadResult extends ExecResult {
  pieces: number;
}

/** The one way bytes go onto a guest through exec: sends the upload's execs in order, each piece confirmed before the
 * next goes, and answers with the last exec's result, which the caller reads for its own marker.
 *
 * Every exec here is written to land the same whether it runs once or twice, which is this function's own law
 * above: a piece is a whole file written under its own name, an append is held behind its marker, and the lines
 * around them are the caller's to write that way. So each carries a key of this upload's, and a road that broke
 * under one sends it again rather than losing the file half written. */
export async function putFiles(machine: Machine, files: GuestWrite[], opts: PutFilesOptions = {}): Promise<UploadResult> {
  const timeoutMs = opts.timeoutMs ?? INLINE_EXEC_MS;
  const upload = randomBytes(6).toString("hex");
  const execs = uploadSequence(files, opts.before ?? [], opts.after ?? [], upload);
  for (const [at, cmd] of execs.slice(0, -1).entries()) {
    const res = await machine.exec(cmd, { timeoutMs, idempotencyKey: `${upload}/${at}` });
    if (res.exitCode !== 0 || !res.stdout.includes(HANDSHAKE.piece)) {
      throw new Error(`a piece did not land on ${machine.id}: nothing came back saying ${HANDSHAKE.piece}, the word the guest prints once a piece is written; ${machineAnswer(res)}`);
    }
  }
  const last = await machine.exec(execs.at(-1)!, { timeoutMs, idempotencyKey: `${upload}/last` });
  return { ...last, pieces: execs.length - 1 };
}

/** The wrapper is the session leader: its pid is the group the deadline kills, and it writes the exit file
 * after the script's streams are closed, so an exit file always means the streams are complete. */
function launch(machine: Machine, base: string, script: string): Promise<ExecResult> {
  return putFiles(machine, [{ path: `${base}.sh`, text: script }], {
    // The script carries whatever the caller put in it, which for a machine's environment is its keys: every file of
    // a run is unreadable to any other account on the machine from the moment it is made, not chmodded after. The
    // mask is the run's own; the script runs under the one the shell came with, since what it installs is not this
    // road's to narrow.
    // exec honours no idempotency key and a launch whose answer was lost is retried; the claim makes the second a no-op.
    before: ["u=$(umask)", "umask 077", `b=${base}`, `mkdir "$b.d" 2>/dev/null || { echo ${HANDSHAKE.launched}; exit 0; }`],
    after: [
      `setsid nohup bash -c '( umask "$1"; exec bash "$0.sh" ) > "$0.out" 2> "$0.err" < /dev/null; echo $? > "$0.exit"' "$b" "$u" > /dev/null 2>&1 &`,
      'echo $! > "$b.pid"',
      `echo ${HANDSHAKE.launched}`,
    ],
  });
}

/** The exit file is read before the streams, so a poll that sees an exit code reads streams that are complete. */
function pollCommand(base: string, outOffset: number, errOffset: number): string {
  return [
    `b=${base}`,
    "echo WSP_POLL",
    `printf '%s\\n' "$(cat "$b.exit" 2>/dev/null)"`,
    `printf '%s\\n' "$(tail -c +${outOffset + 1} "$b.out" 2>/dev/null | head -c ${EXEC_CHUNK_BYTES} | base64 -w0)"`,
    `printf '%s\\n' "$(tail -c +${errOffset + 1} "$b.err" 2>/dev/null | head -c ${EXEC_CHUNK_BYTES} | base64 -w0)"`,
    `p=$(cat "$b.pid" 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo up; else echo down; fi`,
    "echo WSP_POLL_END",
  ].join("\n");
}

function killCommand(base: string): string {
  return `b=${base}; p=$(cat "$b.pid" 2>/dev/null); if [ -n "$p" ]; then kill -TERM -- "-$p" "$p" 2>/dev/null; sleep 2; kill -KILL -- "-$p" "$p" 2>/dev/null; fi; true`;
}

/** Everything of one run: its script, its streams, its exit code, its pid, its claim, and the numbered pieces and
 * append markers a large script left behind. The base is this run's own random name, so the glob reaches no other. */
function cleanCommand(base: string): string {
  return `rm -rf ${base}.*`;
}

interface Poll {
  exit: string;
  out: Buffer;
  err: Buffer;
  up: boolean;
}

function parsePoll(stdout: string): Poll | undefined {
  const lines = stdout.split("\n");
  const at = lines.indexOf("WSP_POLL");
  if (at === -1 || lines[at + 5] !== "WSP_POLL_END") return undefined;
  return { exit: lines[at + 1]!.trim(), out: Buffer.from(lines[at + 2]!, "base64"), err: Buffer.from(lines[at + 3]!, "base64"), up: lines[at + 4] === "up" };
}

/** Bytes to complete lines for the listener; what follows the last newline waits for the next read. */
class LineStream {
  private readonly chunks: Buffer[] = [];
  private pending = Buffer.alloc(0);
  offset = 0;

  constructor(private readonly onLine: ((line: string) => void) | undefined) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.offset += chunk.length;
    if (this.onLine === undefined) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    let nl: number;
    while ((nl = this.pending.indexOf(0x0a)) !== -1) {
      const line = this.pending.subarray(0, nl).toString("utf8");
      this.pending = this.pending.subarray(nl + 1);
      if (line !== "") this.onLine(line);
    }
  }

  /** The tail with no newline after it, once nothing more is coming. */
  flush(): void {
    if (this.pending.length > 0 && this.onLine !== undefined) this.onLine(this.pending.toString("utf8"));
    this.pending = Buffer.alloc(0);
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Runs the script on the machine as run() promises: the result is shaped like one exec's, with exit 124 past
 * the deadline and -1 when the session ended without an exit code. `runDir` is for tests on a local bash. */
export async function execDetached(machine: Machine, script: string, opts: RunOptions, runDir = RUN_DIR): Promise<ExecResult> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const base = `${runDir}/${randomBytes(6).toString("hex")}`;
  const startedAt = Date.now();
  const exec = (cmd: string): Promise<ExecResult> => machine.exec(cmd, { timeoutMs: INLINE_EXEC_MS });

  const quiet = (p: Promise<unknown>): Promise<void> => p.then(() => undefined, () => undefined);

  // A launch that failed may have left the script, or the pieces of one, on the guest: nothing else will come back
  // for them, and they hold whatever the caller put in the script.
  const launched = await launch(machine, base, script).catch(async (e: unknown) => {
    await quiet(exec(cleanCommand(base)));
    throw e;
  });
  if (launched.exitCode !== 0 || !launched.stdout.includes(HANDSHAKE.launched)) {
    await quiet(exec(cleanCommand(base)));
    throw new Error(`launch failed on ${machine.id}: nothing came back saying ${HANDSHAKE.launched}, the word the guest prints once the run is up; ${machineAnswer(launched)}`);
  }

  const out = new LineStream(opts.onLine);
  const err = new LineStream(opts.onLine);
  const result = (exitCode: number, note?: string): ExecResult => {
    out.flush();
    err.flush();
    const stderr = err.text();
    return { exitCode, stdout: out.text(), stderr: note === undefined ? stderr : `${stderr}${stderr === "" || stderr.endsWith("\n") ? "" : "\n"}${note}\n` };
  };
  const read = (poll: Poll): boolean => {
    out.push(poll.out);
    err.push(poll.err);
    return poll.out.length === EXEC_CHUNK_BYTES || poll.err.length === EXEC_CHUNK_BYTES;
  };

  let wait = Math.min(FIRST_POLL_MS, pollMs);
  let downs = 0;
  while (true) {
    if (Date.now() - startedAt > opts.deadlineMs) {
      await quiet(exec(killCommand(base)));
      const last = await exec(pollCommand(base, out.offset, err.offset)).then(r => parsePoll(r.stdout), () => undefined);
      if (last !== undefined) read(last);
      await quiet(exec(cleanCommand(base)));
      return result(DEADLINE_EXIT);
    }
    let poll: Poll | undefined;
    try {
      poll = parsePoll((await exec(pollCommand(base, out.offset, err.offset))).stdout);
    } catch (e) {
      // An unusable guest or a machine the provider no longer has answers no later poll; waiting ends in a bare 124.
      if (e instanceof GuestUnusableError || isMissing(e)) throw e;
      poll = undefined;
    }
    if (poll === undefined) {
      await sleep(pollMs);
      continue;
    }
    if (read(poll)) continue;
    if (poll.exit !== "") {
      await quiet(exec(cleanCommand(base)));
      const code = Number(poll.exit);
      return Number.isInteger(code) ? result(code) : result(-1, NO_EXIT_NOTE);
    }
    // The pid is checked after the exit file: a leader that finished in between shows as down with no exit yet.
    if (!poll.up && ++downs > 1) {
      await quiet(exec(cleanCommand(base)));
      return result(-1, NO_EXIT_NOTE);
    }
    if (!poll.up) continue;
    await sleep(wait);
    wait = Math.min(pollMs, wait * 2);
  }
}
