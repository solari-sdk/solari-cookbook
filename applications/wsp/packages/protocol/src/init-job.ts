// SPDX-License-Identifier: AGPL-3.0-only
// The init job as every client reads it: wsp init's run on the host, from the
// first read of this computer through the screens, the build, the sign-ins,
// the seal and the first workspace. The terminal draws it screen by screen,
// the app in the modal behind the sidebar's cloud row, an agent over MCP as
// one object; there is one job and one view of it, and its rows and progress
// are the same numbers wherever they are shown.
import { z } from "zod";

/** How the recipe gets written: the person on the screens, an agent's thread on this computer reading their usage,
 * or wsp init at a terminal, which asks its own screens and hands the build over with the recipe beside the state. */
export const InitRoad = z.enum(["manual", "agent", "terminal"]);
export type InitRoad = z.infer<typeof InitRoad>;

/** Where the job is. `agent` while the thread writes the recipe; `reading` while this computer is read; `answering`
 * while the screens wait for the person; then the build's own three stretches; `finishing` is the first workspace and
 * its import. */
export const InitPhase = z.enum(["agent", "reading", "answering", "building", "signing-in", "sealing", "finishing", "done", "failed", "cancelled"]);
export type InitPhase = z.infer<typeof InitPhase>;

/** The screens a person can answer, in the terminal's order; the build after them is what the rows below draw. */
export const InitScreenId = z.enum(["agents", "tools", "also", "logins", "wsp"]);
export type InitScreenId = z.infer<typeof InitScreenId>;

export const InitChoice = z.object({ value: z.string(), label: z.string() });
export type InitChoice = z.infer<typeof InitChoice>;

/** One row of a screen, as the terminal's list draws it: a label, its size in bytes (null on a sized row nothing
 * measured, absent on a row with no size), a why between them, the group it sits under, the lines shown while it is
 * highlighted, whether its tick is locked, the words it cycles through instead of a tick when it takes an answer, and
 * on a sign-in row whose agent takes an API key, the variable the agent reads it from and whether the home holds one. */
export const InitScreenItem = z.object({
  id: z.string(),
  label: z.string(),
  size: z.number().nonnegative().nullable().optional(),
  why: z.string().optional(),
  group: z.string().optional(),
  detail: z.array(z.string()),
  lock: z.enum(["on", "off"]).optional(),
  choices: z.array(InitChoice).optional(),
  key: z.object({ name: z.string(), saved: z.boolean() }).optional(),
  /** A row's state as a word where its answer is fixed: a sign-in whose tool is off the image. */
  state: z.string().optional(),
  /** The catalog id whose mark leads the row where it is not the row's own id: a sign-in row's tool. */
  mark: z.string().optional(),
});
export type InitScreenItem = z.infer<typeof InitScreenItem>;

/** A footer line under a screen's rows, loud in a weight's colour when it carries one. */
export const InitFooterLine = z.object({ text: z.string(), tone: z.enum(["yellow", "yellowBright", "red"]).optional() });
export type InitFooterLine = z.infer<typeof InitFooterLine>;

export const InitScreen = z.object({
  id: InitScreenId,
  title: z.string(),
  top: z.string(),
  items: z.array(InitScreenItem),
  /** The rows ticked as the screen stands. */
  ticks: z.array(z.string()),
  /** Each answering row's answer, by row id. */
  answers: z.record(z.string()),
  footer: z.array(InitFooterLine),
  /** The noun the line under the card counts the ticked rows in ("agents", "tools"); absent on a screen with no tally. */
  tally: z.string().optional(),
});
export type InitScreen = z.infer<typeof InitScreen>;

/** The screens a person is shown: one with no row to pick is left out, whichever it is. The agents and tools screens
 * always have rows; the Also screen, the sign-ins and the wsp tools may have none on a computer with no formula, no
 * sign-in or no agent installed. The app's screens and the terminal's run both read this one rule, and each counts
 * its steps over what it keeps. */
export const initShownScreens = <S extends { items: readonly unknown[] }>(screens: readonly S[]): S[] => screens.filter(s => s.items.length > 0);

/** What a row of the job is: a fact read off this computer while it is read, a stage of the image, a sign-in the
 * person finishes in their browser, a secret set on the machine, an agent here given the wsp tools, the first
 * workspace, the project landed on it, a machine a stop could not reach the provider to kill. */
