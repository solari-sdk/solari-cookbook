// SPDX-License-Identifier: AGPL-3.0-only
// The composer under the chat thread: the transplanted prompt editor, slash
// menu, send and stop buttons over one draft per workspace. Enter starts one
// turn through sessions.start, resumed with the workspace's Claude session
// unless a new thread was requested; a thread with no session to resume, its
// launch having failed, is named instead, and the runtime runs the message as
// its first turn. A failed send puts the draft back. Stop
// sends one sessions.interrupt for the turn on screen and waits, disabled,
// for the turn's end; the runtime pushes the interrupted done before it
// answers, and the composer opens when the process exits. not-running means
// the turn beat the click and is no error; not-found and a refused request
// show in the line above the box. The editor is disabled with the reason
// while the runtime is not live or the agents here have not answered yet, and
// one reading of that reason serves the slot above the box, the send button's
// name and tooltip and the Enter path alike: the block heads the slot as one
// muted mono sentence, the button is held at the weight every held primary
// wears, and an Enter leaves the draft where it was typed with that line still
// standing, so Enter never fails silently. A workspace whose machine is not
// answering keeps its editor open and holds the send alone, so the wait can be
// spent writing the message that goes when the machine answers. A running turn
// blocks nothing: Enter then queues the message under the thread's key in the
// draft store, the rows stack above the box, and when the turn ends the head
// row starts the next turn; a fresh thread's rows wait under the workspace id
// until its own first start names it, then move under that id, whichever
// thread is on screen when that start lands. Every send holds the thread's
// rows until its start lands, so a start the runtime refuses or a harness
// that dies before init drains nothing behind it. Rows read back from storage
// are held too. Held rows go only after the person's next Enter or send-now
// here, never on their own, and a row typed during a turn goes ahead of the
// held ones it releases. Send-now on a row puts it at the head; when the
// harness's catalog says it steers, the row goes into the running turn
// through sessions.steer and leaves the queue once the runtime took it (the
// thread shows it from the session.steer event), while not-running leaves it
// at the head for the turn's end. A harness that does not steer gets the turn
// stopped first, with the one-line notice. A new thread owes nothing to the
// turn it left behind: the runtime runs a workspace's threads side by side
// and holds each to one turn, so the fresh composer opens at once. The slash
// menu offers what the session's harness announced less the commands the
// runtime catalog says run only in the CLI's own terminal; with nothing left
// to offer it does not open at all and the placeholder drops its half about
// commands, since a menu that answers a typed slash with an empty state
// promises what it cannot keep. What it offers is grouped by the source the
// announcement named, in the order it named them. Enter on a screen command
// sends nothing: the line names the wsp control that serves it and goes with
// the next edit, and a block on the send outranks it. A draft that is a slash
// alone, or a slash and a name nothing announced, is held the way every other
// held send is held, in the same slot and on the same button, with the box
// still open since the next keystroke is what lifts it: sent, it would reach
// the agent as a command it does not have, and come back as a question about
// a stray slash with a turn's price on it. A slash command nobody announced
// with words after it still goes as text, since the words may be meant.
// The checkout row under the composer picks the folder a fresh thread starts
// in; a resumed one is started where its harness last said it was. The
// model, effort, context window and access picks in the box's footer ride a
// start that opens a thread; a send into a thread that has run carries the
// model, its window and the effort, so a change mid-thread applies at the
// next turn, and never the agent or the access, which are that thread's own
// off its rows.
import { cn } from "../../lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ClipboardEvent } from "react";
import { PaperclipIcon } from "lucide-react";
import { composerHeldLine, foldThreads, HOST_ASLEEP_SEND, IMAGES_AFTER_TURN, IMAGES_MAX, IMAGE_ACCEPT, IMAGE_MAX_WORDS, IMAGE_TYPE_WORDS, TURN_IN_FLIGHT, movesRunningAccess, noImagesLine, readsImages, screenCommandLine, screenCommandTyped, screenCommandsOf, sendNowFailedLine, sendRefusal, stillWorkingLine, stopFailedLine, type SendRefusalKind, type WorkspaceState } from "@wsp/protocol";
import type { ConnStatus } from "../../protocol/client";
import { hostAsleep } from "../../boot";
import { projectHomeKey, useAbsentComputer, useHarnessCatalogs, useStore, useWorkspace, useWorkspaceState } from "../../protocol/store";
import { useComputerName } from "../../sidebar/workspaceRows";
import { onComposerFocusRequest } from "../../shell/shellRequests";
import { useThreadStart } from "../../files/root";
import { useLinkDownLine } from "../../terminal/paneWords";
import { composerSubmissionIntentForEnter, detectComposerTrigger, replaceTextRange } from "../../composer-logic";
import { ComposerPromptEditor, type ComposerCommandKey, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { catalogFromHarness, composerPlaceholder, offersSlashCommands, slashHoldLine } from "./adapt";
import { canPickFolder, ComposerCheckoutRow, HomeCheckoutRow } from "./ComposerCheckoutRow";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { composerCommandGroups, type ComposerCommandGroup } from "./composerCommandGroups";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
import { ChatImageThumb } from "./ChatImages";
import { attachmentOf, recordOf, useComposerImages, useComposerImagesStore } from "./composerImages";
import { EMPTY_DRAFT, newId, useComposerDraft, useComposerDraftStore, useComposerQueue, useComposerQueueHeld } from "./composerDraftStore";
import { ComposerAccessPicker, ComposerOptionPickers, useAccessPick, useComposerPicks, type AccessTarget } from "./ComposerOptionPickers";
import type { ComposerStart } from "./composerPicks";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerQueue } from "./ComposerQueue";
import { slashCommandItemsForPromptPosition } from "./composerSlashCommandSearch";
import { ComposerSurface } from "./ComposerSurface";
import { useAnimatedHeight, useFlip, useTallDraft } from "./composerMotion";
import { Button } from "../ui/button";
import type { ChatThreadHandle } from "./useChatThread";

