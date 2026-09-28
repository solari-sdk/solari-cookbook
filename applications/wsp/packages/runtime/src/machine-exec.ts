// ExecStreamFactory over a Machine's one-shot REST exec, for running harnesses
// on remote workspaces. The command is launched detached inside the guest
// (setsid + log file), because REST-launched processes survive machine
// pause/resume while control-channel children get reaped (PoC P10/P4b). The
// stream then polls the log, so a mid-turn nap only stalls polling: polls fail
// while the machine is paused, recover after wake, and the turn's own output
// picks up where it left off. The script goes up through the engine's
// putFiles, so it lands under the exec body cap however long it is; the
// engine's execDetached polls the same way for a command that ends on its
// own, while this one streams and can be signalled while it runs, which is
// what a harness turn needs. A stream started with an input channel gets a
// file the launch seeds and every write() appends to through putFiles; a tail
// feeds it to the command's stdin through a fifo, so a message reaches a
// running process the runtime holds no pipe to. The tail's pid is recorded:
// closeInput() kills it so the command reads EOF, and the script kills it once
// the command ended. When the stream ends, however it ends, the recorded
// process group gets TERM then KILL and the run's files go: the CLI's own
// children (MCP servers under npx) stay in the setsid group after it exits,
// and were seen holding 90 MB each for the machine's life. A launch nothing
// answered (this computer's DNS gone, a reset connection, a gateway error the
// backend gave up on) is posted again at the engine's backoff for its reach
// window before the turn fails; the claim makes one that did land a no-op.
// The run outlives the process that launched it, so the factory also attaches
// to one by the handle its stream reported: the log on the guest is the whole
// turn, and a reader that comes later reads it from its first byte. The claim
// directory is what says the run is still there; the reap takes it with the
// rest, so an attach to a swept run answers gone instead of hanging. That
// question travels the launch road's reach window, and only the machine's own
// answer that the claim is gone may end a run: a probe nothing answered says
// nothing about the run it was sent to find, and killing that process group
// would end the very turn the attach exists to save. The same fact cuts the
// other way once a host has finished connecting: a run no row of that host
// holds is a harness process nobody will ever read again, so the sweep ends
// every claim on the machine that the caller did not name.

import { randomBytes } from "node:crypto";
import { HANDSHAKE, INLINE_EXEC_MS, MachineUnreachableError, MachineUnreached, RUN_DIR, execFits, isPlaceAbsent, machineAnswer, putFiles, realRetryClock, untilReached, type ExecResult, type GuestWrite, type Machine } from "@wsp/engine";
import { EXEC_CHUNK_BYTES, RUN_STOP_MS, TURN_IDLE_MS, TURN_WALL_MS, TURN_WORK_TICKS_PER_S, shellQuote, turnCutLine, workScoreLine } from "@wsp/protocol";
import type { ExecStream, ExecStreamFactory, TurnCutRule } from "@wsp/protocol";

export interface MachineExecOptions {
  /** Delay between log polls. */
  pollMs?: number;
  /** How long the log may stay quiet, write() and the run group's own work included, before the stream ends with
   * exit null and the idle line. */
  idleMs?: number;
  /** The cap on one stream however much it prints; the stream ends with exit null and the wall line past it. */
  deadlineMs?: number;
  /** Per-poll REST exec timeout. */
  execTimeoutMs?: number;
  /** Directory inside the guest for script/log/pid/exit files. */
  runDir?: string;
  /** The clock both limits read. */
  now?: () => number;
  /** What every wait runs on, the poll's and the launch retry's; tests hand in one that moves the clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Every run this process is reading, each as the call that stops reading it. A poll of a run holds the event
   * loop until that run ends, so a process that is done with its work has to let go of the ones still going: the
   * turns themselves go on running on their machines, and whatever opens them next reads their logs from the
   * first byte. The wiring that made this factory owns the set and empties it when it closes. */
  reading?: Set<() => void>;
}

/** The two limits a turn runs under on every kind of machine, and what ends one: the wall since it started, else the
 * idle stretch since it last did anything, which is its last byte, the person's last message, or work in the
 * process tree it started. */
export interface TurnLimits {
  idleMs: number;
  deadlineMs: number;
}

/** The one rule that cuts a turn, whatever launched it: the error carrying turnCutLine when a limit has passed, else
 * nothing. The cloud road and the local child both read it, so a hung agent ends with the same words on either. */
