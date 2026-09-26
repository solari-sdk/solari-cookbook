// SPDX-License-Identifier: AGPL-3.0-only
// The one vocabulary for a workspace's state. The runtime's phase leads; the
// provider's word and the daemon reach only change it where they contradict
// it. Every client renders these words, and the runtime refuses a send with
// the same sentence the composer shows, so one screen never says two things.
import { computerWord, fmtThreads, LIST_PRICE_WORD, MACHINE_WSP_FORKS, offlineFor, OVER_SSH, THIS_COMPUTER, type CpuWord } from "./format.js";
import type { HarnessCatalog, MachineFacts, MachineState, PauseMode, PlaceBack, ProjectCopy, ProjectSource, ReachState, ScreenCommand, ScreenControl, WorkspaceKind, WorkspacePhase, WorkspaceStatus, WorkspaceView } from "./index.js";
import { LOOPBACK, authority } from "./app-ports.js";

export type WorkspaceState = "running" | "pausing" | "paused" | "waking" | "unreachable" | "gone";

/** A workspace's kind as every client must read it: a record written before local workspaces existed carries none
 * and is a provider fork. The one place an absent kind is resolved. */
export function workspaceKind(view: Pick<WorkspaceView, "kind">): WorkspaceKind {
  return view.kind ?? "cloud";
}

/** Whether this workspace is this computer. Asked by every surface that offers to make one (the app's sidebar and
 * palette, wsp init's workspace step), and written once so the two cannot disagree about what counts. */
export const isLocalWorkspace = (view: Pick<WorkspaceView, "kind">): boolean => workspaceKind(view) === "local";

/** The word a turn's cost figure carries, off the workspace it ran on: a turn on a computer of the person's own ran
 * on their own sign-in, so nobody is billed for it and the number is the agent's own list price; a workspace wsp
 * forked is billed by its provider and its figure stands alone. Nothing where the caller does not know which
 * workspace it was. The one reading, so the terminal's last line and the app's chat footer cannot part again. */
export const turnSpendWord = (view: Pick<WorkspaceView, "kind"> | null | undefined): string | undefined =>
  view !== null && view !== undefined && isLocalWorkspace(view) ? LIST_PRICE_WORD : undefined;

/** What a workspace's kind changes about the words a client shows for it. */
export interface WorkspaceKindWords {
  /** What a sentence calls a machine of this kind, read through machineWord: every refusal that names the machine,
   * the line a recorded machine is announced with and the notice a second record on one is refused with. Every kind
   * has its own, so no sentence about one kind's machine borrows another kind's words. */
  machine: string;
  /** Whether the slot a row gives to what the machine is reads a fact off that machine: the size its status carries
   * in this kind's own word for a cpu on the sidebar row and the Spaces header, the provider's id in the command
   * line's table. False for a kind wsp holds no such fact about, whose rows print the word above there instead. */
  rowReadsMachine: boolean;
  /** What this kind calls one of its cpus in that size line: a provider's are virtual, a machine that exists has cores. */
  cpu: CpuWord;
  /** What a row calls where a workspace of this kind runs, in the lowercase a row's mono reads it. A fork's own
   * record names the provider it runs at, since this host may be wired to any of them, so the kind's word is only
   * what a row says when that record carries none (one written before the provider rode the wire): the kind
   * itself, never the id a provider minted. Null where the kind holds neither, and the name wsp has for the
   * machine stands, which on those kinds is a login or a name somebody gave it. */
  where: string | null;
  /** Whether wsp forks this machine, pauses it, wakes it, resizes it and pays for it by the hour, or it is a machine
   * that already exists and simply runs while the host does. The state word beside the name, the state dot, the
   * spend, the rate, the nap countdown, the usage chart and the pause and upgrade buttons all ride this. */
  driven: boolean;
  /** Whether a machine of this kind ever serves a daemon, which is what the terminal, files and ports ride. False
   * says the reach word `unsupported` is this kind's steady state rather than something missing from one machine,
   * so a row says what the machine is instead of that its daemon is not there. True on a kind whose machines take
   * one, even before one has landed on a given machine: what a machine without one yet says is its own reach word. */
  daemon: boolean;
  /** Where the Machine tab's Live rows are read for a machine of this kind: off the daemon on that machine, or in
   * the host process for the computer the host runs on. False says those rows read that the reading is not on this
   * kind, rather than waiting on a sample that never comes. */
  metrics: ReadingRoad;
  /** Where the Processes tab's list is read, which the same rule holds for. */
  processes: ReadingRoad;
  /** Which kinds of project source a workspace of this kind can hold: this computer copies a folder of the person's
   * own, a machine wsp forks clones a repo into itself, and a machine wsp only reaches takes neither yet.
   * The one table every road that records a project or makes a workspace reads, so no road decides for itself
   * what a computer can be given. */
  projectSources: readonly ProjectSource["kind"][];
  /** Whether a workspace of this kind is a copy of a folder on this computer, made by directory and forking no
   * image: this computer alone. Its own word and not a reading of the sources above, since a computer that clones
   * also takes a folder on this computer as a source, seeded onto the clone, and would otherwise read as one. */
  copiesFolder: boolean;
  /** Whether the agents on a machine of this kind could drive this host at all, which is what says the spawn switch
   * means anything there. A fork's agents reach the host over the road a scoped token opens, and this computer's
   * over its loopback with a token of the same scope; a machine somebody already owns is handed no wsp to drive
   * one with, so there the switch would hand out a token that opens nothing. */
  agents: boolean;
  /** What a delete does to a machine of this kind, which is never the same sentence twice: wsp takes away the
   * machine it forked, leaves this computer alone, and on a machine somebody owns takes off what it put there and
   * leaves the machine standing. */
  onDelete: MachineOnDelete;
  /** The one line under the Workspace panel's name in the picker: what that panel holds for a workspace of this
   * kind. Only a kind wsp drives pays by the hour or has a version behind it, so a kind that takes none of that
   * names what it does hold rather than verbs its panel never offers. */
  panel: string;
  /** What a thread on a machine of this kind runs at when nobody names an access: `asks` is the harness row's own
   * keptMode, whose tools reach the person as a prompt, and `bypass` is the row's bypassMode, which runs every
   * action without asking. A machine wsp forked costs a rebuild and nothing else. This computer is the person's
   * own and the owner's word for it is bypass: a thread here may do what a session they start in their own terminal
   * may do, and a queue of prompts for reading a file and running a command is what they asked to be rid of. A
   * computer somebody already owns and works on is where a thread asks. Read through workspaceAccess, which every
   * road that opens a thread goes through, so no road holds a default of its own. */
  access: "asks" | "bypass";
}

