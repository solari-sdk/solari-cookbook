// SPDX-License-Identifier: AGPL-3.0-only
// The Processes pane of the right panel: every process the daemon lists in
// one dense mono table, a tree by parent with the harness pieces named,
// sortable by cpu or memory, filtered by a box. The selected row is the only
// lit one and opens into the daemon's inspect fields with the kill controls.
// On a local workspace the computer is the person's own: this workspace's
// running threads come first, each under its own name, and the rest waits
// behind a toggle. The count is the rows on the screen, never the machine's total.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronRightIcon } from "lucide-react";
import { foldThreads, isLocalWorkspace, type ProcEntry, type ProcInspectReply, type ProcSignal } from "@wsp/protocol";
import { cn, errorText } from "../../lib/utils.js";
import { staleWord, type StaleWord } from "../../machine/live.js";
import { getProcs, useWorkspaceProcs } from "../../machine/procs.js";
import { useAbsentComputer, useStore, useWorkspace } from "../../protocol/store.js";
import { StartDaemonButton } from "../DaemonDown.js";
import { getTerminals, onTerminals } from "../../terminal/link.js";
import { clockLabel } from "../../lib/timestampFormat.js";
import { compactBytes } from "@wsp/protocol";
import { ScrollArea } from "../ui/scroll-area.js";
import { terminalLabels } from "../WorkspaceTerminalDrawer.js";
import { IDLE, offered, press, settle, type KillState } from "./kill.js";
import { procLabel, procTable, type ProcRow, type ProcSort, type ProcThread } from "./tree.js";

/** Every row is this tall, so the table reads as a grid and a selection moves nothing. */
export const ROW_PX = 22;
const COLUMNS = "grid grid-cols-[3.5rem_3.25rem_3.75rem_minmax(0,1fr)] items-center px-2";
const NO_TABS: readonly never[] = [];
const NO_THREADS: readonly ProcThread[] = [];

/** The threads of this workspace with a turn running, each with the process the host started for it. */
function useThreadRoots(workspaceId: string): readonly ProcThread[] {
  const sessions = useStore(s => s.sessions[workspaceId]);
  return useMemo(() => {
    if (sessions === undefined) return NO_THREADS;
    return foldThreads(sessions)
      .filter(t => t.pid !== undefined)
      .map(t => ({ threadId: t.id, title: t.title, pid: t.pid! }));
  }, [sessions]);
}

function useTerminalTitles(workspaceId: string): ReadonlyMap<string, string> {
  const terms = useSyncExternalStore(onTerminals, () => getTerminals(workspaceId));
  const subscribe = useCallback((fn: () => void) => (terms ? terms.onTabs(fn) : () => {}), [terms]);
  const tabs = useSyncExternalStore(subscribe, () => (terms ? terms.tabs() : NO_TABS));
  return useMemo(() => terminalLabels(tabs), [tabs]);
}