export function turnCut(limits: TurnLimits, elapsedMs: number, quietMs: number): Error | undefined {
  const rule: TurnCutRule | undefined = elapsedMs >= limits.deadlineMs ? "wall" : quietMs >= limits.idleMs ? "idle" : undefined;
  return rule === undefined ? undefined : new Error(turnCutLine(rule, elapsedMs, rule === "wall" ? limits.deadlineMs : limits.idleMs));
}

/** One reading of the process tree a turn started: its work in ticks, whatever the road can count of them, and the
 * clock the reading was taken on. Only the difference between two readings means anything. */
interface WorkReading {
  ticks: number;
  at: number;
}

/** The clock the idle limit is read against, one shape for every road: the harness's bytes and the person's messages
 * move it, and so does work in the process tree the turn started once that work clears TURN_WORK_TICKS_PER_S since
 * the clock last moved. A harness sitting in a long tool call prints nothing while its children burn a core, and
 * reading bytes alone ended two builds that were still working (43 and 38 minutes, 2026-09-08). */
export interface TurnActivity {
  /** How long the turn has done nothing: what the idle limit is compared with. */
  quietMs(nowMs: number): number;
  /** A byte from the harness, or a message the person sent into the turn. */
  touch(atMs: number): void;
  /** A stretch nothing could be read through: the road to the machine was dark, so it is no part of the turn's
   * quiet and the clock goes on from where it stood. */
  hold(ms: number): void;
  /** One reading of the turn's tree. The first, and any that undercuts the one before it, is only what the next is
   * measured from: a group whose members exited carries less work than it did and is no baseline. */
  read(ticks: number, atMs: number): void;
}

export function turnActivity(startedAt: number): TurnActivity {
  let activeAt = startedAt;
  let base: WorkReading | undefined;
  return {
    quietMs: nowMs => nowMs - activeAt,
    touch: atMs => {
      activeAt = atMs;
    },
    hold: ms => {
      activeAt += ms;
    },
    read: (ticks, atMs) => {
      if (base === undefined || ticks < base.ticks) {
        base = { ticks, at: atMs };
        return;
      }
      if (ticks - base.ticks < Math.max(1, (TURN_WORK_TICKS_PER_S * (atMs - base.at)) / 1_000)) return;
      activeAt = atMs;
      base = { ticks, at: atMs };
    },
  };
}

/** Whether the turn's tree is worth reading at this moment: there is an idle limit for a reading to hold open, and
 * the stream has been quiet long enough that the cut is in sight. A turn that is printing is already alive on its
 * bytes, and a stream run with no idle limit (the exec verb hands both limits infinite on purpose) would pay for a
 * reading every second for the life of a build and could not be cut by any answer it got. */
export function readsWork(idleMs: number, quietMs: number): boolean {
  return Number.isFinite(idleMs) && quietMs >= idleMs / 2;
}

/** What the guest counts a run's work by, given the run's process group id in `p`: for every process in that group,
 * the CPU ticks it has burned and the megabytes it has read or written, summed into one number the next poll is
 * compared with. /proc is the only road to it, since the guests have no pgrep, and the comm field is stripped by its
 * last bracket because a process may be named `(sh (2))`. A guest that answers nothing here (no awk, no /proc)
 * leaves the turn's idle clock on bytes alone. */
export const GROUP_WORK_AWK =
  'FNR==1{s=$0;sub(/^[0-9]+ \\(.*\\) /,"",s);split(s,f," ");if(f[3]==p){t+=f[12]+f[13];i=FILENAME;sub(/stat$/,"io",i);while((getline l<i)>0)if(l~/^[rw]char:/){split(l,g," ");t+=int(g[2]/1048576)}close(i)}}END{print t+0}';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What a launch mints a run's name from, so a handle read back off the sessions index is checked against the shape
 * this code writes before it reaches shell text: a value that has been to a file on disk is no longer this code's. */
const RUN_ID = /^[0-9a-f]{12}$/;
/** How often the reap looks at the group it asked to go, while it waits out the one stop grace both roads give. */
const GRACE_POLL_MS = 200;
/** That grace as the shell's own counter, since a guest has no seq to lean on. */
const GRACE_CHECKS = Array.from({ length: Math.round(RUN_STOP_MS / GRACE_POLL_MS) }, (_, i) => String(i + 1)).join(" ");

