// SPDX-License-Identifier: AGPL-3.0-only
// wsp init beside a host that already serves the state: the run's screens, its
// recipe and its confirm happen at the terminal, and the build happens in that
// host's init job, over the same door the app's setup drives. One state file
// has one writer, and while a host serves that writer is the host; this is how
// a terminal run reaches it instead of asking the person to stop it first.
// Nothing here reads a key or the provider: the host owns both.
import { log } from "@clack/prompts";
import { styleText } from "node:util";
import { CLOUD_SETUP_WORDS, InitJob, SIGN_IN_OPEN_STATE, fmtDuration, initJobOver, initRowOver, initRowUnrun, INIT_ROW_STATES, type InitRow } from "@wsp/protocol";
import { appUrl } from "./init-first.js";
import { textPrompt } from "./init-layout.js";
import { openApp, type ServedAt } from "./init-serve.js";
import type { InitIO } from "./init.js";

const dim = (s: string): string => styleText("dim", s);

/** What this needs of a socket to the host: the door's ops, the pushed frames its events ride, and the promise that
 * says the host went away, so a build is never waited on for ever. */
export interface DoorClient {
  request<T extends Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T>;
  events(): Promise<void>;
  onFrame(fn: (frame: Record<string, unknown>) => void): () => void;
  closed: Promise<void>;
  closeWords(): string;
}

export interface BesideOptions {
  client: DoorClient;
  /** The terminal the run's lines print on and a sign-in's code is typed at. */
  io: InitIO;
  /** The first workspace the build forks once the image is sealed, and the folder that lands on it. */
  fork?: { name: string; folder?: string };
  /** wsp init --yes: the sign-ins on the machine are skipped there too, so the flag means the same on both roads. */
  yes?: boolean;
  /** wsp init --on: the place the image is built on; absent, that host's default place. */
  on?: string;
  /** wsp init --rebuild: the next version is sealed from a fresh machine, as it is on the road with no host serving. */
  rebuild?: boolean;
  /** The app the host serving this state already serves, opened once the build is over the way every init road
   * opens it: on the workspace the build forked, with a code that host minted for the browser, through a page in
   * that host's run folder. */
  app?: { at: ServedAt; runDir: string; interactive: boolean };
}

/** A row's state as one line under the terminal's own glyphs: the label, what the row said and how long it took. */
function rowLine(row: InitRow): string {
  const detail = row.detail === undefined || row.detail === "" ? "" : `  ${dim(row.detail)}`;
  const took = row.ms === undefined ? "" : `  ${dim(fmtDuration(row.ms))}`;
  return `${row.label}${detail}${took}`;
}

/** The states a row sits in while it waits on something this run cannot hurry. */
const WAITING_ON = new Set<string>([INIT_ROW_STATES.slot, INIT_ROW_STATES.retrying]);

/** Runs the build in the host's init job and prints what it says. The recipe the job builds is the one this run
 * saved beside the state; the answer is this run's exit code. */