/** What a delete does to a machine, in the two moods the two sentences need: the clause the confirmation asks
 * under "Its", and the clause the line after the delete states, which is given the machine's id since the only
 * kind whose machine goes is worth naming. Both read one entry, so a kind's words cannot say two things. */
export interface MachineOnDelete {
  asked: string;
  done(machineId: string): string;
}

/** What a delete does to a machine wsp did not fork and put nothing on: nothing. Both halves of the sentence are
 * here beside the table that reads them, and each mood supplies the "its" its own line needs. */
export const COMPUTER_LEFT = "computer is left as it is";

/** What a machine somebody already owns keeps and loses: wsp puts a daemon, a user unit and a line in the login
 * file on it, and a delete takes exactly those off again; the machine is theirs and stays. */
const SSH_SWEPT = "daemon, its unit and its login line come off the computer, which is otherwise left as it is";

/** What the Workspace panel holds for a computer that already existed: no spend and no version behind it, so the
 * panel is what the computer is running and how it is doing. */
const OWN_COMPUTER_PANEL = "What the computer is running, its projects and how it is doing.";

/** What a row calls a fork whose record names no provider: what it is, since the id the provider minted for the
 * machine names nothing to the person reading the row. */
const A_PROVIDER = "a provider";

/** The two readings a pane waits on. Each is one module per kind: the cloud kind and a machine over ssh read
 * that machine's own /proc through the daemon on it, and this computer reads its own host. */
export type KindReading = "metrics" | "processes";

/** Who reads one of those two for a machine of this kind. `daemon` is the machine answering for itself over the
 * link a pane holds. `host` is the host process reading the computer it runs on, which is the whole machine there:
 * the reading then stands whether or not that computer's daemon is up, since nothing about cpu, memory or disk
 * needs a port, a token or a pty. False is a kind that reads it on no road. */
export type ReadingRoad = "daemon" | "host" | false;

/** The words per kind, the one table every client reads instead of comparing a kind itself. Adding a kind (an ssh
 * machine) is a row here. */
export const WORKSPACE_KIND_WORDS: Record<WorkspaceKind, WorkspaceKindWords> = {
  cloud: { machine: MACHINE_WSP_FORKS, rowReadsMachine: true, cpu: "vCPU", where: A_PROVIDER, driven: true, daemon: true, metrics: "daemon", processes: "daemon", projectSources: ["git", "github", "gitlab", "folder"], copiesFolder: false, agents: true, onDelete: { asked: "computer is deleted in the cloud", done: machineId => `computer ${machineId} is gone in the cloud` }, panel: "Where it runs, its projects and what it costs.", access: "bypass" },
  local: { machine: THIS_COMPUTER, rowReadsMachine: true, cpu: "cores", where: THIS_COMPUTER, driven: false, daemon: true, metrics: "host", processes: "daemon", projectSources: ["folder"], copiesFolder: true, agents: true, onDelete: { asked: COMPUTER_LEFT, done: () => `its ${COMPUTER_LEFT}` }, panel: "What this Mac is running, its projects and how it is doing.", access: "bypass" },
  ssh: { machine: OVER_SSH, rowReadsMachine: false, cpu: "cores", where: null, driven: false, daemon: true, metrics: "daemon", processes: "daemon", projectSources: [], copiesFolder: false, agents: false, onDelete: { asked: SSH_SWEPT, done: () => `its ${SSH_SWEPT}` }, panel: OWN_COMPUTER_PANEL, access: "asks" },
};

