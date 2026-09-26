// SPDX-License-Identifier: AGPL-3.0-only
// The chat thread for one workspace: the transplanted timeline over the
// adapter's entries, the empty-thread headline before the first turn, and the
// settled footer with the last turn's duration and cost. The composer is a
// render-prop slot filled by whoever mounts the view. A new-thread request
// for this workspace clears the thread, whether it arrived before or after
// the view mounted; a view pinned to an older thread unpins first, since the
// new thread opens as the workspace's latest. A send from a thread that never
// started runs as that thread's first turn, so the pin stays where it is.
// Under the transcript stand the threads this one's agent opened, one row each
// with the workspace it runs on and a link to it, and the footer weighs the
// turn's own cost against what those threads spent.
import { HeroAtmosphere, HeroMark } from "./EmptyHero.js";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownIcon } from "lucide-react";
import type { LegendListRef } from "@legendapp/list/react";
import { isLocalWorkspace, LIST_PRICE_WORD, turnSettledParts } from "@wsp/protocol";
import { useHarnessCatalog, useSidebarProjects, useStatus, useStore, useThreadSessions, useWorkspace, useWorkspaceState } from "../../protocol/store";
import { ThreadLink } from "../ThreadLink.js";
import { useDiffRevealStore } from "../../diffs/reveal";
import { useRightPanelStore } from "../../rightPanelStore";
import { cn } from "../../lib/utils";
import { DEFAULT_TIMESTAMP_FORMAT, pausedLine, turnWait, type TimestampFormat, type TurnSummary } from "./adapt";
import { threadsOpenedBy, type ThreadOnWorkspace } from "../../sidebar/threadTree";
import { useWhereWord, whereWord } from "../../sidebar/workspaceRows";
import { TimelineRuleLine } from "./TimelineRuleLine";
import { MessagesTimeline, type MachineWait } from "./MessagesTimeline";
import { useNewThreadRequests } from "./newThreadRequests";
import { useChatThread, type ChatThreadHandle } from "./useChatThread";
import { DEFAULT_HARNESS } from "./ComposerOptionPickers";
import { TRANSCRIPT_LOADING } from "../../transcript-words";
import { useAppDark } from "../../settings/theme";

const noopImageExpand = () => {};