const noop = () => {};

/** What blocks a send right now, or null; the refusal table gives its words. The socket comes first: with it down
 * every other reading is stale, and a state the app has no workspace for at all is one it cannot name. A paused machine
 * is named too, and the composer reads it not as a block but as the wake the send makes first. The agent catalog is
 * last and blocks as well: the model, effort, context window and access a start rides are resolved out of it, so a
 * turn started before it lands carries none of them. */
export function composerSendBlock(input: {
  conn: ConnStatus;
  hasApi: boolean;
  state: WorkspaceState | null;
  hydrated: boolean;
  agents: boolean;
  /** This workspace's computer is not answering, which is its state whatever a status that predates the silence
   * still says: the send is held on it in the same slot every other state is held in. */
  absent?: boolean;
  /** What is not answering is a daemon this host started, not the computer under it: the turn runs in this host's
   * own process, on this computer, and never went through that daemon, so neither the silence nor the state word
   * it folds into holds the box. The panes that do need the daemon say so where they are. */
  daemonOnly?: boolean;
}): SendRefusalKind | null {
  if (!input.hasApi || input.conn === "connecting") return "connecting";
  if (input.conn === "reconnecting") return "reconnecting";
  if (input.conn === "closed") return "closed";
  if (input.state === null) return "not-found";
  if (input.daemonOnly === true) return !input.hydrated ? "loading" : input.agents ? null : "no-agents";
  if (input.absent === true) return "unreachable";
  if (input.state !== "running") return input.state;
  if (!input.hydrated) return "loading";
  if (!input.agents) return "no-agents";
  return null;
}

/** What a send carries beyond its words and its images: the composer's picks where it opens a thread, and into a
 * thread that has already run the model and the effort alone, the window riding inside the model as it always
 * does. Changing the model in the middle of a thread is ordinary and the agent's own command line takes both per
 * turn. The agent and the access are not picks a message makes: the thread runs on the agent its rows carry, the
 * runtime refuses a send naming another, and sessions.access is the one road that changes what a thread may
 * touch. Pinned is the same reading the rail is pinned by, and the runtime reads a thread as existing by the same
 * rows. */
export function sendPicks(pinned: boolean, picks: ComposerStart): ComposerStart {
  if (!pinned) return picks;
  const kept: ComposerStart = { ...picks };
  delete kept.harness;
  delete kept.permissionMode;
  return kept;
}

/** What one stop click left behind for the turn it targeted; the turn id keeps it from leaking onto the next turn. */
interface StopAttempt {
  readonly turnId: string;
  readonly pending: boolean;
  readonly error: string | null;
}

/** What the last send-now into a running turn left behind: the row while it is in flight, the runtime's refusal after. */
interface SteerAttempt {
  readonly turnId: string;
  readonly rowId: string | null;
  readonly error: string | null;
}

/** `onStart` takes the first send instead of the runtime: a project's home has no workspace yet, and its send is what
 * makes one. */