/**
 * The access list a workspace of this kind shows and its starts are checked against: the harness's own modes, in
 * the same order and with the same sentences, with the default mark on the mode this kind starts a thread at and
 * the mode that skips the asking named after the machine it would hand over. That name is the kind's own word for
 * its machine, and only a kind wsp neither forks nor throws away carries one: picking it on a machine wsp made
 * hands over nothing of the person's. The CLI's own word for that mode stays as the row's short form, which is
 * what the picker's button says once it is picked: the long name is read in the menu and in every line about the
 * pick, and a button that carried it crushed the model's name beside it in a narrow window (measured 2026-09-09,
 * 316 px of row at a 1200 px viewport with the right panel open). A catalog whose CLI takes no access mode comes
 * back as it went in. The one place a start's access is decided, so the composer's picker, the command line and
 * the MCP tool cannot show three answers.
 */
export function workspaceAccess(catalog: HarnessCatalog, kind: WorkspaceKind): HarnessCatalog {
  if (catalog.keptMode === undefined) return catalog;
  const words = WORKSPACE_KIND_WORDS[kind];
  const starts = words.access === "asks" ? catalog.keptMode : catalog.bypassMode;
  const permissionModes = catalog.permissionModes.map(({ isDefault: _unplaced, ...mode }) => ({
    ...mode,
    ...(mode.value === starts ? { isDefault: true } : {}),
    ...(!words.driven && mode.value === catalog.bypassMode ? { label: `${mode.label} on ${words.machine}`, short: mode.label } : {}),
  }));
  return { ...catalog, permissionModes };
}

export function kindWords(kind: WorkspaceKind): WorkspaceKindWords {
  return WORKSPACE_KIND_WORDS[kind];
}

/** Whether a machine of this kind answers this reading at all. The one question a pane asks before it waits: a kind
 * that serves it shows pending until the first value lands, and a kind that serves it on no road says so at once,
 * so no slot sits at pending for a stream that will never come. */
export function servesReading(kind: WorkspaceKind, reading: KindReading): boolean {
  return readingRoad(kind, reading) !== false;
}

/** Who answers this reading for a machine of this kind: the one table both the pane that asks for it and the host
 * that serves it read, so neither can decide for itself where a kind's figures come from. */
export function readingRoad(kind: WorkspaceKind, reading: KindReading): ReadingRoad {
  return WORKSPACE_KIND_WORDS[kind][reading];
}

/** Whether the spawn switch means anything on a workspace of this kind, the one reading both doors that set it
 * take: the create that names it on a new workspace and the verb that turns it on for one that exists. */
export function agentsMayDrive(kind: WorkspaceKind): boolean {
  return WORKSPACE_KIND_WORDS[kind].agents;
}

/** The one sentence both those doors refuse with, so a person reads the same thing whichever they typed. */
export function agentsKindRefusal(kind: WorkspaceKind): string {
  return `agents on ${machineWord(kind)} cannot drive this host, so the spawn switch would hand out a token that opens nothing; it is for the machines wsp forks and this computer`;
}

/** What a sentence calls this workspace's machine. Every kind answers for itself: a refusal on a machine wsp forks
 * says so, and this computer's words are this computer's alone. */
export function machineWord(kind: WorkspaceKind): string {
  return WORKSPACE_KIND_WORDS[kind].machine;
}

/** What deleting a workspace takes, the one sentence every client's confirmation shows: what the delete does to
 * this kind's machine, in that kind's own words, and either way the record and the threads go from here. It sits
 * with the kind table rather than with the other notices, since the machine half is a kind's word and a second
 * copy of it beside the sentence is what let the ssh kind say a delete leaves its machine untouched. */
export function deleteNotice(threads: number, kind: WorkspaceKind, copy?: Pick<ProjectCopy, "path">): string {
  return `Its ${onDeleteOf(kind, copy).asked}; its record and ${fmtThreads(threads)} leave this computer.`;
}

/** What a delete does to a workspace that is a copy of a project folder: the copy goes and the folder it was copied
 * from stays. Every other workspace takes its kind's words. */
export function onDeleteOf(kind: WorkspaceKind, copy?: Pick<ProjectCopy, "path">): MachineOnDelete {
  if (copy === undefined) return WORKSPACE_KIND_WORDS[kind].onDelete;
  const removed = `copy at ${copy.path} is removed and the project folder is left as it is`;
  return { asked: removed, done: () => `its ${removed}` };
}

export interface WorkspaceStateInput {
  phase: WorkspacePhase;
  machineState?: MachineState | null | undefined;
  reach?: ReachState | null | undefined;
  /** Set on a record whose last wake ran its asks out with the machine still paused at the provider; the state words
   * are unchanged by it (the machine is paused, and a wake may be tried again) but the rebuild is offered. */
  wakeRefused?: string | null | undefined;
}

