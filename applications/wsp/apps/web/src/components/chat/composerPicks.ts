// SPDX-License-Identifier: AGPL-3.0-only
// What the composer's pickers stand for and what rides sessions.start, from
// one harness catalog, the picks remembered for the workspace and the values
// the thread already runs on, which are its running turn's, else the ones its
// last start recorded. A pick wins, then the thread's value, then the
// default marked for that pick, which for an effort is the picked model's own
// where its binary names one; a pick the resolved model cannot take shows as
// nothing and is not sent. The model, the window that rides inside it, the
// effort and the access are the picks a thread that has run takes only from
// its own picker, each read against the thread it was picked on, since the
// picks are one record per workspace and a thread keeps what it was opened
// on. Picks ride the wire, and with them the values the thread already runs
// at, so a send that touched no picker keeps that thread where it is: the
// runtime runs a NEW thread on the model and the effort the catalog marks
// when neither is picked, the same ones the pickers show; a context window
// rides as a suffix on the model, so it brings the model along. Of what
// comes out here, a send into a thread that has run carries the model and
// the effort and leaves the agent and the access behind, those being that
// thread's own off its rows (sendPicks).
import { contextWindowsFor, effortsFor, everyModel, listedPick, markedDefault, modelOf, type HarnessCatalog, type HarnessModel, type HarnessOption, type SessionView, type StartPicks } from "@wsp/protocol";
import { THREAD_SCOPED_PICKS, type ComposerOptions, type PickThreads } from "./composerOptionsStore";

export interface ResolvedPicks {
  readonly model: string | null;
  readonly effort: string | null;
  readonly contextWindow: string | null;
  readonly permissionMode: string | null;
}

/** What the composer adds to sessions.start beyond the prompt: the checked picks, plus the harness and the context window. */
export type ComposerStart = StartPicks & Partial<Record<"harness" | "contextWindow", string>>;

const ONE_M = /\[1m\]$/;

/** The model the next start runs with, or null when nothing was picked and the catalog marks no default; a picked
 * slug the catalog does not list still counts, named by itself, as it is on a start. */
export function resolveModel(catalog: HarnessCatalog, input: { picked: string | undefined; thread: string | undefined }): HarnessModel | null {
  return modelOf(catalog, input.picked ?? input.thread ?? markedDefault(catalog.models)?.value);
}

/** The model a start or a row names, with the window it runs at: the CLI announces the model with its own 1M suffix,
 * and a row that names a window of its own says it outright. The two are read together wherever either is read,
 * since on claude's wire the window rides inside the model string. */
function modelPicks(model: string, contextWindow?: string): ComposerOptions {
  const window = contextWindow ?? (ONE_M.test(model) ? "1m" : undefined);
  return { model: model.replace(ONE_M, ""), ...(window !== undefined ? { contextWindow: window } : {}) };
}

/** How each pick is read off one turn's row, one entry per pick, so a pick the thread keeps for itself is an entry
 * here rather than a rule of its own; the model and the window it ran at come from the same row, never two. */
const ROW_READERS: ReadonlyArray<(row: SessionView) => ComposerOptions | null> = [
  row => (row.model === undefined ? null : modelPicks(row.model, row.contextWindow)),
  row => (row.effort === undefined ? null : { effort: row.effort }),
  row => (row.permissionMode === undefined ? null : { permissionMode: row.permissionMode }),
];

/** What a thread has already run with, from the rows the runtime holds for its turns: for each pick, the last turn
 * that named one. A resume records only what its send carried, so an untouched picker leaves that turn's row silent
 * about it and the turn that opened the thread, where the runtime fills the catalog's marks in, is what still
 * stands. */
export function recordedPicks(rows: ReadonlyArray<SessionView>): ComposerOptions {
  const picks: ComposerOptions = {};
  for (const read of ROW_READERS) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const named = read(rows[i]!);
      if (named !== null) {
        Object.assign(picks, named);
        break;
      }
    }
  }
  return picks;
}

/** The running session's values, from the runtime's row for it, read by the same rule as every other row. */
export function runningPicks(session: SessionView | null, running: boolean): ComposerOptions {
  return recordedPicks(running && session !== null && session.status === "running" ? [session] : []);
}

/** What the next send inherits from the thread it lands in: a running turn's own values, and between turns what the
 * thread's own turns recorded, the model coming from its last start as the transcript shows it. Every one of them is
 * read off this thread's own rows, the running turn included, or a second thread running in the same workspace would
 * paint this one's pickers with its model, effort and access. A thread keeps running on the model, the effort and
 * the access it was opened with, so those, and not the catalog's defaults, are what the pickers show once the turn
 * is over and what the send carries: a default filled in here moves the thread somewhere nobody asked for. The
 * access the transcript's record carries stands under the rows: an access pick moves the thread's latest row along
 * with its record, so the row is the fresher of the two where there is one, and the record is what a thread whose
 * rows fell off the runtime's cap still has. */
