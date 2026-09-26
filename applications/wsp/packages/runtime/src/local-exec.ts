// SPDX-License-Identifier: AGPL-3.0-only
// The ExecStreamFactory a harness turn on a local workspace runs through: a
// real process on this computer, launched detached the way the daemon launches
// one inside a guest. machineExecStream is written for a Linux guest reached
// over REST (setsid, base64 -w0, /proc), which cannot drive a binary on this
// Mac, so a local machine has its own factory; the shape of a run is the same
// on both roads. A turn is one command: bash -c it, its stdout and stderr
// merged into one log file in arrival order, its exit code in an exit file
// beside it. The reader polls that log, so the run belongs to the computer and
// not to the process that launched it: a host that restarts re-opens the run
// by the handle its stream reported and reads what the turn printed while
// nobody was listening, and a run no row of the connecting host holds is ended
// by the sweep. A stream started with an input channel gets a file the launch
// seeds and every write() appends to; a tail feeds it through a fifo, so a
// message reaches a running process this host holds no pipe to. One started
// without gets no stdin at all, so the binary reads EOF rather than hanging on
// a silent open pipe.
//
// The child leads a process group of its own and every signal goes to that
// group, never to the leader alone: a harness leaves its own children behind
// when it goes, and a grandchild that outlives the leader holds the inherited
// log, so a signal to the leader alone left the stream unended and the harness
// running (seven such processes were found on one box, the oldest fourteen
// hours past its turn's reply) and left a cut turn's test workers and packagers
// burning that box's cores. The group is taken at every ending, the leader's
// own exit included, which is what the cloud road's reap does at the same
// point. The claim directory is what says a run is still on this computer; the
// reap takes it with the rest, so an attach to a swept run answers gone. What
// it signals is read before it signals it: a pid this computer handed out again
// leads a group of its own, so the reap asks whether the group is still there
// and how old its leader is against the claim, and leaves anything else alone.
// The turn runs under the same two limits a cloud turn does, idle and
// wall, read from the one rule machine-exec reads, so a hung agent ends with
// the same line on either kind, and the idle limit reads the same activity on
// both: bytes, the person's messages, and the work the turn's own tree is doing
// while it prints nothing.

import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXEC_CHUNK_BYTES, psCpuSeconds, RUN_STOP_MS, shellQuote, TURN_IDLE_MS, TURN_WALL_MS } from "@wsp/protocol";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { readsWork, turnActivity, turnCut, type MachineExecOptions, type TurnWaiting } from "./machine-exec.js";

/** One reading of the work a turn's process group has done, in the ticks the activity clock counts, or undefined
 * when this computer cannot answer for the group. */
export type GroupWorkReader = (pgid: number, then: (ticks: number | undefined) => void) => void;

export interface LocalExecOptions extends Pick<MachineExecOptions, "idleMs" | "deadlineMs" | "now" | "pollMs"> {
  /** The folder the child starts in; the command may cd elsewhere, as a harness turn's does. */
  root: string;
  /** The folder a run's script, log, pid and exit code live in. One folder per state file, so two hosts on this
   * computer never sweep each other's turns. */
  runDir: string;
  /** How the turn's tree is read; ps is the road on this computer. A test hands in a reader that answers off the
   * clock the rule measures against, since what a real tree is given on a loaded box is not what the rule is. */
  readWork?: GroupWorkReader;
  /** Every run this process is reading, each as the call that stops reading it. A poll of a run holds the event
   * loop until that run ends, so a process that is done with its work has to let go of the ones still going: the
   * turns themselves lead their own process groups and go on, and whatever opens them next reads their logs from
   * the first byte. The wiring that made this factory owns the set and empties it when it closes. */
  reading?: Set<() => void>;
}

/** How often the log is read and the limits are read against the clock; the cloud road polls its guest the same way,
 * slower because every poll there is a round trip. */
const POLL_MS = 100;
/** How often the reap looks at the group it asked to go, while it waits out the one stop grace both roads give. */
const GRACE_POLL_MS = 200;
/** A handle this factory could have minted: a name of this shape inside the run folder it launches into. Read off
 * every handle that arrives from a store before it reaches a path or a signal, since a value that has been to a file
 * on disk is no longer this code's. */
const RUN_ID = /^[0-9a-f]{12}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The line that ends one run's input channel. The pump forwards every line written before it and then goes, so the
 * command reads EOF after the last message and never in front of one; ending the pump by a signal instead took the
 * message a person had just sent with it. Derived from the run's own name, so a host that attaches to a run an
 * earlier one launched closes the same channel without being told anything. */