export function workspaceState(input: WorkspaceStateInput): WorkspaceState {
  const machine = input.machineState ?? null;
  const reach = input.reach ?? null;
  if (machine === "gone") return "gone";
  switch (input.phase) {
    case "pausing":
      return "pausing";
    case "napping":
      return "paused";
    case "waking":
      return "waking";
    case "gone":
      return "gone";
    case "running":
      if (machine === "paused") return "paused";
      if (machine === "starting") return "waking";
      if (reach === "unreachable" || reach === "no-daemon" || reach === "zombie") return "unreachable";
      return "running";
    default: {
      const _exhaustive: never = input.phase;
      return "running";
    }
  }
}

/** The one state word's key for a workspace as every client knows it: its phase, and the machine state and reach of
 * its status when one has arrived. A caller holding only the record passes null and reads the phase alone, which is
 * why a surface that shows a state asks for the status: the phase alone calls a paused or unreachable machine
 * running. */
export function workspaceStateOf(workspace: Pick<WorkspaceView, "phase">, status: Pick<WorkspaceStatus, "machineState" | "reach"> | null): WorkspaceState {
  return workspaceState({ phase: workspace.phase, machineState: status?.machineState, reach: status?.reach.state });
}

const WORDS: Record<WorkspaceState, string> = {
  running: "Running",
  pausing: "Stopping",
  paused: "Stopped",
  waking: "Waking",
  unreachable: "Unreachable",
  gone: "Gone",
};

/** The two words a computer that keeps the processes and the bytes of a paused machine reads instead: a nap there
 * is a pause, and everywhere else it is a stop, which is what the machine does to every process it was running. */
const MEMORY_WORDS: Partial<Record<WorkspaceState, string>> = { pausing: "Pausing", paused: "Paused" };

/** The one word for a workspace's state. The computer's pause mode rides where the caller holds it, since the same
 * state is a pause on a machine that keeps its memory and a stop on one that does not; a caller holding none reads
 * the stopping words, which is what every computer but a provider with memory pauses does. */
export function workspaceWord(state: WorkspaceState, pauseMode?: PauseMode): string {
  return (pauseMode === "memory" ? MEMORY_WORDS[state] : undefined) ?? WORDS[state];
}

/** What a row this workspace's machine stands on says under WHERE: the name this host has for the computer it runs
 * on, which only a caller holding the places list can give and which is what a person calls that machine; else the
 * provider its own record names, since this host may be wired to any of them and reading it off the kind would tell
 * somebody on Docker their workspace is at Solari; else the kind's own word; else the name wsp has for the machine,
 * which on those kinds is a login or a name somebody gave it and never an id a provider minted. Wherever that comes
 * out as the computer the host runs on, it is said in that machine's own words. The one place a surface asks where
 * a workspace runs. */
export function whereWord(record: Pick<WorkspaceView, "machineId"> & { kind?: WorkspaceKind | undefined; provider?: string | undefined; facts?: Pick<MachineFacts, "os"> | undefined }, named?: string): string {
  const word = named ?? record.provider ?? kindWords(workspaceKind(record)).where ?? record.machineId;
  return word === THIS_COMPUTER ? computerWord(record.facts?.os) : word;
}

/** The line a verb that moved a workspace prints once the runtime has answered: the workspace and the word the next
 * listing will show for it, in the lowercase a line of work reads. The one place that word is lowered, so a pause
 * and a wake cannot spell one state two ways. The computer's pause mode rides where the caller holds it, as the
 * state word itself takes it: a nap on a provider that keeps the machine's memory is a pause, and a stop anywhere
 * else. A machine the provider has started and nothing on it answers gets a
 * sentence of its own, since one word there would say the wake failed when what happened is that the machine is up
 * and its daemon is not talking yet; a caller holding only a phase never reaches it. */
export function workspaceStateLine(name: string, state: WorkspaceState, pauseMode?: PauseMode): string {
  return state === "unreachable" ? `${name} is up and not answering yet` : `${name} ${workspaceWord(state, pauseMode).toLowerCase()}`;
}

/** Every word a slot beside facts can hold for a computer that is not answering, which is what lets a reader of
 * that slot keep a closed set of words: a reading added here is a word added there, in one place. */
export type AwayWord = "no answer" | "no daemon";

/** What every surface says about a workspace whose computer is not answering, one reading per slot that has to
 * hold it: the mono word of a state slot, a row's third line, the length of the silence beside the computer's own
 * name, the two halves a pane refuses in, and the whole sentence. Six surfaces used to word this silence six ways
 * (a dead label, a state word that disagreed with the readings under it, two table cells, a launch refusal naming
 * a machine id and a toast in the sidebar's corner); they read these instead. */