export function threadPicks(thread: { running: boolean; model: string | null; permissionMode?: string | null }, rows: ReadonlyArray<SessionView>): ComposerOptions {
  const live = runningPicks(rows.at(-1) ?? null, thread.running);
  if (live.model !== undefined || thread.model === null) return live;
  const recorded = thread.permissionMode ?? undefined;
  return { ...(recorded !== undefined ? { permissionMode: recorded } : {}), ...recordedPicks(rows), ...modelPicks(thread.model), ...live };
}

/** The picks that apply to the thread in front of the person. Every pick a thread keeps for itself, the model and the
 * window that rides inside it on the wire, the effort and the access, is remembered per workspace while the thread
 * goes on running at the one it was opened at, so each is dropped here unless it was made on this thread: otherwise
 * it paints this one's button and moves it on the next send. They apply to a thread that has not run, which is what
 * the pick was made for, and each to the thread it was made on, which is someone changing that thread on purpose.
 * Each is read against its own thread and not several against one, or picking a window here would carry in a model
 * picked somewhere else. */
export function pickedFor(picked: ComposerOptions, thread: { model: string | null }, pickedOn: PickThreads, threadKey: string): ComposerOptions {
  if (thread.model === null) return picked;
  const applies: ComposerOptions = { ...picked };
  for (const key of THREAD_SCOPED_PICKS) if (pickedOn[key] !== threadKey) delete applies[key];
  return applies;
}

/** What a picker shows: the pick where this list carries it, else what the thread already runs at as the reading
 * beside each call below has read it, else the list's own default. The pick is read against the list rather than
 * being taken and then checked, so a pick made on another harness leaves the picker showing what the next start will
 * actually run instead of showing nothing. */
function current(options: ReadonlyArray<HarnessOption>, picked: string | undefined, thread: string | undefined): string | null {
  return listedPick(options, picked) ?? thread ?? markedDefault(options)?.value ?? null;
}

/** The access a thread already runs at, read against a list that may not have arrived. A workspace whose machine has
 * not sent its own catalog is lent the host-wide lists with no access modes at all, since which mode a thread starts
 * at is that machine's to decide and those lists were read against no machine. An empty list has not answered, so
 * the thread's own word, written on its rows by the machine that ran it, stands, and only the list's default is
 * withheld. A list with modes in it has answered: one it does not carry belongs to another harness and is dropped,
 * the way every remembered pick is. The effort and the window are not read this way, since their lists are narrowed
 * by the model in front of us and an empty one there is that model taking none. */
function threadAccess(modes: ReadonlyArray<HarnessOption>, value: string | undefined): string | undefined {
  return modes.length === 0 ? value : listedPick(modes, value);
}

export function effectivePicks(catalog: HarnessCatalog, input: { picked: ComposerOptions; thread: ComposerOptions }): ResolvedPicks {
  const model = resolveModel(catalog, { picked: input.picked.model, thread: input.thread.model });
  const efforts = effortsFor(catalog, model);
  const windows = contextWindowsFor(catalog, model);
  const modes = catalog.permissionModes;
  return {
    model: model?.value ?? null,
    effort: current(efforts, input.picked.effort, listedPick(efforts, input.thread.effort)),
    contextWindow: current(windows, input.picked.contextWindow, listedPick(windows, input.thread.contextWindow)),
    permissionMode: current(modes, input.picked.permissionMode, threadAccess(modes, input.thread.permissionMode)),
  };
}

export function startOptionsFrom(catalog: HarnessCatalog, picked: ComposerOptions, thread: ComposerOptions = {}): ComposerStart {
  const model = resolveModel(catalog, { picked: picked.model, thread: thread.model });
  const efforts = effortsFor(catalog, model);
  const windows = contextWindowsFor(catalog, model);
  const effort = listedPick(efforts, picked.effort) ?? listedPick(efforts, thread.effort);
  const window = listedPick(windows, picked.contextWindow) ?? listedPick(windows, thread.contextWindow);
  // Read by the same two readings the buttons are, so what the person sees is what rides.
  const permissionMode = listedPick(catalog.permissionModes, picked.permissionMode) ?? threadAccess(catalog.permissionModes, thread.permissionMode);
  // The thread's own model rides only where this list carries it. Nobody named it on this send, and sessions.start
  // refuses a model the list does not carry, so an inherited one the binary has since dropped would turn every send
  // into a refusal. Unsent, a claude resume keeps the harness session's own model, which is that same model
  // (measured on 2.1.257, 2026-09-12); on a harness whose resume does not, the turn runs on that CLI's own default,
  // which is the price of a send that lands over one that is refused. An effort and an access the thread already
  // runs at ride rather than being left out: absent, every adapter here leaves its CLI's own default in place, which
  // is neither what the thread ran at nor what the pickers show.
  const models = everyModel(catalog);
  const modelValue = picked.model ?? listedPick(models, thread.model) ?? (window !== undefined ? listedPick(models, model?.value) : undefined);
  // A window rides on the model, never alone: claude builds "<model>[1m]" and refuses a window with no model to
  // ride on, so a frame carrying one without the other fails at the adapter.
  const contextWindow = modelValue === undefined ? undefined : window;
  return {
    ...(picked.harness !== undefined ? { harness: picked.harness } : {}),
    ...(modelValue !== undefined ? { model: modelValue } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}
