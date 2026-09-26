// SPDX-License-Identifier: AGPL-3.0-only
// Row labels for the workspace sidebar. The adapter names the state; this file
// turns it into the words and classes a row shows. What a workspace is made of
// and what its ports are is the protocol's word table (madeOfWord, portsWord),
// read here and never respelled. Pure but for the one hook beside the where
// word, which reads that word off the store for the surfaces that hold a
// workspace's id and no snapshot.
import { agentName } from "@wsp/catalog";
import { broughtBackRowLine } from "../actions/format.js";
import { HERE_PLACE_ID, computerNamed, kindWords, madeOfWord, portsWord, whereWord as whereOf, machineLacksShort, outOfMemoryRowLine, workspaceKind, type AbsentComputer, type BringBackResult, type Capabilities, type MemoryReading, type ReachState, type SessionOrigin, type PlaceView, type WorkspaceKindWords } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot, StatusIndicatorTone } from "../adapt/index.js";
import type { ProjectRef } from "./threadTree.js";
import { APP_PLATFORM, PLACE_KIND_WORDS, THIS_COMPUTER_WORD, placeName, placeOf } from "../settings/places.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutLabelForCommand } from "../keybindings.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { usePlaces, useStatus, useWorkspace } from "../protocol/store.js";
import { formatWorkingDurationLabel, type ThreadStatusPill } from "./Sidebar.logic.js";

export const NEW_THREAD_SHORTCUT = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "chat.new");
export const NEW_THREAD_TITLE = NEW_THREAD_SHORTCUT ? `New thread (${NEW_THREAD_SHORTCUT})` : "New thread";

/** The row's line for a daemon that is not there, and which of the two facts it is: no-daemon is a machine that
 * answers with nothing on the daemon's port, unsupported one with no daemon road at all. Nothing for every other
 * reach, and nothing at all on a kind whose machines serve no daemon, which has none to miss. A daemon that died
 * is said on every kind that has one, since a driven kind's state word reads Unreachable for it, which is also
 * what a machine gone dark reads, and only one of the two is a helper wsp puts back by itself while the machine is
 * fine. A machine with no road to a daemon says only what that machine said it lacks, which is the one thing on
 * the row a person can act on; the bare fact of a missing daemon is not a line, having no verb in it and naming a
 * thing a person never installed. */
export function daemonGoneLine(reach: ReachState | null, kind: WorkspaceKindWords, lacks?: string): string | undefined {
  if (!kind.daemon) return undefined;
  if (reach === "no-daemon") return "no daemon answering";
  if (reach !== "unsupported" || kind.driven || lacks === undefined) return undefined;
  // The whole sentence rides the row's own hover text, since the instruction is at the end of it and this line
  // cuts from the right.
  return machineLacksShort(lacks);
}

/** The sentences a meta line can carry in place of its counts, in the order a surface draws them: the
 * computer that is not answering first, since nothing else on the row is known while it is, then a thread of this
 * workspace stopped on a question, then what the runtime is doing to the machine's daemon, then a drop with
 * memory near full, then a daemon that is not there at all. Written once because two surfaces draw them and both
 * have to tell them from a figure: prose takes the ink that reads at AA, the counts beside it keep the whisper.
 * Every one of them is something a person is waiting on now; a note on a step already taken (a nap that saved no
 * backup) is not here, since this slot is the row's state and its spend. */
export function metaSentences({ project, absent, outOfMemory }: Pick<WorkspaceMetaInput, "project" | "absent" | "outOfMemory">): string[] {
  return [
    absent?.line,
    askingNote(project),
    daemonNote(project),
    outOfMemory === undefined ? undefined : outOfMemoryRowLine(outOfMemory),
    daemonGoneLine(project.reach, kindWords(workspaceKind(project.workspace)), (project.status ?? project.workspace).daemonRefusedAt?.why),
  ].filter((line): line is string => line !== undefined);
}

export interface WorkspaceMetaInput {
  readonly project: Pick<SidebarProjectSnapshot, "state" | "status" | "workspace" | "reach" | "threads">;
  /** What the last bring back on this workspace answered, where one has; the row's third line reads it in place of
   * the branch, since it says the branch and what became of it. */
  readonly broughtBack?: BringBackResult | undefined;
  /** The one reading of a computer that is not answering; the row's third line is then its own. Absent on a
   * caller that holds no places list. */
  readonly absent?: AbsentComputer | null | undefined;
  /** The last memory sample from a machine whose link then dropped. */
  readonly outOfMemory: MemoryReading | undefined;
}

/** What a workspace is made of, the row's second line: the word for its copy, the computer it stands on where
 * that is not the computer this window runs on, and what the copy has for a network. Every word is the
 * protocol's table, so this line and the command line's two cells cannot say two things about one workspace. A
 * workspace with no copy of a folder is a fork, whose line is its network alone; a caller with no landing for the
 * project has no flags to read the network off and says the copy and the computer.  */