export interface AbsentComputer {
  /** The state slot's word, the protocol's own for a machine that answers nothing. */
  readonly word: string;
  /** The one word a table slot standing beside three fact columns holds: the silence itself, with no figure on it.
   * How long it has been rides the row's title and the detail that already carries it. */
  readonly away: AwayWord;
  /** A workspace row's third line, which has room for the figure. Written to thirty characters because that is
   * what the row leaves for text: a longer line is cut from the right, and the half that says what to do is the
   * half that goes. The second half states the silence and asks; it never says the computer is off, which this
   * host cannot know, since a computer that is on and not answering reads this same line. */
  readonly line: string;
  /** What happened, the first half a pane refuses in. */
  readonly said: string;
  /** What happens next, the second half: nobody has to reconnect it, so the one thing left to do is switch it on.
   * Absent on a reading that carries a button instead, where the button is what happens next. */
  readonly will?: string;
  /** Both halves, for every slot with room for a sentence: the row's title, the pane's State row, the held send. */
  readonly sentence: string;
  /** The word on the button that puts back what the reading names, where this host owns the process that is
   * missing rather than waiting on a computer of its own accord. A reading that carries one is also one a turn
   * runs under, since what is missing never carried the turn: the composer stays open on it. */
  readonly start?: string;
}

/** The one state of a computer that is not answering. awayMs is how long this host has not heard from it, null
 * where it never has. */
export function absentComputer(name: string, awayMs: number | null): AbsentComputer {
  const away = "no answer";
  const said = `${name} is not answering`;
  const will = "it connects on its own when it is on";
  const dated = awayMs === null ? away : `${away} ${offlineFor(awayMs)}`;
  return { word: workspaceWord("unreachable"), away, line: `${dated}, is it on?`, said, will, sentence: `${said}; ${will}` };
}

/** The word on the button under every pane that needs the daemon this host started. */
export const START_DAEMON_WORD = "Start it";

/** The one state of the daemon this host started for its own computer's workspace while it is not running. The
 * daemon is a child of the host, so this computer's reach is that child's reach and the app reads it as the
 * computer being absent, in this computer's own words; the host can start another, so the reading carries the
 * button rather than a second sentence, and a turn here runs without it. Unreachable is never one of these words:
 * the computer the app is drawn on is the one computer a person can see is on. */
export function ownDaemonDown(name: string): AbsentComputer {
  const said = `${name}'s daemon is not running`;
  // The row leaves thirty characters, which the sentence itself does not fit in, so the line says the same fact
  // without the computer's name: the row already names the workspace, and the whole sentence rides its title.
  return { word: "No daemon", away: "no daemon", line: "daemon not running, start it", said, sentence: said, start: START_DAEMON_WORD };
}

/** What the slot above the composer says while the workspace's computer is not answering. The box stays open and
 * keeps what is typed, so the line says what became of those words rather than that a send was refused: nothing
 * leaves until the computer answers, and then only on the person's own send. The computer is named because it is
 * the one thing the person can act on; the state word belongs to the row. */
export const composerHeldLine = (computer: string): string => `held until ${computer} answers`;

/** How long this host has not heard from a computer, off the row it holds for it; null on a row that never
 * reported. One spelling of the silence's length, so the table and the sidebar date it alike. */
export function awayMsOf(place: { readonly lastSeenAt?: string | undefined }, now: number): number | null {
  const since = place.lastSeenAt === undefined ? NaN : Date.parse(place.lastSeenAt);
  return Number.isNaN(since) ? null : now - since;
}

/** A fact a computer reported before it went quiet, marked as the reading it is: what it was when it last spoke,
 * not what it is. Every slot that would otherwise stand at pending on a computer that is not answering says this
 * instead, since the host already holds the answer and pending reads as a fact still coming.
 *
 * The word is the mark's, because the two spans a slot can be dated by are not the same: a fact that does not
 * change is dated by the silence (`last seen`), and one that grows while the computer is up is dated by the
 * report it was read in (`reported`), which can be hours older than the last frame. */
export function lastKnown(value: string, agoMs: number | null, word = "last seen"): string {
  return agoMs === null ? value : `${value}, ${word} ${offlineFor(agoMs)} ago`;
}

/** The mark on a figure that was true when the computer last reported and has grown since: its uptime. */
export const REPORTED_WORD = "reported";

/** What this host knows about reaching one computer, for the surfaces that have to say it. absentComputer says the
 * computer is silent; this says where the app expects it, when it last spoke and what the last dial said, which
 * together are what tells a computer that is off from a road that is broken. */
export interface AbsentRoadInput {
  name: string;
  /** The ssh login the host was given for it, the address its last link dialled in from, and the forward on its own
   * loopback it dials back through where it reaches this host no other way. */
  road?: { readonly ssh?: string | undefined; readonly from?: string | undefined; readonly back?: PlaceBack | undefined } | undefined;
  /** How long this host has not heard from it; null where it never has. */
  awayMs: number | null;
  /** What the last dial of it came to, where one has been made. */
  dialled?: { readonly answered: boolean; readonly roundTripMs?: number | undefined; readonly said?: string | undefined } | undefined;
}

/** The road reading in the pieces its two surfaces need: the row detail draws them as rows of their own and the
 * pane says them as one sentence. Written once so the two cannot date the same silence differently. */