export function ProcessesSurface({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const absent = useAbsentComputer(workspaceId);
  const procs = useWorkspaceProcs(workspaceId);
  const titles = useTerminalTitles(workspaceId);
  const [sort, setSort] = useState<ProcSort>("cpu");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [restOpen, setRestOpen] = useState(false);

  useEffect(() => getProcs(workspaceId).watch(), [workspaceId]);

  const snapshot = procs.snapshot;
  const threads = useThreadRoots(workspaceId);
  // Only a local workspace shares its computer with everything else the person runs; this computer's own panel is
  // that whole computer, and a machine wsp forks runs only what this workspace put on it.
  const own = workspace !== null && isLocalWorkspace(workspace);
  const table = useMemo(() => procTable(snapshot?.procs ?? [], sort, filter, own ? threads : NO_THREADS), [snapshot, sort, filter, own, threads]);
  const sectioned = own && table.threads.length > 0;
  const showRest = !sectioned || restOpen;
  // This computer never reads unreachable: its panes say pending until the first frame.
  const stale = workspace === null ? null : (absent?.away ?? staleWord(workspace.phase, procs.reach === "live"));

  // A process that went away takes its selection with it.
  useEffect(() => {
    if (selected !== null && snapshot !== null && !snapshot.procs.some(p => p.pid === selected)) setSelected(null);
  }, [snapshot, selected]);

  const shown = table.threads.reduce((n, t) => n + t.rows.length, 0) + (showRest ? table.rest.length : 0);
  const count = snapshot === null ? "pending" : shown < snapshot.total ? `${shown} of ${snapshot.total}` : `${shown} processes`;
  const unavailable = stale === null && snapshot === null ? procs.unavailable : null;
  const draw = (rows: readonly ProcRow[], under = 0) =>
    rows.map(({ proc, depth }) => {
      const lit = proc.pid === selected;
      const label = snapshot ? procLabel(proc, snapshot.daemon, titles) : null;
      return (
        <div key={proc.pid}>
          <Row proc={proc} depth={depth + under} label={label} lit={lit} onSelect={() => setSelected(lit ? null : proc.pid)} />
          {lit && <Details workspaceId={workspaceId} proc={proc} stale={stale} />}
        </div>
      );
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col font-mono text-[11px]" data-procs>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/50 px-2">
        <input
          aria-label="Filter processes"
          placeholder="filter"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="h-6 min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-placeholder"
        />
        <span className={cn("shrink-0 tabular-nums", stale !== null ? "text-muted-foreground/60" : "text-muted-foreground")} data-procs-count>
          {stale ?? (unavailable !== null ? "unavailable" : count)}
        </span>
      </div>
      <div className={cn(COLUMNS, "h-6 shrink-0 border-b border-border/50 text-[.65rem] uppercase tracking-wider text-muted-foreground")} role="row">
        <span className="text-right">pid</span>
        <SortButton k="cpu" sort={sort} onSort={setSort}>
          cpu
        </SortButton>
        <SortButton k="mem" sort={sort} onSort={setSort}>
          mem
        </SortButton>
        <span className="pl-2">command</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div role="table" aria-label="Processes" className={cn(stale !== null && "text-muted-foreground/60")} {...(stale !== null ? { "data-stale": stale } : {})}>
          {absent !== null ? (
            <div className="flex flex-col items-start gap-2 px-2 py-2 text-muted-foreground" data-procs-unavailable>
              <p>{absent.said}</p>
              {absent.will !== undefined ? <p>{absent.will}</p> : null}
              <StartDaemonButton absent={absent} workspaceId={workspaceId} />
            </div>
          ) : (
            unavailable !== null && (
              <p className="truncate px-2 text-muted-foreground" style={{ lineHeight: `${ROW_PX}px` }} title={unavailable} data-procs-unavailable>
                {unavailable}
              </p>
            )
          )}
          {sectioned &&
            table.threads.map(({ thread, rows }) => (
              <div key={thread.threadId}>
                <p className="truncate px-2 text-foreground" style={{ lineHeight: `${ROW_PX}px` }} title={thread.title} data-procs-thread={thread.threadId}>
                  {thread.title}
                </p>
                {draw(rows, 1)}
              </div>
            ))}
          {sectioned && (
            <button
              type="button"
              aria-expanded={restOpen}
              onClick={() => setRestOpen(o => !o)}
              data-procs-rest
              style={{ height: ROW_PX }}
              className="flex w-full cursor-pointer items-center gap-1 px-2 text-left text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon aria-hidden className={cn("size-3 shrink-0 transition-transform duration-150", restOpen && "rotate-90")} />
              <span className="truncate">everything else</span>
              <span className="tabular-nums">{table.rest.length}</span>
            </button>
          )}
          {showRest && draw(table.rest)}
        </div>
      </ScrollArea>
    </div>
  );
}

function SortButton({ k, sort, onSort, children }: { k: ProcSort; sort: ProcSort; onSort: (k: ProcSort) => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={sort === k}
      onClick={() => onSort(k)}
      className={cn("cursor-pointer text-right uppercase tracking-wider hover:text-foreground", sort === k ? "text-foreground" : "text-muted-foreground")}
    >
      {children}
    </button>
  );
}

interface RowProps {
  proc: ProcEntry;
  depth: number;
  label: string | null;
  lit: boolean;
  onSelect: () => void;
}

function Row({ proc, depth, label, lit, onSelect }: RowProps) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };
  const command = proc.cmdline !== "" ? proc.cmdline : `[${proc.comm}]`;
  return (
    <div
      role="row"
      tabIndex={0}
      data-proc-row={proc.pid}
      {...(lit ? { "data-selected": "" } : {})}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      style={{ height: ROW_PX }}
      className={cn(COLUMNS, "cursor-default outline-none", lit ? "bg-accent text-foreground" : "hover:bg-accent/40 focus-visible:bg-accent/40")}
    >
      <span className={cn("text-right tabular-nums", !lit && "text-muted-foreground")}>{proc.pid}</span>
      <span className="text-right tabular-nums" data-col="cpu">
        {proc.cpu.toFixed(1)}
      </span>
      <span className="text-right tabular-nums" data-col="mem">
        {compactBytes(proc.rss)}
      </span>
      <span className="min-w-0 truncate" style={{ paddingLeft: 8 + depth * 12 }} title={command}>
        {label !== null && (
          <span className="mr-1.5 text-muted-foreground" data-proc-label>
            {label}
          </span>
        )}
        {command}
      </span>
    </div>
  );
}