/** Whether the run is stopped on a question only a person can answer. A harness blocked on a permission prompt
 * prints nothing and burns nothing, so the idle limit would cut the very turn the question is waiting for; the idle
 * clock does not run while this answers true. It rides beside the options rather than in them because it is a fact
 * about one turn and not a limit: the registry hands the turn road no limits, so that road stays the one that runs
 * under the turn's own. */
export type TurnWaiting = () => boolean;

/** What a reader that has let go of a run waits on: nothing settles it, so the stream it handed out ends for
 * nobody and the run is left exactly as it is. Ending the stream here would settle a turn this process has merely
 * stopped reading, and its own owner would read it as over. */
const never = (): Promise<never> => new Promise<never>(() => {});

/** The poll's own wait, and the one call that cuts it short. The timer belongs to the reader, so a reader that
 * lets go of a run frees it where it stands rather than at the end of the poll it was in; a caller that handed in
 * a clock of its own waits on that instead, and the wake ends that wait the same way. */
function pollNap(sleep?: (ms: number) => Promise<void>): { nap: (ms: number) => Promise<void>; wake: () => void } {
  let woken: (() => void) | undefined;
  /** Set once the reader has let go. Every nap after that returns where it stands rather than starting a timer:
   * the wake often lands while the poll is inside its exec, and the nap it comes back to would otherwise hold
   * this process for one more poll. */
  let awake = false;
  const nap = (ms: number): Promise<void> => {
    if (awake) return Promise.resolve();
    return new Promise<void>(resolve => {
      let done = false;
      const settle = (): void => {
        if (done) return;
        done = true;
        woken = undefined;
        resolve();
      };
      const timer = sleep === undefined ? setTimeout(settle, ms) : undefined;
      if (sleep !== undefined) void sleep(ms).then(settle);
      woken = () => {
        if (timer !== undefined) clearTimeout(timer);
        settle();
      };
    });
  };
  return {
    nap,
    wake: () => {
      awake = true;
      woken?.();
    },
  };
}