export interface AbsentRoad {
  /** The Address row: the login the host dials, or the address the computer dialled in from, with the road it is.
   * Null on a computer this host was not installed on and has never held a link from. */
  address: string | null;
  /** How it dials back through the forward on its own loopback, where it does; null for every other road. */
  dialsBack: string | null;
  /** The Answered row, without its label. */
  answered: string;
  /** What the last dial said, where it was refused; null where it answered or where none was made. */
  refused: string | null;
  /** The three as one sentence, for a pane with room for prose. */
  sentence: string;
}

/** The word for each road, said the way a person would: a login this host dials, or an address that dials it. */
const DIALS_IN = "dials in";
const OVER_SSH_WORD = "ssh";

/** The ssh login this host holds for a computer, where it holds one: the one road to a computer that is not
 * answering. A record written without a login carries the word empty rather than absent, and a sentence built on
 * an empty word names nothing, so every reading of a road asks here rather than comparing for itself. */
export const sshRoadOf = (road?: { readonly ssh?: string | undefined } | undefined): string | undefined =>
  road?.ssh === undefined || road.ssh === "" ? undefined : road.ssh;

/** The address a box's link dials for a forward standing on its own loopback. */
export const backUrl = (boxPort: number): string => `http://${authority(LOOPBACK, boxPort)}`;

/** The road back to this host through the forward on a box's own loopback, the one spelling every surface says. */
export const BACK_OVER_SSH = `back over ${OVER_SSH_WORD}`;

/** A box's road back to this host through the forward on its own loopback, with where that forward stands. */
export const dialsBackWord = (boxPort: number, name: string): string => `dials ${BACK_OVER_SSH} (${authority(LOOPBACK, boxPort)} on ${name})`;

/** The road a link came in on, off the address the computer says it dialled. The box writes that address, so one
 * this host did not hand out is never said: undefined, and the sentence names no road. */
export const linkedOver = (dialed: string, back: PlaceBack | undefined, handed: readonly string[]): string | undefined =>
  back !== undefined && dialed === backUrl(back.boxPort) ? `over ${OVER_SSH_WORD}` : handed.includes(dialed) ? `at ${dialed}` : undefined;

export function absentRoad(input: AbsentRoadInput): AbsentRoad {
  const ssh = sshRoadOf(input.road);
  const back = input.road?.back;
  const dialsBack = back === undefined ? null : dialsBackWord(back.boxPort, input.name);
  // A link through the forward comes from this computer's own loopback, which is no address of that computer's.
  const from = back === undefined ? input.road?.from : undefined;
  const address = ssh !== undefined ? `${ssh} over ${OVER_SSH_WORD}` : from !== undefined && from !== "" ? `${from} ${DIALS_IN}` : null;
  const answered = input.awayMs === null ? "not since it joined" : `${offlineFor(input.awayMs)} ago`;
  const refused = input.dialled !== undefined && !input.dialled.answered && input.dialled.said !== undefined ? input.dialled.said : null;
  const where =
    ssh !== undefined
      ? `wsp logs in to ${input.name} at ${ssh} over ssh${dialsBack === null ? "" : `, and ${input.name} ${dialsBack}`}`
      : dialsBack !== null
        ? `${input.name} ${dialsBack}`
        : from !== undefined && from !== ""
          ? `wsp waits for ${input.name} to dial in, last from ${from}`
          : `wsp waits for ${input.name} to dial in`;
  const when = input.awayMs === null ? `it has not answered since it joined` : `it last answered ${offlineFor(input.awayMs)} ago`;
  return { address, dialsBack, answered, refused, sentence: `${where}; ${when}.${refused === null ? "" : ` The last try said: ${refused}`}` };
}

/** What one dial came to, in the slot the button that asked stands in. A computer holding its link answers the
 * frame; one that does not is dialled over the road it was added on, and a road that answers while the link is
 * down is the reading a person came for: the computer is on and the agent on it is not calling home. */
export function placeDialLine(input: { name: string; road?: { readonly ssh?: string | undefined } | undefined; linked: boolean; dialled: { readonly answered: boolean; readonly roundTripMs?: number | undefined; readonly said?: string | undefined } }): string {
  const { dialled } = input;
  if (!dialled.answered) return dialled.said ?? `${input.name} answered nothing.`;
  const took = dialled.roundTripMs === undefined ? "" : ` in ${dialled.roundTripMs} ms`;
  if (input.linked) return `${input.name} answered${took}.`;
  const at = sshRoadOf(input.road);
  return `${at ?? input.name} answered over ${OVER_SSH_WORD}${took}, so the computer is on; the agent on it is not dialling this host.`;
}

/** The one sentence a dial gets on a computer this host has no road to: it was joined by typing a code, so nothing
 * here can make it speak and the only thing to do is switch it on. */
export const placeNoDialLine = (name: string): string => `wsp has no road to dial ${name}: it joined by typing a code, so it connects on its own when it is on.`;

/** The roads a dial can take, in the order the host tries them. */
export type PlaceDialRoad = "link" | "ssh";

