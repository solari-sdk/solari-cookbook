// SPDX-License-Identifier: AGPL-3.0-only
// The model picker in the composer box: the agent's mark, its name and the
// model on the button, since the chip has to say which agent runs a turn
// before it says what that agent runs on; behind it a rail of the agents that
// can run one, each named in text on hover, a search box, the models with
// favourites first, the older models an agent still runs folded under one
// row at the end, and a jump chip per row, and a footer
// naming where the list came from in that agent's own words, on one line
// whatever the words are and whole on hover, then two sentences that hold
// whatever that line says: whose sign-in the turn runs on and where, and what
// the dollar figures beside the models are. Cmd-1 to cmd-9 pick a
// listed model while the menu is open. The harness is pinned once the thread
// has a turn: a thread is one resumed session, so picking another harness
// changes nothing and the footer says to start a new thread for it. A
// workspace whose project remembers no agent and whose turns have not started
// has the rail opened for it once, without taking focus: the box under it is
// where the ask is typed, the pick is one click away beside it, and the first
// keystroke takes the list away again.
import { ChevronDownIcon, ChevronRightIcon, SearchIcon, StarIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { everyModel, noModelsLine } from "@wsp/protocol";
import type { HarnessCatalog, HarnessModel } from "@wsp/protocol";
import { cn, isMacPlatform, normalizeSearchText } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { favouriteKey, useComposerFavouritesStore } from "./composerFavouritesStore";
import { HarnessMark } from "./HarnessMark";

const JUMP_KEYS = 9;

export interface ModelPickerProps {
  catalogs: ReadonlyArray<HarnessCatalog>;
  catalog: HarnessCatalog;
  model: HarnessModel | null;
  /** The thread already has a turn on this harness, so the rail offers no other. */
  pinned: boolean;
  /** Where this workspace's turns run, as the rest of the app names it, for the footer's sentences. */
  where: string;
  /** Put the rail in front of the person: a project nobody has run an agent on has no agent to default to, so the
   * list is opened for them the one time. It takes no focus, since the box under it is where the ask is typed. */
  onPickHarness: (harness: string) => void;
  onPickModel: (harness: string, model: string) => void;
}

/** The line under the model the composer names that this list has no row for: it may be the one the thread runs on
 * or a pick the binary has since dropped, and this is true of both. */
export const UNLISTED_MODEL_LINE = "Not in this task's list";

/** One row of the model menu: the catalog's own, or the model the composer names that this list has no row for,
 * marked once here so the row that draws it reads the mark rather than asking the catalog again. */
export interface ModelRow extends HarnessModel {
  readonly unlisted?: boolean;
  readonly legacy?: boolean;
}

/** Favourites first, then the catalog's order; a search narrows by label, slug and description. The model the
 * composer names comes after the catalog's own under its own id where the list does not carry it, so the pick the
 * button shows has a row to sit on and moving off it is a click on another model rather than the first send. The
 * catalog's legacy models come last. */
export function listModels(catalog: HarnessCatalog, favourites: ReadonlyArray<string>, query: string, current: HarnessModel | null): ModelRow[] {
  const q = normalizeSearchText(query);
  const unlisted: ModelRow[] = current !== null && !everyModel(catalog).some(m => m.value === current.value) ? [{ ...current, description: UNLISTED_MODEL_LINE, unlisted: true }] : [];
  const legacy: ModelRow[] = (catalog.legacyModels ?? []).map(m => ({ ...m, legacy: true }));
  const rows: ModelRow[] = [...catalog.models, ...unlisted, ...legacy].filter(m => q === "" || normalizeSearchText(`${m.label} ${m.value} ${m.description ?? ""}`).includes(q));
  const starred = (m: ModelRow) => favourites.includes(favouriteKey(catalog.harness, m.value));
  return [...rows.filter(starred), ...rows.filter(m => !starred(m))];
}

/** The legacy fold's own place in the menu, beside the model rows the arrow keys walk. */
const LEGACY_FOLD = "legacy-fold";
type MenuItem = ModelRow | typeof LEGACY_FOLD;

/** What the menu draws, in order: behind an unsearched agent tab the legacy models nobody starred sit under one fold
 * row at the end, drawn only once it is open; a search or the favourites tab shows every row it finds, unfolded. */
function menuItems(rows: ReadonlyArray<ModelRow>, starred: (m: ModelRow) => boolean, folds: boolean, open: boolean): MenuItem[] {
  const folded = (m: ModelRow) => folds && m.legacy === true && !starred(m);
  const tail = rows.filter(folded);
  if (tail.length === 0) return [...rows];
  return [...rows.filter(m => !folded(m)), LEGACY_FOLD, ...(open ? tail : [])];
}

export function jumpLabel(index: number, platform: string): string | null {
  if (index >= JUMP_KEYS) return null;
  return isMacPlatform(platform) ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

/** What the button says: the model the turn runs on, beside the agent's mark, which is the agent's name enough; the
 * agent's name alone where no model is resolved yet. */
export function agentAndModelLine(catalog: HarnessCatalog, model: HarnessModel | null): string {
  return model?.label ?? catalog.label;
}

/** The one line the composer answers a cross-harness pick on a started thread with. */
export function newThreadNotice(entry: HarnessCatalog): string {
  return `Start a new thread to use ${entry.label} here`;
}

/** A tab of the agent rail: the selected one carries a bar at its left edge rather than a fill. */
const RAIL_TAB =
  "relative flex aspect-square w-full items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 before:absolute before:top-2 before:bottom-2 before:-left-1.5 before:w-0.5 before:rounded-full hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ComposerModelPicker({ catalogs, catalog, model, pinned, where, onPickHarness, onPickModel }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [active, setActive] = useState(0);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // An agent that described nothing says why here, such as a CLI that is not signed in; a notice outranks it while it stands.
  const foot = notice ?? catalog.refusal ?? null;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const favourites = useComposerFavouritesStore(s => s.keys);
  const toggle = useComposerFavouritesStore(s => s.toggle);
  const items = useMemo(() => {
    const starred = (m: ModelRow) => favourites.includes(favouriteKey(catalog.harness, m.value));
    const all = listModels(catalog, favourites, query, model);
    return menuItems(onlyStarred ? all.filter(starred) : all, starred, query === "" && !onlyStarred, legacyOpen);
  }, [catalog, favourites, legacyOpen, model, onlyStarred, query]);
  const rows = useMemo(() => items.filter((item): item is ModelRow => item !== LEGACY_FOLD), [items]);
  const currentIsLegacy = catalog.legacyModels?.some(m => m.value === model?.value) === true;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setNotice(null);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const pick = useCallback(
    (m: HarnessModel) => {
      onPickModel(catalog.harness, m.value);
      setOpen(false);
    },
    [catalog.harness, onPickModel],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
        const row = rows[Number(event.key) - 1];
        if (row === undefined) return;
        event.preventDefault();
        pick(row);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length === 0) return;
        setActive(i => (i + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
        return;
      }
      if (event.key === "Enter") {
        const item = items[active];
        if (item === undefined) return;
        event.preventDefault();
        if (item === LEGACY_FOLD) setLegacyOpen(on => !on);
        else pick(item);
      }
    },
    [active, items, pick, rows],
  );

  const foldAt = items.indexOf(LEGACY_FOLD);
  const head = foldAt === -1 ? rows : rows.slice(0, foldAt);
  const tail = foldAt === -1 ? [] : rows.slice(foldAt);

  const optionRow = (m: ModelRow, index: number) => {
    const starred = favourites.includes(favouriteKey(catalog.harness, m.value));
    const chip = jumpLabel(rows.indexOf(m), platform);
    return (
      <div
        key={m.value}
        role="option"
        aria-selected={model?.value === m.value}
        data-composer-option={m.value}
        data-active={index === active || undefined}
        onMouseEnter={() => setActive(index)}
        onClick={() => pick(m)}
        className={cn(
          "group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-foreground",
          index === active && "bg-accent text-accent-foreground",
          model?.value === m.value && "bg-foreground/[0.08]",
        )}
      >
        <div className="min-w-0 flex-1" {...(m.unlisted === true ? { "data-unlisted-model": "" } : {})}>
          <div className="flex items-center gap-2">
            <span className={cn("truncate text-[15px]", m.unlisted === true && "text-muted-foreground")}>{m.label}</span>
            {m.isDefault ? <span className="rounded border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-wide text-primary">default</span> : null}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <HarnessMark harness={catalog.harness} label={catalog.label} className="size-3.5" />
            <span className="truncate">{catalog.label}</span>
          </div>
        </div>
        {chip !== null ? <Kbd className="h-6 min-w-0 rounded-md px-1.5 font-mono text-xs">{chip}</Kbd> : null}
        <button
          type="button"
          aria-label={starred ? `Remove ${m.label} from favourites` : `Add ${m.label} to favourites`}
          aria-pressed={starred}
          data-composer-favourite={m.value}
          onClick={e => {
            e.stopPropagation();
            toggle(catalog.harness, m.value);
          }}
          className={cn("shrink-0 rounded p-1 text-muted-foreground/60 opacity-60 hover:text-foreground group-hover:opacity-100", starred && "text-foreground opacity-100")}
        >
          <StarIcon className={cn("size-4", starred && "fill-current")} aria-hidden />
        </button>
      </div>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        // Set with the open itself, so the first frame of a menu opened on a legacy model already shows it.
        if (next) setLegacyOpen(currentIsLegacy);
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className="h-8 shrink-0 gap-2 px-2 text-[15px] font-normal text-muted-foreground hover:text-foreground sm:h-8 sm:text-[15px] [&_svg]:mx-0"
        aria-label={agentAndModelLine(catalog, model)}
        data-composer-picker="model"
        data-value={model?.value}
        data-harness={catalog.harness}
      >
        <span className="inline-flex text-foreground">
          <HarnessMark harness={catalog.harness} label={catalog.label} className="size-4" />
        </span>
        <span className="truncate">{agentAndModelLine(catalog, model)}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup align="start" side="top" className="w-[25rem] p-0" viewportClassName="p-0 [--viewport-inline-padding:0]">
        <div className="flex max-h-[26rem] min-h-0" data-composer-model-menu onKeyDown={onKeyDown}>
          <div className="flex w-12 shrink-0 flex-col gap-1 border-e border-border p-1.5" role="tablist" aria-label="Agents">
            <button
              type="button"
              role="tab"
              aria-selected={onlyStarred}
              aria-label="Favourites"
              data-composer-favourites-tab
              onClick={() => {
                setOnlyStarred(on => !on);
                setActive(0);
              }}
              className={cn(RAIL_TAB, onlyStarred && "text-foreground before:bg-primary")}
            >
              <StarIcon className={cn("size-4", onlyStarred && "fill-current")} aria-hidden />
            </button>
            <span aria-hidden className="mx-1.5 my-0.5 h-px bg-border" />
            {catalogs.map(entry => {
              const selected = entry.harness === catalog.harness && !onlyStarred;
              return (
                <Tooltip key={entry.harness}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-label={entry.label}
                        data-composer-harness={entry.harness}
                        onClick={() => {
                          setOnlyStarred(false);
                          if (entry.harness === catalog.harness) return;
                          if (pinned) setNotice(newThreadNotice(entry));
                          else onPickHarness(entry.harness);
                        }}
                        className={cn(RAIL_TAB, selected && "text-foreground before:bg-primary")}
                      />
                    }
                  >
                    <HarnessMark harness={entry.harness} label={entry.label} className="size-5" />
                  </TooltipTrigger>
                  <TooltipPopup side="right">{entry.label}</TooltipPopup>
                </Tooltip>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <label className="mx-2 flex items-center gap-2.5 border-b border-border px-1.5 py-3 text-sm transition-colors duration-150 focus-within:border-primary">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder="Search models..."
                aria-label="Search models"
                className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-placeholder"
                data-composer-model-search
              />
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              <div role="listbox" aria-label="Models">
                {items.length === 0 ? (
                  <div className="px-2 py-3 text-center text-xs text-muted-foreground">{catalog.models.length === 0 ? noModelsLine(catalog) : onlyStarred && query === "" ? "Star a model to keep it here." : "No model matches"}</div>
                ) : (
                  head.map((m, index) => optionRow(m, index))
                )}
              </div>
              {foldAt === -1 ? null : (
                <>
                  <button
                    type="button"
                    aria-expanded={legacyOpen}
                    data-composer-legacy-fold
                    data-active={foldAt === active || undefined}
                    onMouseEnter={() => setActive(foldAt)}
                    onClick={() => setLegacyOpen(on => !on)}
                    className={cn("flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-start text-[15px] text-foreground", foldAt === active && "bg-accent text-accent-foreground")}
                  >
                    <span className="min-w-0 flex-1 truncate">Legacy models</span>
                    <ChevronRightIcon className={cn("size-4 shrink-0 opacity-60 transition-transform duration-150", legacyOpen && "rotate-90")} aria-hidden />
                  </button>
                  {tail.length === 0 ? null : (
                    <div role="listbox" aria-label="Legacy models">
                      {tail.map((m, index) => optionRow(m, foldAt + 1 + index))}
                    </div>
                  )}
                </>
              )}
            </div>
            {foot === null ? null : (
              <div className="border-t border-border px-2.5 py-1.5" data-composer-model-foot>
                <div className="truncate font-mono text-[10px] text-muted-foreground/70" role="status" title={foot}>
                  {foot}
                </div>
              </div>
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