export function machineExecStream(machine: Machine, opts: MachineExecOptions = {}, isWaiting?: TurnWaiting): ExecStreamFactory {
  const pollMs = opts.pollMs ?? 1500;
  const idleMs = opts.idleMs ?? TURN_IDLE_MS;
  const waiting = isWaiting ?? (() => false);
  const deadlineMs = opts.deadlineMs ?? TURN_WALL_MS;
  const execTimeoutMs = opts.execTimeoutMs ?? INLINE_EXEC_MS;
  const runDir = opts.runDir ?? RUN_DIR;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realRetryClock.sleep;

  /** Every path this file puts in shell text goes through here first. The run folder is the machine's own answer on
   * a kind that has one (a home read over ssh), so a word in it must not be read as shell; a glob or a brace that
   * the shell has to expand keeps its own place outside the quotes. */
  const q = (path: string): string => shellQuote(path);
  /** The one path that says a run is on the machine: the launch makes it, the reap takes it with the rest of the
   * run's files, and every road that asks whether a run is still there asks about this one. */
  const claim = (base: string): string => `${base}.d`;
  /** What ending one run comes to on the guest, in the shell both the reader's own reap and the connect sweep run:
   * the recorded process group gets TERM, then KILL once the stop grace passes, and the run's files go. */
  const reapScript = (b: string): string =>
    `P=$(cat ${q(b)}.pid 2>/dev/null); ` +
    `if [ -n "$P" ]; then kill -TERM -- -$P 2>/dev/null; ` +
    `for i in ${GRACE_CHECKS}; do kill -0 -- -$P 2>/dev/null || break; sleep ${GRACE_POLL_MS / 1000}; done; ` +
    `kill -KILL -- -$P 2>/dev/null; fi; ` +
    `rm -rf ${q(b)}.*`;
  /** A handle this factory could have minted: the run directory it launches into and a name of its own shape. */
  const minted = (run: string): boolean => run.startsWith(`${runDir}/`) && RUN_ID.test(run.slice(runDir.length + 1));

  /** The one reader both roads share: a launch that has just posted its script, and an attach to a run an earlier
   * host process left behind. `opened` settles once the run is known to be on the machine and rejects with the words
   * the turn fails on when it is not. The log is read from its first byte either way, so a run that printed while no
   * host was listening is replayed to whoever attaches. */
  const open = (base: string, hasInput: boolean, opened: Promise<void>): ExecStream => {
    const sentinel = `__WSP_EOF_${randomBytes(6).toString("hex")}__`;

    let killed = false;
    let inputClosed = false;
    /** Set when this process lets go of the run: the poll ends where it stands, nothing is reaped and no exit is
     * written, since ending the run here would take a turn its own owner is still waiting on. */
    let dropped = false;
    const { nap, wake } = pollNap(opts.sleep);
    const drop = (): void => {
      dropped = true;
      opts.reading?.delete(drop);
      wake();
    };
    opts.reading?.add(drop);
    // Both limits run from this reader's first second: nothing on the machine records when the run's last byte
    // landed, so an attach cannot inherit an idle clock and starts the turn's cap again.
    const startedAt = now();
    const activity = turnActivity(startedAt);
    let finishCode: number | null | undefined;
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => {
      resolveExit = resolve;
    });
    const finish = (code: number | null): void => {
      if (finishCode === undefined) {
        finishCode = code;
        opts.reading?.delete(drop);
        resolveExit(code);
      }
    };

    const signal = (sig: "TERM" | "KILL"): void => {
      void opened
        .catch(() => undefined)
        .then(() =>
          machine.exec(`P=$(cat ${q(base)}.pid 2>/dev/null); [ -n "$P" ] && kill -${sig} -- -$P 2>/dev/null; true`, {
            timeoutMs: execTimeoutMs,
          }),
        )
        .catch(() => undefined);
    };

    // Runs after the last poll read the log, so the group's stragglers cannot cost the turn a line.
    const reap = (): Promise<void> =>
      machine.exec(`${reapScript(base)}; true`, { timeoutMs: execTimeoutMs }).then(() => undefined, () => undefined);

    // The exit file is read before the log, so a poll that sees an exit code reads a log that is complete. The
    // group's work rides the same poll when it is worth reading, so a turn working in silence costs no exec of its
    // own and a stream nothing could cut asks the guest for nothing; unasked, $W is empty and the reader sees no
    // reading.
    const pollCmd = (offset: number, work: boolean): string =>
      `E=$(cat ${q(base)}.exit 2>/dev/null); ` +
      `tail -c +${offset + 1} ${q(base)}.log 2>/dev/null | head -c ${EXEC_CHUNK_BYTES} | base64 -w0; ` +
      `P=$(cat ${q(base)}.pid 2>/dev/null); ` +
      (work ? `W=$(awk -v p="$P" ${shellQuote(GROUP_WORK_AWK)} /proc/[0-9]*/stat 2>/dev/null); ` : "") +
      `printf '\\n${sentinel} %s %s %s\\n' "$E" ` +
      `"$([ -n "$P" ] && kill -0 "$P" 2>/dev/null && echo up || echo down)" "$W"`;

    async function* lines(): AsyncGenerator<string> {
      let offset = 0;
      let downs = 0;
      let pending = Buffer.alloc(0);
      const drainPending = (): string | undefined =>
        pending.length > 0 ? pending.toString("utf8") : undefined;

      try {
        await opened;
      } catch (e) {
        await reap();
        finish(null);
        throw e;
      }

      while (true) {
        // This process is done reading this run: the poll ends here and the stream settles for nobody.
        if (dropped) await never();
        if (killed) {
          await reap();
          finish(null);
          return;
        }
        const at = now();
        if (waiting()) activity.touch(at);
        const quietMs = activity.quietMs(at);
        const cut = turnCut({ idleMs, deadlineMs }, at - startedAt, quietMs);
        if (cut !== undefined) {
          await reap();
          finish(null);
          throw cut;
        }

        let res: ExecResult;
        try {
          res = await machine.exec(pollCmd(offset, readsWork(idleMs, quietMs)), { timeoutMs: execTimeoutMs });
        } catch {
          // Machine likely napping; polls recover after wake (P10 semantics). A poll that never reached the machine
          // says nothing about the process it was sent to read, so the stretch the road was dark is no part of the
          // turn's silence: the idle clock holds here and goes on from the road's return.
          await nap(pollMs);
          activity.hold(now() - at);
          continue;
        }

        const out = res.stdout.split("\n");
        const markIdx = out.findIndex(l => l.startsWith(sentinel));
        if (markIdx === -1) {
          await nap(pollMs);
          continue;
        }
        const [, exitStr = "", live = "up", workStr = ""] = out[markIdx]!.split(" ");
        const work = Number.parseInt(workStr, 10);
        if (Number.isSafeInteger(work)) activity.read(work, now());
        const chunk = Buffer.from(out.slice(0, markIdx).join(""), "base64");
        offset += chunk.length;

        if (chunk.length > 0) {
          activity.touch(now());
          pending = Buffer.concat([pending, chunk]);
          let nl: number;
          while ((nl = pending.indexOf(0x0a)) !== -1) {
            yield pending.subarray(0, nl).toString("utf8");
            pending = pending.subarray(nl + 1);
          }
          continue; // there may be more than one chunk buffered up
        }

        if (exitStr !== "") {
          const tail = drainPending();
          if (tail !== undefined) yield tail;
          await reap();
          finish(Number.parseInt(exitStr, 10));
          return;
        }
        // The pid is checked after the exit file: a leader that finished in between shows as down with no exit yet.
        if (live === "down" && ++downs > 1) {
          const tail = drainPending();
          if (tail !== undefined) yield tail;
          await reap();
          finish(null);
          return;
        }
        await nap(pollMs);
      }
    }

    const stream: ExecStream = {
      lines: lines(),
      run: base,
      teardown: () => signal("TERM"),
      kill: () => {
        killed = true;
        signal("KILL");
      },
      write: async line => {
        if (!hasInput) throw new Error("this stream has no input channel");
        if (finishCode !== undefined) throw new Error("the stream has ended");
        await opened;
        // The guest knows the command ended the moment its exit file exists, up to a poll before this side does,
        // and a reap in flight has taken the claim with the rest of the run.
        const res = await putFiles(machine, [{ path: `${base}.in`, text: `${line}\n`, append: true }], {
          before: [`{ [ -e ${q(base)}.exit ] || [ ! -d ${q(claim(base))} ]; } && { echo ${HANDSHAKE.gone}; exit 0; }`],
          after: [`echo ${HANDSHAKE.written}`],
          timeoutMs: execTimeoutMs,
        });
        if (res.stdout.includes(HANDSHAKE.gone)) return "gone";
        if (res.exitCode !== 0 || !res.stdout.includes(HANDSHAKE.written)) throw new Error(`remote write failed on ${machine.id}: nothing came back saying ${HANDSHAKE.written}, the word the guest prints once the message landed; ${machineAnswer(res)}`);
        // The person just acted, so the turn gets its idle time over.
        activity.touch(now());
        return "written";
      },
      closeInput: () => {
        if (!hasInput || inputClosed || finishCode !== undefined) return;
        inputClosed = true;
        void opened
          .catch(() => undefined)
          .then(() => machine.exec(`P=$(cat ${q(base)}.tail 2>/dev/null); [ -n "$P" ] && kill -TERM "$P" 2>/dev/null; true`, { timeoutMs: execTimeoutMs }))
          .catch(() => undefined);
      },
      exited,
    };
    return stream;
  };

  const factory: ExecStreamFactory = (command, { env, input }) => {
    const base = `${runDir}/${randomBytes(6).toString("hex")}`;

    const exports = Object.entries(env)
      .filter(([k]) => ENV_KEY.test(k))
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("\n");
    // The tail starts in a subshell so bash's job notice for its kill never lands in the log; the command's exit code
    // is written before the tail is killed, so a poll that sees it reads a finished log.
    const run =
      input === undefined
        ? `${command}\necho $? > ${q(base)}.exit\n`
        : `( tail -n +1 -f ${q(base)}.in > ${q(base)}.fifo & echo $! > ${q(base)}.tail )\n{ ${command}\n} < ${q(base)}.fifo\necho $? > ${q(base)}.exit\nkill $(cat ${q(base)}.tail) 2>/dev/null\n`;
    // The turn's processes are what the kernel takes first when memory runs out: the work outgrew the machine, and
    // the daemon and the guest agent are how anyone hears of it.
    const files: GuestWrite[] = [{ path: `${base}.sh`, text: `${workScoreLine()}\n${exports}\n${run}` }];
    if (input !== undefined) files.push({ path: `${base}.in`, text: input.map(line => `${line}\n`).join("") });

    // Spawn eagerly, like a local child process would.
    const posted: Promise<ExecResult> = untilReached(
      () =>
        putFiles(machine, files, {
          // exec honours no idempotency key and a launch whose answer was lost is retried; the claim makes the second
          // a no-op. A mkdir that fails for any other reason (a run folder another login on the machine owns) fails
          // the launch: read as a replay it would answer launched and leave the reader polling a log nobody writes.
          // Every file of the run is the login's alone from the moment it is made, not chmodded after: the script
          // carries the turn's environment as export lines, the provider key and the thread token among them, and
          // a machine somebody owns may carry other logins that can read a folder wsp did not make.
          before: ["umask 077", `mkdir ${q(claim(base))} 2>/dev/null || { [ -d ${q(claim(base))} ] && { echo ${HANDSHAKE.launched}; exit 0; }; echo ${q(`no run folder on this machine: ${claim(base)}`)} >&2; exit 1; }`],
          after: [...(input === undefined ? [] : [`mkfifo ${q(base)}.fifo`]), `setsid bash ${q(base)}.sh > ${q(base)}.log 2>&1 & echo $! > ${q(base)}.pid; echo ${HANDSHAKE.launched}`],
          timeoutMs: execTimeoutMs,
        }),
      { now, sleep },
    );
    const opened = posted.then(
      res => {
        if (res.exitCode !== 0 || !res.stdout.includes(HANDSHAKE.launched)) throw new Error(`remote launch failed on ${machine.id}: nothing came back saying ${HANDSHAKE.launched}, the word the guest prints once the run is up; ${machineAnswer(res)}`);
      },
      (e: unknown) => {
        // Each carries the one sentence every surface says about it, and a machine id wrapped round it is nothing a person reads.
        if (e instanceof MachineUnreached || e instanceof MachineUnreachableError || isPlaceAbsent(e)) throw e;
        throw new Error(`remote launch failed on ${machine.id}: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return open(base, input !== undefined, opened);
  };

  factory.attach = async (run, { input }) => {
    if (!minted(run)) throw new Error(`${run} is not a run this host could have launched`);
    const res = await untilReached(() => machine.exec(`[ -d ${q(claim(run))} ] && echo ${HANDSHAKE.run} || echo ${HANDSHAKE.gone}`, { timeoutMs: execTimeoutMs }), { now, sleep });
    // Only these two answers say anything about the run. Anything else is the machine failing to answer the
    // question, which is the unreached road, not a run to end: the reader is built and the run swept on WSP_GONE
    // alone, so nothing here can take a live turn's process group with it.
    if (res.stdout.includes(HANDSHAKE.run)) return open(run, input, Promise.resolve());
    if (res.stdout.includes(HANDSHAKE.gone)) return "gone";
    throw new Error(`the machine did not answer whether it still holds ${run}; ${machineAnswer(res)}`);
  };

  factory.sweep = async keep => {
    // The claims are what the machine holds, so the machine is asked what is there rather than told; the shape a
    // handle must have to be one of this factory's is read here, by the same predicate the attach road reads, so
    // nothing the guest wrote into the run directory reaches shell text on the strength of being there.
    const listed = await machine.exec(`for d in ${q(runDir)}/*.d; do [ -d "$d" ] && printf '%s\\n' "$d"; done`, { timeoutMs: execTimeoutMs });
    const kept = new Set(keep);
    const stale = listed.stdout
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.endsWith(".d"))
      .map(line => line.slice(0, -".d".length))
      .filter(base => minted(base) && !kept.has(base));
    if (stale.length === 0) return [];
    // Each run's group is ended beside the others, not after them: every reap waits out its own stop grace, and a
    // machine holding a day of them would spend that grace once per run in a connect that has to end.
    const page = (bases: readonly string[]): string => `${bases.map(base => `{ ${reapScript(base)}; } &`).join(" ")} wait; true`;
    // The machine holding the most stale runs is the one this exists for, and it is the one whose command would pass
    // the exec body cap and be refused whole, so the reaps go a page at a time under the same rule every upload reads.
    const pages: string[][] = [[]];
    for (const base of stale) {
      const last = pages.at(-1)!;
      if (last.length > 0 && !execFits(page([...last, base]))) pages.push([base]);
      else last.push(base);
    }
    for (const bases of pages) await machine.exec(page(bases), { timeoutMs: execTimeoutMs });
    return stale;
  };

  return factory;
}