export const InitRowKind = z.enum(["fact", "stage", "sign-in", "secret", "agent", "workspace", "project", "machine"]);
export type InitRowKind = z.infer<typeof InitRowKind>;

/** What each login came to by the time the golden sealed: a sign-in on the machine, or a copy from this computer
 * checked there with the tool's status command. `copied` is a copy nothing checked: an update re-imported it, or the
 * tool has no status command or is not on the machine. `deferred` is a login nobody signed in during the build,
 * because it was left to first use or because the sign-in that ran hit the build's cap: the build never waits on a
 * person, so that is an outcome and not a failure. */
export const LoginState = z.enum(["signed-in", "not-signed-in", "not-verified", "skipped", "copied", "deferred"]);
export type LoginState = z.infer<typeof LoginState>;

/** What happens to a login: copied from this computer, signed in on the machine while the build runs, left to the
 * first time the tool needs it on a workspace, set on the machine as an API key the tool reads, minted here as a
 * long-lived token the vault hands every turn, or left out. One list, read by the collector's rows, by a recipe's
 * rows and by the words `wsp recipe --signin` takes. */
export const LOGIN_CHOICES = ["copy", "machine", "later", "key", "skip", "token"] as const;
export const LoginChoice = z.enum(LOGIN_CHOICES);
export type LoginChoice = z.infer<typeof LoginChoice>;

/** How a sign-in finishes where nobody is at the machine's terminal, which is the app's case: `callback` for a page
 * that redirects to a port on the machine, forwarded from this computer, so no code ever comes back; `code` for a
 * page that hands a code back, which goes to the tool on the machine as the person would type it; `none` for a flow
 * finished on the page or in the tool's own prompts, which the tool's status then proves. */
export const SignInFinish = z.enum(["callback", "code", "none"]);
export type SignInFinish = z.infer<typeof SignInFinish>;

/** The longest code a page hands back that a client may submit: gcloud's is about eighty characters, and the field
 * types into a machine's terminal, so the wire caps it. */
export const SIGN_IN_CODE_MAX = 256;

export const InitRow = z.object({
  id: z.string(),
  kind: InitRowKind,
  /** A sign-in's tool, the catalog's sign-in row id, so a client picks its mark without reading the row id. */
  tool: z.string().optional(),
  label: z.string(),
  /** The state as a word the row prints. A sign-in's is drawn for the computer the run reads, so a copy on a Linux
   * computer says copied from this computer, and nothing compares it: its outcome is the login below. Every other
   * kind's word comes from the INIT_ROW_STATES table and the predicates compare it against that table, so wording
   * one of those for a platform would break every count. */
  state: z.string(),
  /** A sign-in's outcome under its own name, which is what every client compares; the stage the sign-ins fold into
   * carries the name of the one that ran out. Absent on a row whose outcome is not in, and on every other kind. */
  login: LoginState.optional(),
  detail: z.string().optional(),
  /** A sign-in's page, the person's to open on this computer. */
  page: z.string().optional(),
  /** The code that page asks for, when the flow prints one. */
  code: z.string().optional(),
  /** A sign-in's road, absent on every other kind of row: `code` is the row that takes a code from the person. */
  finish: SignInFinish.optional(),
  /** How long the row ran, once it is over. */
  ms: z.number().optional(),
  /** When a running stage's clock started, epoch ms, so a row counts its own seconds while the provider says nothing. */
  since: z.number().optional(),
  /** A stage's latest lines, what the machine said while it ran, for the block under its row. */
  lines: z.array(z.string()).optional(),
});
export type InitRow = z.infer<typeof InitRow>;

/** Which providers this computer holds a key for, keyed by the word WSP_PROVIDER holds: the presence alone, never a
 * value. One entry per provider that reads a key, read off the host's own provider table, so a provider added
 * tomorrow is a row there and nothing here. The agents' keys sit on the sign-ins screen's rows instead, each beside
 * the agent that reads it. */
export const InitKeys = z.record(z.boolean());
export type InitKeys = z.infer<typeof InitKeys>;

/** The step of the setup a draft belongs to that is not one of the screens: the build's own question, the first
 * workspace's name and folder. */
export const INIT_BUILD_STEP = "build";

/** What the person changed on a step and has not sent yet, kept on the host beside the step so shutting the sheet
 * loses nothing and reopening it comes back to what was typed and ticked. A screen's draft is spent by its Continue;
 * the build question's stands until the build starts. Typed API keys are never drafted: they go to the key store. */