/** Which road a dial of this computer would take, and nothing at all where there is none: a computer holding its
 * link answers a frame on it, one that is down is dialled over the ssh login it was installed with, and a computer
 * that joined by typing a code and is not there can only be switched on, which is placeNoDialLine's whole subject.
 * The host reads this to pick the road and the app reads it to decide whether to draw the button at all, so no
 * screen offers a press whose only answer is that there was nothing to press. */
export function placeDialRoad(place: { present?: boolean | undefined; road?: { readonly ssh?: string | undefined; readonly from?: string | undefined } | undefined }): PlaceDialRoad | undefined {
  if (place.present === true) return "link";
  return sshRoadOf(place.road) === undefined ? undefined : "ssh";
}

/** Why an action that needs the machine (send, import, export) cannot run in this state; null while running.
 * goneWords are the provider's, quoted when the caller holds them (the runtime does, the composer does not). */
export function actionRefusal(state: WorkspaceState, action: string, goneWords?: string): string | null {
  switch (state) {
    case "running":
      return null;
    case "pausing":
    case "paused":
      return `Workspace is ${state}; wake it to ${action}`;
    case "waking":
      return `Workspace is waking; ${action}s open when it is running`;
    case "unreachable":
      return `Workspace is unreachable; ${action}s open when the machine answers`;
    case "gone":
      return goneRefusal(action, goneWords);
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}

/** What refuses a send before the workspace's state is asked: the socket to wsp, the workspace lookup, the
 * transcript still loading, the agent catalog this workspace picks its model and access out of still unanswered. */
export type SendBlock = "connecting" | "reconnecting" | "closed" | "not-found" | "loading" | "no-agents";

/** Every kind of send refusal: a block, or a state other than running. */
export type SendRefusalKind = WorkspaceState | SendBlock;

/** What the composer says on the send button for each block, and the one table of those words: a harness driving
 * the built app reads them to know the app is not ready for a key press yet. */
export const SEND_BLOCK_WORDS: Record<SendBlock, string> = {
  connecting: "Connecting to wsp",
  reconnecting: "wsp is not running, reconnecting",
  closed: "wsp is not running",
  "not-found": "Task not found",
  loading: "Loading transcript",
  "no-agents": "the agents here have not answered yet",
};

/** Why a turn cannot be sent, one sentence per kind; null while running. The composer draws every row; the runtime
 * throws the state rows, so the two say the same thing about a machine. A thread whose turn replied but still runs
 * has stillWorkingLine, which says the message waits for it. */
export function sendRefusal(kind: SendRefusalKind, goneWords?: string): string | null {
  return isBlock(kind) ? SEND_BLOCK_WORDS[kind] : actionRefusal(kind, "send", goneWords);
}

const isBlock = (kind: SendRefusalKind): kind is SendBlock => kind in SEND_BLOCK_WORDS;

const CONTROL_WORDS: Record<Exclude<ScreenControl, "sign-in">, string> = {
  model: "pick the model in the row under the box",
  access: "pick the access mode in the row under the box",
  settings: "wsp's settings open from the command palette",
  docs: "wsp's docs are at wsp.apidocumentation.com",
};

/** How the person signs this workspace's agent in, in one place: the sign-in is the workspace's, so the Workspace
 * panel signs one in and this computer is signed in from its own terminal. Both the composer's line for a sign-in
 * command and a turn the agent refused for want of a sign-in read this rule, so the two never send a person two ways. */
export function signInRoad(view: Pick<WorkspaceView, "kind">): string {
  return isLocalWorkspace(view) ? `sign in from a terminal on ${THIS_COMPUTER}` : "sign this workspace in from the Workspace panel";
}

/** wsp's half of a turn the agent refused for want of a sign-in: the road above, and that the turn is the person's
 * to send again once they have taken it. The agent's own sentence names its login command; this names where. */
export const signInRefusalLine = (view: Pick<WorkspaceView, "kind">): string => `${signInRoad(view)}, then send again`;

/** The composer's line for a slash command the CLI runs only in its own terminal, in place of a turn that would answer
 * the command is not available: what the command is, then the wsp control that serves the same intent. */
export function screenCommandLine(command: ScreenCommand, catalog: Pick<HarnessCatalog, "label">, view: Pick<WorkspaceView, "kind">): string {
  const control = command.control === "sign-in" ? signInRoad(view) : CONTROL_WORDS[command.control];
  return `/${command.name} works only in ${catalog.label}'s own terminal; ${control}`;
}

/** A probe that found the machine: the edge answered, promptly or late. */
const ANSWERED: ReadonlySet<ReachState> = new Set<ReachState>(["reachable", "slow"]);
/** A probe nothing answered: silence, or the edge dialling the guest and finding the daemon port dead. */
const UNANSWERED: ReadonlySet<ReachState> = new Set<ReachState>(["unreachable", "no-daemon"]);

/** Whether a workspace's reach says nothing is answering on its daemon's road: the probe found silence, or found
 * the road open with the daemon port dead. On the computer the host runs on both mean one thing, the child this
 * host started is not running, which is why the one reading of it asks this and not a list of states. */
export const daemonSilent = (reach: ReachState | null | undefined): boolean => reach != null && UNANSWERED.has(reach);

/** The reach word a row shows after one probe. A single silence after an answer keeps the answer's word: one slow
 * edge answer, one DNS blip, one busy second on the box or one probe that landed while the daemon was restarting
 * is not the machine gone dark, so the word turns only on the second silence in a row. Every answer, and a silence
 * after anything but an answer, shows as it came. This is also the window the runtime waits out before it puts a
 * daemon back: the word the row is given is already the second unanswered probe. */
export function reachShown(lastProbe: ReachState | undefined, probed: ReachState): ReachState {
  if (!UNANSWERED.has(probed)) return probed;
  return lastProbe !== undefined && ANSWERED.has(lastProbe) ? lastProbe : probed;
}

/** Whether the latest poll's probes failed before leaving this computer. A road that fails here fails for every
 * machine at once, so one row saying so is the computer's network, never that row's machine. */
export function computerOffline(statuses: Iterable<Pick<WorkspaceStatus, "reach">>): boolean {
  for (const s of statuses) if (s.reach.offline === true) return true;
  return false;
}

/** Whether the machine is up and billing in this state: running, or running with its edge or daemon dark (the
 * provider bills a machine it cannot be reached on). Paused, moving and gone ones bill nothing, and only a billing
 * machine has anything to nap, so the rate and the nap countdown on every surface read this one rule. */
export function isBilling(state: WorkspaceState): boolean {
  return state === "running" || state === "unreachable";
}

/** Rebuild is a road out: the machine is gone, a zombie the provider still calls running, or one the provider would
 * not resume for the whole of a wake's asking. Every surface that offers the rebuild (sidebar row, palette, Machine
 * tab, the command line and its tool) asks this and nothing else. It is the only one left on the first two; on the
 * third the wake can be tried again beside it, since the fault is the provider's and may pass. */
export function needsRebuild(input: WorkspaceStateInput): boolean {
  return workspaceState(input) === "gone" || input.reach === "zombie" || (input.wakeRefused ?? null) !== null;
}

/** Why a road out that opens only once the machine is gone is refused on one that is merely not answering. The
 * rebuild and the forget are both such roads and stand four rows apart in one list, so they read the workspace's
 * state off the same field and say it in the same words: a machine nothing has heard from does not answer, and a
 * person told both at once stops believing either. Two halves as every refusal here has them: what is so, then when
 * the road is there to take. */
export const notAnsweringYet = (road: "rebuild" | "forget"): string => `This one is not answering yet; the ${road} is offered once it is gone`;

/** The half of the forget's refusal that holds whatever the workspace is: what is so about it comes after, and
 * two callers word that half differently. */
export const FORGET_NEEDS_GONE = "Only a workspace whose computer is gone can be forgotten";

/** Why a road that waits on the machine being gone is refused, for the two roads that wait on it: the rebuild and
 * the forget. Both read the one folded state and say it in the one word the row under them shows; each names its
 * own road in the second half, which is all that differs between them. The command line and the app refuse a
 * rebuild through this same sentence off the same state, so the terminal and the row can no longer say two things
 * about one workspace. Two halves as every refusal here has them: what is so, then when the road is there to take. */
export function goneRoadRefusal(state: WorkspaceState, road: "rebuild" | "forget"): string {
  if (state === "unreachable") return notAnsweringYet(road);
  const word = workspaceWord(state).toLowerCase();
  return road === "rebuild" ? `This one is ${word}, so nothing needs rebuilding; the rebuild is offered once a workspace is gone` : `${FORGET_NEEDS_GONE}; this one is ${word}`;
}

/** The one sentence for a verb a gone machine cannot take (send, wake, fork), with the provider's words when the
 * caller holds them; rebuild and delete are the roads out. */
export function goneRefusal(action: string, words?: string): string {
  const sentence = `Workspace machine is gone; rebuild it to ${action}`;
  return words === undefined || words === "" ? sentence : `${sentence} (${words})`;
}

/** What a workspace's image is, for a move onto the golden's head: whether any golden of this host knows the
 * snapshot it forked from as a version, and whether that snapshot is a project golden. */
export interface ImageMoveInput {
  knownVersion: boolean;
  projectImage: boolean;
}

/** Why a workspace cannot be moved onto its golden's head, or null when it can. One rule, so the app's offer and
 * the runtime's refusal cannot drift apart: the app hides the button on the sentence the runtime would throw.
 * A move replaces the machine, so only a running one can take it; a project image is refused outright, since the
 * disk the move leaves behind is the project's. */
export function imageMoveRefusal(name: string, state: WorkspaceState, image: ImageMoveInput): string | null {
  if (image.projectImage) return `${name} was forked from a project image, which a version move would throw away; make a new workspace on the newer version instead`;
  if (!image.knownVersion) return `${name}'s image is not one of the versions this host knows; make a new workspace on the newest version instead`;
  if (state === "gone") return `${name}'s machine is gone; rebuild it to move it to a newer image`;
  if (state !== "running") return `${name} is ${workspaceWord(state).toLowerCase()}; wake it to move it to a newer image`;
  return null;
}
