// SPDX-License-Identifier: AGPL-3.0-only
// The agents, MCP servers and skills on one computer or for one task, drawn
// by two hosts: a task's right panel and a computer's page in Settings. The
// tabs pick a kind; in the panel a line under them says what the tab holds on
// which computer, whose name opens its page, and on the page a head says
// whose they are. One toolbar searches, groups and adds while the list
// stands, in groups with no rules between rows; any other level has its own
// head in the toolbar's place.
// A row opens its detail in place of the list, with Back; a kind may add a
// level of rows under the detail and one row's own level under that, and an
// add level in place of the list: a search that asks as the person pauses,
// whose rows open the detail of one before it is added, or a form for what a
// person types. Every kind is a registered module, so this file never names
// one. Its root is the container every width rule reads.
import { ListFilterIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { offlineFor, type AgentsReport } from "@wsp/protocol";
import { MICRO_LABEL } from "../../lib/microLabel.js";
import { cn } from "../../lib/utils.js";
import { FACT } from "../../settings/format.js";
import { Button } from "../ui/button.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group.js";
import { Menu, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu.js";
import { SegmentedControl } from "../ui/segmented-control.js";
import { Skeleton } from "../ui/skeleton.js";
import { Spinner } from "../ui/spinner.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.js";
import { ActButton } from "./agentsParts.js";
import { AGENTS_LIST_WORDS as W, editImageAct, heldReason, notYet, onImage, pausedReport, refusedLines, type RefusedLine, type RowAct, type RowsContext } from "./agentsRows.js";
import { NARROW, TABS } from "./agentsWidths.js";
import { AgentsRow } from "./AgentsRow.js";
import { AddFormLevel, AddLevelView, DetailLevel, UnderLevelView, UnderRowLevel } from "./AgentsDetail.js";
import { AGENTS_KINDS } from "./kinds/index.js";
import type { AgentsShell, AnyKind, GroupBy } from "./kinds/kind.js";
import { focusRow, rovingKeys } from "./roving.js";
import { forgetServerIcons } from "./useServerIcon.js";

export type { AgentsShell } from "./kinds/kind.js";

/** What the head says: on the page its one sentence; in the panel the computer the rows are on, the road to its page,
 * and the project the task works, its folder on its name's hover. */
export interface AgentsHead {
  readonly line?: string;
  readonly computer?: string;
  readonly open?: () => void;
  readonly project?: { readonly name: string; readonly path?: string };
}

export interface AgentsManagerProps {
  readonly shell: AgentsShell;
  readonly head: AgentsHead;
  readonly report: AgentsReport | null;
  readonly reading: boolean;
  /** The host's sentence for a read it refused, drawn only while no report stands. */
  readonly error?: string | null;
  /** What the empty lines name: the computer. */
  readonly on: string;
  readonly ctx: RowsContext;
  /** Read again; absent where nothing is read, as on a cloud's page. */
  readonly onRefresh?: () => void;
  readonly now: number;
  /** Lines under the list beside the report's own refusals: the recipe's rows that are not there. */
  readonly misses?: readonly RefusedLine[];
  /** The kinds drawn, in tab order; the registry unless a test names fewer. */
  readonly kinds?: readonly AnyKind[];
}

type Level =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly key: string }
  | { readonly kind: "under"; readonly key: string }
  | { readonly kind: "under-row"; readonly key: string; readonly row: string }
  | { readonly kind: "add" }
  | { readonly kind: "add-detail"; readonly key: string };

/** How long the add level's search waits after the last key before it asks. */
const ASK_AFTER_MS = 250;

const GROUP_WORDS: Record<GroupBy, string> = { none: "None", agent: "Agent", source: "Source", scope: "Scope" };
const LABEL = cn(MICRO_LABEL, "text-muted-foreground");

/** The nearest box that scrolls, whose place the list keeps while a detail stands over it. */
const scrollerOf = (el: HTMLElement | null): HTMLElement | null => {
  for (let at = el?.parentElement ?? null; at !== null; at = at.parentElement) {
    const y = getComputedStyle(at).overflowY;
    if (y === "auto" || y === "scroll") return at;
  }
  return null;
};

const typingIn = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

export function AgentsManager({ shell, head, report, reading, error = null, on, ctx: given, onRefresh, now, misses = [], kinds = AGENTS_KINDS }: AgentsManagerProps) {
  const [tabId, setTabId] = useState(kinds[0]!.id);
  const [level, setLevel] = useState<Level>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState<Record<string, GroupBy>>({});
  const [typed, setTyped] = useState("");
  const [asked, setAsked] = useState("");
  const root = useRef<HTMLElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const kept = useRef<{ key: string; top: number } | null>(null);

  const tab = kinds.find(k => k.id === tabId) ?? kinds[0]!;
  const paused = pausedReport(report);
  const held = given.heldWhy ?? (paused ? W.paused : null);
  const ctx: RowsContext = { ...given, on, ...(held === null ? {} : { heldWhy: held }), ...(report?.reach === undefined ? {} : { reach: report.reach }) };
  const staleWord = paused ? W.paused : given.heldWhy !== null && given.heldWhy !== undefined ? W.away : undefined;
  const dim = reading || held !== null;
  const page = shell === "page";

  const itemsOf = new Map(kinds.map(k => [k.id, report === null ? [] : k.items(report, ctx)]));
  const items = itemsOf.get(tab.id) ?? [];
  const shown = items.filter(item => tab.matches(item, query));
  const by = grouping[tab.id] ?? tab.defaultGroup(shell);
  const groups = tab.groups(shown, by, ctx).filter(g => g.items.length > 0);
  const count = report === null ? null : tab.count(items);
  const lines: RefusedLine[] = [...(report === null ? [] : refusedLines(report.refused)), ...misses, ...(report === null && error !== null ? [{ id: "read-refused", label: error }] : [])];
  const readAgo = report === null ? undefined : W.readAgo(offlineFor(now - Date.parse(report.readAt)));
  const adder = heldReason(ctx) === undefined ? tab.adder?.(ctx) : undefined;
  const former = heldReason(ctx) === undefined && adder === undefined ? tab.form?.(ctx) : undefined;
  const adding = level.kind === "add" || level.kind === "add-detail";
  const current = level.kind === "list" || adding ? undefined : items.find(item => tab.key(item) === level.key);
  const addView = level.kind === "add-detail" ? adder?.detail(level.key, asked, report, ctx) : undefined;
  // A level whose item left goes back one: to the list, or to the add level where the search no longer holds it.
  const at: Level =
    adding && adder === undefined && former === undefined ? { kind: "list" } : level.kind === "add-detail" && addView === undefined ? { kind: "add" } : !adding && level.kind !== "list" && current === undefined ? { kind: "list" } : level;
  if (at !== level) setLevel(at);
  const askRef = useRef(adder);
  askRef.current = adder;
  // The search asks once the person pauses, and at once on Enter.
  useEffect(() => {
    if (typed.trim() === asked.trim()) return;
    const timer = setTimeout(() => setAsked(typed), ASK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [typed, asked]);
  useEffect(() => {
    if (asked.trim() !== "") askRef.current?.ask(asked, ctx);
  }, [asked, tab.id]);

  const open = (key: string): void => {
    const scroller = scrollerOf(root.current);
    kept.current = { key, top: scroller?.scrollTop ?? 0 };
    setLevel({ kind: "detail", key });
  };
  const backToList = (): void => setLevel({ kind: "list" });
  // Back on the list: the scroll it had, and focus on the row that was opened.
  useLayoutEffect(() => {
    if (at.kind !== "list" || kept.current === null) return;
    const { key, top } = kept.current;
    kept.current = null;
    const scroller = scrollerOf(root.current);
    if (scroller !== null) scroller.scrollTop = top;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-agents-rows] [data-row-trigger]") ?? [])];
    const index = rows.findIndex(r => r.closest<HTMLElement>("[data-agents-row]")?.dataset["agentsRow"] === key);
    if (index >= 0) focusRow(rows, index);
  }, [at.kind]);

  const pick = (next: string): void => {
    setTabId(next);
    setQuery("");
    setTyped("");
    setAsked("");
    setLevel({ kind: "list" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "/" && !typingIn(e.target) && search.current !== null) {
      e.preventDefault();
      search.current.focus();
    }
  };

  const addWord = tab.add;
  const add: RowAct | undefined =
    addWord === undefined ? undefined : onImage(ctx) ? editImageAct(ctx) : adder !== undefined || former !== undefined ? { id: "add", label: addWord, icon: PlusIcon, run: () => setLevel({ kind: "add" }) } : { ...notYet("add", addWord, PlusIcon), hover: heldReason(ctx) ?? W.notYet };
  // Each time a tab shows a report, its kind asks what it checks there.
  const shownRef = useRef<() => void>(() => {});
  shownRef.current = () => tab.shown?.(items, ctx);
  useEffect(() => {
    if (report !== null) shownRef.current();
  }, [tab.id, report]);

  const staleMark =
    staleWord === undefined ? null : (
      <span data-k="agents-stale" className={cn(FACT, "shrink-0")} {...(given.heldWhy ? { title: given.heldWhy } : {})}>
        {staleWord}
      </span>
    );
  const headRow =
    head.line === undefined ? null : (
      <div data-agents-head className="flex min-h-6 items-center gap-3 px-4 pb-3">
        {/* Under a phone's width the line wraps rather than cut, since its hover is not there to read. */}
        <p data-k="agents-line" className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground max-sm:whitespace-normal" title={head.line}>
          {head.line}
        </p>
        {staleMark}
        {readAgain()}
      </div>
    );
  const [before, after] = tab.line(head.project?.name);
  const tabLine =
    head.computer === undefined ? null : (
      <div data-agents-line className="flex min-h-6 items-center gap-3 px-4">
        <p data-k="agents-line" className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground">
          {before}
          {head.open === undefined ? (
            <span data-k="agents-computer">{head.computer}</span>
          ) : (
            <button type="button" data-k="agents-computer" aria-label={W.openComputer(head.computer)} title={W.openComputer(head.computer)} onClick={head.open} className="cursor-pointer text-foreground/80 underline decoration-foreground/30 underline-offset-2 transition-colors duration-150 hover:text-foreground hover:decoration-foreground/60">
              {head.computer}
            </button>
          )}
          {after === "" ? null : (
            <span data-k="agents-project" {...(head.project?.path === undefined ? {} : { title: head.project.path })}>
              {after}
            </span>
          )}
        </p>
        {staleMark}
        {readAgain()}
      </div>
    );

  function readAgain() {
    if (onRefresh === undefined) return null;
    if (reading) {
      return (
        <span className="flex size-6 items-center justify-center">
          <Spinner className="size-3.5 text-muted-foreground" />
        </span>
      );
    }
    return (
      <span className="inline-flex" title={held ?? readAgo}>
        <Button
          data-k="agents-read-again"
          aria-label={W.readAgain}
          size="icon-xs"
          variant="ghost"
          held={held !== null}
          onClick={() => {
            forgetServerIcons();
            onRefresh();
          }}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </span>
    );
  }

  const tabs = (
    <div className="px-4">
      <SegmentedControl
        value={tab.id}
        onChange={pick}
        className="flex w-full"
        segmentClassName={cn("flex-auto gap-1.5 whitespace-nowrap px-3 text-sm", TABS.narrowPad)}
        segments={kinds.map(k => {
          const Icon = k.icon;
          const n = report === null ? null : k.count(itemsOf.get(k.id) ?? []);
          return {
            value: k.id,
            label: (
              <TabLabel word={k.word}>
                <Icon aria-hidden className="size-4 shrink-0" />
                <span data-segment-word className={NARROW.hidden}>
                  {k.word}
                </span>
                {n === null ? null : (
                  <span data-segment-count className={cn(FACT, "text-xs", TABS.countHidden)}>
                    {n}
                  </span>
                )}
              </TabLabel>
            ),
          };
        })}
      />
    </div>
  );

  // The toolbar is the list's own: any other level draws its head in its place, and Back finds the query kept.
  const toolbar =
    tab.search === undefined || at.kind !== "list" ? null : (
      <div data-agents-toolbar className="flex h-8 items-center gap-1.5 px-4">
        <InputGroup className="h-8 min-w-0 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={search}
            data-k="agents-search"
            value={query}
            placeholder={tab.search}
            aria-label={tab.search}
            spellCheck={false}
            className="font-mono text-[13px] sm:text-[13px]"
            onChange={e => {
              setQuery(e.target.value);
              setLevel({ kind: "list" });
            }}
            onKeyDown={e => {
              if (e.key !== "Escape" || query !== "") return;
              e.preventDefault();
              const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-agents-rows] [data-row-trigger]") ?? [])];
              const active = rows.findIndex(r => r.tabIndex === 0);
              focusRow(rows, Math.max(active, 0));
            }}
          />
        </InputGroup>
        {count === null ? null : (
          <span data-k="agents-count" className={cn(FACT, "hidden shrink-0", TABS.countShown)}>
            {query.trim() === "" ? tab.noun(count) : W.of(shown.length, count)}
          </span>
        )}
        {tab.groupings.length === 0 ? null : (
          <Menu>
            <Tooltip>
              <TooltipTrigger render={<MenuTrigger render={<Button data-k="agents-view" size="icon" variant="ghost" className="size-8" aria-label={W.groupAndSort} />} />}>
                <ListFilterIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">{W.groupAndSort}</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end">
              <MenuGroup>
                <MenuGroupLabel>{W.groupBy}</MenuGroupLabel>
                <MenuRadioGroup value={by} onValueChange={value => setGrouping(g => ({ ...g, [tab.id]: value as GroupBy }))}>
                  {tab.groupings.map(g => (
                    <MenuRadioItem key={g} value={g} data-k={`group-${g}`}>
                      {GROUP_WORDS[g]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>{W.sortBy}</MenuGroupLabel>
                <MenuRadioGroup value="name">
                  <MenuRadioItem value="name">{W.name}</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            </MenuPopup>
          </Menu>
        )}
        {add === undefined ? null : <ActButton act={{ ...add, hover: add.hover ?? add.label }} k="agents-add" tall wordClassName={TABS.addWordHidden} className="shrink-0" />}
      </div>
    );

  const rowHeight = tab.rowHeight;
  const emptyBox = "flex min-h-[168px] items-center justify-center px-4 text-center text-[13px] text-muted-foreground";
  const list =
    report === null ? (
      reading || error === null ? (
        <div data-agents-rows aria-busy className="flex flex-col gap-0.5">
          {[0, 1, 2].map(n => (
            <Skeleton key={n} data-k="agents-skeleton" className={cn("mx-2 rounded-lg", rowHeight)} />
          ))}
        </div>
      ) : null
    ) : shown.length === 0 ? (
      query.trim() !== "" ? (
        <p data-k="agents-empty" className={emptyBox}>
          {W.nothingMatches(query.trim())}
        </p>
      ) : page ? (
        <div data-k="agents-empty" className="mx-4 flex min-h-[168px] flex-col items-center justify-center gap-3 rounded-lg bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[12px_12px]">
          <span className="rounded-md border border-dashed border-border bg-background px-2 py-1 font-mono text-xs text-muted-foreground">{tab.none}</span>
          {add === undefined ? null : <ActButton act={add} />}
        </div>
      ) : (
        <p data-k="agents-empty" className={emptyBox}>
          {tab.empty(on)}
        </p>
      )
    ) : (
      // Labels and rows stand 2 px apart alike, a label's words centred in its slot: one rhythm down the list.
      <div data-agents-rows aria-busy={reading} onKeyDown={rovingKeys} className="flex flex-col gap-0.5">
        {groups.map((group, g) => (
          <div key={group.id} role="group" data-agents-group={group.id} {...(group.label === undefined ? {} : { "aria-label": group.label })} className="flex flex-col gap-0.5">
            {group.label === undefined ? null : (
              <div data-group-label className={cn(LABEL, "flex h-8 items-center gap-2 px-4")}>
                <span>{group.label}</span>
                {group.path === undefined ? null : <span className="truncate normal-case tracking-normal">{group.path}</span>}
              </div>
            )}
            <div role="list" className="flex flex-col gap-0.5">
              {group.items.map((item, i) => {
                const key = tab.key(item);
                return <AgentsRow key={key} row={tab.row(item, ctx)} height={rowHeight} dim={dim} first={g === 0 && i === 0} onOpen={() => open(key)} />;
              })}
            </div>
          </div>
        ))}
      </div>
    );

  const backLabel = W.back(tab.word);
  const addLevel =
    adder === undefined || !(at.kind === "add" || at.kind === "add-detail") ? null : at.kind === "add-detail" && addView !== undefined ? (
      <DetailLevel key={`add-${at.key}`} view={addView} back={() => setLevel({ kind: "add" })} backLabel={W.back(adder.title)} />
    ) : (
      <AddLevelView
        adder={adder}
        level={adder.level(asked, report, ctx)}
        query={typed}
        typing={typed.trim() !== asked.trim()}
        onQuery={setTyped}
        onAsk={() => setAsked(typed)}
        onRow={row => setLevel({ kind: "add-detail", key: row.key })}
        back={backToList}
        backLabel={backLabel}
      />
    );
  const formLevel =
    former === undefined || at.kind !== "add" ? null : <AddFormLevel key={`form-${tab.id}`} form={former} props={{ report, ctx, done: backToList }} back={backToList} backLabel={backLabel} />;
  const levelView =
    formLevel !== null
      ? formLevel
      : addLevel !== null
      ? addLevel
      : at.kind === "list" || current === undefined
      ? null
      : (() => {
          const key = "key" in at ? at.key : "";
          const detail = tab.detail(current, ctx, { openUnder: () => setLevel({ kind: "under", key }) });
          const under = detail.under;
          const row = at.kind === "under-row" ? under?.rows?.find(r => r.key === at.row) : undefined;
          if (at.kind === "detail" || under === undefined) return <DetailLevel key={key} view={detail} back={backToList} backLabel={backLabel} />;
          const toUnder = (): void => setLevel({ kind: "under", key });
          if (row !== undefined) return <UnderRowLevel key={`row-${row.key}`} row={row} back={toUnder} backLabel={W.back(under.title)} />;
          return <UnderLevelView key="under" level={under} back={() => setLevel({ kind: "detail", key })} backLabel={W.back(detail.title)} now={now} onRow={r => setLevel({ kind: "under-row", key, row: r.key })} />;
        })();

  return (
    // On the page the content stands on the cards' text edge, their hairline and px-5, 5 px past the panel's.
    <section ref={root} data-agents-manager data-shell={shell} aria-label={W.section} onKeyDown={onKeyDown} className={cn("@container flex flex-col", page ? "px-[5px]" : "min-h-0 flex-1")}>
      {/* The page scrolls as a whole, so its head pins over the list on the page's grained ground; the panel's head
          stands still and only the list under it scrolls, since the panel's ground is the glass and clear. */}
      <div data-agents-top className={cn("flex flex-col pb-1", page ? "sticky top-0 z-10 bg-background surface-grain" : "flex-none pt-4")}>
        {headRow}
        <div className="flex flex-col gap-3">
          {tabs}
          {tabLine}
          {toolbar}
        </div>
      </div>
      {/* The list's end keeps the rows' own side gutter under the last one. */}
      <div data-agents-body className={cn("flex flex-col pt-2 pb-2", !page && "min-h-0 flex-1 overflow-y-auto", dim && at.kind !== "list" && "opacity-50")}>
        {at.kind === "list" ? list : levelView}
        {at.kind !== "list" || lines.length === 0 ? null : (
          <div data-agents-refused className="mt-2 flex flex-col px-4">
            {lines.map(line => (
              <p key={line.id} data-refused-line={line.id} className="flex min-h-7 items-start gap-2 py-1.5">
                <span data-refused-label className={cn(FACT, "min-w-0 [overflow-wrap:anywhere]", line.value !== undefined && "shrink-0 text-foreground")}>
                  {line.label}
                </span>
                {line.value === undefined ? null : (
                  <span data-refused-value className={cn(FACT, "min-w-0 flex-1 [overflow-wrap:anywhere]")}>
                    {line.value}
                  </span>
                )}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** A tab's face; its tooltip opens only while the word is hidden, since it says nothing more than the word. */
function TabLabel({ word, children }: { word: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const face = useRef<HTMLSpanElement | null>(null);
  const hidden = (): boolean => {
    const el = face.current?.querySelector<HTMLElement>("[data-segment-word]");
    return el === null || el === undefined || getComputedStyle(el).display === "none";
  };
  return (
    <Tooltip open={open} onOpenChange={next => setOpen(next && hidden())}>
      <TooltipTrigger render={<span ref={face} data-segment-label aria-label={word} className="flex items-center gap-1.5" />}>{children}</TooltipTrigger>
      <TooltipPopup side="bottom">{word}</TooltipPopup>
    </Tooltip>
  );
}