/** The daemon's inspect fields for the lit row, read once when it opens, and the kill controls. */
function Details({ workspaceId, proc, stale }: { workspaceId: string; proc: ProcEntry; stale: StaleWord }) {
  const [inspect, setInspect] = useState<ProcInspectReply | string | null>(null);
  useEffect(() => {
    let gone = false;
    setInspect(null);
    getProcs(workspaceId)
      .inspect(proc.pid)
      .then(r => !gone && setInspect(r), e => !gone && setInspect(errorText(e)));
    return () => {
      gone = true;
    };
  }, [workspaceId, proc.pid]);

  const detail = typeof inspect === "object" && inspect !== null ? inspect : null;
  const list = (xs: number[] | undefined): string => (xs === undefined ? "" : xs.length === 0 ? "none" : xs.join(" "));
  return (
    <div className="border-y border-border/50 bg-accent/30 px-2 py-1.5" data-proc-details={proc.pid}>
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        <Field k="user">{proc.user}</Field>
        <Field k="state">{proc.state}</Field>
        <Field k="started">{clockLabel(new Date(proc.startedAt).toISOString())}</Field>
        <Field k="threads">{detail?.threads === undefined ? "" : String(detail.threads)}</Field>
        <Field k="cwd">{detail ? (detail.cwd ?? "unreadable") : ""}</Field>
        <Field k="ports">{list(detail?.ports)}</Field>
        <Field k="children">{list(detail?.children)}</Field>
        <Field k="command">{proc.cmdline !== "" ? proc.cmdline : `[${proc.comm}]`}</Field>
        {typeof inspect === "string" && <Field k="inspect">{inspect}</Field>}
      </dl>
      <Kill workspaceId={workspaceId} pid={proc.pid} disabled={stale !== null} />
    </div>
  );
}

function Field({ k, children }: { k: string; children: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 truncate text-foreground" title={children} data-k={k}>
        {children}
      </dd>
    </>
  );
}

const SIGNAL_WORD: Record<ProcSignal, string> = { TERM: "kill", KILL: "kill -9" };

/** Two presses, no dialog: kill arms, confirm within two seconds sends TERM; kill -9 appears once TERM did nothing for five seconds. */
function Kill({ workspaceId, pid, disabled }: { workspaceId: string; pid: number; disabled: boolean }) {
  const [state, setState] = useState<KillState>(IDLE);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.step === "idle") return;
    const t = setInterval(() => {
      const at = Date.now();
      setNow(at);
      setState(s => settle(s, at));
    }, 250);
    return () => clearInterval(t);
  }, [state.step]);

  const onPress = (): void => {
    const at = Date.now();
    const next = press(state, at);
    setNow(at);
    setState(next.state);
    if (next.send !== undefined) {
      setError(null);
      getProcs(workspaceId)
        .kill(pid, next.send)
        .catch(e => {
          setState({ step: "idle" });
          setError(errorText(e));
        });
    }
  };

  const offer = offered(state, now);
  return (
    <div className="mt-1.5 flex h-5 items-center gap-2" data-proc-kill>
      {offer !== null ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onPress}
          data-signal={offer.signal}
          className={cn(
            "h-5 cursor-pointer rounded-sm border px-1.5 disabled:cursor-default disabled:opacity-50",
            offer.confirm ? "border-transparent bg-destructive text-white hover:bg-destructive/90" : "border-border text-muted-foreground transition-colors duration-150 hover:border-destructive/50 hover:text-destructive-foreground",
          )}
        >
          {offer.confirm ? `confirm ${offer.signal}` : SIGNAL_WORD[offer.signal]}
        </button>
      ) : (
        <span className="text-muted-foreground" data-proc-sent>
          {state.step === "sent" ? `${state.signal} sent` : ""}
        </span>
      )}
      {error !== null && <span className="min-w-0 truncate text-muted-foreground">{error}</span>}
    </div>
  );
}