export const InitDraft = z.object({
  /** The screen the draft answers, or INIT_BUILD_STEP for the build's own question. */
  at: z.string(),
  ticks: z.array(z.string()),
  answers: z.record(z.string()),
});
export type InitDraft = z.infer<typeof InitDraft>;

/** The kinds a refused `init.keys` carries, so a client tells the provider's own refusal, which the person fixes by
 * typing another key, from a check that never got an answer, which is worth pressing again. */
export const KEY_REFUSED = "keyRefused";
export const KEY_UNCHECKED = "keyUnchecked";

/** What the job waits on the person for while it waits: the sentence every surface says, and when the wait began.
 * The host writes it and nothing else derives it, so the sidebar's row, the toast, the window title and a system
 * notification say one thing. */
export const InitNeedsYou = z.object({ what: z.string(), since: z.number().int().nonnegative() });
export type InitNeedsYou = z.infer<typeof InitNeedsYou>;

export const InitJob = z.object({
  id: z.string(),
  road: InitRoad,
  phase: InitPhase,
  keys: InitKeys,
  /** The screen the person is on, an index into screens; one past the last is the build's own question. Kept here so
   * a setup shut mid-step reopens where it was. */
  step: z.number().int().nonnegative(),
  /** Whether a cancel would stop the job now: not once the seal runs, since the snapshot and the save go to their end. */
  stoppable: z.boolean(),
  /** What the image's disk holds before any tick (the base and the files that travel) and the disk the build asks
   * the provider for, in bytes; absent when the provider reports no disk. */
  disk: z.object({ fixed: z.number().nonnegative(), total: z.number().positive() }).optional(),
  /** The screens shown, filled once this computer is read; empty before. */
  screens: z.array(InitScreen),
  rows: z.array(InitRow),
  /** Rows over, rows in all: what the collapsed sidebar row counts. */
  progress: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  /** What the job waits on the person for, absent while it waits on the machine instead. */
  needsYou: InitNeedsYou.optional(),
  /** The steps with something drafted on them, absent while nothing is; one entry per step at most. */
  drafts: z.array(InitDraft).optional(),
  /** The tail of what the run said, the lines a terminal would have shown. */
  log: z.array(z.string()),
  /** The agent's thread, on the agent road: the thread a client focuses, the workspace it runs on (this computer),
   * the runtime's id for its running turn, which is what answers a prompt that turn raised, and the agent writing
   * the recipe, which is what a retry starts again. */
  thread: z.object({ id: z.string(), workspaceId: z.string(), session: z.string(), harness: z.string() }).optional(),
  /** The one line the agent's thread is on, for the block the agent step shows: the tool it is running, the prompt
   * it is blocked on, else its own latest line. Absent before the thread's first line. */
  line: z.string().optional(),
  error: z.string().optional(),
  /** Set when the provider refused the key already saved, which stops the build before its first stage: the way on
   * is another key on the keys step, not another build. */
  keyRefused: z.boolean().optional(),
  golden: z.object({ version: z.number().int() }).optional(),
  workspace: z.object({ id: z.string(), name: z.string() }).optional(),
  /** The computer the job is for, by id and the name wsp places lists: the one a card started it from, from its start,
   * then the place the build was sent to once it starts. Absent on a job no card started, until its build starts. */
  place: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type InitJob = z.infer<typeof InitJob>;

/** An agent on this computer the agent road can start: the catalog's id and name, whether its config already names
 * the wsp tools, and whether wsp can hand its thread those tools at launch, which is what the road needs. An agent
 * whose adapter renders no MCP server for its CLI cannot be picked: its thread would run without the two tools the
 * brief tells it to call, so the picker shows it and does not offer it. */
export const InitAgent = z.object({ id: z.string(), name: z.string(), configured: z.boolean(), takesTools: z.boolean() });
export type InitAgent = z.infer<typeof InitAgent>;

/** Every change to the job, as one whole view: a client draws the newest and needs no history. */
export const InitJobEvent = z.object({ type: z.literal("init.job"), job: InitJob });
export type InitJobEvent = z.infer<typeof InitJobEvent>;

/** A wait on the person arriving, once per need: the signal a surface that speaks once (a toast, a system
 * notification) rides. The wait standing and the wait ending both ride the job's own view. */
export const InitNeedsYouEvent = z.object({ type: z.literal("job.needs-you"), jobId: z.string(), needsYou: InitNeedsYou });
export type InitNeedsYouEvent = z.infer<typeof InitNeedsYouEvent>;
