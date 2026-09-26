// SPDX-License-Identifier: AGPL-3.0-only
// The levels under a row, each replacing the list inside its tab: the detail
// (a head with Back, the facts as a label column and a value column, the acts
// next step first, and a sign-in drawn under them), the level of rows a kind
// may add under it, and one of those rows. Escape goes back one level;
// ArrowDown from the head reaches the acts.
import { ArrowLeftIcon, CheckIcon, CopyIcon, ExternalLinkIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { offlineFor } from "@wsp/protocol";
import { copyText } from "../../actions/clipboard.js";
import { MICRO_LABEL } from "../../lib/microLabel.js";
import { cn } from "../../lib/utils.js";
import { FACT, VALUE } from "../../settings/format.js";
import { CopyRow, RefusalSlot } from "../../settings/sheetParts.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { Button } from "../ui/button.js";
import { Checkbox } from "../ui/checkbox.js";
import { Skeleton } from "../ui/skeleton.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group.js";
import { Spinner } from "../ui/spinner.js";
import { ActButton, AgentMarks, LeadMark, OneOf, StatusView } from "./agentsParts.js";
import { AGENTS_LIST_WORDS as W } from "./agentsRows.js";
import { NARROW } from "./agentsWidths.js";
import type { AddForm, AddFormProps, AddLevel, AddModule, AddRow, Choice, DetailView, Fact, Lead, UnderLevel, UnderRow } from "./kinds/kind.js";
import { rovingKeys } from "./roving.js";
import { SignInFlowView } from "./SignInFlowView.js";
import { SkillPreview } from "./SkillPreview.js";

const COPIED_MS = 1_400;

/** A level's head: Back, the lead, the name at 15 px, and the level's own glyph at the right. */
function LevelHead({ back, backLabel, lead, title, marks, right, headRef }: { back: () => void; backLabel: string; lead?: Lead; title: string; marks?: readonly string[]; right?: ReactNode; headRef: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <div data-level-head className="flex h-10 items-center gap-2 px-4">
      <Button ref={headRef} data-k="agents-back" size="icon-xs" variant="ghost" className="-ml-1" aria-label={backLabel} onClick={back}>
        <ArrowLeftIcon />
      </Button>
      {lead === undefined ? null : <LeadMark lead={lead} label={title} big />}
      <h3 data-k="detail-title" className="min-w-0 truncate text-[15px] leading-5 font-medium text-foreground" title={title}>
        {title}
      </h3>
      {marks === undefined ? null : <AgentMarks agents={marks} />}
      {right === undefined ? null : <span className="ml-auto flex items-center">{right}</span>}
    </div>
  );
}

/** Focus lands on Back when a level opens, or on the level's own field where it has one; Escape leaves it, and
 * ArrowDown from the head steps to the first act. */
function useLevelKeys(back: () => void, first?: React.RefObject<HTMLElement | null>) {
  const headRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => (first?.current ?? headRef.current)?.focus({ preventScroll: true }), []);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    if (e.key === "Escape" && !typing) {
      e.preventDefault();
      e.stopPropagation();
      back();
      return;
    }
    if (e.key === "ArrowDown" && target === headRef.current) {
      const first = e.currentTarget.querySelector<HTMLElement>("[data-detail-acts] button:not(:disabled), [data-level-body] [data-row-trigger]");
      if (first !== null) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  return { headRef, onKeyDown };
}

function CopyGlyph({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      data-k="fact-copy"
      size="icon-xs"
      variant="ghost-muted"
      aria-label={`${W.copy} ${label.toLowerCase()}`}
      className="opacity-0 transition-opacity duration-150 group-hover/fact:opacity-100 focus-visible:opacity-100"
      onClick={() =>
        void copyText(value).then(
          () => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), COPIED_MS);
          },
          () => {},
        )
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

/** A path or a command that wraps only after a slash or at a space, so a second line starts at a folder; a hyphen
 * is a break opportunity in Chromium, so each word between stands whole. */
const slashBreaks = (value: string): ReactNode =>
  value.split(/(\/|\s+)/).map((token, at) =>
    token === "/" ? (
      <Fragment key={at}>
        /<wbr />
      </Fragment>
    ) : token === "" || token.trim() === "" ? (
      token
    ) : (
      <span key={at} className="whitespace-nowrap">
        {token}
      </span>
    ),
  );

/** One fact: the label in its column, the value in the mono clamped at two lines with the whole on its hover, the
 * reason or state after it in the muted mono. */
function FactLine({ fact, labelFor }: { fact: Fact; labelFor: string }) {
  const copy = fact.copy === true && fact.value !== undefined ? <CopyGlyph value={fact.value} label={fact.label === "" ? labelFor : fact.label} /> : null;
  // With nothing after the value the glyph stays beside it, so a long value never wraps an empty line under it.
  const trailing = fact.fact !== undefined || fact.act !== undefined;
  return (
    <div data-fact={fact.id} className="group/fact flex min-h-7 items-start gap-3">
      <span data-fact-label className="flex min-h-7 w-24 shrink-0 items-center text-xs text-muted-foreground @min-[480px]:w-40">
        {fact.label}
      </span>
      <span className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-1">
        <span className="flex min-w-0 max-w-full items-center gap-2">
          {fact.agent === undefined ? null : <HarnessMark harness={fact.agent} label={agentName(fact.agent)} className="size-3.5" />}
          {fact.status === undefined ? null : <StatusView status={fact.status} />}
          {fact.value === undefined ? null : fact.line === true ? (
            <CopyRow k={`fact-${fact.id}`} value={fact.value} />
          ) : fact.href !== undefined ? (
            <button type="button" data-fact-value title={fact.href} onClick={() => void window.open(fact.href, "_blank", "noopener,noreferrer")} className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 truncate font-mono text-xs text-foreground underline-offset-4 transition-colors duration-150 hover:underline">
              <span className="truncate">{fact.value}</span>
              <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </button>
          ) : (
            <span data-fact-value className={cn(fact.muted === true ? FACT : VALUE, "line-clamp-2 min-w-0 break-words")} title={fact.hover ?? fact.value}>
              {fact.muted === true ? fact.value : slashBreaks(fact.value)}
            </span>
          )}
          {trailing ? null : copy}
        </span>
        {trailing ? (
          <span className="flex min-w-0 flex-auto items-center gap-2">
            {fact.fact === undefined ? null : typeof fact.fact !== "string" ? (
              <StatusView status={fact.fact} fit />
            ) : (
              <span data-fact-note className={cn(FACT, "line-clamp-2 min-w-0 break-words")} title={fact.fact}>
                {fact.fact}
              </span>
            )}
            {copy}
            {fact.act === undefined ? null : <ActButton act={fact.act} className="ml-auto" />}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** One pick a detail asks for, in the label column's grammar: ticks for several, a select for one of a few; a held
 * option stands ticked and says why on its hover. */
function ChoiceLine({ choice }: { choice: Choice }) {
  return (
    <div data-choice={choice.id} className="flex min-h-7 items-start gap-3">
      <span className="flex min-h-7 w-24 shrink-0 items-center text-xs text-muted-foreground @min-[480px]:w-40">{choice.label}</span>
      {choice.many ? (
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 py-1">
          {choice.options.map(o => {
            const on = choice.value.includes(o.value);
            return (
              <label key={o.value} data-choice-option={o.value} className="inline-flex min-h-5 cursor-pointer items-center gap-2 text-xs text-foreground has-data-disabled:cursor-default" {...(o.held === undefined ? {} : { title: o.held })}>
                <Checkbox tone="neutral" checked={on} disabled={o.held !== undefined} aria-label={o.label} onCheckedChange={next => choice.set(next ? [...choice.value, o.value] : choice.value.filter(v => v !== o.value))} />
                {o.agent === undefined ? null : <HarnessMark harness={o.agent} label={o.label} className="size-3.5" />}
                {o.label}
              </label>
            );
          })}
        </span>
      ) : (
        <span className="min-w-0 flex-1">
          <OneOf k={`${choice.id}-pick`} label={choice.label} options={choice.options} value={choice.value[0] ?? ""} set={v => choice.set([v])} {...(choice.lost === undefined ? {} : { lost: choice.lost })} className="h-7 min-h-7 sm:min-h-7" />
        </span>
      )}
    </div>
  );
}

export function DetailLevel({ view, back, backLabel }: { view: DetailView; back: () => void; backLabel: string }) {
  const { headRef, onKeyDown } = useLevelKeys(back);
  const load = view.doc?.load;
  // Asked at every draw, since the target under an open level can change; the road asks each target once.
  useEffect(() => load?.());
  let labelFor = "";
  return (
    <div data-agents-detail onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} lead={view.lead} title={view.title} {...(view.marks === undefined ? {} : { marks: view.marks })} headRef={headRef} />
      <div data-level-body className="flex flex-col gap-3 px-4 pt-2">
        {view.about === undefined ? null : (
          <p data-detail-about className="text-[13px] leading-5 text-foreground">
            {view.about}
          </p>
        )}
        <div data-facts className="flex flex-col gap-y-1">
          {view.facts.map(fact => {
            if (fact.label !== "") labelFor = fact.label;
            return <FactLine key={fact.id} fact={fact} labelFor={labelFor} />;
          })}
        </div>
        {view.choices === undefined ? null : (
          <div data-choices className="flex flex-col gap-y-1">
            {view.choices.map(choice => (
              <ChoiceLine key={choice.id} choice={choice} />
            ))}
          </div>
        )}
        {view.acts.length === 0 ? null : (
          <div data-detail-acts className="flex flex-wrap gap-2">
            {view.acts.map(act => (
              <ActButton key={act.id} act={act} />
            ))}
          </div>
        )}
        {view.flow === undefined ? null : <SignInFlowView view={view.flow} label={view.title} />}
        {view.flow === undefined && view.refused !== undefined ? <RefusalSlot k="detail-refused" said={view.refused} /> : null}
        {view.doc === undefined ? null : <SkillPreview doc={view.doc} />}
      </div>
    </div>
  );
}

/** A kind's add level: its head with Back and where its things come from, a search that asks as the person pauses
 * or presses Enter, and its rows, each opening the detail of one before it is added. */
export function AddLevelView({ adder, level, query, typing, onQuery, onAsk, onRow, back, backLabel }: { adder: AddModule; level: AddLevel; query: string; typing: boolean; onQuery: (q: string) => void; onAsk: () => void; onRow: (row: AddRow) => void; back: () => void; backLabel: string }) {
  const field = useRef<HTMLInputElement | null>(null);
  const { headRef, onKeyDown } = useLevelKeys(back, field);
  const link =
    adder.link === undefined ? undefined : (
      <Button data-k="add-link" size="xs" variant="ghost-muted" onClick={() => void window.open(adder.link!.href, "_blank", "noopener,noreferrer")}>
        {adder.link.label}
        <ExternalLinkIcon aria-hidden className="size-3" />
      </Button>
    );
  return (
    <div data-agents-add onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} title={adder.title} right={link} headRef={headRef} />
      <div className="px-4 pt-1 pb-2">
        <InputGroup className="h-8">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={field}
            data-k="add-search"
            value={query}
            placeholder={adder.search}
            aria-label={adder.search}
            spellCheck={false}
            className="font-mono text-[13px] sm:text-[13px]"
            onChange={e => onQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              onAsk();
            }}
          />
          <InputGroupAddon align="inline-end">{level.reading || typing ? <Spinner data-k="add-reading" className="size-3.5 text-muted-foreground" /> : null}</InputGroupAddon>
        </InputGroup>
      </div>
      {level.rows.length === 0 ? (
        level.empty === undefined ? null : (
          <p data-k="add-empty" className="flex min-h-[168px] items-center justify-center px-4 text-center text-[13px] text-muted-foreground">
            {level.empty}
          </p>
        )
      ) : (
        <div data-level-body className="flex flex-col gap-0.5" role="list" onKeyDown={rovingKeys}>
          {level.rows.map((row, at) => (
            <div key={row.key} role="listitem" data-add-row={row.key} className={cn("relative isolate mx-2 flex h-12 items-center gap-3 rounded-lg px-2", row.dim === true && "opacity-60")}>
              <button
                type="button"
                data-row-trigger
                tabIndex={at === 0 ? 0 : -1}
                onClick={() => onRow(row)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left outline-none before:absolute before:inset-0 before:-z-10 before:rounded-lg before:transition-colors before:duration-150 hover:before:bg-accent focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset"
              >
                <span data-add-title className="min-w-0 truncate text-[13px] leading-5 font-medium text-foreground" title={row.title}>
                  {row.title}
                </span>
                {row.subtext === undefined ? null : (
                  <span data-add-subtext className={cn(FACT, "min-w-0 truncate", NARROW.hidden)} title={row.subtext}>
                    {row.subtext}
                  </span>
                )}
                {row.fact === undefined ? null : (
                  <span data-add-fact className={cn(FACT, "ml-auto shrink-0 pl-2")}>
                    {row.fact}
                  </span>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A kind's add form in place of the list: its head with Back, then the form, whose first field takes focus. */
export function AddFormLevel({ form, props, back, backLabel }: { form: AddForm; props: Omit<AddFormProps, "first">; back: () => void; backLabel: string }) {
  const first = useRef<HTMLElement | null>(null);
  const { headRef, onKeyDown } = useLevelKeys(back, first);
  const Form = form.Form;
  return (
    <div data-agents-add-form onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} title={form.title} headRef={headRef} />
      <div data-level-body className="px-4 pt-2">
        <Form {...props} first={first} />
      </div>
    </div>
  );
}

export function UnderLevelView({ level, back, backLabel, now, onRow }: { level: UnderLevel; back: () => void; backLabel: string; now: number; onRow: (row: UnderRow) => void }) {
  const { headRef, onKeyDown } = useLevelKeys(back);
  const readAgo = level.readAt === undefined ? undefined : W.readAgo(offlineFor(now - Date.parse(level.readAt)));
  const again = level.reading ? (
    <span className="flex size-6 items-center justify-center">
      <Spinner className="size-3.5 text-muted-foreground" />
    </span>
  ) : (
    <span className="inline-flex" {...(readAgo === undefined ? {} : { title: readAgo })}>
      <Button data-k="under-again" aria-label={W.readAgain} size="icon-xs" variant="ghost" held={level.refresh === undefined} {...(level.refresh === undefined ? {} : { onClick: level.refresh })}>
        <RefreshCwIcon className="size-3.5" />
      </Button>
    </span>
  );
  const rows = level.rows ?? [];
  return (
    <div data-agents-under onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} title={level.title} right={again} headRef={headRef} />
      <div data-level-body className="flex flex-col gap-0.5 pt-1" role="list" aria-busy={level.reading} onKeyDown={rovingKeys}>
        {level.reading && rows.length === 0 ? [0, 1, 2].map(n => <Skeleton key={n} data-k="under-skeleton" className="mx-2 h-12 rounded-lg" />) : null}
        {rows.map((row, at) => (
          <div key={row.key} role="listitem" data-under-row={row.key} className="relative isolate mx-2 flex h-12 items-center rounded-lg px-2">
            <button
              type="button"
              data-row-trigger
              tabIndex={at === 0 ? 0 : -1}
              onClick={() => onRow(row)}
              className="flex min-w-0 flex-1 cursor-pointer flex-col justify-center text-left outline-none before:absolute before:inset-0 before:-z-10 before:rounded-lg before:transition-colors before:duration-150 hover:before:bg-accent focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset"
            >
              <span className="truncate font-mono text-xs leading-5 text-foreground">{row.title}</span>
              {row.subtext === undefined ? null : <span className="truncate text-xs leading-4 text-muted-foreground">{row.subtext}</span>}
            </button>
          </div>
        ))}
      </div>
      {level.empty === undefined || level.reading || rows.length > 0 ? null : (
        <p data-k="under-empty" className={cn(FACT, "px-4 py-2 leading-4")}>
          {level.empty}
        </p>
      )}
      <div className="px-4">{level.refused === undefined ? null : <RefusalSlot k="under-refused" said={level.refused} />}</div>
    </div>
  );
}

export function UnderRowLevel({ row, back, backLabel }: { row: UnderRow; back: () => void; backLabel: string }) {
  const { headRef, onKeyDown } = useLevelKeys(back);
  return (
    <div data-agents-under-row onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} title={row.title} headRef={headRef} />
      <div data-level-body className="px-4 pt-2">
        {row.body === undefined ? null : <p className="whitespace-pre-line break-words text-[13px] leading-5 text-foreground">{row.body}</p>}
        {row.list === undefined ? null : (
          <section data-k="under-list" aria-label={row.list.label} className={cn("flex flex-col gap-3", row.body !== undefined && "mt-5")}>
            <h4 className={cn(MICRO_LABEL, "leading-4 text-muted-foreground")}>{row.list.label}</h4>
            <ul className="flex flex-col gap-3">
              {row.list.items.map(item => (
                <li key={item.name} data-under-item={item.name} className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-mono text-xs leading-5 text-foreground">{item.name}</span>
                    {item.fact === undefined ? null : <span className={cn(FACT, "shrink-0")}>{item.fact}</span>}
                  </span>
                  {item.about === undefined ? null : <span className="break-words text-xs leading-4 text-muted-foreground">{item.about}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