export async function buildBesideHost(o: BesideOptions): Promise<number> {
  const out = { output: o.io.output };
  const seen = new Map<string, string>();
  /** The code prompt open for each sign-in, with the stop that ends it. A prompt holds the terminal in raw mode and
   * this process's loop with it, so every one is ended when its row moves on and when the run is over: a person who
   * never typed the code is not left at a live prompt under a sealed golden. */
  const asking = new Map<string, { stop: AbortController; done: Promise<void> }>();
  let view: InitJob | undefined;
  const waiting = new Set<() => void>();

  const draw = (job: InitJob): void => {
    for (const row of job.rows) {
      if (row.kind === "fact") continue;
      if (seen.get(row.id) === row.state) continue;
      seen.set(row.id, row.state);
      // The prompt belongs to the row's own wait: the page hands one code, and once that row moves on there is
      // nothing left to type into.
      if (row.state !== SIGN_IN_OPEN_STATE) asking.get(row.id)?.stop.abort();
      if (row.page !== undefined && row.state === SIGN_IN_OPEN_STATE) {
        log.warn(`${row.label}: open ${row.page}`, out);
        void o.io.open(row.page);
        // Only where someone can type it: off a terminal the prompt would sit on a stdin nobody is at, and the page
        // line above is the whole of what an agent driving this run can act on.
        if (row.finish === "code" && o.io.isTTY && !asking.has(row.id)) {
          const stop = new AbortController();
          asking.set(row.id, { stop, done: askCode(o, row, stop.signal).finally(() => asking.delete(row.id)) });
        }
        continue;
      }
      // A wait on something outside this run is said as it starts: the account with no room for the machine, or a
      // machine a stop could not reach the provider to kill. Nothing else says it, and both can stand for minutes.
      if (WAITING_ON.has(row.state)) {
        log.warn(`${row.label}: ${row.state}`, out);
        continue;
      }
      if (!initRowOver(row)) continue;
      if (row.state === INIT_ROW_STATES.failed) log.error(rowLine(row), out);
      else if (initRowUnrun(row.state)) log.warn(`${rowLine(row)}  ${dim(row.state)}`, out);
      else log.step(rowLine(row), out);
    }
  };

  const off = o.client.onFrame(frame => {
    if (frame["type"] !== "init.job") return;
    const parsed = InitJob.safeParse(frame["job"]);
    if (!parsed.success) return;
    view = parsed.data;
    draw(parsed.data);
    for (const wake of [...waiting]) wake();
  });

  const until = async (holds: (job: InitJob) => boolean): Promise<InitJob> =>
    new Promise<InitJob>((settle, fail) => {
      const check = (): void => {
        if (view === undefined || !holds(view)) return;
        waiting.delete(check);
        settle(view);
      };
      waiting.add(check);
      void o.client.closed.then(() => {
        waiting.delete(check);
        fail(new Error(o.client.closeWords()));
      });
      check();
    });

  // A cancel the job refuses has words of its own (the seal cannot be stopped); swallowing them reads as a Ctrl-C
  // nothing heard.
  const stop = (): void => void o.client.request("init.cancel").catch((e: unknown) => log.warn(e instanceof Error ? e.message : String(e), out));
  o.io.signals.on("SIGINT", stop);
  try {
    await o.client.events();
    const started = await o.client.request<{ job: unknown }>("init.start", { road: "terminal" });
    // The reply is the job as the start left it, which the first pushed frame may already have moved past: it stands
    // only when no frame has landed yet, so a view is never rolled back to an older one and the wait never hangs.
    if (view === undefined) {
      view = InitJob.parse(started.job);
      draw(view);
    }
    const read = await until(job => job.phase === "answering" || initJobOver(job.phase));
    if (read.phase !== "answering") return await ended(o, read);
    await o.client.request("init.build", {
      ...(o.fork !== undefined ? { firstWorkspace: o.fork.name } : {}),
      ...(o.fork?.folder !== undefined ? { importFolder: o.fork.folder } : {}),
      ...(o.yes === true ? { yes: true } : {}),
      ...(o.on !== undefined ? { on: o.on } : {}),
      ...(o.rebuild === true ? { rebuild: true } : {}),
    });
    return await ended(o, await until(job => initJobOver(job.phase)));
  } finally {
    o.io.signals.off("SIGINT", stop);
    off();
    // The run ends when its prompts do: an aborted one hands the terminal back and settles, and until it has, this
    // process has a readline on stdin and would not exit.
    const open = [...asking.values()];
    for (const ask of open) ask.stop.abort();
    await Promise.allSettled(open.map(ask => ask.done));
  }
}

/** The code a sign-in's page handed back, typed here and sent to the tool waiting for it on the machine; the signal
 * ends the prompt where the row it belongs to did not wait for one. */
async function askCode(o: BesideOptions, row: InitRow, signal: AbortSignal): Promise<void> {
  const typed = await textPrompt({ message: `${row.label}: ${CLOUD_SETUP_WORDS.build.codeAsk}`, input: o.io.input, output: o.io.output, signal });
  const code = typeof typed === "string" ? typed.trim() : "";
  if (code === "") return;
  await o.client.request("init.signInCode", { tool: row.tool ?? row.id, code }).catch((e: unknown) => {
    log.error(`the code was not taken: ${e instanceof Error ? e.message : String(e)}`, { output: o.io.output });
  });
}

/** What the run says once the job is over, and the exit code it ends on. The code the browser is let in with is
 * minted over this run's own socket, which holds the host's token: the same door wsp host pair mints at. */
async function ended(o: BesideOptions, job: InitJob): Promise<number> {
  const out = { output: o.io.output };
  if (job.phase !== "done") {
    log.error(`${job.phase === "cancelled" ? CLOUD_SETUP_WORDS.build.stopped : CLOUD_SETUP_WORDS.build.failed}${job.error !== undefined ? `: ${job.error}` : ""}`, out);
    return 1;
  }
  if (job.golden !== undefined) log.step(`Image v${job.golden.version} sealed on the host serving this state.`, out);
  if (job.workspace !== undefined) log.step(`Workspace ${job.workspace.name} (${job.workspace.id}) forked from it.`, out);
  if (o.app !== undefined) {
    const { code } = await o.client.request<{ code: string }>("pair.issue", { here: true });
    await openApp(appUrl(o.app.at, job.workspace?.id, code), o.app.at, o.io, o.app.interactive, { runDir: o.app.runDir });
  }
  return 0;
}