export function madeOfLine({ project, landing, computer }: { project: Pick<SidebarProjectSnapshot, "workspace">; landing: Pick<Capabilities, "copies" | "ownNetwork"> | null; computer: string | null }): string[] {
  const copy = project.workspace.copy;
  return [
    copy === undefined ? undefined : madeOfWord(copy.road),
    computer ?? undefined,
    landing === null ? undefined : portsWord(landing, project.workspace.portBase, APP_PLATFORM) || undefined,
  ].filter((part): part is string => part !== undefined);
}

/** The branch the agent is working on, off the record the copy was made with; empty where the record carries
 * none, which is a workspace whose copy was made with no branch of its own. */
export function branchLine(project: Pick<SidebarProjectSnapshot, "workspace">): string {
  return project.workspace.copy?.branch ?? "";
}

/** The workspace row's third line: the one sentence a person is waiting on while there is one, else what the last
 * bring back answered, else the branch the agent is working on, else nothing. The sentence leads because it is the
 * one thing on the row a person can act on and the branch is there either way: a copy always carries one, so a
 * branch that led would hide every prompt and every note on this computer's rows. No figure ever stands here: what
 * a machine costs is a fact about the computer it runs on, and it lives on that computer's row in Settings. */
export function workspaceMetaLine({ project, absent, outOfMemory, broughtBack }: WorkspaceMetaInput): string {
  const waiting = metaSentences({ project, absent, outOfMemory })[0];
  if (waiting !== undefined) return waiting;
  return broughtBack === undefined ? branchLine(project) : broughtBackRowLine(broughtBack);
}

/** The whole of that line for the row's hover text: after a bring back that opened no pull request, the host's
 * own sentence for why follows it. That sentence names a command line and a remote and fits no row, and the line
 * without it would read as a push that simply stopped. */
export function workspaceMetaTitle(input: WorkspaceMetaInput): string {
  const line = workspaceMetaLine(input);
  const note = input.broughtBack?.note;
  return note === undefined || line !== broughtBackRowLine(input.broughtBack!) ? line : `${line}: ${note}`;
}

/** The lead of the prompt a thread of this workspace is stopped on, the one sentence a person is waiting on: the
 * oldest waiting thread's, so a second prompt never takes the line from the one that has waited longest. The row
 * cuts it at its own cap and the whole sentence rides the row's title, as every line three does. */
export function askingNote(project: Pick<SidebarProjectSnapshot, "threads">): string | undefined {
  return project.threads.find(thread => thread.asking !== null)?.asking ?? undefined;
}

/** What the runtime is doing to this machine's daemon, or why its last attempt failed; the status leads where one
 * has arrived, and nothing is being done when it is absent. */
export function daemonNote(project: Pick<SidebarProjectSnapshot, "status" | "workspace">): string | undefined {
  return project.status !== null ? project.status.daemonNote : project.workspace.daemonNote;
}

/** Whether a word can ever stand in this row's state slot: a machine wsp drives has a state of its own to name,
 * since wsp pauses and wakes it, and one wsp does not drive has none. The one exception is the computer under it
 * not answering, which is a state of that computer rather than of wsp's handling of it: a slot that stayed blank
 * there was the row that read nothing beside readings of unreachable. The row reads this to know how wide to keep
 * the slot, and the word below reads it to know whether to write one, so a row cannot keep room for a word that
 * never comes or cut a name short of one that does. */
export function holdsStateWord(project: Pick<SidebarProjectSnapshot, "workspace">, absent?: AbsentComputer | null): boolean {
  return absent != null || kindWords(workspaceKind(project.workspace)).driven;
}

/** The word in the row's state slot: nothing while running, since the dot says it; the state's word otherwise, and
 * nothing at all in a slot no word can stand in. */
export function stateSlotWord(project: Pick<SidebarProjectSnapshot, "state" | "indicator" | "workspace">, absent?: AbsentComputer | null): string {
  if (!holdsStateWord(project, absent)) return "";
  if (absent != null) return absent.word;
  return project.state === "running" ? "" : project.indicator.label;
}

/** The computer or the provider a workspace runs on, as a row names it: the live record once a status has arrived,
 * read through the protocol's one reading of that question, so this row, the command line's table and the pane
 * cannot name one machine three ways. */
export function whereWord(project: Pick<SidebarProjectSnapshot, "status" | "workspace">): string {
  return whereOf({ ...(project.status ?? project.workspace), kind: workspaceKind(project.workspace) });
}

/** The fuller reading of the same question, for the pane that has a whole row for it: the computer or provider the
 * workspace stands on by the name its own row carries, and what that row is. The computer the host runs on says so
 * in the words a sentence says it in, and nothing more, being the one row a person needs no word for. A workspace this host holds no row for falls back
 * to the row's own short word, which is what a browser tab on a host without places has.
 *
 * Built on placeOf and placeName, the readings the places list already holds, so the pane and the table name a
 * computer alike. */
export function whereRuns(places: readonly PlaceView[], project: Pick<SidebarProjectSnapshot, "status" | "workspace">): string {
  const at = placeOf(places, project.workspace);
  if (at === undefined) return whereWord(project);
  const name = nameOfPlace(places, at);
  return at === places[0] ? name : `${name} (${PLACE_KIND_WORDS[at.kind]})`;
}