export function ChatComposer({ workspaceId, thread, onStart }: { workspaceId: string; thread: ChatThreadHandle; onStart?: (prompt: string) => void }) {
  const api = useStore(s => s.api);
  const wake = useStore(s => s.wake);
  const conn = useStore(s => s.conn);
  const sessions = useStore(s => s.sessions[workspaceId]);
  const state = useWorkspaceState(workspaceId);
  const workspace = useWorkspace(workspaceId);
  const [stop, setStop] = useState<StopAttempt | null>(null);
  const [screenLine, setScreenLine] = useState<string | null>(null);
  const [steering, setSteering] = useState<string | null>(null);
  const [steered, setSteered] = useState<SteerAttempt | null>(null);
  const draft = useComposerDraft(workspaceId);
  const { threadKey, named } = thread;
  const queue = useComposerQueue(threadKey);
  const held = useComposerQueueHeld(threadKey);
  const nextStart = useThreadStart(workspaceId);
  // A view locked to a turn resumes in that turn's folder, as its row says; only a view about to open a thread reads the pick.
  const viewCwd = thread.view.cwd;
  const pickable = canPickFolder(thread);
  const folderStart = useMemo(() => (pickable ? nextStart : viewCwd !== null ? { cwd: viewCwd } : {}), [nextStart, pickable, viewCwd]);
  // The folder picker under the box is up: opened from its own trigger, from new thread here, or from the project
  // menu's other folder row in the footer; it goes with the pick once the view is locked to a turn.
  const [folderPicker, setFolderPicker] = useState(false);
  const openFolderPicker = useCallback(() => setFolderPicker(true), []);
  const { harness: harnessId, startOptions, pinned, latestRow, catalog: harnessCatalog } = useComposerPicks(workspaceId, thread);
  const launching = useStore(s => s.launching);
  const launched = useStore(s => s.launched);
  const harnessCatalogs = useHarnessCatalogs(workspaceId);
  const setDraft = useComposerDraftStore(s => s.setDraft);
  const enqueue = useComposerDraftStore(s => s.enqueue);
  const editQueued = useComposerDraftStore(s => s.editQueued);
  const removeQueued = useComposerDraftStore(s => s.removeQueued);
  const promoteQueued = useComposerDraftStore(s => s.promoteQueued);
  const hold = useComposerDraftStore(s => s.hold);
  const requeue = useComposerDraftStore(s => s.requeue);
  const release = useComposerDraftStore(s => s.release);
  const rekeyQueue = useComposerDraftStore(s => s.rekeyQueue);
  useEffect(() => {
    if (named === null) return;
    if (named.key !== named.thread) rekeyQueue(named.key, named.thread);
    release(named.thread);
  }, [named, rekeyQueue, release]);
  const images = useComposerImages(workspaceId);
  const addImages = useComposerImagesStore(s => s.add);
  const removeImage = useComposerImagesStore(s => s.remove);
  const sendImagesAs = useComposerImagesStore(s => s.sendAs);
  const restoreImages = useComposerImagesStore(s => s.restore);
  const [imageRefusal, setImageRefusal] = useState<string | null>(null);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [highlightedSearchKey, setHighlightedSearchKey] = useState<string | null>(null);
  const [dismissedSearchKey, setDismissedSearchKey] = useState<string | null>(null);

  const absent = useAbsentComputer(workspaceId);
  const computer = useComputerName(workspaceId);
  const linkDown = useLinkDownLine(workspaceId);
  const { harness } = thread.view;
  const catalog = useMemo(() => catalogFromHarness({ id: harnessId, harness, screen: screenCommandsOf(harnessCatalog) }), [harness, harnessCatalog, harnessId]);
  // A daemon this host started is not the road a turn takes, so its absence leaves the box open on this computer.
  const daemonOnly = absent?.start !== undefined;
  const blocked = composerSendBlock({ conn, hasApi: api !== null, state, hydrated: thread.hydrated, agents: harnessCatalogs.length > 0, absent: absent !== null, daemonOnly });
  // A send wakes a paused machine by itself, so paused is not a refusal here: the box takes the words and the send
  // button says it wakes first.
  const wakesFirst = blocked === "paused";
  // A machine that is not answering is the one block a person can write through. The turn cannot go now, but what
  // they write while they wait is what goes the moment it answers, so the box takes it and the send alone is held,
  // named after the computer rather than after the wire's state word, since switching that computer on is the move.
  // Nothing leaves on its own when it comes back: the draft sits in the editor, which no effect here reads, and the
  // person's own send starts the turn. Every other block leaves the box shut, its sentence being about this app
  // rather than about a machine to wait for; a window on another computer whose wsp has gone quiet says which
  // computer is asleep rather than that wsp is not running, nothing there being broken.
  const heldForAnswer = blocked === "unreachable";
  // A home's composer has no workspace to be blocked by: its send is what makes one.
  const unavailable =
    onStart !== undefined || blocked === null || wakesFirst
      ? null
      : heldForAnswer
        ? composerHeldLine(computer)
        : hostAsleep(conn)
          ? HOST_ASLEEP_SEND
          : sendRefusal(blocked);
  const shut = unavailable !== null && !heldForAnswer;
  // Everything that holds this send, in one reading: what blocks every send in this workspace, then what this draft
  // alone cannot be sent as. The slot, the send button and the Enter path all take it from here, so a person is told
  // once and told the same thing wherever they look.
  const sendHeld = unavailable ?? slashHoldLine({ prompt: draft.prompt, catalog, screen: screenCommandsOf(harnessCatalog) });
  const sendDisabledReason = sendHeld ?? (thread.busy ? TURN_IN_FLIGHT : null);
  const hasText = draft.prompt.trim().length > 0;
  // The catalog answers before the click; a row the runtime's table stood in for is no answer, so the picker is
  // offered and the runtime refuses in the agent's name if that binary turns out to read none.
  const canAttach = readsImages(harnessCatalog);

  const runningTurn = thread.view.running ? thread.view.latestTurn : null;
  // What the still-working line calls the thread: its own title, never the key wsp holds it under.
  const workingTitle = useMemo(() => foldThreads(sessions ?? []).find(row => row.id === threadKey)?.title, [sessions, threadKey]);
  // The runtime keys sessions.interrupt by its own session id; the events carry the harness id, which differs after a
  // resume, so the row from sessions.list maps one to the other. Without a row the events' id goes, and the runtime answers.
  const stopTarget = useMemo(() => {
    if (runningTurn === null) return null;
    const row = sessions?.find(r => r.claudeSessionId === runningTurn.sessionId || r.id === runningTurn.sessionId);
    return row?.id ?? runningTurn.sessionId;
  }, [runningTurn, sessions]);
  // The same row sessions.interrupt is keyed by: a pick made while this turn runs goes to the runtime by that id.
  // Between turns, a thread that has run is named by its latest row, the one the pickers stand on, so the pick still
  // goes through the access verb and the thread's next turn runs at it; a thread that has not run names nothing,
  // its pick opens it.
  const pickTarget = useMemo<AccessTarget | null>(() => {
    if (stopTarget !== null && runningTurn !== null) return { sessionId: stopTarget, turnId: runningTurn.turnId };
    return latestRow !== null ? { sessionId: latestRow.id, turnId: null } : null;
  }, [latestRow, runningTurn, stopTarget]);
  // The harness's own row decides whether the pick moves the running turn, and it is the same row the menu reads
  // to say so before the pick.
  const accessPick = useAccessPick(workspaceId, pickTarget, thread.threadKey, movesRunningAccess(harnessCatalog));
  const stopAttempt = stop !== null && runningTurn !== null && stop.turnId === runningTurn.turnId ? stop : null;
  const steerAttempt = steered !== null && runningTurn !== null && steered.turnId === runningTurn.turnId ? steered : null;
  const canStop = runningTurn !== null && api?.interruptSession !== undefined;
  // The catalog answers before the click: a harness that steers takes the row into the turn, any other gets the turn stopped.
  const canSteer = canStop && harnessCatalog?.steers === true && api?.steerSession !== undefined;
  // One line in the slot above the box, and what blocks a send heads it: every other line here is about a send this
  // composer could make, so while it can make none the block is the one true thing to say and the slot, the button's
  // name and an Enter all read it. Under it: the newest failure, then the screen command Enter refused, then the turn
  // that replied but still runs, in the runtime's own words, since a message sent now waits for that process and runs
  // as the next turn, then an access pick the running turn refused after its harness said it takes one, then the workspace's
  // link being down, which blocks no send and so comes after everything a person is being stopped by.
  const line =
    sendHeld !== null
      ? sendHeld
      : imageRefusal !== null
        ? imageRefusal
        : stopAttempt !== null && stopAttempt.error !== null
          ? stopFailedLine(stopAttempt.error)
          : steerAttempt !== null && steerAttempt.error !== null
            ? sendNowFailedLine(steerAttempt.error)
            : screenLine !== null
              ? screenLine
              : runningTurn?.replied === true
                ? stillWorkingLine(workingTitle)
                : (accessPick.line ?? linkDown);

  const trigger = useMemo(() => detectComposerTrigger(draft.prompt, draft.cursor), [draft]);
  const searchKey = trigger ? `${trigger.kind}:${trigger.query.trim().toLowerCase()}` : null;
  const menuTriggered = offersSlashCommands(catalog) && trigger !== null && trigger.rangeStart === 0 && dismissedSearchKey !== searchKey && unavailable === null;
  const groups = useMemo<ComposerCommandGroup[]>(() => {
    if (!menuTriggered || trigger === null) return [];
    const all = catalog.slashCommands.map(command => ({
      id: `provider-slash-command:${catalog.harness}:${command.name}`,
      type: "provider-slash-command" as const,
      harness: catalog.harness,
      command,
      label: `/${command.name}`,
      description: command.description ?? command.input?.hint ?? "",
    }));
    return composerCommandGroups(slashCommandItemsForPromptPosition(all, trigger.rangeStart === 0), trigger.query);
  }, [catalog, menuTriggered, trigger]);
  // The keyboard walks the menu as it is drawn, so the groups decide the order the arrows take and not the other way round.
  const items = useMemo<ComposerCommandItem[]>(() => groups.flatMap(group => group.items), [groups]);
  // A slash that matched nothing draws no menu: the slot above the box already holds the one line that says so, and
  // an empty drawer under it would say it a second time in other words.
  const menuOpen = groups.length > 0;
  const activeItemId = resolveComposerMenuActiveItemId({ items, highlightedItemId, currentSearchKey: searchKey, highlightedSearchKey });

  useEffect(() => {
    if (thread.fresh) editorRef.current?.focus();
  }, [thread.fresh]);

  useEffect(() => onComposerFocusRequest(workspaceId, () => editorRef.current?.focus()), [workspaceId]);

  const onChange = useCallback(
    (value: string, cursor: number) => {
      setScreenLine(null);
      setDraft(workspaceId, { prompt: value, cursor });
    },
    [setDraft, workspaceId],
  );

  /** The one road every image takes into the composer: the paste, the drop and the picker all end here, so the caps
   * and the refusal words are said once. An agent that reads no image is turned away before a file is even read. */
  const take = useCallback(
    (files: readonly File[]) => {
      // Paste and drop answer to the same state the picker button does: one door open and two shut would take an
      // image the send could not carry.
      if (files.length === 0 || shut) return;
      if (!canAttach) {
        setImageRefusal(noImagesLine(harnessId));
        return;
      }
      void addImages(workspaceId, files).then(setImageRefusal);
    },
    [addImages, canAttach, harnessId, shut, workspaceId],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      take(files);
    },
    [take],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      take(files);
    },
    [take],
  );

  const highlight = useCallback(
    (itemId: string | null) => {
      setHighlightedItemId(itemId);
      setHighlightedSearchKey(searchKey);
    },
    [searchKey],
  );

  const { setSending, appendUserTurn, appendLocalError, resume, thread: into, busy, sending } = thread;
  const start = useCallback(
    (prompt: string, onRefused: () => void) => {
      if (!api) return;
      const requestId = newId();
      const attachments = images.map(attachmentOf);
      setSending(true);
      hold(threadKey);
      appendUserTurn(prompt, requestId, images.map(recordOf));
      // A send that names neither a thread nor a session to resume opens one the runtime has written no row for, so
      // the sidebar is handed the same thread the transcript has until that row arrives.
      if (into === undefined && resume === undefined) launching(workspaceId, { requestId, title: prompt, harness: harnessId });
      // The images leave the composer with the send and are kept under its request id, which is what the person's
      // row in the transcript is drawn from; a refused send hands them back rather than losing them.
      sendImagesAs(workspaceId, requestId);
      setImageRefusal(null);
      // The wake settles or fails before the start is asked; a wake that failed leaves the runtime to refuse the
      // start in its own words, which land in the transcript like any other refusal.
      void (wakesFirst ? wake(workspaceId) : Promise.resolve())
        .then(() =>
          api.startSession({
            workspaceId,
            prompt,
            requestId,
            ...(resume ? { resume } : {}),
            ...(into !== undefined ? { thread: into } : {}),
            ...folderStart,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...sendPicks(pinned, startOptions),
          }),
        )
        .catch((err: unknown) => {
          setSending(false);
          launched(workspaceId, requestId);
          onRefused();
          restoreImages(workspaceId, requestId);
          appendLocalError(err instanceof Error ? err.message : String(err));
        });
    },
    [api, appendLocalError, appendUserTurn, folderStart, harnessId, hold, images, into, launched, launching, pinned, restoreImages, resume, sendImagesAs, setSending, startOptions, threadKey, wake, wakesFirst, workspaceId],
  );

  const send = useCallback(() => {
    // The same reading the slot and the send button are already wearing: an Enter that lands here leaves the draft
    // where it was typed and that line standing.
    if (sendHeld !== null) return;
    const snapshot = editorRef.current?.readSnapshot() ?? { value: draft.prompt, cursor: draft.cursor };
    const prompt = snapshot.value.trim();
    if (prompt === "") return;
    // A command the CLI runs only in its own terminal would come back as not available, so the draft stays for
    // editing and the line names the wsp control that serves it instead.
    const screen = screenCommandTyped(harnessCatalog, prompt);
    if (screen !== null && harnessCatalog !== null) {
      setScreenLine(screenCommandLine(screen, harnessCatalog, workspace ?? {}));
      setImageRefusal(null);
      setDismissedSearchKey(searchKey);
      return;
    }
    // A queued row keeps only its words, so a message with images waits for the turn rather than losing them.
    if (busy && images.length > 0) {
      setImageRefusal(IMAGES_AFTER_TURN);
      return;
    }
    setDraft(workspaceId, EMPTY_DRAFT);
    if (onStart !== undefined) {
      onStart(prompt);
      return;
    }
    if (!busy) {
      start(prompt, () => {
        const current = useComposerDraftStore.getState().drafts[workspaceId];
        if (current === undefined || current.prompt === "") setDraft(workspaceId, { prompt, cursor: prompt.length });
      });
      return;
    }
    // Behind a pending send the row waits with the rest, held since that send began; its start releases them.
    if (sending) {
      enqueue(threadKey, prompt);
      return;
    }
    enqueue(threadKey, prompt, held ? "head" : "tail");
    release(threadKey);
  }, [busy, draft, enqueue, harnessCatalog, held, images, onStart, release, searchKey, sendHeld, sending, setDraft, start, threadKey, workspace, workspaceId]);

  // The head row goes as soon as nothing blocks a send; starting flips busy, so the rest wait for the next end.
  const head = queue[0];
  useEffect(() => {
    if (head === undefined || held || unavailable !== null || busy) return;
    removeQueued(threadKey, head.id);
    const prompt = head.prompt.trim();
    if (prompt !== "") start(prompt, () => requeue(threadKey, head));
  }, [busy, head, held, removeQueued, requeue, start, threadKey, unavailable]);

  const interrupt = useCallback(() => {
    const method = api?.interruptSession;
    if (!method || runningTurn === null || stopTarget === null || stopAttempt?.pending) return;
    const { turnId } = runningTurn;
    setStop({ turnId, pending: true, error: null });
    void method(stopTarget).then(
      outcome => setStop({ turnId, pending: false, error: outcome === "not-found" ? "the runtime does not know this session" : null }),
      (err: unknown) => setStop({ turnId, pending: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }, [api, runningTurn, stopAttempt?.pending, stopTarget]);

  const steer = useCallback(
    (id: string) => {
      release(threadKey);
      promoteQueued(threadKey, id);
      if (!canStop) return;
      if (!canSteer) {
        setSteering(id);
        interrupt();
        return;
      }
      const method = api?.steerSession;
      const row = queue.find(r => r.id === id);
      if (method === undefined || runningTurn === null || stopTarget === null || row === undefined || steerAttempt?.rowId != null) return;
      const { turnId } = runningTurn;
      setSteering(id);
      setSteered({ turnId, rowId: id, error: null });
      void method(stopTarget, row.prompt.trim(), newId()).then(
        outcome => {
          setSteering(null);
          if (outcome === "accepted") removeQueued(threadKey, id);
          // not-running: the turn beat the message, so the row stays at the head and the head effect starts it once the turn ends.
          const error = outcome === "not-found" ? "the runtime does not know this session" : outcome === "unsupported" ? "this harness takes no message mid-turn" : null;
          setSteered(error === null ? null : { turnId, rowId: null, error });
        },
        (err: unknown) => {
          setSteering(null);
          setSteered({ turnId, rowId: null, error: err instanceof Error ? err.message : String(err) });
        },
      );
    },
    [api, canSteer, canStop, interrupt, promoteQueued, queue, release, removeQueued, runningTurn, steerAttempt, stopTarget, threadKey],
  );

  const selectItem = useCallback(
    (item: ComposerCommandItem) => {
      const snapshot = editorRef.current?.readSnapshot() ?? { value: draft.prompt, cursor: draft.cursor };
      const active = detectComposerTrigger(snapshot.value, snapshot.cursor);
      if (active === null) return;
      const replacement = `/${item.command.name} `;
      const rangeEnd = snapshot.value[active.rangeEnd] === " " ? active.rangeEnd + 1 : active.rangeEnd;
      const next = replaceTextRange(snapshot.value, active.rangeStart, rangeEnd, replacement);
      setDraft(workspaceId, { prompt: next.text, cursor: next.cursor });
      setHighlightedItemId(null);
      window.requestAnimationFrame(() => editorRef.current?.focusAt(next.cursor));
    },
    [draft, setDraft, workspaceId],
  );

  const onCommandKeyDown = useCallback(
    (key: ComposerCommandKey, event: KeyboardEvent): boolean => {
      if (key === "Escape") {
        if (menuOpen) {
          setDismissedSearchKey(searchKey);
          return true;
        }
        return false;
      }
      if (menuOpen && items.length > 0) {
        if (key === "ArrowDown" || key === "ArrowUp") {
          const index = items.findIndex(item => item.id === activeItemId);
          const offset = key === "ArrowDown" ? 1 : -1;
          const next = items[(index + offset + items.length) % items.length];
          highlight(next?.id ?? null);
          return true;
        }
        if (key === "Enter" || key === "Tab") {
          const item = items.find(candidate => candidate.id === activeItemId) ?? items[0];
          if (item) selectItem(item);
          return true;
        }
      }
      if (key === "Enter") {
        const intent = composerSubmissionIntentForEnter({
          isMobileViewport: false,
          shiftKey: event.shiftKey,
          modifierKey: event.metaKey || event.ctrlKey,
          isDraftThread: false,
        });
        if (intent !== null) {
          send();
          return true;
        }
      }
      return false;
    },
    [activeItemId, highlight, items, menuOpen, searchKey, selectItem, send],
  );

  // A home's thread carries a history-unavailable row and no message, so the count is of messages alone.
  const compact = thread.view.running || thread.view.entries.some(entry => entry.kind === "message");
  const home = useStore(s => s.projects.find(p => projectHomeKey(p.id) === workspaceId));
  const heightRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const tall = useTallDraft(mirrorRef, draft.prompt, compact);
  useAnimatedHeight(heightRef, surfaceRef);
  useFlip(surfaceRef, compact ? (tall ? "tall" : "line") : "full");
  const commandMenu = menuOpen ? (
    <ComposerCommandMenuLayer anchor={menuAnchor}>
      <ComposerCommandMenu groups={groups} triggerKind={trigger?.kind ?? null} activeItemId={activeItemId} onHighlightedItemChange={highlight} onSelect={selectItem} />
    </ComposerCommandMenuLayer>
  ) : null;
  const actions = (
    <div data-flip="actions" className="flex shrink-0 flex-nowrap items-center gap-2">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost-muted"
        aria-label="Attach"
        title={`Add an image: paste, drop or pick one. ${IMAGE_TYPE_WORDS}, at most ${IMAGES_MAX} and ${IMAGE_MAX_WORDS} each.`}
        disabled={shut}
        onClick={() => pickerRef.current?.click()}
        data-composer-image-picker="true"
      >
        <PaperclipIcon />
      </Button>
      <input
        ref={pickerRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        aria-hidden="true"
        data-composer-image-input="true"
        onChange={event => {
          take([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <ComposerPrimaryActions
        compact={false}
        pendingAction={null}
        isRunning={canStop}
        isInterruptPending={stopAttempt?.pending ?? false}
        showPlanFollowUpPrompt={false}
        promptHasText={hasText}
        isSendBusy={thread.busy}
        wakesFirst={wakesFirst}
        sendDisabledReason={sendDisabledReason}
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={hasText}
        onPreviousPendingQuestion={noop}
        onInterrupt={interrupt}
        onImplementPlanInNewThread={noop}
      />
    </div>
  );

  return (
    <div className="w-full px-3 pt-1.5 pb-4 sm:px-5 sm:pt-2 sm:pb-5" data-chat-composer>
      {/* The refusal takes room only while it holds a sentence, which wraps to two lines at most: at the smallest
          window with the right panel open a cut would drop the half that says what happens next. */}
      <div className={cn("mx-auto flex w-full max-w-3xl items-center px-3", line !== null && "min-h-9 pb-1")} aria-live="polite" data-composer-refusal>
        {line !== null ? (
          <span role="status" className="min-w-0 text-pretty font-mono text-[11px] leading-[18px] text-muted-foreground line-clamp-2" title={line}>
            {line}
          </span>
        ) : null}
      </div>
      <ComposerQueue
        rows={queue}
        steering={stopAttempt?.error ? null : steering}
        steer={unavailable !== null ? null : canSteer ? "now" : canStop ? "stop" : busy ? null : "now"}
        onEdit={(id, prompt) => editQueued(threadKey, id, prompt)}
        onRemove={id => removeQueued(threadKey, id)}
        onSteer={steer}
      />
      <ComposerSurface.Shell contextStrip>
        <ComposerSurface.Host>
          <form
            className="mx-auto w-full min-w-0 max-w-3xl"
            data-chat-composer-form="true"
            onSubmit={event => {
              event.preventDefault();
              send();
            }}
          >
            <div className="relative">
              <ComposerSurface.Main>
                <div
                  ref={heightRef}
                  className="overflow-hidden rounded-[20px] data-armed:transition-[height] data-armed:duration-180 data-armed:ease-out motion-reduce:transition-none!"
                >
                  <div
                    ref={surfaceRef}
                    data-chat-composer-surface="true"
                    data-compact={compact || undefined}
                    data-tall={tall || undefined}
                    className="rounded-[20px] transition-[background-color] duration-200"
                    onPaste={onPaste}
                    onDrop={onDrop}
                    onDragOver={event => event.preventDefault()}
                  >
                    {images.length > 0 ? (
                      <ul aria-label="Images to send" data-composer-images="true" className="flex flex-wrap gap-1.5 px-3 pt-3 sm:px-4">
                        {images.map((image, at) => (
                          <li key={image.id}>
                            <ChatImageThumb
                              image={image}
                              at={at + 1}
                              onRemove={() => {
                                removeImage(workspaceId, image.id);
                                setImageRefusal(null);
                              }}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div
                      data-chat-composer-compact={compact || undefined}
                      className={cn(
                        "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center",
                        compact ? "gap-x-1 ps-4 pe-2 sm:ps-5 [&_[data-composer-picker]]:h-7 [&_[data-composer-picker]]:gap-1.5 [&_[data-composer-picker]]:text-[13px]" : "gap-x-2 gap-y-2 px-3 pt-3.5 pb-3 sm:px-4 sm:pt-4 sm:pb-4",
                        compact && (tall ? "gap-y-1 pt-3.5 pb-2" : "py-2"),
                      )}
                    >
                      <div aria-hidden className="relative col-start-1 row-start-1 h-0 self-start">
                        <div
                          ref={mirrorRef}
                          className="invisible absolute inset-x-0 top-0 whitespace-pre-wrap wrap-break-word leading-relaxed [font-family:var(--font-composer,var(--font-sans))] [font-size:var(--font-size-prompt,0.875rem)]"
                        >
                          {compact ? `${draft.prompt}\u200b` : null}
                        </div>
                      </div>
                      <div ref={setMenuAnchor} className={cn("relative col-start-1 row-start-1 min-w-0", (!compact || tall) && "col-end-4", !compact && "pb-1")}>
                        {commandMenu}
                        <ComposerPromptEditor
                          editorRef={editorRef}
                          value={draft.prompt}
                          cursor={draft.cursor}
                          disabled={shut}
                          placeholder={composerPlaceholder(catalog)}
                          onChange={onChange}
                          onCommandKeyDown={onCommandKeyDown}
                          {...(compact ? { className: "min-h-[1lh] max-h-[8lh]" } : {})}
                        />
                      </div>
                      <div
                        data-flip="pickers"
                        data-chat-composer-footer={compact ? undefined : "true"}
                        className={cn(
                          "flex min-w-0 items-center",
                          compact ? "col-start-2" : "-m-1 -ms-3.5 col-start-1 flex-wrap gap-1 p-1 ps-3.5",
                          compact && !tall ? "row-start-1" : "row-start-2",
                        )}
                      >
                        <ComposerOptionPickers compact={compact} workspaceId={workspaceId} thread={thread} onPickAccess={accessPick.pick} onOtherFolder={openFolderPicker} />
                      </div>
                      <div data-chat-composer-actions="right" className={cn("col-start-3 flex shrink-0 items-center justify-self-end", compact && !tall ? "row-start-1" : "row-start-2 self-end")}>
                        {actions}
                      </div>
                    </div>
                  </div>
                </div>
              </ComposerSurface.Main>
            </div>
          </form>
        </ComposerSurface.Host>
        {home !== undefined ? (
          <HomeCheckoutRow path={home.path} branch={home.defaultBranch} />
        ) : (
          <ComposerCheckoutRow
          workspaceId={workspaceId}
          thread={thread}
          pickerOpen={folderPicker && pickable}
          onPickerOpenChange={setFolderPicker}
          access={compact ? <ComposerAccessPicker workspaceId={workspaceId} thread={thread} onPickAccess={accessPick.pick} /> : null}
          />
        )}
      </ComposerSurface.Shell>
    </div>
  );
}