const endMarker = (base: string): string => `__WSP_EOF_${base.slice(-12)}__`;

/** One turn's whole group, by the pid its launch recorded: the child leads the group, so a negative pid is every
 * process the turn started. A group whose last member is already gone answers ESRCH, which is the same nothing to
 * do as no group at all. */
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    return;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Cumulative CPU as ps prints it, in the ticks the activity clock counts. The column is parsed in one place, which
 * the daemon's processes module reads too. */
function cpuTicks(time: string): number {
  const ticks = Math.round(psCpuSeconds(time) * 100);
  return Number.isSafeInteger(ticks) ? ticks : 0;
}

/** The work the turn's own process group has done, as this computer's ps reports it: the group's cumulative CPU,
 * which is every process the turn started and nothing else. Neither ps reports a process's I/O, so a local turn's
 * reading is CPU alone where a guest's counts bytes moved too. Nothing here may reach the timer that calls it:
 * node hands only five errnos to a spawn's async error path and throws the rest (EPERM where ps is out of reach,
 * ENOMEM on a full box) straight out of execFile, so both roads answer with no reading, and a turn whose tree
 * cannot be read is left on its stream alone. */
const readGroupWork: GroupWorkReader = (pgid, then) => {
  const sum = (stdout: string): number => {
    let ticks = 0;
    for (const row of stdout.split("\n")) {
      const [group = "", time = ""] = row.trim().split(/\s+/);
      if (Number(group) === pgid) ticks += cpuTicks(time);
    }
    return ticks;
  };
  try {
    execFile("ps", ["-eo", "pgid=,time="], (err, stdout) => then(err === null ? sum(stdout) : undefined));
  } catch {
    then(undefined);
  }
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** What a run's own folder and its files are readable by: the person whose turn it is and nobody else on this
 * computer. A Mac has other logins on it, and a run's script carries the whole launch environment. */
const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

/** One of a run's files, made owner-only from its first byte. `wx` is what makes that true rather than hoped for:
 * the mode is only applied to a file this call creates, so a path that somehow already exists fails the launch
 * instead of writing a turn's environment into a file somebody else made. */
function writeOwned(path: string, text: string): void {
  writeFileSync(path, text, { mode: OWNER_FILE, flag: "wx" });
}

/** Whether a process group with this id exists at all: signal 0 asks the kernel and sends nothing, and a group
 * whose last member is gone answers ESRCH. EPERM is a group under another login, which exists. */
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** When a process started, in milliseconds on this computer's clock, off the elapsed time ps prints: `[[dd-]hh:]mm:ss`
 * on both computers wsp runs a local turn on. Nothing here may reach the caller's error road, so a ps that will not
 * answer is no reading rather than a throw. */
function startedAt(pid: number): Promise<number | undefined> {
  return new Promise(resolve => {
    const parse = (out: string): number | undefined => {
      const said = out.trim();
      const [span = "", days = "0"] = said.split("-").reverse();
      const parts = span.split(":").map(Number);
      if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return undefined;
      const [hours = 0, minutes = 0, seconds = 0] = parts.length === 3 ? parts : [0, ...parts];
      return Date.now() - (((Number(days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
    };
    try {
      execFile("ps", ["-o", "etime=", "-p", String(pid)], (err, stdout) => resolve(err === null ? parse(stdout) : undefined));
    } catch {
      resolve(undefined);
    }
  });
}

/** How far a leader's own age may sit from the claim's before it is read as somebody else's process. The launch
 * makes the claim and spawns within the same moment, so this is slack for a busy computer and nothing more; a pid
 * this computer handed out again is younger than its claim by however long the run had been going. */
const LEADER_WINDOW_MS = 5_000;

/** Whether the pid a run recorded still leads that run's own group, which is what a reap must know before it
 * signals anything. A pid is free again only once its group has no members left, so a group that still answers is
 * the one this run made and its stragglers are the turn's. The one hole that leaves is a pid handed out again
 * after the whole group went, to a process that then led a group of its own; the leader's own age closes it, since
 * the launch claims and spawns in the same moment. A ps that will not answer leaves the group's own reading as the
 * whole of it, which is what this had before the age was read at all. */
async function leadsThisRun(base: string, pid: number): Promise<boolean> {
  if (!groupExists(pid)) return false;
  // The leader is gone and its children hold the group open: the kernel keeps that number while they do.
  if (!alive(pid)) return true;
  const started = await startedAt(pid);
  if (started === undefined) return true;
  const claimed = ((): number | undefined => {
    try {
      return statSync(`${base}.d`).mtimeMs;
    } catch {
      return undefined;
    }
  })();
  return claimed === undefined || Math.abs(started - claimed) <= LEADER_WINDOW_MS;
}

/** Everything one run left on this computer, ended and taken away: the run's own process group gets TERM, then
 * KILL once the stop grace passes, and the run's files go. The group and never the leader alone, at every ending
 * including the leader's own exit, since the children a harness leaves behind are what hold a machine's memory for
 * its life. A group that is not this run's is left alone and only its files go. */
async function reapRun(base: string, graceMs = RUN_STOP_MS): Promise<void> {
  const pid = Number(readFile(`${base}.pid`)?.trim() ?? "");
  if (Number.isSafeInteger(pid) && pid > 0 && (await leadsThisRun(base, pid))) {
    signalGroup(pid, "SIGTERM");
    // The grace is the group's, not the leader's: a leader that goes at once on the TERM leaves the children it
    // started to take the whole of it, which is the stop every road here promises them.
    for (let waited = 0; waited < graceMs && groupExists(pid); waited += GRACE_POLL_MS) await sleep(Math.min(GRACE_POLL_MS, graceMs - waited));
    signalGroup(pid, "SIGKILL");
  }
  for (const suffix of ["sh", "log", "pid", "exit", "in", "fifo", "tail"]) rmSync(`${base}.${suffix}`, { force: true });
  rmSync(`${base}.d`, { recursive: true, force: true });
}

/** The fifo a turn's messages reach its command through, owner-only like the files beside it: what a person sends
 * into a running turn travels through it. mkfifo is on both computers wsp runs a local turn on, and node has no
 * call of its own for one. */
function spawnFifo(path: string): void {
  const made = spawnSync("mkfifo", ["-m", "600", path]);
  if (made.status !== 0) throw new Error(`no input channel for this turn: mkfifo ${path} answered ${String(made.status)}`);
}

/** One complete line at a time out of a growing byte stream: what precedes each newline is yielded, the tail waits
 * for more, and the final tail with no newline is yielded when the stream closes. The queue fills whether or not
 * anybody is iterating, so a turn's ending is the run's own and not its reader's. */
class Lines {
  private readonly queue: string[] = [];
  private pending = "";
  private wake: (() => void) | undefined;
  private done = false;
  private error: Error | undefined;

  feed(chunk: string): void {
    this.pending += chunk;
    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      this.queue.push(this.pending.slice(0, nl));
      this.pending = this.pending.slice(nl + 1);
    }
    this.wake?.();
    this.wake = undefined;
  }

  /** Ends the stream with an error once everything already read is out: what a cut turn's reader sees last. */
  fail(error: Error): void {
    this.error = error;
    this.end();
  }

  end(): void {
    if (this.pending !== "") {
      this.queue.push(this.pending);
      this.pending = "";
    }
    this.done = true;
    this.wake?.();
    this.wake = undefined;
  }

  async *iterate(): AsyncGenerator<string> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>(resolve => {
        this.wake = resolve;
      });
    }
  }
}

export function localExecStream(opts: LocalExecOptions, isWaiting?: TurnWaiting): ExecStreamFactory {
  const limits = { idleMs: opts.idleMs ?? TURN_IDLE_MS, deadlineMs: opts.deadlineMs ?? TURN_WALL_MS };
  const waiting = isWaiting ?? (() => false);
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? POLL_MS;
  const runDir = opts.runDir;
  const readWork = opts.readWork ?? readGroupWork;
  /** A handle this factory could have minted, and nothing else: the shape is read here, by the one predicate both
   * the attach road and the sweep read, so nothing that turned up in the run folder reaches a signal on the
   * strength of being there. */
  const minted = (run: string): boolean => run.startsWith(`${runDir}/`) && RUN_ID.test(run.slice(runDir.length + 1));

  /** The one reader both roads share: a launch that has just started its child, and an attach to a run an earlier
   * host process left behind. The log is read from its first byte either way, so a run that printed while no host
   * was listening is replayed to whoever attaches. */
  const open = (base: string, hasInput: boolean, launch?: { failed?: Error }): ExecStream => {
    // Both limits run from this reader's first second: nothing on disk records when the run's last byte landed, so
    // an attach cannot inherit an idle clock and starts the turn's cap again.
    const startedAt = now();
    const activity = turnActivity(startedAt);
    let killed = false;
    let inputClosed = false;
    let finishCode: number | null | undefined;
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => {
      resolveExit = resolve;
    });
    const finish = (code: number | null): void => {
      if (finishCode !== undefined) return;
      finishCode = code;
      resolveExit(code);
    };
    const leader = (): number | undefined => {
      const pid = Number(readFile(`${base}.pid`)?.trim() ?? "");
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    };
    const signal = (sig: NodeJS.Signals): void => {
      const pid = leader();
      if (pid === undefined || finishCode !== undefined) return;
      signalGroup(pid, sig);
    };

    /** The poll runs whether or not anybody is reading yet: the run is on this computer either way, so its limits,
     * its ending and its reap cannot wait on a consumer. What it reads is queued for whoever iterates. */
    const lines = new Lines();
    let offset = 0;
    let downs = 0;
    let reading = false;
    /** Set when this process lets go of the run: the poll ends where it stands, the stream never settles and the
     * run is left exactly as it is, since ending it here would write the turn off for whoever owns it. */
    let dropped = false;
    let wake: (() => void) | undefined;
    const nap = (ms: number): Promise<void> =>
      new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    const drop = (): void => {
      dropped = true;
      opts.reading?.delete(drop);
      wake?.();
    };
    opts.reading?.add(drop);
    /** What the log holds past what has been read, a chunk at a time so one poll of a run that printed megabytes
     * while nobody watched cannot hold the loop. */
    const readLog = (): Buffer => {
      let fd: number | undefined;
      try {
        const size = statSync(`${base}.log`).size;
        if (size <= offset) return Buffer.alloc(0);
        fd = openSync(`${base}.log`, "r");
        const buf = Buffer.alloc(Math.min(size - offset, EXEC_CHUNK_BYTES));
        const read = readSync(fd, buf, 0, buf.length, offset);
        offset += read;
        return buf.subarray(0, read);
      } catch {
        return Buffer.alloc(0);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    };
    const settle = async (code: number | null, cut?: Error): Promise<void> => {
      if (finishCode !== undefined) return;
      opts.reading?.delete(drop);
      await reapRun(base);
      if (cut === undefined) lines.end();
      else lines.fail(cut);
      finish(code);
    };

    const poll = async (): Promise<void> => {
      while (finishCode === undefined && !dropped) {
        if (killed) return settle(null);
        // Nothing was launched, so no process will write a log or an exit code: the stream ends where a run that
        // was killed before it answered ends, rather than polling a log nobody writes.
        if (launch?.failed !== undefined) return settle(null);
        const at = now();
        if (waiting()) activity.touch(at);
        const quietMs = activity.quietMs(at);
        const pid = leader();
        if (pid !== undefined && !reading && readsWork(limits.idleMs, quietMs)) {
          reading = true;
          readWork(pid, ticks => {
            reading = false;
            if (ticks !== undefined) activity.read(ticks, at);
          });
        }
        const cut = turnCut(limits, at - startedAt, quietMs);
        if (cut !== undefined) return settle(null, cut);

        // The exit file is read before the log, so a poll that sees an exit code reads a log that is complete.
        // An empty one is a run still writing: the shell's write truncates before it writes, as the cloud road reads it too.
        const ended = readFile(`${base}.exit`)?.trim();
        const chunk = readLog();
        if (chunk.length > 0) {
          activity.touch(now());
          lines.feed(chunk.toString("utf8"));
          continue; // there may be more than one chunk waiting
        }
        if (ended !== undefined && ended !== "") return settle(Number.parseInt(ended, 10));
        // The leader is checked after the exit file: one that finished in between shows as down with no exit yet.
        if ((pid === undefined || !alive(pid)) && ++downs > 1) return settle(null);
        await nap(pollMs);
      }
    };
    // Nothing the poll does may reach this process's own error road: a reader that threw would take the host and
    // every other turn on it with it, so the throw ends this stream alone and its reader sees it.
    void poll().catch((e: unknown) => {
      lines.fail(e instanceof Error ? e : new Error(String(e)));
      finish(null);
    });

    return {
      lines: lines.iterate(),
      run: base,
      // The leader of the turn's own group, which is every process the turn started: what names this turn's tree in
      // the pane that lists this computer's processes.
      ...((): { pid?: number } => {
        const pid = leader();
        return pid !== undefined ? { pid } : {};
      })(),
      teardown: () => signal("SIGTERM"),
      kill: () => {
        killed = true;
        signal("SIGKILL");
      },
      write: async line => {
        if (!hasInput) throw new Error("this stream has no input channel");
        if (finishCode !== undefined || inputClosed) return "gone";
        // The run knows the command ended the moment its exit file exists, up to a poll before this side does, and
        // a reap in flight has taken the claim with the rest of the run.
        if (existsSync(`${base}.exit`) || !existsSync(`${base}.d`)) return "gone";
        try {
          appendFileSync(`${base}.in`, `${line}\n`);
        } catch {
          return "gone";
        }
        // The person just acted, so the turn gets its idle time over, as on a cloud turn.
        activity.touch(now());
        return "written";
      },
      closeInput: () => {
        if (!hasInput || inputClosed || finishCode !== undefined) return;
        inputClosed = true;
        try {
          appendFileSync(`${base}.in`, `${endMarker(base)}\n`);
        } catch {
          return;
        }
      },
      exited,
    } satisfies ExecStream;
  };

  const factory: ExecStreamFactory = (command, { env, input }) => {
    const base = join(runDir, randomBytes(6).toString("hex"));
    mkdirSync(runDir, { recursive: true, mode: OWNER_DIR });
    // The claim is the one path that says a run is on this computer, and mkdir is what makes it exist at once.
    mkdirSync(`${base}.d`, { mode: OWNER_DIR });
    const exports = Object.entries(env)
      .filter(([k]) => ENV_KEY.test(k))
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("\n");
    // The tail starts in a subshell so bash's job notice for its kill never lands in the log; the command's exit
    // code is written before the tail is killed, so a poll that sees it reads a finished log.
    // The command runs in a subshell, so a turn whose own line ends in `exit` leaves the script standing and its
    // code still reaches the exit file: a run whose code nobody wrote reads as a run that answered nothing.
    const body =
      input === undefined
        ? `( ${command}\n)\necho $? > ${shellQuote(`${base}.exit`)}\n`
        : `( tail -n +1 -f ${shellQuote(`${base}.in`)} | { while IFS= read -r l; do [ "$l" = ${shellQuote(endMarker(base))} ] && break; printf '%s\\n' "$l"; done; } > ${shellQuote(`${base}.fifo`)} & echo $! > ${shellQuote(`${base}.tail`)} )\n` +
          `( ${command}\n) < ${shellQuote(`${base}.fifo`)}\n` +
          `echo $? > ${shellQuote(`${base}.exit`)}\n` +
          `kill $(cat ${shellQuote(`${base}.tail`)}) 2>/dev/null\n`;
    // The three files that carry what a turn is: the script holds the whole launch environment as export lines,
    // the provider key and the turn's own token among them, the input channel holds every message a person sends
    // and the log holds everything the agent prints. The mode goes on at the open, never by a chmod after it: a
    // file that is readable for one moment has been read.
    writeOwned(`${base}.sh`, `${exports}\n${body}`);
    if (input !== undefined) {
      writeOwned(`${base}.in`, input.map(line => `${line}\n`).join(""));
      spawnFifo(`${base}.fifo`);
    }
    writeOwned(`${base}.log`, "");
    const log = openSync(`${base}.log`, "a");
    /** A launch node itself could not make: no bash on the PATH the turn runs under. Nothing wrote a log or an exit
     * code, so the reader has to be told rather than left polling for one. */
    const launch: { failed?: Error } = {};
    try {
      const child = spawn("bash", [`${base}.sh`], {
        cwd: opts.root,
        env: { ...env },
        // No pipe of this process's is handed to the run: its output is the log, and its stdin the fifo the script
        // opens, so nothing it holds dies with the host that launched it.
        stdio: ["ignore", log, log],
        // Its own process group, so a signal can reach what the turn started without reaching this host, and the
        // terminal's Ctrl-C reaches the host alone.
        detached: true,
      });
      child.on("error", (e: Error) => {
        launch.failed = e;
      });
      child.unref();
      if (child.pid !== undefined) writeFileSync(`${base}.pid`, `${child.pid}\n`);
    } finally {
      closeSync(log);
    }
    return open(base, input !== undefined, launch);
  };

  factory.attach = async (run, { input }) => {
    if (!minted(run)) throw new Error(`${run} is not a run this host could have launched`);
    // The claim is what says the run is still here, and this computer's own answer is the only one there is: a
    // folder that is gone is a run that is gone, and nothing else may end one.
    if (!existsSync(`${run}.d`)) return "gone";
    return open(run, input);
  };

  factory.sweep = async keep => {
    const kept = new Set(keep);
    let held: string[];
    try {
      held = readdirSync(runDir);
    } catch {
      return [];
    }
    const stale = held
      .filter(name => name.endsWith(".d"))
      .map(name => join(runDir, name.slice(0, -".d".length)))
      .filter(base => minted(base) && !kept.has(base));
    // Each run's group is ended beside the others, not after them: every reap waits out its own stop grace, and a
    // computer holding a day of them would spend that grace once per run in a connect that has to end.
    await Promise.all(stale.map(base => reapRun(base)));
    return stale;
  };

  return factory;
}