/** What one row of the places list is called inside a sentence: the computer the host runs on says so in the words
 * a sentence says it in, and every other row carries the name it reported. */
const nameOfPlace = (places: readonly PlaceView[], at: PlaceView): string => (at === places[0] ? THIS_COMPUTER_WORD : placeName(at));

/** The same name with nothing after it, for a sentence that has to call the computer something and has no room to
 * say what kind of row it is: a person waiting on a machine is waiting on the name their own list shows, never on
 * a machine id or on the kind's word. */
export function computerName(places: readonly PlaceView[], project: Pick<SidebarProjectSnapshot, "status" | "workspace">): string {
  const at = placeOf(places, project.workspace);
  return at === undefined ? whereWord(project) : nameOfPlace(places, at);
}

/** The same word for a surface that holds the workspace's id and no snapshot: the record and its status off the
 * store, and the id itself until the record has arrived, which is what a window opened straight onto a workspace
 * has for the first frames. Written once because two surfaces ask it, and a second copy of the fallback would be a
 * second answer to give a person. */
export function useWhereWord(workspaceId: string): string {
  const workspace = useWorkspace(workspaceId);
  const status = useStatus(workspaceId);
  return workspace === null ? workspaceId : whereWord({ workspace, status });
}

/** The computer's name off the store for the same kind of surface, so the sentence a composer holds names the
 * machine the row beside it names. */
export function useComputerName(workspaceId: string): string {
  const places = usePlaces();
  const workspace = useWorkspace(workspaceId);
  const status = useStatus(workspaceId);
  return workspace === null ? workspaceId : computerName(places, { workspace, status });
}

/** The words a thread row's meta line carries after the agent's mark, in the order it draws them. A thread a
 * person or the command line opened names the project its folder sits in and who opened it. A thread another
 * thread's agent opened names neither: the indent already says an agent opened it, and that slot holds the
 * workspace it runs in, dropped where that is the workspace whose rows it is drawn under, then where that
 * workspace runs. The workspace and the project never share a position, so one word never means two things. */
export function threadMetaWords(
  thread: Pick<SidebarThreadSnapshot, "parentThreadId" | "project" | "startedBy">,
  runs: { readonly workspace: string; readonly where: string },
  under: string,
): string[] {
  if (thread.parentThreadId === null) {
    return [...(thread.project !== null ? [thread.project] : []), openerWord(thread.startedBy)];
  }
  return [...(runs.workspace === under ? [] : [runs.workspace]), runs.where];
}

const OPENER_WORD: Record<SessionOrigin, string> = { person: "you", cli: "cli", agent: "agent" };

/** Who opened the thread: you, the command line on this computer, or a local agent. */
export function openerWord(startedBy: SessionOrigin): string {
  return OPENER_WORD[startedBy];
}

/** The agent inside the thread and the words beside its mark, as the row's hover text reads them and in the order
 * the row draws them, so what a screen reader is given is the line a person sees. */
export function provenanceLabel(thread: Pick<SidebarThreadSnapshot, "harness">, words: ReadonlyArray<string>): string {
  return [agentName(thread.harness), ...words].join(", ");
}

/** The word a thread row's state slot carries, off the adapter's own reading: a thread waiting on the person, one
 * that is working and one that did not settle each say so, and the resting states say nothing, since a row nobody
 * is waiting on is what every other row is. No dot for any state: a state is a word here, and the row beside it
 * says the rest. */
export function threadStateWord(thread: Pick<SidebarThreadSnapshot, "status" | "indicator" | "asking">): string | null {
  if (!thread.indicator) return null;
  if (thread.asking !== null) return thread.indicator.label;
  switch (thread.status) {
    case "running":
    case "failed":
      return thread.indicator.label;
    case "completed":
    case "interrupted":
      return null;
    default: {
      const _exhaustive: never = thread.status;
      return null;
    }
  }
}

/** The computer a project lives on, as the switcher and a project row name it: nothing for a project on the
 * computer this window runs on, which every row would otherwise carry, and the name this host has for the computer
 * otherwise, through the protocol's one rule for the question. */
export function projectComputerWord(project: Pick<ProjectRef, "computer">, named: ReadonlyMap<string, string>): string | null {
  if (project.computer === undefined || project.computer === HERE_PLACE_ID) return null;
  return computerNamed(project.computer, named, APP_PLATFORM);
}

/** Every computer this host holds by the name a person reads it as, keyed by its id, which is what a project record
 * names its computer by. */
export function placeNames(places: readonly PlaceView[]): ReadonlyMap<string, string> {
  return new Map(places.map(place => [place.id, placeName(place)]));
}

export function dotClassForTone(tone: StatusIndicatorTone): string {
  switch (tone) {
    case "running":
      return "bg-success-foreground";
    case "paused":
      return "border border-muted-foreground/60 bg-transparent";
    case "neutral":
      return "bg-muted-foreground/60";
    default: {
      const _exhaustive: never = tone;
      return "";
    }
  }
}

/** t3code's row label: "just now" reads "now", "3m ago" reads "3m". */
export function compactTimeLabel(iso: string | null): string {
  if (iso === null) return "";
  const label = formatRelativeTimeLabel(iso);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