export function ChatView({
  workspaceId,
  threadId = null,
  timestampFormat = DEFAULT_TIMESTAMP_FORMAT,
  children,
}: {
  workspaceId: string;
  threadId?: string | null;
  timestampFormat?: TimestampFormat;
  children?: ((thread: ChatThreadHandle) => ReactNode) | undefined;
}) {
  const workspace = useWorkspace(workspaceId);
  // The page starts on the dark side (index.html) and the preference flips it after the first paint, so a side read
  // once during a render stays wrong until something else repaints: a fenced block highlighted for the other side
  // draws its line in the ink the box's own background is.
  const appDark = useAppDark();
  const wake = useStore(s => s.wake);
  const newThread = useStore(s => s.newThread);
  const readingThread = useStore(s => s.readingThread);
  const freshThread = useStore(s => s.freshThread && s.selectedId === workspaceId);
  const thread = useChatThread(workspaceId, threadId, freshThread);
  // Every workspace's threads, not this one's: a thread this one's agent opened may run anywhere, and nothing in
  // the transcript itself records that a turn opened one.
  const projects = useSidebarProjects();
  const opened = useMemo(() => threadsOpenedBy(projects, thread.threadKey), [projects, thread.threadKey]);
  const openSurface = useRightPanelStore(s => s.open);
  const revealInDiff = useDiffRevealStore(s => s.request);
  const api = useStore(s => s.api);
  const listRef = useRef<LegendListRef | null>(null);
  const { view } = thread;
  const empty = view.entries.length === 0 && !view.running;
  const cwd = view.cwd ?? undefined;
  // A file named in the transcript is read in the Diff pane, which is the one pane that shows a file now: the
  // reveal waits there until that pane has a diff to look in, and a file the diff does not touch is named in a line.
  const onOpenFile = useCallback(
    (path: string) => {
      revealInDiff(workspaceId, path);
      openSurface(workspaceId, "diff");
    },
    [openSurface, revealInDiff, workspaceId],
  );
  // The prompt row's own options: the answer travels straight to the runtime and the row closes on the event the
  // runtime records, never on the reply here, so two clients watching one prompt end up saying the same thing.
  const onAnswerPermission = useCallback(
    (sessionId: string, askId: string, optionId: string) => {
      void api?.answerPermission?.(sessionId, askId, optionId);
    },
    [api],
  );
  // A Working thread on a workspace that is not running is a contradiction: the row says what it waits for instead,
  // naming the workspace and, while it wakes, where it runs, since that is what the send is waiting on.
  const state = useWorkspaceState(workspaceId);
  const status = useStatus(workspaceId);
  const where = useWhereWord(workspaceId);
  const runs = useMemo(() => ({ name: workspace?.name ?? workspaceId, where }), [workspace, workspaceId, where]);
  const machineWait = useMemo<MachineWait | null>(() => {
    if (state === null || !view.running) return null;
    const wait = turnWait(state, runs);
    if (wait === null) return null;
    return { label: wait.label, elapsed: wait.elapsed, onWake: wait.wake ? () => void wake(workspaceId) : null };
  }, [state, view.running, wake, workspaceId, runs]);
  // Nothing is running and the workspace is paused: the last thing that happened to this thread is the nap, and the
  // next send is what wakes it. One line under the transcript in the timeline's own rule grammar, never a dialog.
  const paused = state === "paused" && !view.running ? pausedLine(status?.reason) : null;
  const { startNewThread, hydrated, threadKey } = thread;
  // What the footer's figure is: on this computer the turn ran on the person's own sign-in, so the number is the
  // agent's own list price and nobody is billed for it. The word goes on the figure from the record alone, which
  // the page has before it draws the footer at all; a word that arrived a moment after the figure would be the
  // change this ticket took off the sidebar's line. The sentence the model menu's foot carries rides the figure's
  // title once the catalog holding the agent's own name is in, since nobody opens that menu before sending.
  const onThisComputer = workspace !== null && isLocalWorkspace(workspace);
  const turnRows = useThreadSessions(workspaceId, threadKey);
  const catalog = useHarnessCatalog(turnRows.at(-1)?.harness ?? DEFAULT_HARNESS, workspaceId);
  const asked = useNewThreadRequests(s => s.pending.has(workspaceId));
  useEffect(() => {
    // The latest view takes the request once its transcript is in, so it knows which thread it leaves behind.
    const consume = () => {
      const requests = useNewThreadRequests.getState();
      if (!requests.pending.has(workspaceId)) return;
      if (threadId !== null) newThread(workspaceId);
      else if (hydrated && requests.take(workspaceId)) startNewThread();
    };
    consume();
    return useNewThreadRequests.subscribe(consume);
  }, [hydrated, newThread, startNewThread, threadId, workspaceId]);
  // With nothing picked, the thread this view settled on is what the person is reading, whether the transcript
  // carried it or its own first turn opened it: the store records it in the address, and the header reads the same
  // pick the body does. The key is the workspace's own until a session.start gives the view a thread, and a view
  // about to clear itself for a new thread still holds the one it is leaving.
  useEffect(() => {
    if (!hydrated || asked || threadId !== null || threadKey === workspaceId) return;
    readingThread(workspaceId, threadKey);
  }, [asked, hydrated, readingThread, threadId, threadKey, workspaceId]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const atEndRef = useRef(true);
  const onIsAtEndChange = useCallback((next: boolean) => {
    atEndRef.current = next;
    setAtEnd(next);
  }, []);
  // The transcript's end spacer reads the composer's height from a variable set here, so a composer that grows by a
  // line moves no React state and the last message stays pinned above it while the reader is at the end.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const composer = composerRef.current;
    if (root === null || composer === null) return;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--chat-composer-inset", `${composer.offsetHeight}px`);
      const scroller = listRef.current?.getScrollableNode();
      if (atEndRef.current && scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  const showTranscript = thread.hydrated && !empty;
  // A turn that completed says so by its reply standing, so its facts join that reply's row; any other ending keeps
  // its own line, since the state word is the news.
  const settledOnReply = view.settled?.state === "completed";
  const replyMeta = settledOnReply ? (
    <SettledFacts parts={turnSettledParts(view.settled!, openedSpend(opened), onThisComputer ? LIST_PRICE_WORD : undefined)} />
  ) : null;
  const footer = thread.hydrated ? (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      {opened.length > 0 ? <OpenedThreadRows opened={opened} /> : null}
      {view.settled !== null && !settledOnReply ? <SettledFooter turn={view.settled} openedCostUsd={openedSpend(opened)} onThisComputer={onThisComputer} /> : null}
      {paused !== null ? <TimelineRuleLine data-workspace-paused line={paused} /> : null}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative isolate h-full min-h-0 text-foreground [--empty-lift:calc((100%-var(--chat-composer-inset,0px)-5.5rem)/2)]">
      <div className="absolute inset-0">
        {!thread.hydrated ? (
          <div className="flex h-full items-center justify-center pb-(--chat-composer-inset) text-sm text-muted-foreground">{TRANSCRIPT_LOADING}</div>
        ) : empty ? (
          // A fresh thread centres the headline and the composer as one stack; the composer glides to its dock
          // when the first message goes.
          <>
            <HeroAtmosphere {...(workspace?.project?.id === undefined ? {} : { projectId: workspace.project.id })} />
            <div className="absolute inset-x-0 bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+2.5rem)]">
              <EmptyThread workspaceName={workspace?.name ?? workspaceId} {...(workspace?.project?.id === undefined ? {} : { projectId: workspace.project.id })} />
            </div>
          </>
        ) : (
          <MessagesTimeline
            isWorking={view.running}
            machineWait={machineWait}
            activeTurnStartedAt={view.activeTurnStartedAt}
            waitingOn={turnRows.at(-1)?.waitingOn ?? null}
            listRef={listRef}
            timelineEntries={view.entries}
            turns={view.turns}
            threadKey={threadId === null ? workspaceId : `${workspaceId}/${threadId}`}
            onImageExpand={noopImageExpand}
            onAnswerPermission={onAnswerPermission}
            onOpenFile={onOpenFile}
            onIsAtEndChange={onIsAtEndChange}
            footer={footer}
            replyMeta={replyMeta}
            markdownCwd={cwd}
            workspaceRoot={cwd}
            resolvedTheme={appDark ? "dark" : "light"}
            timestampFormat={timestampFormat}
          />
        )}
      </div>
      <div
        ref={composerRef}
        data-chat-composer-dock
        data-at-end={!showTranscript || atEnd || undefined}
        data-centred={(thread.hydrated && empty) || undefined}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 *:pointer-events-auto transition-[bottom] duration-300 ease-out data-centred:bottom-(--empty-lift) motion-reduce:transition-none"
      >
        <ScrollToEnd hidden={!showTranscript || atEnd} onClick={() => void listRef.current?.scrollToEnd({ animated: true })} />
        {children?.(thread)}
      </div>
    </div>
  );
}

/** Rides over the composer while the reader is above the transcript's end; kept mounted so it fades both ways. */
function ScrollToEnd({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  return (
    <div className="pointer-events-none! absolute inset-x-0 bottom-full flex justify-center pb-2">
      <button
        type="button"
        data-scroll-to-end
        aria-hidden={hidden || undefined}
        tabIndex={hidden ? -1 : 0}
        onClick={onClick}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-popover/95 px-3 text-xs text-muted-foreground shadow-[0_8px_20px_-8px_rgb(0_0_0/45%),0_2px_4px_-2px_rgb(0_0_0/30%)] glass-backdrop transition-[opacity,translate,color] duration-200 ease-out hover:text-foreground motion-reduce:transition-none",
          hidden ? "pointer-events-none translate-y-1 opacity-0" : "pointer-events-auto translate-y-0 opacity-100",
        )}
      >
        <ArrowDownIcon className="size-3.5" aria-hidden />
        Scroll to end
      </button>
    </div>
  );
}

export function EmptyThread({ workspaceName, projectId }: { workspaceName: string; projectId?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 px-6">
      <HeroMark {...(projectId === undefined ? {} : { projectId })} />
      <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        What should we build in{" "}
        <span className="inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-baseline">{workspaceName}</span>?
      </h1>
    </div>
  );
}

/** What the threads this one opened have spent between them, as each thread's own rows add up; zero where none of
 * them reported a figure, which the footer then says nothing about. */
function openedSpend(opened: ReadonlyArray<ThreadOnWorkspace>): number {
  return opened.reduce((sum, { thread }) => sum + (thread.costUsd ?? 0), 0);
}

/** One row per thread this thread's agent opened, wherever each runs: what it is called, the workspace it runs on
 * with where that runs, how it stands, and the page's own address for it, so a person reading the opener can reach
 * every thread it started without hunting the sidebar for it. */
function OpenedThreadRows({ opened }: { opened: ReadonlyArray<ThreadOnWorkspace> }) {
  return (
    <>
      {opened.map(({ thread, runs }) => (
        <TimelineRuleLine key={thread.id} data-opened-thread line="opened" {...(thread.indicator === null ? {} : { end: thread.indicator.label })}>
          <ThreadLink thread={thread} className="min-w-0 truncate text-foreground" />{" "}
          <span className="ms-1 shrink-0 whitespace-nowrap">{`${runs.displayName} on ${whereWord(runs)}`}</span>{" "}
        </TimelineRuleLine>
      ))}
    </>
  );
}

/** Facts as flex items, the gap between them the only separator. The spaces between draw nothing in a flex row;
 * they keep the words apart in the text content a plain-text read takes. */
function FlexParts({ parts }: { parts: ReadonlyArray<string> }) {
  return parts.map((part, at) => (
    <Fragment key={part}>
      {at === 0 ? null : " "}
      <span className="whitespace-nowrap">{part}</span>
    </Fragment>
  ));
}

function SettledFacts({ parts }: { parts: ReadonlyArray<string> }) {
  return (
    <p data-testid="settled-footer" className="ms-1 flex flex-wrap items-center gap-x-3 text-muted-foreground text-xs tabular-nums">
      <FlexParts parts={parts} />
    </p>
  );
}

const TURN_STATUS: Record<TurnSummary["state"], string> = {
  running: "running",
  completed: "completed",
  interrupted: "interrupted",
  error: "failed",
};

/** Duration and cost of the turn that just settled, with what the threads it opened spent beside its own figure;
 * its error, when it has one, is already a row in the thread. The line carries facts and a state word, so it wears
 * the type ladder's 11 px mono, the size the rule lines above it and the row meta in the sidebar read at. A narrow
 * window breaks the line between facts and never inside one: a duration or a price split over two lines is a
 * figure a person has to reassemble before they can read it. */
function SettledFooter({ turn, openedCostUsd, onThisComputer }: { turn: TurnSummary; openedCostUsd: number; onThisComputer: boolean }) {
  const failed = turn.state !== "completed";
  const parts = turnSettledParts(turn, openedCostUsd, onThisComputer ? LIST_PRICE_WORD : undefined);
  return (
    <div
      data-testid="settled-footer"
      className={cn(
        "flex w-full flex-wrap items-center gap-x-3 px-1 pb-2 font-mono text-[11px] tabular-nums",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <FlexParts parts={[TURN_STATUS[turn.state], ...parts]} />
    </div>
  );
}
